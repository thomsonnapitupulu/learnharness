# LearnHarness mobile: approach

2026-11-22 · Thomson Simplify · decided; background for the [combined plan](combined-plan.md)

**Decision:** "mobile" means a phone browser, installed to the home screen as a web app, talking to the owner's own LearnHarness server. Agents and storage do not move onto the phone. The server is hosted on AWS ([aws-hosting.md](aws-hosting.md)).

> Superseded detail: the first version of this proposal had the desktop app serve the phone through a "Phone access" switch. AWS hosting replaced that.

## Why

LearnHarness v0.7.0 is a Next.js app inside an Electron shell. The server does all the real work; the browser only renders records it fetches and streams ([architecture.md](../architecture.md)).

| Piece | Where it lives today | Why it matters for mobile |
| --- | --- | --- |
| Agent runs (prober, teacher, practitioner, workers) | Server process, `src/agent/` | Need Node and provider SDKs |
| Chats, jobs, graph, settings | JSON/JSONL files under `LH_DATA_DIR`, sync `fs` calls | "One server owner per data/auth profile"; no cross-process locking |
| API keys | Plaintext `auth.json` | Must never sit where a phone browser can read it |
| UI to server | `POST /api/chat`, `GET /api/chats/:id/stream`, `/api/events` | Already a client/server split that reattaches after disconnects |
| API access control | Packaged app: per-launch secret header. Browser-only mode: host and same-origin checks, no login (`src/server/desktop-access.ts`) | Needs a real login before going on a network |
| Layout | Desktop-first; only 9 lines in `components/` and `app/` use `sm:`/`md:` breakpoints | Needs phone layouts |

## Options compared

| | A: phone client to own server (chosen) | B: everything on the phone |
| --- | --- | --- |
| Code reused | Server unchanged; UI gets phone layouts | UI partly; server rewritten |
| Learning data | One copy | Separate copy, needs sync |
| API keys | Stay on the server | On each phone |
| Long background jobs | Keep running on the server | Paused when the app sleeps |
| Demo checking (headless Chrome), PDF/SVG native rendering | Unchanged | Need replacements (`puppeteer-core`, `@resvg/resvg-js`, Skia PDF path) |
| File tools | Read the server's disk; uploads added | Only files shared into the app |
| Rough size **(guess)** | Weeks | Months, plus ongoing upkeep |

## Desktop-only features

| Feature | Today | With the hosted server |
| --- | --- | --- |
| File-path attachments | Local paths, "not an upload" | Uploads from the device, 64 MiB max, deleted with the session |
| Subscription sign-ins | Electron main / files beside `auth.json`; ChatGPT callback on `127.0.0.1` | Not used: the owner uses API keys only |
| Demo checking | Electron browser service or system Chrome | Chromium on the server; the phone just plays the sandboxed iframe |
| Dictation | Browser → Deepgram with a server-minted token | Should work; check mic permission on iOS Safari |
| In-app updates, folder picker, window guards | Electron only | Not needed on the phone |

## Decisions

Option A; just the owner, in the owner's fork; reachable from anywhere over public HTTPS; uploads from the phone (64 MiB, deleted with the session); every screen in the first release; home-screen web app on iOS and Android, no app store.
