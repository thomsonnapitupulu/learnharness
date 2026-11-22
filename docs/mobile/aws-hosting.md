# LearnHarness on AWS: hosting spec

2026-11-22 · Thomson Simplify · part of the [combined plan](combined-plan.md)

## Summary

Run LearnHarness on one small EC2 instance in US East (N. Virginia), the cheapest region, with the data on its own encrypted EBS volume, Caddy for HTTPS on the owner's domain, and daily snapshots. The phone (home-screen web app) and the desktop app (step 7 of the plan) both use it, so they share one copy of the data. Rough cost is about US$40 a month **(approximate)**. One user only.

## Architecture

```mermaid
flowchart LR
    PHONE[Phone: home-screen web app] -->|HTTPS, your domain| CADDY
    DESKTOP[Desktop app, Server = AWS] -->|HTTPS, your domain| CADDY
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
| Route 53 | DNS for the domain (or an A record at the current DNS host) | 1 hosted zone | ~US$0.50 |
| Data Lifecycle Manager | Daily snapshots of the data disk, kept 14 days | | ~US$1 |
| SES | One-time unlock emails from a verified sender on the domain, DKIM in Route 53; sandbox is enough for one recipient **(guess: true under current SES rules)** | | ~US$0 |
| Systems Manager Session Manager | Shell access with no SSH port open | | Free |
| CloudWatch | Auto-recover alarm on the instance status check | 1 alarm | ~US$0.10 |
| AWS Budgets | Alert before credits run out | 1 budget | Free |
| IAM | Instance role: SSM managed policy, `ses:SendEmail` for the one sender, read on the temporary migration bucket | | Free |
| S3 (temporary) | One-time data migration bucket, deleted afterwards | | ~US$0 |

Region: `us-east-1`. t3.medium is US$0.0416 an hour there against about US$0.053 in Jakarta or Singapore ([CloudPrice](https://cloudprice.net/aws/ec2/instances/t3.medium), [DevZero](https://www.devzero.io/instances/aws/t3.medium), checked 2026-11-22). Pages may load about a quarter second slower from Indonesia; model replies come from US-based providers anyway.

Everything is created by one CloudFormation template in the fork.

Not needed for one user:

- **Load balancer and ACM:** about US$16+ a month only to end HTTPS; Caddy does it with Let's Encrypt.
- **RDS or DynamoDB:** the app stores files, not database rows.
- **Lambda, ECS, App Runner:** no persistent disk; long jobs would stop.
- **Cognito:** the app's own password login is enough for one person.
- **Secrets Manager:** keys stay in `auth.json` on the encrypted data disk, as the app expects.

## Server setup

1. Ubuntu 24.04 LTS with unattended security upgrades.
2. Node.js at the version the repo's CI uses **(guess: Node 22 LTS)**, then `npm ci`, `npm run plugins:setup`, `npm run build` from the fork.
3. Chromium from apt, with `CHROME_PATH` pointing at it, so demo checking works.
4. A `learnharness` system user with home `/srv/lh`, and a systemd service running `npm start` (binds `localhost`), restarting on failure.
5. Environment: `LH_DATA_DIR=/srv/lh/data`, `LH_AUTH_FILE=/srv/lh/auth.json` (both on the data disk), `LH_ALLOWED_HOSTS=<domain>`, `LH_ACCESS_EMAIL=<unlock address>`.
6. Caddy: `<domain> { request_body { max_size 70MB } reverse_proxy 127.0.0.1:3000 }`. It gets and renews the certificate itself.
7. Updates: pull the fork, rebuild, restart. A small script does this, run over Session Manager.

## Security

- **Security group:** inbound 443 and 80 only (80 for certificate checks and the redirect). No port 22.
- **App port:** LearnHarness listens on `localhost:3000` only; only Caddy reaches it.
- **Login:** as in [login.md](login.md). With no password set, the server refuses every non-localhost request.
- **HTTPS behind a proxy:** today's same-origin check builds the expected origin from the request URL, which is `http://` behind Caddy, while the browser sends `https://`. The login work makes it trust Caddy's `X-Forwarded-Proto`, with a test.
- **Disks:** EBS encryption on both volumes. `auth.json` stays plaintext inside, as the app stores it today.
- **File tools:** the agent can read the service user's home folder, which holds only LearnHarness data and uploads.
- **Account:** MFA on the AWS root user, and a budget alert.

## Backups and recovery

- **Backups:** a daily snapshot of the data disk, kept 14 days. The stores are plain files with no transactions, so the snapshot runs at a quiet hour **(guess: 3 AM Jakarta time)**, or the service is stopped for a few seconds first.
- **Recovery:** if the instance fails its status check, the CloudWatch alarm recovers it. To rebuild, re-run the template and attach a disk made from the latest snapshot.
- **Moving the desktop data:** see [combined-plan.md](combined-plan.md#moving-current-data-to-aws).
