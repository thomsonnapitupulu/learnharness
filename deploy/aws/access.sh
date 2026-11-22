#!/usr/bin/env bash
# The server's sign-in tool (docs/mobile/login.md), run as the service user with the service's settings:
#
#   sudo /opt/learnharness/deploy/aws/access.sh set-password          a new password, made up for you and shown once
#   sudo /opt/learnharness/deploy/aws/access.sh set-password --stdin  one you choose (16 characters or more), read from the pipe
#   sudo /opt/learnharness/deploy/aws/access.sh sign-out-all          end every session on every device
#   sudo /opt/learnharness/deploy/aws/access.sh unlock                clear a lockout after too many wrong passwords
#   sudo /opt/learnharness/deploy/aws/access.sh status
#   sudo /opt/learnharness/deploy/aws/access.sh test-email            send the unlock email's test message to the owner
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
cd /opt/learnharness
set -a
# shellcheck source=/dev/null
. /etc/learnharness/service.env
set +a
exec runuser -u learnharness -- env HOME=/var/cache/learnharness npm run access --silent -- "$@"
