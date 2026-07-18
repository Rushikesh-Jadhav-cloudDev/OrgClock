# OrgClock

An automatic timesheet across every site you work in — Salesforce orgs,
JIRA, docs, research, AI tools — built to make filling out a real weekly
timesheet (Replicon, etc.) accurate without reconstructing your day from
memory. Manifest V3, no backend, everything stays in `chrome.storage` on
your machine.

## Install (unpacked)

1. Unzip this folder somewhere permanent — Chrome runs it straight from
   these files.
2. Go to `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked**, select this folder.
4. Pin the extension so its icon stays visible.
5. Click the icon for the menu (see below), or open **Open Dashboard**
   from that menu.

Chrome will show a real "read and change all your data on all websites"
prompt — expected, since tracking is opt-out (every site by default,
exclude what you don't want) rather than opt-in.

## Clicking the icon

The icon now opens a small menu instead of jumping straight to the
dashboard:
- **Log New Task** — retag what new time on the current site counts
  toward, without waiting for a new day (this replaces the old floating
  on-page button).
- **Continue Current Task** — just closes the menu; tracking continues as
  normal.
- **Open Dashboard**
- **Pause Tracking / Resume Tracking** — a manual, global on/off switch,
  independent of idle detection.

## How it works day to day

- Visit any site. The first time you're on a **new domain** with no entry
  for today (after a short, configurable delay — see Performance below),
  a small card appears with:
  - **Project name** — remembered permanently for this domain.
  - **Currently working on** — defaults to the project above, but can
    point at a different project for this specific block of time.
  - **Task** — a short label (e.g. "Validation Rule Fix"). Logging a
    second task under the same project (via the icon's "Log New Task")
    does not create a new project — it's tracked as its own session
    group, visible in the **Session Summary** view as its own row.
  - **Comments** — a fresh note field. Existing notes for that project
    today are shown as read-only reference text above it, not stuffed
    into the editable box (see "Duplicate comments," below).
- **Settings → Excluded sites** opts a site OUT (e.g. Gmail).
- Not now / Escape / click outside skips a prompt for the rest of the
  browsing session, recoverable via **Settings → Dismissed prompts**.
- A same-tab domain change (e.g. Salesforce's Lightning app handing off
  to Setup) waits ~2 seconds and, if it looks like the same underlying
  org, carries the project (and task) over silently.
- Rapid switching between two sites billed to the same project **and
  task** merges into one block (gap configurable in Settings, default
  90s) — matching on task too keeps two different tasks under one
  project from blurring together.
- Idle-pauses billing after 5–10 minutes of no input. A separate, more
  forgiving grace period covers the "Chrome active" stat specifically.

## What changed in this round (root-caused, not guessed)

- **Missed keystrokes in the popup.** The setup card lives in a closed
  Shadow DOM; a host page's own global keyboard shortcuts (Salesforce
  Lightning has several) see events retargeted to the outer container
  rather than the actual input, so a shortcut handler checking "is the
  user typing in a field?" could wrongly say no and swallow the key.
  Every field now calls `stopPropagation()` on keyboard/input events.
- **Website loading impact / Salesforce org load failures.** The content
  script used to do storage reads and DOM work immediately at
  `document_end`. It now waits for `document_idle` *and* an additional
  configurable delay (Settings, default ~2.5s, 0–10s) before touching the
  page at all — this was also the most likely cause of some Salesforce
  pages failing to load, since the page's own bootstrap now gets a clear
  run first.
- **`help.salesforce.com` (and similar) never prompting.** A hardcoded
  exclusion list left over from the old opt-in tracking model was
  silently blocking Salesforce's own help/docs/admin pages from being
  tracked at all. Removed — tracking is opt-out now, so these pages are
  tracked like anything else unless you exclude them.
- **Duplicate comments.** The old "log a task" flow pre-filled the
  comment box with the *entire* joined history for a project, so
  re-saving it unchanged saved a growing blob as a "new" note each time.
  Existing notes are now shown as read-only reference text; the editable
  box only pre-fills when genuinely continuing the same task, and only
  with that task's own last note.
- **Chrome hangs / dashboard loads slowly toward end of day.** The
  Settings panel (including an async dismissed-prompts lookup) was being
  fully rebuilt on *every* storage change, all day, whether or not
  Settings was even open — now it only rebuilds when actually visible.
  Background reconciliation is now debounced against the burst of
  `tabs.onUpdated` events SPAs like Salesforce Lightning fire per
  logical (pushState) navigation, and settings are cached in the service
  worker instead of re-read from storage on every single check.
- **Multiple tasks under one project / session-based tracking.** Sessions
  now carry their own `taskName` alongside `projectId`. A new **Session
  Summary** view groups by (project, task) — e.g. "ATLAS – Validation
  Rule Fix – 1h 45m" as its own row, distinct from other tasks on the
  same project that day.
- **Manual pause/resume**, a global auto-track on/off switch, a
  configurable prompt delay, and user-defined custom categories are all
  new, in Settings and/or the icon menu.

## Dashboard — four views

**Stat cards**: today's/this week's tracked time, Chrome active time,
productive %, projects touched, sessions.

**Day-wise history** — grouped by project. Each card's editor leads with
a single **Comments** box (the thing you actually edit day to day), a
**Sites contributing** list with per-site relink, and a collapsed
**Advanced** section with the raw sessions — each now editable for start/
end/task, plus add/merge/consolidate.

**Timeline** — chronological, color-coded blocks for a day.

**Session summary** — one row per (project, task) for a day, e.g. "ATLAS
– Validation Rule Fix – 1h 45m", click-through to the same editor.

**Timesheet summary** — project rows × day columns of hours + Total,
comment indicator per cell, **Copy for Replicon** (tab-separated, decimal
hours).

**Settings**: idle threshold, merge-gap threshold, screen-time grace,
prompt delay, global tracking on/off, theme, per-project renaming/
category, custom categories, excluded sites, dismissed-prompt recovery,
three CSV export modes (daily summary, full session detail, by-task).

## Data model

```
projects:      { [projectId]: { name, category, hue, createdAt } }
domainMap:     { [domain]: projectId }                        -- permanent home link
taskContext:   { [domain]: { projectId, taskName, comment } }  -- what a NEW session tags as
entries:       { [date]: { [domain]: { sessions: [
                   { id, start, end, projectId, taskName, comment, manual }
                ] } } }
