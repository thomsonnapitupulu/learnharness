# LearnHarness on phones: audit and touch layouts

2026-11-22 · Thomson Simplify · part of the [combined plan](combined-plan.md)

> Hosting note: an earlier version described serving the phone from the desktop app's "Phone access" switch. That is superseded; the phone uses the AWS-hosted server ([aws-hosting.md](aws-hosting.md)). The layouts below are unaffected.

## How this was checked

The app (`npm run dev`, v0.7.0 on the fork's main) ran against a scratch copy of the repo's golden test data, with extra copies of sessions cut off while a quiz, an ask-user question and a practice problem were waiting, so every dock could be seen live. Screens were taken with touch emulation at 390×844 (phone portrait), 390×470 (portrait with the keyboard up) and 844×390 (landscape). Screenshots are in [images/](images/).

Caveat: this is emulation in headless Chromium, not a real iPhone or Android device. Native selection menus and the iOS keyboard's exact behaviour are inferred.

## What breaks, worst first

### 1. The sidebar eats the screen (blocker)

On first load the sidebar is open and takes 288px of a 390px screen, leaving the lesson about 100px wide ([sidebar_open.png](images/sidebar_open.png)). The narrow-window auto-close in `components/sidebar.tsx` only runs inside Electron. The sidebar is in-flow, not an overlay, and its controls are 24 to 27px tall.

### 2. Landscape hides the answer controls (blocker)

At 844×390 a pending quiz shows the question and the first option, then cuts off; the thinking field and Submit can't be reached ([landscape_quiz.png](images/landscape_quiz.png)). The dock's height cap ignores the header, the 96px fade band and the stats row.

### 3. Docking the side question crushes the lesson (blocker)

Pinning the side question docks it as a fixed 352px (22rem) panel, leaving the lesson 38px wide ([side_docked.png](images/side_docked.png)). Drag, eight resize handles and pin/unpin make no sense on a phone.

### 4. Answering with the keyboard up (major)

With the keyboard up, a quiz shows about three lines of the question and none of the options ([kbd_quiz.png](images/kbd_quiz.png)); practice cuts the statement after four lines ([kbd_practice.png](images/kbd_practice.png)). Expanded, the quiz dock covers about 80% of the screen ([phone__chat_chat_quizpend_00000001.png](images/phone__chat_chat_quizpend_00000001.png)). Collapsing it by scrolling up works well ([collapsed.png](images/collapsed.png)).

### 5. Enter sends, and phones have no Shift+Enter (major)

The composer, quiz/ask/probe thinking, practice thinking and side questions all send on Enter. Soft keyboards have no Shift+Enter, so multi-line answers are impossible.

### 6. Dictation disappears in portrait (major)

The Dictate control in the stats row shrinks to 2px wide at 390px.

### 7. Hover-only and tiny controls (moderate)

- Copy-code and expand-diagram buttons (`components/md-blocks.tsx`) only appear on hover.
- Side-question button 24×24px, plan chip 21px tall, phase ring 20px, stats pills 25px, Submit 36px; about 44px is recommended.
- Some labels live only in hover tooltips.

### 8. Header and title (moderate)

The 60px header's 30px serif title truncates session names to six or seven characters.

### 9. Text selection → Cite / Ask (needs a real-device check)

The selection toolbar appears for touch selections in emulation ([selection.png](images/selection.png)), but on real phones the system copy/paste menu may overlap it.

### What already works

Transcript reflow, tables scrolling in their own box, 40px+ quiz options, the reveal-a-check flow ([reveal.png](images/reveal.png)), the collapsed dock bar, and the plan popup ([plan.png](images/plan.png)).

## Touch layouts

Phone layout below 768px wide; touch behaviours (Enter, always-visible buttons, larger hit areas) on any coarse-pointer device, tablets included. Desktop and Electron layouts don't change. Opened from the home screen there is no browser bar, so the layout uses `viewport-fit=cover`, `env(safe-area-inset-*)` and `100dvh`.

### A. App shell

- The sidebar becomes an overlay drawer below 768px: closed by default, dimmed backdrop, closes on backdrop tap, swipe left, or picking a session. 44px rows.
- A 48px header with a 20px title. Plan chip and phase ring merge into one 44px button that opens the plan.

### B. Transcript

- Copy and expand buttons always visible on touch (`@media (hover: none)`).
- The side-question button gets a 44px invisible hit area.
- Selection toolbar kept, pending the device check in item 9.

### C. Composer

- On touch keyboards Enter inserts a newline and the send button sends. Hardware keyboards keep Enter to send.
- The mic moves into the composer row next to Attach. Attach opens the system picker and uploads (see the combined plan).
- The stats row condenses to the model pill; tokens and cost move into its menu.

### D. Question dock (quiz, ask, probe, explain, recall): bottom sheet — decided

1. **Answering:** question and options fill the sheet and scroll; the thinking field is a single collapsed row; a full-width 48px Submit at the bottom.
2. **Typing:** tapping the thinking field pins a two-line summary of the question and chosen options above it, and the sheet rides above the keyboard (`visualViewport`), so Submit is never hidden.

The sheet pulls down to the collapsed bar, and its height is capped to the visible screen, which fixes landscape.

### E. Practice dock

Same sheet. The statement shows in full when opened, collapses to two lines plus "Show problem" once typing starts, and the thinking field grows.

### F. Side question: bottom sheet — decided

About 70% height, pull up for full screen, pull down or ✕ to close. The quoted passage sits at the top. No pin, float, drag or resize on phones; the sheet sits above the keyboard.

## Decisions

All four are decided: bottom sheet for the question dock; Enter = newline on touch keyboards; phone layout below 768px with touch behaviours on any coarse pointer; side question as a bottom sheet.

The remaining screens (graph, session list, settings, plugin pages) get their own audit and proposal in step 5 of the [combined plan](combined-plan.md).
