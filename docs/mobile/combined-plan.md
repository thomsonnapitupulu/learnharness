# LearnHarness mobile: combined plan

2026-11-22 · Thomson Simplify

## Summary

LearnHarness becomes a home-screen web app on the phone, and the desktop app connects to the same server. Both reach one LearnHarness server on AWS behind a password login, so there is one copy of the data. This plan merges [aws-hosting.md](aws-hosting.md), [login.md](login.md) and [phone-layouts.md](phone-layouts.md) into one build order.

Status: plan only, and nothing is built. The paused login code survives only as a patch outside the repo (`phone-access-wip.patch` in the project files). Building starts once the owner approves this plan and answers the open questions at the end.

## Decisions so far

| Area | Decision | Source |
| --- | --- | --- |
| Approach | Phone uses the browser to reach your own server; agents, keys and data stay on the server | [approach.md](approach.md) |
| Audience | Just the owner, built in the owner's fork | approach.md |
| Hosting | One EC2 t3.medium in us-east-1, encrypted data disk, Elastic IP, Route 53, Caddy for HTTPS, Session Manager instead of SSH, daily snapshots kept 14 days, SES for unlock email, about US$40 a month | [aws-hosting.md](aws-hosting.md) |
| Region | US East (N. Virginia) `us-east-1`, the cheapest: t3.medium US$0.0416/hr vs about US$0.053 in Jakarta or Singapore ([CloudPrice](https://cloudprice.net/aws/ec2/instances/t3.medium), [DevZero](https://www.devzero.io/instances/aws/t3.medium), checked 2026-11-22) | aws-hosting.md |
| AWS setup | A CloudFormation template in the fork | This plan |
| Server mode | Browser-only mode (`npm start`); no desktop "Phone access" switch | aws-hosting.md |
| Desktop app | Gets a "Server" setting and connects to the AWS server (step 7) | This plan |
| Models | API keys only, which move with the data | This plan |
| Login | Password first set by a server command, changeable in Settings; refuses every request until a password exists; HTTPS only | [login.md](login.md) |
| Sessions | 30 days, end after 7 idle days; "Sign out" and "Sign out of all devices" in Settings | login.md |
| Attempt limits | 5 tries per address, then backoff up to 15 min; 20 failures in an hour lock sign-in | login.md |
| Unlock | One-time email link through Amazon SES, sent with the instance role; valid 15 min; at most 1 email per 15 min and 5 a day | login.md |
| Phones | Home-screen web app on iOS and Android, no app store | approach.md |
| Scope | Every screen, including graph, notes import and settings | approach.md |
| Attachments | Uploads from the device, max 64 MiB per file, deleted with their session | This plan |
| Layout switch | Phone layout below 768px; touch behaviours on any touch device, tablets included | [phone-layouts.md](phone-layouts.md) |
| Quizzes and practice | Bottom sheet over the lesson | phone-layouts.md |
| Enter key | On touch keyboards Enter adds a new line and the button sends; hardware keyboards keep Enter to send | phone-layouts.md |
| Side questions | Bottom sheet at about 70% height, pull up or down, no pin, float or resize | phone-layouts.md |

## Where the earlier docs disagreed

| Point | What the docs said | This plan |
| --- | --- | --- |
| Desktop app | login.md: the Electron app stays as it is and doesn't talk to EC2 | Decided: the Electron app connects to the AWS server (step 7). |
| Phone layouts doc | Still describes the desktop app's "Phone access" switch | Out of date on that point only. The layouts don't change. |
| HTTPS behind Caddy | Today's same-origin check builds the expected origin from the request URL (`http://` behind a proxy). login.md requires `X-Forwarded-Proto: https`. | The login work also makes the same-origin check use the forwarded protocol, with a test. |
| Install files before sign-in | Not covered | The login gate lets the web-app manifest and icons through without a session, or "Add to Home Screen" fails on the login page. |
| Remaining phone screens | phone-layouts.md covers lessons and practice only | One more audit of the graph, session list, settings and plugin pages, with its own layout proposal (step 5). |

## Build order

Each step is its own set of commits with tests and phone screenshots. Nothing is pushed or opened as a pull request without asking.

1. **Login on the server.** Apply the saved patch, keep its password, session and attempt-limit logic, and port it into `src/server/`. Revert its `electron/` changes. Add the login page, the whole-site gate (manifest and icons let through), the forwarded-HTTPS fix, the `npm run access` command, the email unlock through SES, and the Settings buttons.
2. **Uploads,** as described below.
3. **Phone shell:** a sidebar drawer, a compact header, safe-area spacing, and the web-app manifest and icons.
4. **Lessons and practice:** bottom sheets for questions, practice and side questions; Enter behaviour; the mic in the composer; touch targets.
5. **Remaining screens audit:** the graph, session list, settings and plugin pages at phone size. Ends in a layout proposal for approval before step 6.
6. **Remaining screens build,** as approved.
7. **Desktop app connects to the server.** Settings gets a "Server" choice: this computer (today's behaviour) or a server address. With an address set, the app skips its own server and opens that address in its window, and you sign in through the same login page. It never sends its desktop secret to the remote server. Desktop-only features that assume a local server switch off in that mode: the folder picker and dropped file paths (uploads take over), the subscription sign-in bridge, and the local demo-check browser (the server checks demos itself). In-app updates keep working **(guess: no change needed there)**.
8. **AWS setup:** the CloudFormation template for the instance, disks, DNS, Caddy, SES, snapshots and alerts in [aws-hosting.md](aws-hosting.md).
9. **Move the data** (below), point the desktop app at the server, and switch over.

Steps 1 to 7 are code and can be tested locally. Steps 8 and 9 need the AWS account. Step 8 can also run early, so the server is ready while the code is built.

## Uploads

Uploads matter on the desktop too, because the agent's file tools read the server's disk, not the user's computer.

1. **Picking.** On touch devices, Attach opens the system picker (camera, photos, files). On a computer, it opens the file dialog and accepts drag and drop. Pasting a path stays possible for files already on the server.
2. **Sending.** Each file goes to a new upload route as soon as it's picked, with a progress bar on its chip. Files over 64 MiB are refused in the browser before sending.
3. **Storing.** Uploads are saved under `<data folder>/uploads/<session id>/`. The message carries that server path, so the agent reads it the same way it reads attached paths today.
4. **Deleting.** Deleting a session also deletes its uploads folder.

Constraints from today's code:

- `proxy.ts` gets a copy of the request body that Next cuts off at 25 MiB (`proxyClientMaxBodySize` in `next.config.ts`). So the upload route must be exempt from the proxy, like the existing streamed document route, and run the login check inside its own handler.
- Caddy needs a request size limit a little above 64 MiB.
- The agent's file tools read only inside the server user's home folder. So the service user's home is `/srv/lh`, which holds the data folder **(guess: simpler than widening the file-access rules)**.

## Moving current data to AWS

The installed desktop app keeps everything in one folder, which the server can read as-is when it runs the same app version or newer.

| Desktop OS | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/LearnHarness/` |
| Windows | `%APPDATA%\LearnHarness\` |
| Linux | `~/.config/LearnHarness/` |

Inside it: `data/` (chats, jobs, graph, settings, prompt overrides, plugin data), `auth.json` (API keys) and any `*-credentials.json` files (subscription sign-ins). `logs/` isn't needed.

1. Quit the desktop app, so nothing writes while copying.
2. Zip `data/` and `auth.json`. Keep the zip as a backup.
3. Copy the zip to a temporary private S3 bucket. The server pulls it with its instance role, and the bucket is deleted right after, so no SSH is opened.
4. On the server: stop the service, unzip into `/srv/lh/`, set the owner to the service user and `auth.json` to mode 600, start the service.
5. Check on the phone: the session list, the graph and one lesson resume as before.
6. Point the desktop app at the server (step 7). Its own local copy is no longer used; there is no sync back.

| Item | After the move |
| --- | --- |
| Chats, plans, graph, settings, prompt overrides, plugins | Work as before |
| API keys in `auth.json` | Work as before |
| Images shown in lessons | Still display; they're saved inside the chats |
| File paths attached in old chats | Point at the old computer, so the agent can't open them on the server. Re-attach as uploads if needed. |

## Still open

- [x] Desktop app: connects to the AWS server.
- [x] Models: API keys only.
- [x] AWS setup: CloudFormation template.
- [x] Region: us-east-1.
- [ ] Domain or subdomain (also the SES sender domain).
- [ ] Unlock email address (set in the server's environment, never in the repo; verified once in SES).
- [ ] Desktop OS, for the exact copy steps.
- [ ] Approval of this plan, so building can start at step 1.
