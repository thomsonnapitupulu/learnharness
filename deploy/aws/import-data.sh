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
# One import runs at a time, a zip with links in it is refused, and nothing is changed until the new data is fully copied.
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

[ -d "$DATA_DIR" ] || die "$DATA_DIR is not there. Is this the LearnHarness server?"
# One import at a time: a second one would delete the first one's half-copied files.
exec 9>"$DATA_DIR/.import.lock"
flock -n 9 || die "another import is already running on this server. Wait for it to finish."

work=$(mktemp -d /var/tmp/lh-import.XXXXXX)
# Whatever happens, the half-made copies go: before the swap they are all that a failure leaves, and after it they are gone.
cleanup() {
  rm -rf "${DATA_DIR:?}/.data-import" "${DATA_DIR:?}/.auth-import"
  [ -n "${work:-}" ] && [ -d "$work" ] && rm -rf "${work:?}"
  return 0
}
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
if ! unzip -q "$work/data.zip" -d "$work/unzipped" 2>"$work/unzip.err"; then
  head -n 5 "$work/unzip.err" >&2
  die "unzip could not unpack the zip. It may be damaged or incomplete, or hold paths unzip will not use. Nothing was changed."
fi
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
need_kb=$(du -sk "$root" | cut -f1)
have_kb=$(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}')
if [ "$have_kb" -lt $((need_kb + need_kb / 10 + 10240)) ]; then
  die "not enough room on the data disk: your data needs about $((need_kb / 1024)) MB and the disk has about $((have_kb / 1024)) MB free. Make the data disk bigger (docs/mobile/hosting-guide.md, Updating) and run this again. Nothing was changed."
fi
rm -rf "${DATA_DIR:?}/.data-import" "${DATA_DIR:?}/.auth-import"
copy_in() {
  if ! cp -a "$1" "$2" 2>"$work/cp.err"; then
    head -n 5 "$work/cp.err" >&2
    die "copying to the data disk failed (is it full? df -h $DATA_DIR). Nothing was changed."
  fi
}
copy_in "$root/data" "$DATA_DIR/.data-import"
[ "$have_auth" -eq 0 ] || copy_in "$root/auth.json" "$DATA_DIR/.auth-import"
chown -R "$SERVICE_USER:" "$DATA_DIR/.data-import"
# The app's data is the app's alone, whatever modes the zip carried (a file with mode 000 would be unreadable).
chmod -R u+rwX,go-rwx "$DATA_DIR/.data-import"
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
