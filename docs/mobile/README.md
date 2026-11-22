# LearnHarness mobile: specs

Status as of 2026-11-22: **plan only, awaiting approval.** Nothing here is built. Per [AGENTS.md](../../AGENTS.md), building starts only after the owner approves the combined plan.

Goal: use LearnHarness from a phone (home-screen web app) and from the desktop app, with one copy of the data, on a single-user LearnHarness server hosted on AWS behind a password login.

| Doc | What it covers | Status |
| --- | --- | --- |
| [combined-plan.md](combined-plan.md) | All decisions, build order, uploads design, data migration, open questions | **Start here.** Current. |
| [aws-hosting.md](aws-hosting.md) | AWS services, sizing, cost, server setup, security, backups | Current |
| [login.md](login.md) | Password login, sessions, attempt limits, email unlock on the hosted server | Current (revision 4) |
| [phone-layouts.md](phone-layouts.md) | Phone-width audit of lessons and practice, and the proposed touch layouts | Current for layouts; its hosting notes are superseded |
| [approach.md](approach.md) | Why "phone client to your own server" rather than everything on the phone | Decided; background only |

Screenshots from the phone audit are in [images/](images/).

Superseded along the way (kept out of these docs except as notes): the desktop app's "Phone access" switch, hosting from the desktop app over a tunnel, and the Jakarta region.
