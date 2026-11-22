# LearnHarness on AWS: hosting spec

2026-11-22 · Thomson Simplify · part of the [combined plan](combined-plan.md)

**As built (story 8):** the template and scripts are in `deploy/aws/`. Setting it up is in [hosting-guide.md](hosting-guide.md) and moving your data in [data-migration.md](data-migration.md). Where the build differs from the first plan, this page now says what was built. Nothing has been run on AWS yet.

## Summary

Run LearnHarness on one small EC2 instance in US East (N. Virginia), the cheapest region, with the data on its own encrypted EBS volume, Caddy for HTTPS on the owner's domain, and daily snapshots. The phone (home-screen web app) and the desktop app (step 7 of the plan) both use it, so they share one copy of the data. Rough cost is about US$40 a month **(approximate)**. One user only.

## Architecture

```mermaid
flowchart LR
    PHONE[Phone: home-screen web app] -->|HTTPS, learn.heythomson.com| CADDY
    DESKTOP[Desktop app, Server = AWS] -->|HTTPS, learn.heythomson.com| CADDY
    subgraph AWS us-east-1
      subgraph EC2 t3.medium, ports 80 and 443 only
        CADDY[Caddy: TLS, Let's Encrypt] --> LH[LearnHarness on localhost:3000<br/>password login, agents, jobs, Chromium]
      end
      LH --> DISK[(Data disk, EBS gp3 encrypted)]
      DISK --> SNAP[Daily snapshots, 14 days]
      SSM[Session Manager: admin shell, no SSH] --> LH
      LH --> SES[SES: unlock emails]
    end
```

Only Caddy faces the internet. Outbound, the server calls model providers, search and Deepgram as the desktop app does today.

## AWS services

One user and a single-process server that keeps JSON files on local disk means one always-on VM with a persistent disk. Serverless and container services don't fit: no persistent local filesystem, and long agent jobs and event streams would be cut off.

