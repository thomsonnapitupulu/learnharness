# LearnHarness remote login: design

2026-11-22 · Thomson Simplify · revision 4 · part of the [combined plan](combined-plan.md)

Status: plan only. LearnHarness is hosted on AWS: one EC2 server in browser-only mode, behind Caddy for HTTPS ([aws-hosting.md](aws-hosting.md)). The login protects that hosted server, used from the phone and from the desktop app alike.

> Superseded: revision 3's desktop "Phone access" switch (main-process gateway, fixed local port, preload bridge, Settings section) is dropped. Also superseded: "the desktop app is unchanged". The [combined plan](combined-plan.md) step 7 makes the desktop app connect to the hosted server through this same login.

## What is kept from the paused work

The login page, scrypt password hash, signed 30-day session cookie (ending after 7 idle days), HTTPS-only rules, cross-site checks, and login attempt limits with lockout. The paused patch has this logic and its tests, written for the desktop gateway. It will be ported to TypeScript under `src/server/`.

## Proposal for the hosted server

1. **Turning it on.** The login is on whenever a password has been set in the data folder (`LH_DATA_DIR/access.json`). On a server with no password yet, every request except `localhost` is refused, with a message saying how to set one. A fresh EC2 server is never open to the internet.
2. **How traffic arrives.** Caddy on the same instance handles HTTPS and forwards to `next start` on `127.0.0.1:3000`. The public domain goes in `LH_ALLOWED_HOSTS`, as today.
3. **Every request needs a session.** `proxy.ts` widens its matcher from `/api` to every path, except the self-contained `/login` and `/logout` pages, the web-app manifest and icons, and static build files. Routes exempt from the proxy (the streamed document route, the upload route) run the same check inside their handlers. Requests to `localhost` itself (a Session Manager port forward or a health check) are also gated. Only the "no password set" refusal exempts localhost.
4. **HTTPS only.** Requests must name an allowed host and arrive with `X-Forwarded-Proto: https` from Caddy. Anything else is refused. Writes keep the same-origin check, which uses the forwarded protocol.
5. **Login page.** `/login` is a plain, phone-friendly HTML form served by a route handler, with no app shell, so nothing from the chats loads before sign-in. A correct password redirects back to the page requested.
6. **Session cookie.** Named `__Host-lh_session`, set Secure, HttpOnly and SameSite=Strict. It lasts 30 days, and a session idle for 7 days ends. It is signed with a random key stored in `access.json`.
7. **Login attempt limits.** Each client address (from Caddy's `X-Forwarded-For`) gets 5 free wrong tries, then waits longer and longer, up to 15 minutes. 20 failures in an hour lock sign-in. Every failure is logged.
8. **Managing access from the server.** A command-line tool, run from a Session Manager shell: `npm run access -- set-password` (generates a strong password, or takes one of at least 16 characters), `sign-out-all`, `unlock` and `status`.
9. **Inside the app.** Settings → General gets "Sign out", "Sign out of all devices" and "Change password", shown only when the login is on.

## Decisions

1. **Unlocking after a lockout: by an email link.** When sign-in locks, the server emails a one-time unlock link through Amazon SES, sent with the EC2 instance's IAM role, with no keys stored. The locked login page also has a "Send unlock link" button. The link works once and expires after 15 minutes. Opening it shows an "Unlock" button, so a mail scanner that previews the link doesn't unlock by accident. At most one email every 15 minutes and 5 a day. `npm run access -- unlock` stays as a fallback. The recipient is set in the server's environment (`LH_ACCESS_EMAIL`), never in the repository.
2. **Where the password is set: the server command, and also Settings.** The first password comes from the server command. Once signed in, it can be changed in Settings → General; changing it asks for the current password and signs out every other device.
3. **Sign-out buttons: both.** "Sign out" and "Sign out of all devices", shown only when the login is on.

## Files that would change

- `src/server/desktop-access.ts`: session gate in `browserAPIRefusal`, the HTTPS and no-password rules, forwarded protocol in the same-origin check.
- `proxy.ts`: widen the matcher, redirect page requests to `/login`, return 401 JSON for API calls.
- New `src/server/access-session.ts`: password hash, session cookie, limiter, lock state and unlock tokens (ported from the paused patch).
- New `app/login/route.ts`, `app/logout/route.ts`, `app/unlock/route.ts`.
- New `scripts/access.mjs` and an `access` script in `package.json`.
- Settings → General: sign-out and change-password controls.
- Tests for the gate, cookie tampering and expiry, limits and lockout, unlock links, the CLI, and that desktop mode is unaffected.
- README: a "Hosting on a server" section linking [aws-hosting.md](aws-hosting.md).
- Not carried over from the paused patch: `electron/phone-access.cjs`, the `main.cjs` and `preload.cjs` changes, and the desktop Settings section.
