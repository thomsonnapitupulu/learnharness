# LearnHarness on a phone: Settings, the row menus, the graph and the chains table (as built)

2026-11-22 · Thomson Simplify · story 6 of the [combined plan](combined-plan.md) · builds on [phone-shell.md](phone-shell.md), [touch-input.md](touch-input.md) and [bottom-sheets.md](bottom-sheets.md)

This story goes over the pages that stories 4 and 5 did not touch, and does the least that makes each of them usable with a finger: what a mouse reaches with a right click gets a visible button, the Settings window fits the screen, and the controls that were too small or off the screen are fixed. It adds no new screens and moves nothing on a computer.

## What the audit found

Every page at 390 by 844, 360 by 640 and 320 by 568, with touch: the graph, a new teaching and a new practice session, a teaching session, a waiting quiz, a waiting practice problem, the Flashcards library, Settings (all eight sections; the first audit, on a development server with plugins built, also covered the four plugin pages), the delete dialogs and the graph's pop-ups. Two things to know about the method:

- A mobile browser **widens the layout viewport** when something does not fit (`window.innerWidth` becomes 392 on a 360px phone, and the page shows zoomed out). So "nothing scrolls sideways" has to be measured against the phone's real width, not against `innerWidth`; the audit's first pass measured against `innerWidth` and missed the chains table below.
- Everything was fine except what is listed here. The Flashcards library's table is 651px wide and scrolls sideways inside its own box; the page does not move. The plugin editors (coding questions, drawing pad) need a model to open and were not audited.

## What changed

