#!/usr/bin/env bash
# Runs deploy/aws/import-data.sh against a fake server folder, with a stand-in for systemctl. Needs root (the script
# changes file owners), zip and unzip. Nothing outside a new temporary folder is touched.
#   sudo deploy/aws/test-import-data.sh
# shellcheck disable=SC2086,SC2015,SC2034  # $T is a path mktemp made (no spaces); A && B || C and $out are used inside the check strings
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run this as root: sudo $0" >&2; exit 2; }
command -v zip >/dev/null && command -v unzip >/dev/null || { echo "zip and unzip are needed" >&2; exit 2; }
T=$(mktemp -d /var/tmp/lh-import-test.XXXXXX) && [ -d "$T" ] || { echo "could not make a temporary folder" >&2; exit 2; }
trap 'rm -rf "${T:?}"' EXIT
SCRIPT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/import-data.sh
pass=0; fail=0
ok() { pass=$((pass+1)); echo "ok   - $1"; }
bad() { fail=$((fail+1)); echo "FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
run() { LH_IMPORT_DATA_DIR=$T/srv LH_IMPORT_USER=root LH_IMPORT_SYSTEMCTL=true LH_IMPORT_HEALTH_URL=file:///etc/hostname bash "$SCRIPT" "$@"; }
mkdir -p $T/srv $T/src

# a desktop folder
mk_desktop() { rm -rf "${T:?}/desktop"; mkdir -p "$T/desktop/data/chats" "$T/desktop/data/graph"; echo '{"id":"c1"}' > "$T/desktop/data/chats/c1.json"; echo '{}' > "$T/desktop/data/settings.json"; echo '{"OPENAI_API_KEY":"sk-test"}' > "$T/desktop/auth.json"; chmod 644 "$T/desktop/auth.json"; }
mk_desktop
(cd $T/desktop && zip -qr $T/plain.zip data auth.json)
# Finder-style: the whole folder, plus macOS junk
mkdir -p $T/finder && rm -rf "${T:?}/finder/LearnHarness" && cp -a $T/desktop $T/finder/LearnHarness && mkdir -p $T/finder/__MACOSX && echo junk > $T/finder/__MACOSX/._x && echo junk > $T/finder/LearnHarness/.DS_Store
(cd $T/finder && zip -qr $T/finder.zip LearnHarness __MACOSX)
# no data folder; data without LearnHarness content; no auth.json
(cd $T/desktop && zip -qr $T/nodata.zip auth.json)
mkdir -p $T/odd/data/photos && echo x > $T/odd/data/photos/a.jpg && (cd $T/odd && zip -qr $T/odd.zip data)
(cd $T/desktop && zip -qr $T/noauth.zip data)

echo "--- 1. plain zip onto an empty server"
out=$(run $T/plain.zip 2>&1); rc=$?
check "exits 0" "[ $rc -eq 0 ]"
check "data arrived" "[ -f $T/srv/data/chats/c1.json ]"
check "auth.json arrived with mode 600 (the zip had 644)" "[ \"\$(stat -c %a $T/srv/auth.json)\" = 600 ]"
check "nothing was moved aside (there was nothing)" "[ -z \"\$(ls $T/srv | grep before-import)\" ]"
check "no staging files left" "[ ! -e $T/srv/.data-import ] && [ ! -e $T/srv/.auth-import ]"
check "the work folder is gone" "[ -z \"\$(ls -d /var/tmp/lh-import.* 2>/dev/null)\" ]"

echo "--- 2. a second import onto a server that already has data: the old is kept"
echo '{"id":"server-only"}' > $T/srv/data/chats/server-only.json; echo '{"K":"server"}' > $T/srv/auth.json; echo '{"pw":"hash"}' > $T/srv/access.json
out=$(run $T/plain.zip 2>&1); rc=$?
check "exits 0" "[ $rc -eq 0 ]"
check "the old data folder is kept with before-import in its name" "ls -d $T/srv/data.before-import-* >/dev/null 2>&1 && [ -f \$(ls -d $T/srv/data.before-import-* | head -1)/chats/server-only.json ]"
check "the old auth.json is kept too" "[ -f \$(ls -d $T/srv/auth.json.before-import-* | head -1) ]"
check "the new data does not have the server-only chat" "[ ! -e $T/srv/data/chats/server-only.json ]"
check "access.json (the server's password) is untouched" "[ \"\$(cat $T/srv/access.json)\" = '{\"pw\":\"hash\"}' ]"

echo "--- 3. a Finder zip (whole folder, __MACOSX)"
rm -rf "${T:?}/srv" && mkdir -p $T/srv
out=$(run $T/finder.zip 2>&1); rc=$?
check "exits 0" "[ $rc -eq 0 ]"
check "found the data inside the folder" "[ -f $T/srv/data/chats/c1.json ] && [ -f $T/srv/auth.json ]"

echo "--- 4. refusals leave the server alone"
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data && echo keep > $T/srv/data/keep.txt
for z in nodata odd; do
  out=$(run $T/$z.zip 2>&1); rc=$?
  check "$z.zip is refused (exit $rc)" "[ $rc -ne 0 ]"
  check "$z.zip: the server's data is untouched" "[ -f $T/srv/data/keep.txt ] && [ -z \"\$(ls $T/srv | grep -E 'before-import|import')\" ]"
done
echo "   message for nodata: $(run $T/nodata.zip 2>&1 | tail -1)"
echo "   message for odd:    $(run $T/odd.zip 2>&1 | tail -1)"
out=$(run $T/missing.zip 2>&1); rc=$?
check "a missing file is refused" "[ $rc -ne 0 ]"
out=$(run 2>&1); rc=$?
check "no argument is refused" "[ $rc -ne 0 ]"

echo "--- 5. a zip without auth.json keeps the server's keys"
rm -rf "${T:?}/srv" && mkdir -p $T/srv && echo '{"K":"server"}' > $T/srv/auth.json
out=$(run $T/noauth.zip 2>&1); rc=$?
check "exits 0 and says so" "[ $rc -eq 0 ] && echo \"\$out\" | grep -q 'no auth.json'"
check "the server's auth.json is still there, not moved aside" "[ \"\$(cat $T/srv/auth.json)\" = '{\"K\":\"server\"}' ] && [ -z \"\$(ls $T/srv | grep auth.json.before)\" ]"
check "the data arrived" "[ -f $T/srv/data/chats/c1.json ]"

echo "--- 6. the site does not come up: it says so, and the data is still in place"
out=$(LH_IMPORT_DATA_DIR=$T/srv LH_IMPORT_USER=root LH_IMPORT_SYSTEMCTL=true LH_IMPORT_HEALTH_URL=file:///nonexistent LH_IMPORT_WAIT_TRIES=1 bash $SCRIPT $T/plain.zip 2>&1); rc=$?
check "exits non-zero with the explanation" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'did not answer'"
check "the imported data is there" "[ -f $T/srv/data/chats/c1.json ]"
echo "--- 7. an s3:// address is fetched with the aws command, in the server's region"
mkdir -p $T/bin
cat > $T/bin/aws <<'EOF_AWS'
#!/bin/bash
echo "aws $* (AWS_REGION=${AWS_REGION:-unset})" >> "$LH_FAKE_AWS_LOG"
[ -z "${LH_FAKE_AWS_FAIL:-}" ] || { echo "An error occurred (AccessDenied)" >&2; exit 1; }
cp "$LH_FAKE_AWS_ZIP" "${@: -1}"
EOF_AWS
chmod +x $T/bin/aws
echo 'AWS_REGION=eu-test-1' > $T/service.env
rm -rf "${T:?}/srv" && mkdir -p $T/srv
out=$(env -u AWS_REGION PATH=$T/bin:$PATH LH_FAKE_AWS_LOG=$T/aws.log LH_FAKE_AWS_ZIP=$T/plain.zip LH_IMPORT_SERVICE_ENV=$T/service.env LH_IMPORT_DATA_DIR=$T/srv LH_IMPORT_USER=root LH_IMPORT_SYSTEMCTL=true LH_IMPORT_HEALTH_URL=file:///etc/hostname bash $SCRIPT s3://a-bucket/learnharness-data.zip 2>&1); rc=$?
check "exits 0 and the data arrived" "[ $rc -eq 0 ] && [ -f $T/srv/data/chats/c1.json ]"
check "it ran: aws s3 cp s3://a-bucket/learnharness-data.zip, with the region from the service settings" "grep -q 'aws s3 cp --no-progress s3://a-bucket/learnharness-data.zip .*(AWS_REGION=eu-test-1)' $T/aws.log"
echo "--- 8. a download that fails leaves the server alone"
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data && echo keep > $T/srv/data/keep.txt
out=$(env PATH=$T/bin:$PATH LH_FAKE_AWS_FAIL=1 LH_FAKE_AWS_LOG=$T/aws.log LH_FAKE_AWS_ZIP=$T/plain.zip LH_IMPORT_SERVICE_ENV=$T/service.env LH_IMPORT_DATA_DIR=$T/srv LH_IMPORT_USER=root LH_IMPORT_SYSTEMCTL=true LH_IMPORT_HEALTH_URL=file:///etc/hostname bash $SCRIPT s3://a-bucket/learnharness-data.zip 2>&1); rc=$?
check "exits non-zero and shows what aws said" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q AccessDenied"
check "the server's data is untouched" "[ -f $T/srv/data/keep.txt ] && [ -z \"\$(ls $T/srv | grep -E 'before-import|import')\" ]"
echo; echo "passed $pass, failed $fail"
exit $fail
