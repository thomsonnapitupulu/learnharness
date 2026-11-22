#!/usr/bin/env bash
# Updates LearnHarness on the server: fetches the newest commit of its branch, rebuilds, restarts.
#
#   sudo /opt/learnharness/deploy/aws/update.sh              the branch the server is on
#   sudo /opt/learnharness/deploy/aws/update.sh main         move to another branch (for example main, once the mobile work is merged)
#   sudo /opt/learnharness/deploy/aws/update.sh --rebuild    build again even if nothing new came
#
# The site is down for the few minutes the build takes. Your data is not touched. Run it from a Session Manager shell.
set -Eeuo pipefail   # -E: the ERR trap below also fires for failures inside functions

# The LH_UPDATE_* settings are for deploy/aws/test-update.sh. On the server the defaults are right.
APP_DIR=${LH_UPDATE_APP_DIR:-/opt/learnharness}
SERVICE_USER=learnharness
CACHE_DIR=${LH_UPDATE_CACHE_DIR:-/var/cache/learnharness}
BUILT_FILE=${LH_UPDATE_BUILT_FILE:-/etc/learnharness/built-commit}   # the commit that was last built to the end

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
as_service() { runuser -u "$SERVICE_USER" -- env "HOME=$CACHE_DIR" NEXT_TELEMETRY_DISABLED=1 "$@"; }

rebuild=0
branch=""
for arg in "$@"; do
  case $arg in
    --rebuild) rebuild=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) branch=$arg ;;
  esac
done

cd "$APP_DIR"
[ -n "$branch" ] || branch=$(as_service git rev-parse --abbrev-ref HEAD)
[[ $branch =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "'$branch' is not a branch name." >&2; exit 2; }

before=$(as_service git rev-parse --short HEAD)
echo "==> Fetching $branch (now at $before)"
as_service git fetch --depth 1 origin "$branch"
as_service git checkout -f -B "$branch" FETCH_HEAD
after=$(as_service git rev-parse --short HEAD)
commit=$(as_service git rev-parse HEAD)
built=$(cat "$BUILT_FILE" 2>/dev/null || true)
# Nothing to do only if this very commit was built to the end and the site is running: after a failed build it is neither.
if [ "$rebuild" -eq 0 ] && [ "$built" = "$commit" ] && systemctl is-active --quiet learnharness; then
  echo "Already up to date at $after, built and running. Nothing to do (use --rebuild to build again)."
  exit 0
fi

trap 'echo; echo "The update stopped part-way and the site may be down. Fix the cause and run this script again (it builds again), or look at: journalctl -u learnharness" >&2' ERR
echo "==> Stopping the site, building $after"
systemctl stop learnharness
cd "$APP_DIR"
as_service npm ci
as_service npm run plugins:setup
as_service npm run build
printf '%s\n' "$commit" > "$BUILT_FILE"
echo "==> Starting the site"
systemctl start learnharness
up=0
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null http://localhost:3000/login; then up=1; break; fi
  sleep 2
done
[ "$up" -eq 1 ] || { echo "The app did not answer on port 3000: journalctl -u learnharness" >&2; exit 1; }
echo "Updated $before -> $after. The site is up."