- **Settings is a full-screen window on a phone** (`components/settings/settings-dialog.tsx`). It covers what the screen shows (above the keyboard, with the same `--lh-vv-top` and `--lh-vvh` variables as the shell), with the notch and home-indicator insets as padding (the bottom one drops while the keyboard is up). The eight section buttons and the plugin pages become a **row along the top** that scrolls sideways, 44px tall; the close button is 44px; the dividers between the groups go. In Appearance the theme cards are two across (`theme-cards.tsx`) and the two-column grid is one column (`appearance-section.tsx`). Before, it was a 920px window squeezed to 90% of the screen with a 192px column of sections beside a page 150px wide.
- **A "⋯" button on every session and folder row in the sidebar, on a touch screen** (`components/row-menu-button.tsx`). Rename, Export as Markdown and Delete (and a folder's New subfolder) were reachable only with a right click, which iOS Safari does not send for a touch-and-hold. The button sits over the right end of the row (the row keeps 48px free for it), opens the same menu anchored to itself, and a second tap closes it. It is not there while a row is being renamed, and not at all with a mouse. The menu items, and the Extract button in the session menu, are 44px tall on a touch screen.
- **Delete on the graph's node card, on a touch screen** (`components/graph-view.tsx`). A node could only be deleted with a right click on the canvas. The card that opens when you tap a node now ends in a 44px "Delete node…" button that opens the same confirm dialog.
- **The chains table fits a phone** (`components/chain-table.tsx`). Its top bar was a fixed 392px wide: at 390 the close button was clipped by 2px, and at 360 and 320 it was **off the screen** (and the whole page widened). Now the counts ("204 chains · 278 nodes") are hidden on a phone, the search field takes the room that is left (152px at 320), and the close and add-folder buttons have a 44px touch area. The selection bar's Clear, Done and Delete buttons do too.
- **Finger-sized controls elsewhere**: the graph's Chains and Extract files buttons; the Cancel and Delete buttons of the delete dialogs for a session, a folder and a node; the rows of the searchable dropdowns (providers, models, thinking levels, dictation language: 27px, now 44px on a touch screen); and the two sign-out buttons in Settings.

Nothing changes at 768px or wider with a mouse, or in the desktop app: the "⋯" button and the bigger rows and areas are keyed to `pointer-coarse:` (a finger is the main pointer), so a narrow window with a mouse does not get them; the Settings window and the chains table's bar are keyed to the `phone:` variant (under 768px, not the desktop app), as in story 4.

## Where the code is

- `components/row-menu-button.tsx` (new), used by `components/sidebar.tsx` (session rows, the menu items) and `components/sidebar-folders.tsx` (folder rows: optional `onMenuButton` and `menuOpen`).
- `components/settings/settings-dialog.tsx`, `theme-cards.tsx`, `appearance-section.tsx`, `model-menu.tsx`, `search-menu-list.tsx`, `access-settings.tsx`.
- `components/graph-view.tsx` (node card Delete, Chains button), `components/notes-import.tsx` (Extract files button), `components/chain-table.tsx`, `components/extraction-coverage.tsx` (Extract button), `components/delete-node-dialog.tsx`, `components/delete-session-dialog.tsx`.
- `tests/touch-menus.test.tsx` (new, 19 tests), plus one each in `tests/render-chain-table.test.tsx` and `tests/settings-dialog-interaction.test.tsx`.

## Trying it

On a computer, as in [phone-shell.md](phone-shell.md): check out the branch, `npm run dev`, DevTools' device toolbar at 390 by 844 **with touch on** (touch is what turns on the "⋯" button and the bigger areas), reload.

1. Open the drawer. Every session has a **⋯** at its right end. Tap it: the menu opens under it with Rename, Export as Markdown and Delete, 44px tall. Tap it again: it closes. Rename turns the row into a text field. Add a folder (the folder icon by the search field): its row has a ⋯ too, with Rename, New subfolder and Delete.
2. On the graph (home), tap a node (zoom in with a pinch first): its card ends in **Delete node…**. Tap it: the confirm dialog opens; Cancel closes it.
3. Tap **Chains** (top right): the table opens and its ✕ is in view. Make the window 320 wide and reload: still in view. Tick a row's checkbox: the bar with Clear and Delete floats at the bottom.
4. Open Settings from the drawer: it fills the screen. Swipe the row of sections sideways; open **Providers** and tap "Add a provider": a list of providers with 44px rows. Tap a provider and a key field opens.
5. Turn touch off (or widen the window): the ⋯ buttons are gone, right-click works as before, Settings is the 920px window, and the chains table's bar is as it was.

![The drawer with a ⋯ on each row](screens/s6-sidebar-dots-phone.png)
![A session's menu opened from its ⋯: 44px items](screens/s6-sidebar-menu-phone.png)
![A folder's menu](screens/s6-folder-menu-phone.png)
![A node's card with Delete node…](screens/s6-node-card-phone.png)
![The chains table at 320 wide: search, add folder and close all fit](screens/s6-chains-320-phone.png)
![Settings on a phone: the sections as a row](screens/s6-settings-phone.png)
![Appearance: the theme cards two across](screens/s6-settings-appearance-phone.png)
![The provider list, 44px rows](screens/s6-settings-add-provider-phone.png)
![Settings with a keyboard up: the window is the visible part, the key field above the keyboard](screens/s6-settings-keyboard-phone.png)

## Checked

- **Tests**: 21 new ones (19 in `tests/touch-menus.test.tsx`, one each for the chains table and the Settings window). They check classes and wiring, since the test DOM has no layout. The whole suite (5,816 tests) passes except six that already fail on the epic in this sandbox (Node 22): one in `passive-tooltip`, one in `plugin-document-proxy`, three in `safe-fetch` and `safe-fetch-connector`, one in `subscription-auth`; none is in a file this story touches. `tsc` and `eslint` are clean.
- **A production build, in a browser**, signed in through the login page, at 390 by 844, 360 by 640 and 320 by 568 with touch on: the graph, a new teaching and a new practice session, a teaching session, a waiting quiz, a waiting practice problem and the Flashcards library fit the real device width with nothing past the screen edge (7 pages at 3 sizes); the ⋯ button opens and closes each menu and every item has a 44px area; the node card's Delete opens the dialog and Cancel closes it without deleting; the chains table's bar fits at 320; Settings fills the screen, its eight sections open and fit, and with the keyboard stand-in up the window is the visible part and the focused field is above the keyboard; no page error in the console.
- **On a computer (a mouse, 1280 by 800 and 1024 by 768)**: no ⋯ button on any row and right-click opens the old menu, the node card's Delete button is there but hidden, Settings is still the 920 by 620 centered window with its 192px column of sections, and the chains table's bar is as before.
- **On the graph with touch**: one finger pans it, two fingers pinch-zoom it, and tapping a node opens its card. A drag that starts on a node **pans the graph** (it moved by the distance dragged); moving a single node by dragging it is mouse-only, as before.

Not checked: a real iPhone or Android phone (the on-screen keyboard is a stand-in for `window.visualViewport`, as in story 5b; the notch and home-indicator insets are Chromium's emulation of them), a real touch-and-hold on a row, the settings pages of individual plugins in the production-build runs (that build had no plugins built, so Settings showed only the eight sections), and the plugin editors (coding questions, drawing pad), which need a model to open.

## Open points

- **Moving a session or folder into another folder is drag and drop only**, so it cannot be done on a phone (renaming, deleting and creating folders can). A "Move to…" item in the same menu would fix it; say if you want it.
- **The chains table's checkboxes and expanders are 14px** (they are one shared component, with an alignment that depends on the size). Rows are 33px tall and it works with some care; a bigger hit area needs a change to that component.
- **Settings' Keyboard section** lists computer shortcuts and means nothing on a phone, and the Agent section's rows are a little cramped at 320 wide.
- **Moving a single node on the graph** is mouse-only: with a finger, a drag that starts on a node pans the graph instead. Panning, pinching and tapping a node work. Say if repositioning nodes on a phone matters.