| Service | What for | Size | Rough cost per month (approximate, on-demand) |
| --- | --- | --- | --- |
| EC2 | Runs LearnHarness, Caddy, Chromium | t3.medium (2 vCPU, 4 GiB), Ubuntu 24.04 LTS, x86 | ~US$30 |
| EBS gp3, encrypted | Root disk, plus a separate data disk for `LH_DATA_DIR` and `auth.json` | 20 GiB root + 20 GiB data | ~US$4 |
| Elastic IP | Fixed public address for DNS | 1 public IPv4 | ~US$3.60 |
| DNS | `learn.heythomson.com`: an A record to the Elastic IP plus 3 SES DKIM CNAMEs. Created by the template in the existing `heythomson.com` Route 53 hosted zone (same account). Nothing else on `heythomson.com` changes. | 4 records | ~US$0 |
| Data Lifecycle Manager | Daily snapshots of the data disk, kept 14 days | | ~US$1 |
| SES | One-time unlock emails from `no-reply@learn.heythomson.com` (the subdomain is the verified identity, so the main domain's email setup is untouched) to the owner's verified address; sandbox is enough for one recipient **(guess: true under current SES rules)** | | ~US$0 |
| Systems Manager Session Manager | Shell access with no SSH port open | | Free |
| CloudWatch | Auto-recover alarm on the instance status check | 1 alarm | ~US$0.10 |
| AWS Budgets | Alert before credits run out | 1 budget | Free |
| IAM | Instance role: AWS's managed Session Manager policy (which also lets the server read Parameter Store values in the account), `ses:SendEmail` for the sender and the owner's address, read on the migration bucket | | Free |
| S3 | A private bucket made by the stack for the one-time data upload. Files in it expire after 7 days, and the bucket goes with the stack (empty it first) | | ~US$0 |

Region: `us-east-1`. t3.medium is US$0.0416 an hour there against about US$0.053 in Jakarta or Singapore ([CloudPrice](https://cloudprice.net/aws/ec2/instances/t3.medium), [DevZero](https://www.devzero.io/instances/aws/t3.medium), checked 2026-11-22). Pages may load about a quarter second slower from Indonesia; model replies come from US-based providers anyway.

Everything is created by one CloudFormation template in the fork.

Not needed for one user:

- **Load balancer and ACM:** about US$16+ a month only to end HTTPS; Caddy does it with Let's Encrypt.
- **RDS or DynamoDB:** the app stores files, not database rows.
- **Lambda, ECS, App Runner:** no persistent disk; long jobs would stop.
- **Cognito:** the app's own password login is enough for one person.
- **Secrets Manager:** keys stay in `auth.json` on the encrypted data disk, as the app expects.

## Server setup

The template's first-boot script fetches the repository and runs `deploy/aws/bootstrap.sh`, which does the following (running it again is safe):

1. Ubuntu 24.04 LTS (Canonical's newest image) with unattended security upgrades, and a 2 GiB swap file so the build has room.
2. Node.js 26, which the repo's CI uses, unpacked from nodejs.org's tarball and checked against its published SHA-256. Then, as the service user, `npm ci`, `npm run plugins:setup` and `npm run build` from the fork.
3. Google Chrome stable from Google's package, with `CHROME_PATH=/usr/bin/google-chrome-stable`, so demo checking works. Ubuntu's own `chromium` package is a snap, which does not run for a service.
4. The AWS CLI v2, which sends the unlock email through SES with the instance's role.
5. A `learnharness` system user with home `/srv/lh`, which is the data disk's mount point, and a systemd service running `npm start` (binds `localhost`) that restarts on failure.
6. The service's settings, in `/etc/learnharness/service.env`: `LH_DATA_DIR=/srv/lh/data`, `LH_AUTH_FILE=/srv/lh/auth.json` (so `access.json` sits beside it), `LH_ALLOWED_HOSTS=learn.heythomson.com`, `LH_ACCESS_EMAIL=<unlock address>`, `AWS_REGION` and `CHROME_PATH`.
7. Caddy from its own apt repository: `learn.heythomson.com { request_body { max_size 70MB } reverse_proxy localhost:3000 }`. It gets and renews the certificate itself.
8. Updates and the sign-in tool are small scripts in `deploy/aws/` (`update.sh`, `access.sh`), run over Session Manager.

## Security

- **Security group:** inbound 443 and 80 only (80 for certificate checks and the redirect). No port 22.
- **App port:** LearnHarness listens on `localhost:3000` only; only Caddy reaches it.
- **Login:** as in [login.md](login.md). With no password set, the server refuses every non-localhost request.
- **HTTPS behind a proxy:** today's same-origin check builds the expected origin from the request URL, which is `http://` behind Caddy, while the browser sends `https://`. The login work makes it trust Caddy's `X-Forwarded-Proto`, with a test.
- **Disks:** EBS encryption on both volumes. `auth.json` stays plaintext inside, as the app stores it today.
- **File tools:** the agent can read the service user's home folder, which holds only LearnHarness data and uploads. Its file tools refuse `auth.json` and `access.json` (API keys, password and sign-in state).
- **Account:** MFA on the AWS root user, and a budget alert.

## Backups and recovery

- **Backups:** a daily snapshot of the data disk at 20:00 UTC (03:00 in Jakarta, a quiet hour), kept 14 days. A snapshot of a running disk holds what a power cut would have left; the service is not stopped for it.
- **Recovery:** if AWS reports a problem with the server's host, the CloudWatch alarm moves it to healthy hardware. To rebuild, delete the stack and create it again with `DataSnapshotId` set to a snapshot of the data disk; the new disk is made from it. Steps in [hosting-guide.md](hosting-guide.md#backups-and-restore).
- **Moving the desktop data:** [data-migration.md](data-migration.md).
- **Stack updates:** the template is meant to be created once. The Ubuntu image is looked up again on every stack update, and a newer image makes CloudFormation try to replace the server, which fails while the data disk is attached. Code updates use `update.sh` instead.
