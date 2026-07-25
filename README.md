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

The icon opens a small menu instead of jumping straight to the dashboard:
- **Add Note** — add a comment and/or change which project new time on
  the current site counts toward, without waiting for a new day (this
  replaces the old floating on-page button).
- **Continue Tracking** — just closes the menu; tracking continues as
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
  - **So far today** — the complete, read-only comment history for that
    project today, in order, each with a timestamp.
  - **Comments** — always starts blank. Anything you type here gets
    saved instantly as its own timestamped note the moment you hit Save
    — it's never a "current" value that persists forward and could get
    silently overwritten by a later edit.
- **Settings → Excluded sites** opts a site OUT of the daily prompt (e.g.
  Gmail). **Settings → Always show popup** does the opposite — asks
  every single visit, useful for meeting tools where each visit is a
  different call.
- Not now / Escape / click outside skips a prompt for the rest of the
  browsing session, recoverable via **Settings → Dismissed prompts**.
- A same-tab domain change (e.g. Salesforce's Lightning app handing off
  to Setup) waits ~2 seconds and, if it looks like the same underlying
  org, carries the project over silently.
- Quick switches between sites billed to the same project — including a
  stray half-second click — merge into one block (gap configurable in
  Settings, default 90s).
- Idle-pauses billing after 5–10 minutes of no input. A separate, more
  forgiving grace period covers the "Chrome active" stat specifically.

## What changed in v6.0.2 (hotfix, from real usage on real data)

- **Comments box was completely uneditable.** v6.0.1's move to light DOM
  fixed one keyboard-stealing bug but exposed a worse one: the v5.1.1
  capture-phase guard on `document` (added to fight Salesforce's own
  shortcut handling) called `stopImmediatePropagation()` for any keydown/
  keyup/keypress whose target was inside the overlay. In the old closed
  Shadow DOM, `e.target` for an outside listener was always retargeted to
  the shadow host, so this rarely fired on the actual field. In light DOM,
  `e.target` correctly resolves to the real input for every keystroke —
  including completely normal typing — so the guard started blocking our
  own fields from ever receiving a character. Removed entirely; the
  field-level BUBBLE-phase guard (`guardKeyEvents`, safe by construction
  since it only runs after the browser's own typing already happened)
  plus the light-DOM fix to `document.activeElement` are doing the actual
  protective work now.
- **Old data could show the same line repeated dozens of times in one
  comment.** Confirmed directly in an exported CSV — one cell had the
  same sentence 19 times over. That's pre-v6 architecture: comments used
  to concatenate with `\n` on every same-task session merge, so an
  extended stretch on one ongoing task could pile up the identical line
  again and again. New data can't do this (every note is its own
  standalone entry), but old data doesn't retroactively fix itself —
  `groupDayByProject()` and `getDayCommentLog()` now both collapse
  duplicate lines within a comment before displaying or exporting it.
- **Notes tab gets a Copy button.** Copies the whole day's comment
  history in one click, grouped by project — for pasting into Replicon
  without opening each project's card individually.

## What changed in v6.0.1

- **Comments could silently go missing.** Editing the dashboard's old
  "overall notes" box even once made it the PERMANENT source of truth
  for display — any comment added afterward through the in-page popup
  never showed up again, because the display logic was `note ||
  sessionComments.join()`, and `note` always won once it existed. Fixed
  by removing that competing field entirely: every comment is now an
  independent, immediately-saved, timestamped entry (`addQuickNote()`),
  so there's no longer a separate field that can fall out of sync or
  block anything. The dashboard's project modal now shows the complete,
  always-current comment history directly, with an "Add a note" box
  that's always blank (existing dashboard-added notes were migrated
  into this history automatically, not lost).
- **Task field removed.** Based on feedback that it added complexity
  without enough value — Comments alone now carries what Task + Comments
  used to. The in-page popup's Comments box always starts blank; the
  full running history is what makes that safe to do without losing
  anything. `taskContext` now only tracks which project new time bills
  to, never a comment — which also means the mid-session retroactive-
  relabeling class of bug (from v5.1.1) can't recur, since there's no
  longer a persistent comment value to go stale.
- **"Session Summary" → "Notes."** Since there's no task to group by
  anymore, this view is now a straightforward chronological list of
  every comment logged for the day, across all projects.
- **New icon** — simplified to a plain clock mark (no cloud), meant to
  read cleanly at 16px.
