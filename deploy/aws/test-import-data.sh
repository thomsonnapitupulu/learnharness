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
echo "--- 9. a link inside the zip is refused, and what it points at is left alone"
echo "outside the server" > $T/outside.txt && chmod 644 $T/outside.txt
rm -rf "${T:?}/linked" && mkdir -p $T/linked/data/chats && echo '{}' > $T/linked/data/settings.json && ln -s $T/outside.txt $T/linked/auth.json
(cd $T/linked && zip -qry $T/link-auth.zip data auth.json)
rm -rf "${T:?}/linked2" && mkdir -p $T/linked2/data/chats && echo '{}' > $T/linked2/data/settings.json && ln -s $T/outside.txt $T/linked2/data/chats/c9.json
(cd $T/linked2 && zip -qry $T/link-data.zip data)
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data && echo keep > $T/srv/data/keep.txt
for z in link-auth link-data; do
  out=$(run $T/$z.zip 2>&1); rc=$?
  check "$z.zip is refused and says why" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'symbolic link'"
  check "$z.zip: the server's data is untouched" "[ -f $T/srv/data/keep.txt ] && [ -z \"\$(ls $T/srv | grep -E 'before-import|import')\" ]"
  check "$z.zip: the file the link pointed at keeps its mode (644)" "[ \"\$(stat -c %a $T/outside.txt)\" = 644 ]"
done
echo "--- 10. what is moved aside is readable by root only; the new data belongs to the service user"
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data/chats && echo '{"id":"server-only"}' > $T/srv/data/chats/server-only.json && echo '{"K":"server"}' > $T/srv/auth.json && chmod 644 $T/srv/auth.json
out=$(LH_IMPORT_DATA_DIR=$T/srv LH_IMPORT_USER=nobody LH_IMPORT_SYSTEMCTL=true LH_IMPORT_HEALTH_URL=file:///etc/hostname bash $SCRIPT $T/plain.zip 2>&1); rc=$?
check "exits 0" "[ $rc -eq 0 ]"
check "the new data is owned by the service user, and auth.json has mode 600" "[ \"\$(stat -c %U $T/srv/data)\" = nobody ] && [ \"\$(stat -c %U $T/srv/data/chats/c1.json)\" = nobody ] && [ \"\$(stat -c '%U %a' $T/srv/auth.json)\" = 'nobody 600' ]"
check "the old data folder is root's and closed to others (700)" "[ \"\$(stat -c '%U %a' \$(ls -d $T/srv/data.before-import-* | head -1))\" = 'root 700' ] && [ \"\$(stat -c %U \$(ls -d $T/srv/data.before-import-* | head -1)/chats/server-only.json)\" = root ]"
check "the old auth.json is root's with mode 600" "[ \"\$(stat -c '%U %a' \$(ls -d $T/srv/auth.json.before-import-* | head -1))\" = 'root 600' ]"
echo "--- 11. a second import while one is running is refused, and does not disturb the first"
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data $T/srv/.data-import && echo keep > $T/srv/data/keep.txt && echo half > $T/srv/.data-import/half-copied.txt
exec 8>$T/srv/.import.lock && flock -n 8   # this shell plays the import that is running
out=$(run $T/plain.zip 2>&1); rc=$?
check "exits non-zero and says another import is running" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'already running'"
check "the server's data is untouched, and so is what the running import had copied so far" "[ -f $T/srv/data/keep.txt ] && [ -f $T/srv/.data-import/half-copied.txt ] && [ -z \"\$(ls $T/srv | grep before-import)\" ]"
exec 8>&-   # the first import is over
out=$(run $T/plain.zip 2>&1); rc=$?
check "once it is over, an import goes through" "[ $rc -eq 0 ] && [ -f $T/srv/data/chats/c1.json ] && [ ! -e $T/srv/.data-import ]"
echo "--- 12. a data disk too small: refused before anything is changed"
mkdir -p $T/lowdisk
cat > $T/lowdisk/df <<'EOF_DF'
#!/bin/bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfake 1000 990 10 99%% /\n'
EOF_DF
chmod +x $T/lowdisk/df
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data && echo keep > $T/srv/data/keep.txt
out=$(PATH=$T/lowdisk:$PATH run $T/plain.zip 2>&1); rc=$?
check "exits non-zero and says there is not enough room" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'not enough room'"
check "the server's data is untouched and nothing is left half-made" "[ -f $T/srv/data/keep.txt ] && [ ! -e $T/srv/.data-import ] && [ ! -e $T/srv/.auth-import ] && [ -z \"\$(ls $T/srv | grep before-import)\" ]"
echo "--- 13. the copy fails half-way (disk full): the half-made copy is removed and the data stays"
mkdir -p $T/failcp
cat > $T/failcp/cp <<'EOF_CP'
#!/bin/bash
for a in "$@"; do
  case $a in
    *.data-import) mkdir -p "$a" && echo partial > "$a/partial.json"; echo "cp: error writing '$a/x': No space left on device" >&2; exit 1 ;;
  esac
