#!/usr/bin/env bash
# Puts the data from your desktop app onto the server (docs/mobile/data-migration.md).
#
#   sudo /opt/learnharness/deploy/aws/import-data.sh s3://<bucket>/learnharness-data.zip
#   sudo /opt/learnharness/deploy/aws/import-data.sh /path/to/learnharness-data.zip
#
# The zip holds the desktop app's "data" folder and its "auth.json" file (API keys). This script stops the site, moves
# whatever the server holds now to a folder with "before-import" and the time in its name (nothing is deleted), puts
# your data in its place with the right owner and permissions, and starts the site again.
# The password and the sign-in state (access.json) are the server's own and are never touched.
set -euo pipefail

# The LH_IMPORT_* settings are for deploy/aws/test-import-data.sh. On the server the defaults are right.
DATA_DIR=${LH_IMPORT_DATA_DIR:-/srv/lh}
SERVICE_USER=${LH_IMPORT_USER:-learnharness}
SYSTEMCTL=${LH_IMPORT_SYSTEMCTL:-systemctl}
HEALTH_URL=${LH_IMPORT_HEALTH_URL:-http://localhost:3000/login}
WAIT_TRIES=${LH_IMPORT_WAIT_TRIES:-60}
SERVICE_ENV=${LH_IMPORT_SERVICE_ENV:-/etc/learnharness/service.env}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

[ "$#" -eq 1 ] || die "usage: import-data.sh s3://<bucket>/<file>.zip   (or the path of a zip on this server)"
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
source=$1

work=$(mktemp -d /var/tmp/lh-import.XXXXXX)
cleanup() { [ -n "${work:-}" ] && [ -d "$work" ] && rm -rf "${work:?}"; return 0; }
trap cleanup EXIT

# The download from S3 needs the region the server runs in. The service's settings have it.
if [ -z "${AWS_REGION:-}" ] && [ -r "$SERVICE_ENV" ]; then
  AWS_REGION=$(sed -n 's/^AWS_REGION=//p' "$SERVICE_ENV" | head -n 1)
  [ -z "$AWS_REGION" ] || export AWS_REGION
fi

say "Getting the zip"
case $source in
  s3://*) aws s3 cp --no-progress "$source" "$work/data.zip" ;;
  *) [ -f "$source" ] || die "$source is not a file"; cp "$source" "$work/data.zip" ;;
esac

say "Unpacking and checking it"
mkdir "$work/unzipped"
unzip -q "$work/data.zip" -d "$work/unzipped"
# A link inside the zip could point at any file on this server, and the commands below (chown, chmod) would follow it.
if [ -n "$(find "$work/unzipped" -type l -print -quit)" ]; then
  die "the zip contains a symbolic link (an alias). Those are not copied, because a link can point at any file on this server. Zip the data folder and auth.json again without aliases."
fi
root=$work/unzipped
# A zip made by right-clicking the whole LearnHarness folder has one folder around everything: look inside it.
if [ ! -d "$root/data" ]; then
  inner=$(find "$root" -mindepth 1 -maxdepth 1 -type d ! -name '__MACOSX' | head -n 2)
  if [ -n "$inner" ] && [ "$(printf '%s\n' "$inner" | wc -l)" -eq 1 ] && [ -d "$inner/data" ]; then root=$inner; fi
fi
[ -d "$root/data" ] || die "there is no 'data' folder in the zip. It should hold the desktop app's data folder and auth.json."
if [ ! -d "$root/data/chats" ] && [ ! -d "$root/data/graph" ] && [ ! -f "$root/data/settings.json" ]; then
  die "the 'data' folder in the zip has no chats, graph or settings: this does not look like LearnHarness data"
fi
if [ -f "$root/auth.json" ]; then
  have_auth=1
else
  have_auth=0
  echo "Note: the zip has no auth.json, so your API keys are not copied. Add them again in Settings, Providers."
fi

say "Copying to the data disk"
# Copied first, next to its final place on the same disk, so a full disk or a failure here changes nothing.
rm -rf "${DATA_DIR:?}/.data-import" "${DATA_DIR:?}/.auth-import"
cp -a "$root/data" "$DATA_DIR/.data-import"
[ "$have_auth" -eq 0 ] || cp -a "$root/auth.json" "$DATA_DIR/.auth-import"
chown -R "$SERVICE_USER:" "$DATA_DIR/.data-import"
[ "$have_auth" -eq 0 ] || chown "$SERVICE_USER:" "$DATA_DIR/.auth-import"
[ "$have_auth" -eq 0 ] || chmod 600 "$DATA_DIR/.auth-import"

say "Stopping the site and swapping the data in"
"$SYSTEMCTL" stop learnharness || true
stamp=$(date +%Y%m%d-%H%M%S)-$$
[ ! -e "$DATA_DIR/data" ] || mv "$DATA_DIR/data" "$DATA_DIR/data.before-import-$stamp"
mv "$DATA_DIR/.data-import" "$DATA_DIR/data"
if [ "$have_auth" -eq 1 ]; then
  [ ! -e "$DATA_DIR/auth.json" ] || mv "$DATA_DIR/auth.json" "$DATA_DIR/auth.json.before-import-$stamp"
  mv "$DATA_DIR/.auth-import" "$DATA_DIR/auth.json"
fi

# What was moved aside stays on this disk for you alone. The app, and the agent's file tools that read the app's home
# folder, must not be able to read old keys.
for old in "$DATA_DIR/data.before-import-$stamp" "$DATA_DIR/auth.json.before-import-$stamp"; do
  if [ -e "$old" ] && [ ! -L "$old" ]; then chown -R root:root "$old"; chmod -R go-rwx "$old"; fi
done

say "Starting the site"
"$SYSTEMCTL" start learnharness
up=0
for _ in $(seq 1 "$WAIT_TRIES"); do
  if curl -fsS -o /dev/null "$HEALTH_URL"; then up=1; break; fi
  sleep 2
done
[ "$up" -eq 1 ] || die "the site did not answer after the import (journalctl -u learnharness). Your data is in $DATA_DIR/data; what was there before is in $DATA_DIR/*before-import-$stamp."

echo
echo "Done. Your data is on the server and the site is up."
echo "What the server held before is kept, readable by root only:"
[ ! -e "$DATA_DIR/data.before-import-$stamp" ] || echo "  $DATA_DIR/data.before-import-$stamp"
[ ! -e "$DATA_DIR/auth.json.before-import-$stamp" ] || echo "  $DATA_DIR/auth.json.before-import-$stamp"
echo "Once everything looks right on your phone, you can delete those, and the zip in S3."