- **Settings wording simplified** throughout — shorter labels, plainer
  hints, and the noise-threshold slider was removed entirely (its
  behavior folded into the single merge-gap setting, since without Task
  there's no longer a reason for two separate merge tiers).

## What changed in v5.1.2

- **Full backup / restore** (Settings → Backup). Downloads a complete JSON
  snapshot of everything OrgClock stores — projects, sessions, settings,
  categories, domain links, all of it — and can restore it back. Mainly
  for one specific gap: `chrome.storage.local` is scoped per extension
  ID, and for an unpacked dev install that ID is derived from the folder
  path Chrome loaded it from. Load a new release from a different folder
  (which is exactly what happens re-downloading a new zip each version)
  and Chrome treats it as a different extension — nothing was deleted,
  but the old data is invisible under the old extension's storage until
  you export/import across the switch. (The other, zero-steps-needed
  option: keep overwriting files in the SAME unpacked folder each
  release and just hit reload in `chrome://extensions` — same extension
  ID, storage carries over automatically, no export/import needed.)

## What changed in v5.1.1 (hotfix, from live screenshots)

- **Mid-session task switches were retroactively mislabeled.** Using "Log
  New Task" without switching tabs changed the taskContext immediately,
  but the already-running session on that tab wasn't split at that
  moment — it only flushed at the next real tab switch, and read
  whatever task/comment was CURRENT by then. In practice this meant the
  entire elapsed block silently got relabeled with the latest edit,
  producing the garbled/duplicated-looking comment history seen in
  practice. Fixed: content.js now messages background.js the instant
  "Log New Task" is saved, BEFORE overwriting storage, with the OLD
  task/comment values; background.js flushes the elapsed time under
  those OLD values via a new `overrideTag` param on `appendSession()`,
  then restarts the session clock so only time going forward picks up
  the new tag.
- **"So far today" showed visually-identical duplicate lines.** The dedup
  in `summarizeExistingNotesForProject()` compared raw, untrimmed comment
  strings, so two entries that render identically but differ by
  invisible whitespace (e.g. a retry after noticing dropped keystrokes)
  both showed up. Now dedupes on the trimmed, actually-displayed label.
- **Keystrokes (e, h, etc.) still getting eaten on Salesforce Lightning
  despite the v5.1.0 capture-phase guard.** Root cause: the overlay lived
  in a CLOSED Shadow DOM, and while focus is inside a shadow tree,
  `document.activeElement` — as seen by any script outside that tree —
  reports the shadow HOST, never the actual focused input. A page
  checking "is document.activeElement editable?" before firing its own
  shortcut (a legitimate, common pattern) would see a plain `<div>` and
  conclude it's safe to intercept the key. The overlay now renders in
  light DOM instead, so `document.activeElement` correctly points at the
  real `<input>`/`<textarea>`. overlay.css was hardened with `!important`
  on the properties most likely to collide with a host page's own global
  resets, to make up for losing shadow DOM's style isolation. This is a
  substantial improvement but still can't be a 100% guarantee — if a
  site's shortcut fires unconditionally regardless of focus, no
  client-side extension code can fully prevent it.

## What changed in v5.1.0 (this round, driven by real QA feedback)

- **Session fragmentation.** `appendSession()` now folds very short "blip"
  sessions (under a configurable noise threshold, default 3s — Settings)
  into whichever neighboring session they're closest to, regardless of
  task. A stray few-hundred-ms focus while switching tabs no longer
  becomes its own permanent row.
- **Chrome slowing down over a long session.** The background service
  worker's `chrome.storage.onChanged` listener used to trigger an
  immediate full reconcile on every single session write (i.e. every
  append). It's now debounced the same way SPA route churn already was.
- **Always Show Popup sites** (Settings) — the inverse of Excluded sites.
  Domains on this list (e.g. `meet.google.com`) ask which project every
  visit, ignoring both today's existing setup and an earlier "Not now."
- **Categories are fully user-managed now.** No more fixed built-in list —
  create, rename, or delete freely from Settings. Existing installs keep
  their old category names as a one-time seed so nothing already-tagged
  goes blank.
- **Permanent project deletion** (Settings → Projects) — cascades through
  domain links, task context, and every session (live + archived), not
  just a soft `archived` flag.
- **Delete old data** (Settings) — clear tracked sessions older than a
  week/month/N months, or a custom date range, to keep the live working
  set lean.
- **Project-name field was cramped.** Widened in both the in-page setup
  overlay and the Settings project list, which now stacks name/category/
  delete onto their own rows instead of squeezing into one line.
- **Existing-project picker defaulted to creating near-duplicates.** The
  home-project picker used to filter by a guessed org label (e.g.
  "synlawn2025" from a sandbox subdomain) that often didn't substring-match
  the real project name ("Synlawn"), silently leaving the list empty and
  defaulting to creating a new near-duplicate project on Save unless you
  noticed and re-searched. It now shows your actual recently-used projects
  immediately so the existing one is a single click — domain→project
  linking is still explicit-only, never auto-matched by string pattern,
  this just makes the manual pick faster.
- **Keystrokes still getting eaten on some sites.** The Shadow-DOM field
  guard only stopped propagation in the bubble phase, but a host page's
  own **capture**-phase listener on `window`/`document` runs first and
  completes before the event ever reaches into the shadow tree. Added an
  early capture-phase guard in `content.js`, registered at the top of the
  script rather than behind the popup delay. This narrows the gap
  substantially but isn't a 100% guarantee — a page listener registered
  even earlier during its own bootstrap can still win the race.
- **"Copy for Replicon" → "Copy."**
- **Comments blank when only a Task was filled in.** Timesheet Summary and
  the Replicon copy now fall back to the task name when a session has one
  but no comment, instead of showing nothing.
- **New icon** — a cloud-and-clock mark in the existing indigo/teal palette.

## What changed in v5.0.0

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
an **Add a note** box (always blank — every save is its own timestamped
entry) and **Today's notes**, the complete comment history for that
project, in order. Below that, a **Sites contributing** list with
per-site relink, and a collapsed **Advanced** section with the raw
tracked sessions — editable for start/end, plus add/merge/consolidate.

**Timeline** — chronological, color-coded blocks for a day.

**Notes** — every comment logged for a day, across all projects, in
chronological order with timestamps; click-through to the same editor.

**Timesheet summary** — project rows × day columns of hours + Total,
comment indicator per cell, **Copy** (tab-separated, decimal hours).

**Settings**: idle threshold, merge-gap threshold, screen-time grace,
prompt delay, global tracking on/off, theme, per-project renaming/
category, fully user-managed categories, excluded sites, always-prompt
sites, dismissed-prompt recovery, full backup/restore, delete old data,
three CSV export modes (daily summary, full session detail, notes log).

## Data model

```
projects:      { [projectId]: { name, category, hue, createdAt, lastUsedAt } }
domainMap:     { [domain]: projectId }                 -- permanent home link
taskContext:   { [domain]: { projectId } }              -- which project a NEW session bills to
entries:       { [date]: { [domain]: { sessions: [
                   { id, start, end, projectId, comment, manual, isNote? }
                ] } } }
manualAdjustments: { [date]: { [projectId]: ms } }
excludedSites: { [domain]: { addedAt } }             -- opt-out list: never ask
alwaysPromptSites: { [domain]: { addedAt } }         -- opposite: ask every visit
customCategories: [ "Client Meetings", ... ]         -- fully user-managed, no built-ins
settings:      { idleThresholdMinutes, mergeGapSeconds,
                 screenTimeGraceMinutes, popupDelaySeconds, manuallyPaused,
                 autoTrackEnabled, theme, ... }
archives:      { [weekStart]: { entries, manualAdjustments } }
```

A comment is always a standalone session — `isNote: true` means it's a
zero-duration note (start === end, contributes no tracked time), added
via `addQuickNote()` from either the in-page popup or the dashboard.
`getDayCommentLog()` reconstructs a day's full comment history just by
reading every session's `comment` field in order — there's no separate
"current" field anywhere that a later entry could conflict with.

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
  dashboard.html/.js/.css      History / Timeline / Notes /
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

- **Charts by project** — `groupDayByProject()` already produces
  chart-ready aggregates; `getDayCommentLog()` covers a chronological view.
- **Search and filters** — filtering `state.entries` before render.
- **Excel (.xlsx) export** — swap the CSV writer; row shapes are flat.
- **IndexedDB** — not implemented; `chrome.storage.local` with
  `unlimitedStorage` plus weekly archiving already bounds the live
  working set, so this likely isn't needed unless real usage shows
  storage-quota problems. Worth revisiting only if that happens.
- **JIRA/Salesforce sync** — would be the first exception to the "no
  network calls" guarantee above; flag clearly if ever added.