done
exec /bin/cp "$@"
EOF_CP
chmod +x $T/failcp/cp
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data && echo keep > $T/srv/data/keep.txt
out=$(PATH=$T/failcp:$PATH run $T/plain.zip 2>&1); rc=$?
check "exits non-zero, shows what cp said and that nothing was changed" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'No space left' && echo \"\$out\" | grep -q 'Nothing was changed'"
check "the server's data is untouched" "[ -f $T/srv/data/keep.txt ] && [ -z \"\$(ls $T/srv | grep before-import)\" ]"
check "the half-made copy is gone, and so is the work folder" "[ ! -e $T/srv/.data-import ] && [ -z \"\$(ls -d /var/tmp/lh-import.* 2>/dev/null)\" ]"
echo "--- 14. a damaged zip is refused with a plain message"
head -c 100 $T/plain.zip > $T/broken.zip
rm -rf "${T:?}/srv" && mkdir -p $T/srv/data && echo keep > $T/srv/data/keep.txt
out=$(run $T/broken.zip 2>&1); rc=$?
check "exits non-zero and says unzip could not unpack it" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'could not unpack'"
check "the server's data is untouched and the work folder is gone" "[ -f $T/srv/data/keep.txt ] && [ -z \"\$(ls $T/srv | grep before-import)\" ] && [ -z \"\$(ls -d /var/tmp/lh-import.* 2>/dev/null)\" ]"
echo "--- 15. whatever modes the zip carried, the service user can read and write its data and nobody else can"
rm -rf "${T:?}/modes" && mkdir -p $T/modes/data/chats && echo '{}' > $T/modes/data/settings.json && echo '{"id":"m"}' > $T/modes/data/chats/m1.json && chmod 000 $T/modes/data/chats/m1.json && chmod 666 $T/modes/data/settings.json
(cd $T/modes && zip -qr $T/modes.zip data)
rm -rf "${T:?}/srv" && mkdir -p $T/srv
out=$(LH_IMPORT_DATA_DIR=$T/srv LH_IMPORT_USER=nobody LH_IMPORT_SYSTEMCTL=true LH_IMPORT_HEALTH_URL=file:///etc/hostname bash $SCRIPT $T/modes.zip 2>&1); rc=$?
check "exits 0" "[ $rc -eq 0 ]"
check "the file that had mode 000 is now 600 and the one that had 666 is 600, both the service user's" "[ \"\$(stat -c '%U %a' $T/srv/data/chats/m1.json)\" = 'nobody 600' ] && [ \"\$(stat -c '%U %a' $T/srv/data/settings.json)\" = 'nobody 600' ]"
check "the folders are 700" "[ \"\$(stat -c %a $T/srv/data)\" = 700 ] && [ \"\$(stat -c %a $T/srv/data/chats)\" = 700 ]"
echo "--- 16. run somewhere that is not the server: refused"
out=$(LH_IMPORT_DATA_DIR=$T/not-here LH_IMPORT_USER=root LH_IMPORT_SYSTEMCTL=true bash $SCRIPT $T/plain.zip 2>&1); rc=$?
check "exits non-zero and says the data folder is not there" "[ $rc -ne 0 ] && echo \"\$out\" | grep -q 'is not there'"
echo; echo "passed $pass, failed $fail"
exit $fail
