#!/usr/bin/env bash
# Sets up LearnHarness on a fresh Ubuntu 24.04 server: installs what it needs, builds it, and starts it behind Caddy.
#
# The first-boot script in learnharness.yaml runs this as root, after it has written /etc/learnharness/bootstrap.env
# (the site name, owner email, repository, data disk id and region). Running it again is safe: every step checks first.
# Read docs/mobile/hosting-guide.md for what each part is for.
set -euo pipefail

APP_DIR=/opt/learnharness
DATA_DIR=/srv/lh
SERVICE_USER=learnharness
CACHE_DIR=/var/cache/learnharness
ENV_FILE=/etc/learnharness/bootstrap.env
# Node 26 is what the repository's CI uses. The checksum is from https://nodejs.org/dist/v26.13.1/SHASUMS256.txt
NODE_VERSION=26.13.1
NODE_SHA256=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
apt_get() { apt-get -o DPkg::Lock::Timeout=300 -o Acquire::Retries=5 -y -q "$@"; }
as_service() { runuser -u "$SERVICE_USER" -- env "HOME=$CACHE_DIR" NEXT_TELEMETRY_DISABLED=1 "$@"; }

[ "$(id -u)" -eq 0 ] || die "run this as root"
[ -r "$ENV_FILE" ] || die "$ENV_FILE is missing (the template writes it)"
# shellcheck source=/dev/null
. "$ENV_FILE"
: "${LH_DOMAIN:?}" "${LH_OWNER_EMAIL:?}" "${LH_REPO_URL:?}" "${LH_REPO_BRANCH:?}" "${LH_DATA_VOLUME_ID:?}" "${LH_REGION:?}"
[[ $LH_DOMAIN =~ ^[a-z0-9.-]+$ ]] || die "LH_DOMAIN is not a plain host name"
[[ $LH_OWNER_EMAIL =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "LH_OWNER_EMAIL is not a plain email address"
[[ $LH_DATA_VOLUME_ID =~ ^vol-[0-9a-f]+$ ]] || die "LH_DATA_VOLUME_ID is not a volume id"
[[ $LH_REGION =~ ^[a-z0-9-]+$ ]] || die "LH_REGION is not a region name"

export DEBIAN_FRONTEND=noninteractive

say "System packages"
apt_get update
apt_get install ca-certificates curl gnupg git unzip xz-utils unattended-upgrades

say "Swap (the build needs more memory than 4 GiB can always give)"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  [ -e /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Node.js $NODE_VERSION"
if [ "$(/usr/local/lib/nodejs/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "/tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  echo "$NODE_SHA256  /tmp/$tarball" | sha256sum -c -
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "/tmp/$tarball" -C /usr/local/lib/nodejs --strip-components=1
  rm -f "/tmp/$tarball"
fi
for tool in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$tool" "/usr/local/bin/$tool"; done

say "AWS CLI (the unlock email goes out through it, signed by the server's role)"
if ! command -v aws >/dev/null 2>&1; then
  scratch=$(mktemp -d)
  curl -fsSL -o "$scratch/awscliv2.zip" https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
  unzip -q "$scratch/awscliv2.zip" -d "$scratch"
  "$scratch/aws/install"
  rm -rf "${scratch:?}"
fi

say "Google Chrome (the app uses it to check demos; Ubuntu's own chromium package is a snap, which does not run for a service)"
if ! command -v google-chrome-stable >/dev/null 2>&1; then
  curl -fsSL -o /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt_get install /tmp/google-chrome.deb
  rm -f /tmp/google-chrome.deb
fi

say "Caddy (HTTPS and the certificate)"
if ! command -v caddy >/dev/null 2>&1; then
  apt_get install debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt_get update
  apt_get install caddy
fi

say "The service user and the data disk"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
disk="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${LH_DATA_VOLUME_ID//-/}"
for _ in $(seq 1 120); do [ -e "$disk" ] && break; sleep 5; done
[ -e "$disk" ] || die "the data disk did not appear at $disk"
if ! blkid "$disk" >/dev/null 2>&1; then
  # A new disk is all zeros. Never format one that holds anything.
  [ -z "$(head -c 1048576 "$disk" | tr -d '\0' | head -c 1)" ] || die "the data disk holds data this script does not recognise; not formatting it"
  mkfs.ext4 -q -L lhdata "$disk"
fi
uuid=$(blkid -s UUID -o value "$disk")
mkdir -p "$DATA_DIR"
grep -q "UUID=$uuid " /etc/fstab || echo "UUID=$uuid $DATA_DIR ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$DATA_DIR" || mount "$DATA_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR/data"
# A disk made from a snapshot keeps the number the old server's user had, and this server's user may have another. Hand
# the app's files to the user (not the root-only *.before-import-* copies, nor lost+found).
find "$DATA_DIR" -mindepth 1 -maxdepth 1 ! -name '*.before-import-*' ! -name lost+found -exec chown -R "$SERVICE_USER:$SERVICE_USER" {} +
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$CACHE_DIR"

say "The app: $LH_REPO_URL ($LH_REPO_BRANCH)"
[ -d "$APP_DIR/.git" ] || git clone --depth 1 --branch "$LH_REPO_BRANCH" "$LH_REPO_URL" "$APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
cd "$APP_DIR"
as_service npm ci
as_service npm run plugins:setup
as_service npm run build

say "Settings, service and Caddy"
install -d -m 0755 /etc/learnharness
cat > /etc/learnharness/service.env <<EOF
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
LH_DATA_DIR=$DATA_DIR/data
LH_AUTH_FILE=$DATA_DIR/auth.json
LH_ALLOWED_HOSTS=$LH_DOMAIN
LH_ACCESS_EMAIL=$LH_OWNER_EMAIL
AWS_REGION=$LH_REGION
AWS_DEFAULT_REGION=$LH_REGION
CHROME_PATH=/usr/bin/google-chrome-stable
EOF

cat > /etc/systemd/system/learnharness.service <<EOF
[Unit]
Description=LearnHarness
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$DATA_DIR

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/learnharness/service.env
# npm start is "next start -H localhost": the app listens on this computer only, and only Caddy reaches it.
ExecStart=/usr/local/bin/npm start
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
{
	email $LH_OWNER_EMAIL
}

$LH_DOMAIN {
	# Room for a 64 MiB upload plus its envelope (docs/mobile/uploads.md).
	request_body {
		max_size 70MB
	}
	reverse_proxy localhost:3000
}
EOF

systemctl daemon-reload
systemctl enable learnharness caddy >/dev/null 2>&1
systemctl restart learnharness
systemctl restart caddy

say "Waiting for the app to answer"
up=0
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null http://localhost:3000/login; then up=1; break; fi
  sleep 2
done
[ "$up" -eq 1 ] || die "the app did not answer on port 3000 (journalctl -u learnharness)"
systemctl is-active --quiet caddy || die "caddy is not running (journalctl -u caddy)"

say "Done. https://$LH_DOMAIN answers once DNS has reached the server and Caddy has its certificate (a minute or two). Next: set the password (docs/mobile/hosting-guide.md)."
