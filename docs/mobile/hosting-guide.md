# Setting up LearnHarness on AWS, step by step

2026-11-22 · Thomson Simplify · story 8 of the mobile epic, as built. Why it is built this way, and what each part costs, is in [aws-hosting.md](aws-hosting.md). This page is the how.

> **Nothing here has been run on AWS yet.** The template and scripts were checked with linters and fake folders, not on a real account. The first real run is yours, and the most likely trouble spots are listed under [What was and was not tested](#what-was-and-was-not-tested). The stack is set up so that a failed install keeps the server and its log for you to read.

## What you get

One Ubuntu server in US East (N. Virginia) that runs LearnHarness, with Caddy in front of it for HTTPS at `https://learn.heythomson.com`. The data is on its own encrypted disk with a daily snapshot. Sign-in is the password login from [login.md](login.md), and its unlock email goes out through Amazon SES. One CloudFormation template, `deploy/aws/learnharness.yaml`, creates all of it, including the DNS records for `learn.heythomson.com` inside your existing `heythomson.com` hosted zone. Nothing else in that zone is touched.

## The steps at a glance

1. Collect two things: the hosted zone ID of `heythomson.com`, and the email address for unlock links.
2. Create the stack, then wait.
3. Click the verification link AWS emails you.
4. Open a shell on the server and set the password.
5. Sign in on your phone and add the site to the home screen.
6. Move your desktop data over ([data-migration.md](data-migration.md)).

## Before you start

- The AWS account that holds the `heythomson.com` hosted zone, signed in as someone who may create IAM roles (an administrator is fine). Switch the console to **US East (N. Virginia)**, `us-east-1`.
- The **hosted zone ID**: Route 53, Hosted zones, `heythomson.com`, copy the ID that starts with `Z`.
- The email address for unlock links and budget warnings. Pick one you can open on your phone.
- No existing DNS record named `learn.heythomson.com` (the template creates it, and creating it a second time fails).
- Nothing to install. The server downloads the code from the public GitHub repository, branch `claude/mobile-epic` (use `main` once the mobile work is merged into it).

## 1. Create the stack

In the console:

1. Open [`deploy/aws/learnharness.yaml`](../../deploy/aws/learnharness.yaml) on GitHub and save the raw file.
2. CloudFormation, **Create stack**, *With new resources*, *Upload a template file*, choose the saved file.
3. Stack name `learnharness`. Fill in `HostedZoneId` and `OwnerEmail`. Leave the rest: the defaults are the plan (t3.medium, a 20 GiB system disk and a 20 GiB data disk, `learn.heythomson.com`, a budget alert at US$60 a month).
4. On the options page set **Stack failure options** to *Preserve successfully provisioned resources*. The default deletes everything when the install fails, and with it the log that says why.
5. Tick the box that acknowledges IAM resources, then **Submit**.

The same from a terminal that has the AWS CLI:

```bash
aws cloudformation create-stack --region us-east-1 --stack-name learnharness --capabilities CAPABILITY_IAM \
  --on-failure DO_NOTHING --template-body file://deploy/aws/learnharness.yaml \
  --parameters ParameterKey=HostedZoneId,ParameterValue=<your hosted zone id> ParameterKey=OwnerEmail,ParameterValue=<your email>
```

Expect roughly 15 to 30 minutes **(an estimate, not measured)**: most of it is the server installing Node, Chrome and Caddy and building the app. CloudFormation waits for the server to report that it is done, and gives up after 30 minutes. The stack ends in `CREATE_COMPLETE`, and its **Outputs** tab then lists the site address, a command for a server shell, the migration bucket and the data disk.

What it creates: a small network with only ports 80 and 443 open, the server with a fixed (Elastic) IP, the encrypted data disk and a daily snapshot policy, the DNS records, the SES mail identities, a private bucket for the data migration, a monthly budget alert and an alarm that recovers the server if its host fails.

## 2. Click the verification email

AWS emails the `OwnerEmail` address a link to verify it. **Click it.** A new AWS account sends mail from the SES "sandbox", which delivers only to verified addresses, so until you click, the unlock email cannot reach you. The link lasts 24 hours; to get another, go to Amazon SES, Identities, your address, Resend verification email.

The sender, `no-reply@learn.heythomson.com`, verifies itself through three mail-signing (DKIM) records the stack added to your hosted zone. There is nothing to click for that.

## 3. Check that the site answers

Open `https://learn.heythomson.com`. The certificate can take a minute or two the first time. A plain page that says **"LearnHarness has no password yet, so it only answers on the server itself"** is the success signal: DNS, HTTPS, Caddy and the app all work, and the server refuses everyone until there is a password.

## 4. Set the password

1. Open a shell on the server. Easiest: EC2 console, Instances, `learnharness`, **Connect**, **Session Manager**, **Connect**. (The `OpenAShell` output is the same thing for a terminal, and needs the AWS CLI plus its Session Manager plugin.) There is no SSH and no key.
2. Run:

   ```bash
   sudo /opt/learnharness/deploy/aws/access.sh set-password
   ```

   It prints a long made-up password once. **Put it in your password manager now.** It is not stored and cannot be shown again. To choose your own (16 characters or more): `printf '%s' 'the password' | sudo /opt/learnharness/deploy/aws/access.sh set-password --stdin`.

   The page in step 3 says to run `npm run access -- set-password`. On this server use `access.sh` instead: it runs the same command as the service's user and with the service's settings.
3. Check the unlock email works: `sudo /opt/learnharness/deploy/aws/access.sh test-email`. A test message should arrive within a minute (look in spam). "Could not send" with an identity message means step 2 is not done yet.
4. Reload the site and sign in.

The other commands are `sign-out-all` (end every session), `unlock` (clear a lockout), and `status`. A new password also signs every device out.

## 5. Put it on your phone

- **iPhone:** in Safari, Share, **Add to Home Screen**.
- **Android:** in Chrome, the menu, **Install app** or **Add to Home screen**.

You stay signed in for 30 days, or until 7 days pass without use. Settings has **Sign out** and **Sign out of all devices**. More in [phone-shell.md](phone-shell.md).

## 6. Keys and data

Either bring your desktop data, API keys included, with [data-migration.md](data-migration.md), or start fresh and add your provider keys in Settings, Providers. Models are API keys only.

## The desktop app and your Mac

The simplest way to use the server from the Mac is the site in a browser: in Safari, File, **Add to Dock**; in Chrome, the menu, Cast, save and share, **Install page as app**. That gives it a window of its own with nothing to maintain.

The desktop app also has the Settings, General, **Server** row from story 7 (see [desktop-server.md](desktop-server.md) once it is merged), which makes it open the server instead of running its own. That row exists only in a desktop build made from this fork. The app installed now comes from upstream and updates from there, so how to get a fork build onto the Mac (and keep it from being replaced by an upstream update) is an open question for the owner. It is not needed to use the server.

## Updating

From a server shell:

```bash
sudo /opt/learnharness/deploy/aws/update.sh            # newest commit of the branch it runs; rebuilds and restarts
sudo /opt/learnharness/deploy/aws/update.sh main       # move to another branch (for example once the mobile work is in main)
sudo /opt/learnharness/deploy/aws/update.sh --rebuild  # build again even if nothing new came
```

The site is down for the few minutes the build takes, and your data is not touched. If an update stops part-way (for example the build runs out of memory), the site stays down until you fix the cause and run `update.sh` again. It builds again then, because it skips the build only when the newest commit was built to the end and the site is running. `update.sh` updates the app only. If a new version also changes the server's own setup (the service, the Caddyfile or its settings), run `sudo bash /opt/learnharness/deploy/aws/bootstrap.sh` afterwards: it is safe to repeat and rebuilds the app too.

Ubuntu installs security updates by itself. Some need a restart: about once a month, run `ls /var/run/reboot-required`, and if that file exists, `sudo reboot`. The site is back in about a minute, with the data and sign-ins as they were.

**Do not change settings by updating the stack.** The template is meant to be created once. An update can make CloudFormation try to replace the server (Canonical publishes a new Ubuntu image every few weeks, and the template looks the newest one up each time), and that replacement fails while the data disk is attached. Use the scripts above for code, and for a bigger data disk use the EC2 console (Volumes, Modify volume), then `sudo resize2fs "$(findmnt -no SOURCE /srv/lh)"` on the server.

## Backups and restore

The data disk is snapshotted every day at 20:00 UTC (03:00 in Jakarta) and the last 14 snapshots are kept. Snapshots carry the tag `lh-backup` and the name `learnharness-data`. They are of a running disk, so each is what a power cut would have left; the time is chosen for when you are asleep.

**Get a file or folder back.**

1. EC2 console, Snapshots, pick one, **Actions**, **Create volume from snapshot**. Use the server's Availability Zone (shown on its instance page) and keep it encrypted.
2. Volumes, the new volume, **Actions**, **Attach volume**, the server, device name `/dev/sdg`.
3. In a server shell, with the new volume's id written without the dash (`vol-0abc` becomes `vol0abc`):

   ```bash
   sudo mkdir -p /mnt/restore
   sudo mount -o ro /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0abc /mnt/restore
   sudo ls /mnt/restore/data
   ```

   Copy what you need into `/srv/lh/data/` with `sudo cp -a`, then `sudo chown -R learnharness:learnharness /srv/lh/data`. For more than a single file, run `sudo systemctl stop learnharness` before copying and `sudo systemctl start learnharness` after.
4. `sudo umount /mnt/restore`, then in the console detach and delete the volume.

**Do not restart the server while that extra volume is attached.** It has the same filesystem ID as the real data disk, and the server mounts the data disk by that ID, so it could pick the wrong one.

**Rebuild the whole server from the data disk's snapshot** (the instance is lost, or you want a clean start):

1. Note the newest snapshot of your data disk (EC2, Snapshots). The data disk's id is the `DataVolumeId` output.
2. Empty the migration bucket (see [Taking it down](#taking-it-down)) and delete the stack. Deleting the stack takes one last snapshot of the data disk, and the daily ones stay.
3. Create the stack again exactly as in step 1, with **DataSnapshotId** set to that snapshot's id. The new data disk is made from it, and the install does not format a disk that already holds data. Your data, API keys and password come back with it, so you skip steps 4 and 6. **Do step 2 again:** the new stack makes a new SES identity for your address, and mail to an unverified address does not arrive while the account is in the sandbox.

This path is not rehearsed; it follows how the template is written.

If AWS reports a problem with the server's own host, the alarm in the stack moves the server to healthy hardware on its own.

## What it costs

Rough monthly cost in US$ **(approximate, on-demand prices)**, as in [aws-hosting.md](aws-hosting.md):

| Part | Per month |
| --- | --- |
| t3.medium server | about 30 |
| Two 20 GiB gp3 disks, plus snapshots | about 4 to 5 |
| The fixed IP address | about 3.60 |
| Route 53 records, SES, Session Manager, alarm | about 0.10 |
| **Total** | **about 38 to 40** |

The budget in the stack emails you at 80% of US$60 spent in a month (the whole account counts), and when 100% is forecast. Change the amount with the `MonthlyBudgetUSD` parameter at creation.

## Taking it down

1. S3 console, the migration bucket (the `MigrationBucket` output), **Empty**. CloudFormation cannot delete a bucket that still holds a file.
2. CloudFormation, the stack, **Delete**. The server, fixed IP, disks, DNS records, mail identities and budget go with it.
3. What stays, and costs a little (about US$1 a month): the snapshots of the data disk, including a last one taken at deletion. Delete them in EC2, Snapshots, when you no longer need the data.

## Security notes

- Only ports 80 and 443 are open. There is no SSH. The shell is Session Manager, which uses your AWS sign-in.
- LearnHarness listens on `localhost:3000`, so only Caddy reaches it. With no password set, it refuses every request that did not come from the server itself.
- The server may read its metadata only with a session token (IMDSv2), so a request that merely fetches a page cannot read the server's AWS credentials.
- The server's role may send mail as `no-reply@learn.heythomson.com` and to your address, may read (never write) the migration bucket, and has AWS's standard Session Manager policy (`AmazonSSMManagedInstanceCore`). That policy also lets the server read Parameter Store values in the account. If you keep secrets there for other apps, swap it for the smaller policy AWS documents for Session Manager alone (the `ManagedPolicyArns` entry of `ServerRole` in the template).
- Both disks are encrypted. `auth.json` (your API keys) is plain text inside, as it is on the desktop.
- The agent's file tools can read the data folder, which holds your sessions and uploads, but are blocked from `auth.json` and `access.json` (the password and sign-in state).
- Sign-in locks after 20 wrong passwords in an hour, and the unlock link works once for 15 minutes ([login.md](login.md)).
- Turn on multi-factor sign-in for your AWS root user, if not done.

## Troubleshooting

In a server shell, `journalctl -u learnharness -n 100` is the app's log, `journalctl -u caddy -n 100` is Caddy's, and `/var/log/learnharness-bootstrap.log` is the install.

| What you see | What to try |
| --- | --- |
| The stack ends in `CREATE_FAILED` | Read the **Events** tab, newest first. If the wait step failed, open a server shell and read `/var/log/learnharness-bootstrap.log`. The install can be run again safely with `sudo bash /opt/learnharness/deploy/aws/bootstrap.sh` once the cause is fixed, to see that the site comes up. Then delete the stack and create it again from a fixed branch. |
| The stack fails on the DNS records | A record named `learn.heythomson.com` already exists, or `HostedZoneId` is the wrong zone. |
| The stack fails on the email identity | That address is already a verified SES identity in this region: create it again with `CreateOwnerEmailIdentity` set to `false`. |
| The browser shows a certificate error or no page | Wait two minutes. Then `journalctl -u caddy -n 100`. Let's Encrypt needs port 80 open (it is) and the DNS record pointing at the fixed IP. If `heythomson.com` has CAA records, they must allow `letsencrypt.org`. |
| "has no password yet" | Step 4. |
| "This host name is not allowed" | You opened the server by its IP address or another name. Use the site address. |
| The unlock email does not come | Step 2 (verify your address), then `access.sh test-email` and read what it says. Without email, `access.sh unlock` clears a lockout. |
| The site is down after a restart | `sudo systemctl status learnharness caddy`, then the journals above. |
| An update fails in the build | Read the end of its output. If the build ran out of memory, run `update.sh --rebuild` again; the server has a 2 GiB swap file for this. |
| The disk is full | `df -h /srv/lh`. Make the data disk bigger as described under [Updating](#updating). |
| Deleting the stack fails on the migration bucket | The bucket still holds a file. Empty it ([Taking it down](#taking-it-down), step 1) and delete the stack again. |

## What was and was not tested

Tested, in a sandbox, not on AWS:

- The template passes `cfn-lint`, and `yamllint` with its relaxed rule set and lines of up to 200 characters.
- The scripts (`bootstrap.sh`, `update.sh`, `access.sh`, `import-data.sh`, the two tests, and the start-up script inside the template, rendered with sample values filled in) pass `shellcheck` at its strictest level, with no findings.
- `import-data.sh` was run against fake server folders and zips: a plain zip, a repeat import (the old data is kept aside), a Finder-style zip, refusals, a zip without keys, an `s3://` address read with a stand-in for the `aws` command, a failed download, a zip with a symbolic link in it (refused, and what it pointed at is left alone), the old data kept root-only, a site that does not come back, a second import while one is running (refused), a data disk too small, a copy that fails half-way (the half-made copy is removed), a damaged zip, and files with odd modes (made readable by the service user and nobody else). 52 checks, in `deploy/aws/test-import-data.sh` (run it with `sudo`; it takes a few seconds).
- `update.sh` was run against a local git repository with stand-ins for `runuser`, `systemctl`, `npm` and `curl`: nothing new, a new commit, a build that fails (the site stays down, and the next run builds again), a site started by hand after a failed build, `--rebuild`, moving to another branch, and bad arguments. 17 checks, in `deploy/aws/test-update.sh` (run it with `sudo`).
- The sign-in command, the unlock email and the upload limits are covered by the earlier stories' tests.
- The checksum for the Node 26.13.1 download in `bootstrap.sh` matches the one nodejs.org publishes (checked 2026-11-22), and the AWS CLI download address answers. The sandbox could not reach Google's or Caddy's download hosts, so the Chrome and Caddy addresses are the vendors' own documented ones, unchecked.

**Not tested: anything that needs a real AWS account or a real Ubuntu 24.04 server.** That is the stack itself, the install (`bootstrap.sh`) end to end, the Node 26, Chrome, AWS CLI and Caddy downloads, the disk detection and first format, the certificate, mail through SES, snapshots and the restore steps above, deleting the stack (the data disk is attached through the server's own `Volumes` setting so that deleting the stack terminates the server first and lets go of the disk), and the `update.sh` build on a 4 GiB server. If any of those fails, the install log and journals above say where, and the fix is usually a line in `deploy/aws/bootstrap.sh`.
