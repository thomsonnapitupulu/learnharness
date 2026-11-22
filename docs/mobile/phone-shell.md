# LearnHarness on a phone: the shell and the home-screen app (as built)

2026-11-22 · Thomson Simplify · story 4 of the [combined plan](combined-plan.md) · design in [phone-layouts.md](phone-layouts.md) (section A)

This story makes the app usable as a whole on a phone-sized screen and installable from the home screen. It does not change what any screen shows: the question and practice docks, the composer and the touch keyboard are story 5, and the graph, session list, settings and plugin pages are audited in story 6.

## What changed on a phone (below 768px wide)

- **The sidebar is a drawer.** It is closed on every load and opens from the menu button at the top left of each page. It slides over the page, which is dimmed behind it. It closes on a tap on the dimmed page, a swipe left, picking a session, going to any other page, or opening Settings. It is 20rem wide, or 85% of a narrow screen. While it is closed it is `inert`, so nothing in it can take focus or be read out. Opening it on a phone is never saved: the desktop's open or closed choice (`lh:sidebar-open`) is left alone, and a window that crosses the 768px line comes back as the desktop had it.
- **The header is 48px with a 20px title** (was 60px and 30px, which cut session names to six or seven letters). The plan chip becomes a 44px icon button (the word "Plan" is still its accessible name), the phase label is hidden, and the menu button is 44px.
- **The menu button is reachable on every page.** The knowledge graph's top-right controls (search, Chains, Extract files, settings) used to run across the whole width and cover it. On a phone the row now starts to the right of the menu button, the search takes the space that is left, and Chains and Extract files show only their icons (their names stay for screen readers and tooltips).
- **Session and folder rows in the drawer are at least 44px tall,** including the compact list setting.
- **Safe areas.** The page asks for the whole screen (`viewport-fit=cover`) and pads itself with `env(safe-area-inset-*)`, so nothing sits under the notch, the rounded corners or the home indicator when it is opened from the home screen. The height is `100dvh`, so the browser's own bar does not push the composer off screen. In a normal browser tab all the insets are zero.

A computer-sized window is unchanged, and so is the desktop app. A phone held sideways (844px wide) is over the line and gets the computer layout with the sidebar beside the page; see the open points below.

The line is one number in two places: the CSS `max-md:` variants (768px) and `PHONE_QUERY` in `components/sidebar.tsx` (`(max-width: 767px)`).

## The home-screen app

- `app/manifest.ts` serves `/manifest.webmanifest`: name and short name "LearnHarness", `display: standalone`, start at `/`, dark colours (`#141414`), and three icons.
- `public/icons/`: `icon-192.png` and `icon-512.png` (rounded, transparent corners), `icon-maskable-512.png` (full bleed, the mark inside the safe zone, for Android's shaped icons) and `apple-touch-icon.png` (180px, opaque, for iOS). All four are made from `build/icon.png`.
- `app/layout.tsx` links the manifest and icons, sets the home-screen title, `viewport-fit=cover`, and a `theme-color` taken from the theme's own background, so the browser's bar matches the page. The iOS status bar keeps the system style (`default`), which stays readable on any theme.
- **Public files.** A browser asks for the manifest without cookies, and a phone fetches the home-screen icon outside the page, so the sign-in gate lets exactly these five paths through without a session (`PUBLIC_FILES` in `src/server/access-gate.ts`). The host and HTTPS rules still apply to them, and nothing else under `/icons/` is open. The sign-in page links the same files, and its content security policy allows its own images and manifest (and nothing else new).
- No service worker. The app needs the server for everything, so there is nothing to cache for offline use, and a service worker would add a way to serve a stale page. Chrome on Android has not needed one for its install prompt since 2023; that is still to be seen on a real phone (open points below).

## Trying it

On a computer, with no setup:

1. `npm run dev` and open <http://localhost:3000>. This machine needs no password.
2. In Chrome: open DevTools, turn on the device toolbar (Cmd-Shift-M on macOS, Ctrl-Shift-M elsewhere) and pick a phone, or set the size to 390 by 844 with touch on. Reload, so the page reads the touch and size settings.
3. Look at the graph home, a new session, a session, and Settings. Tap the menu button, then each way of closing the drawer. Widen the window past 768px and the sidebar goes back beside the page.

On a real phone you need the HTTPS address, so this waits for the hosting story (8). The server refuses plain http and any host name that is not in `LH_ALLOWED_HOSTS`, by design. Then: open the address in Safari (iOS) or Chrome (Android), sign in, and use Share, then Add to Home Screen (iOS) or the menu, then Install app (Android). Launched from the new icon, the app opens without the browser's bars.

## Checked

See the story's pull request for the exact runs. In short: the new tests, 42 checks against a real production server (the manifest and icons without a cookie, everything else still refused, the sign-in page's links and policy, the app's tags), and phone-sized touch emulation in Chromium (taps, a swipe, measurements of the header, the buttons and the page width, screenshots in [screens/](screens/)).

Not checked: a real iPhone or Android phone. That means the notch and home-indicator padding, "Add to Home Screen", how the icons render, the status bar, and whether Android offers to install.

## Open points

- **A phone held sideways** is 844px wide, over the 768px line, so it gets the computer layout: the 288px sidebar stays beside a 556px page. A drawer there too is possible, but it needs a height condition in `PHONE_QUERY` and a matching custom Tailwind variant for the CSS side, so it is left for the owner to ask for.
- **Colours.** The manifest's colours are fixed at the dark default, so a light theme shows a dark splash while the app launches from the home screen. The page's own `theme-color` follows the theme, but is read when the page loads, so a theme change shows in the browser bar after the next reload.
- **The graph's folder filter** sits in the header beside the menu button on the graph page. With folders it will compete with the search row for the 390px; that screen is story 6's audit.
