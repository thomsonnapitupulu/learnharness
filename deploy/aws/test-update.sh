#!/usr/bin/env bash
# Runs deploy/aws/update.sh against a local git repository, with stand-ins for runuser, systemctl, npm and curl. Needs root
# (update.sh runs as root) and git. Nothing outside a new temporary folder is touched.
#   sudo deploy/aws/test-update.sh
# shellcheck disable=SC2086,SC2015,SC2034,SC2329  # $T is a path mktemp made (no spaces); A && B || C, $out and built() are used inside the check strings
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run this as root: sudo $0" >&2; exit 2; }
command -v git >/dev/null || { echo "git is needed" >&2; exit 2; }
T=$(mktemp -d /var/tmp/lh-update-test.XXXXXX) && [ -d "$T" ] || { echo "could not make a temporary folder" >&2; exit 2; }
trap 'rm -rf "${T:?}"' EXIT
SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/update.sh
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
run() { : > "$T/calls.log"; PATH=$T/bin:$PATH LH_UPDATE_APP_DIR=$T/app LH_UPDATE_CACHE_DIR=$T/cache LH_UPDATE_BUILT_FILE=$T/built-commit bash "$SCRIPT" "$@"; }
git_() { git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"; }
head_of() { git -C "$1" rev-parse HEAD; }
built() { [ "$(cat $T/built-commit 2>/dev/null)" = "$(head_of $T/app)" ]; }

# stand-ins
mkdir -p $T/bin $T/cache
cat > $T/bin/runuser <<'EOF_STUB'
#!/bin/bash
shift 3   # -u <user> --
exec "$@"
EOF_STUB
cat > $T/bin/systemctl <<'EOF_STUB'
#!/bin/bash
echo "systemctl $*" >> "$LH_TEST_CALLS"
case $1 in
  stop) echo inactive > "$LH_TEST_STATE" ;;
  start) echo active > "$LH_TEST_STATE" ;;
  is-active) [ "$(cat "$LH_TEST_STATE")" = active ] ;;