manualAdjustments: { [date]: { [projectId]: ms } }
dayNotes:      { [date]: { [projectId]: text } }     -- the editable "overall comment"
excludedSites: { [domain]: { addedAt } }             -- opt-out list
customCategories: [ "Client Meetings", ... ]
settings:      { idleThresholdMinutes, mergeGapSeconds, screenTimeGraceMinutes,
                 popupDelaySeconds, manuallyPaused, autoTrackEnabled, theme, ... }
archives:      { [weekStart]: { entries, manualAdjustments, dayNotes } }
```

## Architecture

```
manifest.json          MV3 manifest; broad host permissions; default_popup
                        for the icon menu
background.js           Service worker — the only place tracking decisions
                         are made. Owns the settle window (redirect-chain
                         absorption), same-org silent carry-over, screen-
                         time grace period, manual pause / auto-track gate,
                         a settings cache, and debounced SPA-churn handling.
content.js               Injected into every page. Defers all work behind
                          a configurable delay. Owns the setup overlay
                          (task-aware) — no floating on-page button anymore.
                          No ES module imports (unsupported reliably in
                          content scripts) — talks to chrome.storage
                          directly.
lib/
  storage.js              All chrome.storage reads/writes, session merge/
                           consolidation (task-aware), day/task aggregation,
                           custom categories.
  domains.js               URL parsing, same-org label guessing, exclusion
                            check (minimal built-in list + user's own).
  dateUtils.js               Local-time date/week/duration formatting.
  id.js                       Small id generator.
pages/
  dashboard.html/.js/.css      History / Timeline / Session Summary /
                                Timesheet Summary views, settings drawer.
  actionPopup.html/.js/.css     The icon-click menu.
  overlay.css                   Setup card + Shadow DOM styles.
  common.css                    Shared design tokens (light + dark).
icons/                    Generated PNG icons.
```

## A note on how these fixes were verified

Two bugs were caught during this round's own review, not just described:
a genuinely missing closing brace in `storage.js` that the previous
validation method (`node --check`) failed to catch because of how it
handles ES module syntax on a `.js` file with no `package.json` — and an
unstyled CSS class. Both were found by switching to
`node --input-type=module --check < file.js` (parses as an ES module
without executing) plus, where possible, an actual `import()` of the
module. That's now the standard validation method for every file in this
project going forward, not the weaker `node --check file.js` used
previously.

## Permissions, and why

- `storage`, `unlimitedStorage` — all data, kept locally.
- `idle` — pause tracking when you step away.
- `alarms` — the once-a-minute checkpoint/rollover heartbeat.
- `tabs` — know which tab is active and read its URL.
- `downloads` — save CSV exports.
- `scripting` — inject the setup overlay into tabs already open at
  install time.
- `http://*/*`, `https://*/*` — see every site, so a new one can be
  detected and asked about (the one meaningful trade-off in this build:
  broader visibility for zero per-site setup).

## Privacy

No network requests exist anywhere in this codebase — no `fetch`, no
`XMLHttpRequest`, no analytics, no telemetry. Everything is written to
`chrome.storage.local` (or `chrome.storage.session` for same-session
dismissals) and stays on your machine.

## Extensibility (not yet built, architecture anticipates these)

- **Charts by project/task** — `groupDayByProject()` / `groupDayByTask()`
  already produce chart-ready aggregates.
- **Search and filters** — filtering `state.entries` before render.
- **Excel (.xlsx) export** — swap the CSV writer; row shapes are flat.
- **IndexedDB** — not implemented; `chrome.storage.local` with
  `unlimitedStorage` plus weekly archiving already bounds the live
  working set, so this likely isn't needed unless real usage shows
  storage-quota problems. Worth revisiting only if that happens.
- **JIRA/Salesforce sync** — would be the first exception to the "no
  network calls" guarantee above; flag clearly if ever added.
