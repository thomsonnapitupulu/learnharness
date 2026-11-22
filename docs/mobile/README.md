# LearnHarness mobile: specs

Status as of 2026-11-22: **being built**, in stories, on the branch `claude/mobile-epic`. Each story has its own pull request; the docs marked "as built" describe what a story actually delivered.

Goal: use LearnHarness from a phone (home-screen web app) and from the desktop app, with one copy of the data, on a single-user LearnHarness server hosted on AWS behind a password login.

| Doc | What it covers | Status |
| --- | --- | --- |
| [combined-plan.md](combined-plan.md) | All decisions, build order, uploads design, data migration, open questions | **Start here.** Current. |
| [aws-hosting.md](aws-hosting.md) | AWS services, sizing, cost, server setup, security, backups | Current, updated to what story 8 built |
| [hosting-guide.md](hosting-guide.md) | Setting up the server step by step with the CloudFormation template in `deploy/aws/`, updating, backups and restore, cost, taking it down, troubleshooting (story 8, as built; not yet run on AWS) | Current |
| [data-migration.md](data-migration.md) | Moving your desktop app's data and API keys onto the server, and rolling back (story 8, as built; not yet run on a real server) | Current |
| [login.md](login.md) | Password login, sessions, attempt limits, email unlock on the hosted server | Current (revision 4) |
| [uploads.md](uploads.md) | Attaching files from a browser: the upload route, limits, storage and clean-up (story 3, as built) | Current |
| [phone-layouts.md](phone-layouts.md) | Phone-width audit of lessons and practice, and the proposed touch layouts | Current for layouts; its hosting notes are superseded |
| [phone-shell.md](phone-shell.md) | The drawer sidebar, the phone header, safe areas, and the home-screen app: manifest and icons (story 4, as built) | Current |
| [touch-input.md](touch-input.md) | Enter as a new line on touch keyboards, 44px tap targets, buttons without hover, the microphone in the composer row (story 5a, as built) | Current |
| [bottom-sheets.md](bottom-sheets.md) | The answer docks and the side question on a phone: a screen that follows the on-screen keyboard, full-width Submit and a microphone, the side question as a bottom sheet (story 5b, as built) | Current |
| [other-screens.md](other-screens.md) | Settings as a full-screen window, a ⋯ button on rows, Delete on the graph's node card, the chains table at 320 wide, and the other fixes the phone audit found (story 6, as built) | Current |
| [desktop-server.md](desktop-server.md) | The desktop app's Server setting: open the hosted server in the desktop window, what switches off, what happens if the server is down (story 7, as built) | Current |
| [approach.md](approach.md) | Why "phone client to your own server" rather than everything on the phone | Decided; background only |

Screenshots from the phone audit are in [images/](images/).

Superseded along the way (kept out of these docs except as notes): the desktop app's "Phone access" switch, hosting from the desktop app over a tunnel, and the Jakarta region.