esac
EOF_STUB
cat > $T/bin/npm <<'EOF_STUB'
#!/bin/bash
echo "npm $*" >> "$LH_TEST_CALLS"
if [ "$*" = "run build" ] && [ -e "$LH_TEST_FAIL_BUILD" ]; then echo "build failed: out of memory" >&2; exit 1; fi
EOF_STUB
printf '#!/bin/bash\nexit 0\n' > $T/bin/curl
chmod +x $T/bin/*
export LH_TEST_CALLS=$T/calls.log LH_TEST_STATE=$T/service-state LH_TEST_FAIL_BUILD=$T/fail-build

# a remote with two branches, and the app folder the way setup leaves it: built, and running
git_ init -q $T/work
(cd $T/work && echo one > file.txt && git_ add file.txt && git_ commit -qm one && git_ branch -M claude/mobile-epic \
  && git_ checkout -qb main && echo main > main.txt && git_ add main.txt && git_ commit -qm main && git_ checkout -q claude/mobile-epic)
git_ clone -q --bare $T/work $T/remote.git
git_ -C $T/work remote add origin file://$T/remote.git
git_ clone -q --depth 1 --branch claude/mobile-epic file://$T/remote.git $T/app 2>/dev/null
head_of $T/app > $T/built-commit; echo active > $T/service-state
new_commit() { (cd $T/work && git_ checkout -q claude/mobile-epic && echo "$1" >> file.txt && git_ commit -qam "$1" && git_ push -q origin claude/mobile-epic); }

echo "--- 1. nothing new, built and running: nothing to do"
out=$(run 2>&1); rc=$?
check "exits 0 and says it is up to date" "[ $rc -eq 0 ] && echo \"\$out\" | grep -q 'Already up to date'"
check "it did not build or touch the site" "! grep -q npm $T/calls.log && ! grep -qE 'systemctl (stop|start)' $T/calls.log"

echo "--- 2. a new commit: built, restarted, remembered"
new_commit two
out=$(run 2>&1); rc=$?
check "exits 0 and says the site is up" "[ $rc -eq 0 ] && echo \"\$out\" | grep -q 'The site is up'"
check "it ran npm ci, the plugin setup and the build, in that order" "[ \"\$(grep npm $T/calls.log | tr '\n' ';')\" = 'npm ci;npm run plugins:setup;npm run build;' ]"
check "the app folder is at the new commit, the site is running, and the commit is remembered as built" "[ \"\$(head_of $T/app)\" = \"\$(git -C $T/remote.git rev-parse claude/mobile-epic)\" ] && [ \"\$(cat $T/service-state)\" = active ] && built"

echo "--- 3. the build fails: it says so, the site stays down, the commit is not remembered"
new_commit three
touch $T/fail-build
out=$(run 2>&1); rc=$?
check "exits non-zero and says the update stopped part-way" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'stopped part-way'"
check "the site is down, and the commit is not remembered as built" "[ \"\$(cat $T/service-state)\" = inactive ] && ! built"

echo "--- 4. run again with nothing new (the cause is fixed): it builds, it does not say 'up to date'"
rm -f $T/fail-build
out=$(run 2>&1); rc=$?
check "exits 0, built again and says the site is up" "[ $rc -eq 0 ] && echo \"\$out\" | grep -q 'The site is up' && ! echo \"\$out\" | grep -q 'Already up to date' && grep -q 'npm run build' $T/calls.log"
check "the site is running and the commit is remembered" "[ \"\$(cat $T/service-state)\" = active ] && built"

echo "--- 4b. the build fails again; someone starts the site by hand; the same commit is updated again: it still builds"
new_commit four
touch $T/fail-build
out=$(run 2>&1); rc=$?
check "the first run fails" "[ $rc -ne 0 ]"
rm -f $T/fail-build; echo active > $T/service-state   # started by hand, on a build that never finished
out=$(run 2>&1); rc=$?
check "exits 0, built again (the commit was never built to the end), and remembers it" "[ $rc -eq 0 ] && grep -q 'npm run build' $T/calls.log && ! echo \"\$out\" | grep -q 'Already up to date' && built"

echo "--- 5. up to date again, but the site is stopped: it starts it"
out=$(run 2>&1); rc=$?
check "up to date and running: nothing to do" "[ $rc -eq 0 ] && echo \"\$out\" | grep -q 'Already up to date' && ! grep -q npm $T/calls.log"
echo inactive > $T/service-state
out=$(run 2>&1); rc=$?
check "stopped: builds, starts, exits 0" "[ $rc -eq 0 ] && [ \"\$(cat $T/service-state)\" = active ] && grep -q 'npm run build' $T/calls.log"

echo "--- 6. --rebuild builds even when nothing is new"
out=$(run --rebuild 2>&1); rc=$?
check "exits 0 and ran the build" "[ $rc -eq 0 ] && grep -q 'npm run build' $T/calls.log"

echo "--- 7. a branch name moves the server to that branch"
out=$(run main 2>&1); rc=$?
check "exits 0, the app folder is on main at main's commit, and it was built" "[ $rc -eq 0 ] && [ \"\$(git -C $T/app rev-parse --abbrev-ref HEAD)\" = main ] && [ \"\$(head_of $T/app)\" = \"\$(git -C $T/remote.git rev-parse main)\" ] && built"

echo "--- 8. bad arguments"
out=$(run 'x;y' 2>&1); rc=$?
check "a branch name with odd characters is refused (exit 2)" "[ $rc -eq 2 ] && ! grep -q npm $T/calls.log"
out=$(run --nonsense 2>&1); rc=$?
check "an unknown option is refused (exit 2)" "[ $rc -eq 2 ]"
echo; echo "passed $pass, failed $fail"
exit $fail
