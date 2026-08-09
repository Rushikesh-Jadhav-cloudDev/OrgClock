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
- **Pause Tracking / Resume Tracking** — a manual, global on/off switch
  for PROJECT time tracking specifically, independent of idle detection.
  Chrome active time keeps counting either way.

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

## What changed in v8.0.1 (hotfix, from a real dashboard + CSV)

- **Tracked time could exceed Chrome active time** — structurally
  shouldn't be possible, since project tracking is supposed to be a
  strict subset of "Chrome is active." Root cause: v8.0.0's idle-exempt
  sites feature (Settings → "Keep tracking during meetings") only
  bypassed idle-pausing for PROJECT billing (`getCurrentOrgCandidate`) —
  the separate "Chrome active" tracker (`reconcileGlobalSession`) had no
  idea idle-exemption existed, so on a long stretch on an idle-exempt
  domain, project time correctly kept accruing while Chrome-active
  quietly paused after the idle threshold anyway. Confirmed directly
  from an exported CSV (a day with more tracked minutes than measured
  Chrome-active minutes, with the padding ruled out as coming from
  manual sessions or merge-gap bridging — neither accounted for it).
  Both trackers now check idle-exemption consistently.

## What changed in v8.0.0

### Bug fixes
- **Mid-session project switches split time incorrectly.** Changing
  "Currently working on" mid-call (e.g. a 1-hour meeting, 30 min on
  Project A then 30 on Project B) used to silently log the ENTIRE hour to
  whichever project was picked last — sessions only get tagged when they
  flush (tab loses focus), not at the moment you switch. Fixed the same
  way the old comment-flush mechanism worked in v5.1.1 (removed in
  v6.0.1, which turned out to be premature — that removal was correct for
  comments, not for project changes): content.js now messages
  background.js the instant the project changes, which splits the
  elapsed time under the OLD project and restarts the clock.
- **Domain "forgot" its linked project, silently creating a duplicate.**
  The home-project picker used to pre-fill the search box with a guessed
  label (e.g. "synlawn2025" from a sandbox subdomain) — a plausible-
  looking answer that, if not double-checked against the list below,
  would get saved as a brand-new, separate project instead of the real
  one. The box no longer pre-fills; Save now requires an explicit pick.
  Added Settings → Projects → **Merge into…** to clean up any duplicates
  this already created.
- **Meeting tracking paused during inactivity.** No keyboard/mouse input
  for the idle threshold paused project billing — correct for normal
  browsing, wrong for a call where you're not touching either for an
  hour. New Settings → **Keep tracking during meetings** list exempts
  specific domains from the idle check entirely (Chrome still has to be
  the focused app).

### Performance — IndexedDB migration
- `entries` (tracked sessions — written to on nearly every action) moved
  from a single growing chrome.storage.local blob to IndexedDB, one
  record per date (`lib/db.js`). This is the collection that actually
  caused slowdown after weeks of use; every append/edit/note now only
  touches that day's record instead of the whole history.
- content.js (a content script) can't reach this directly — content
  scripts run in the origin of whatever PAGE they're on, not the
  extension's own origin, so a naive `indexedDB.open()` there would open
  a totally isolated database per website. It now messages background.js
  (which runs in the extension's own origin) for entries reads/writes.
  `chrome.storage.onChanged` has no IndexedDB equivalent, so writes also
  bump a tiny `entriesVersion` timestamp so existing "something changed,
  reload" listeners keep working unmodified.
- One-time migration on upgrade moves any existing chrome.storage.local
  `entries` into IndexedDB, then removes the old key. Full backup/restore
  updated to capture and restore IndexedDB data too (new schema version,
  old backups still importable).
- `archives` stays on chrome.storage.local — already addressed in v7.0.0
  by not re-fetching it on every routine reload, and it's a much
  lower-frequency-write collection than entries.

### Extension icon popup
- Pause/Resume replaced with a visible toggle switch directly in the
  status row, not a menu item — "I could not find the toggle" was a
  discoverability problem (the button worked, just wasn't recognizable
  as the master switch buried in a 5-item list).

### Dashboard
- **Charts**: hover tooltips with exact values on every bar/segment/
  point; date range presets (Today / This week / This month); new
  "Chrome active vs. tracked" comparison chart.
- **Export** moved out of Settings into its own tab.
- **Daily summary banner** — a template-filled sentence ("Today you
  spent 5h 42m across 4 projects...") above the stat cards once there's
  enough tracked time to be worth summarizing.
- **Timeline**: newest-first order, plus a start/end/total header for
  the day so you don't have to scroll to find when it began.
- Settings → **Prepend time to new notes** — an opt-in toggle that
  timestamps comments added via the icon's Add Note.
- Settings → Projects → **Merge into…** (see bug fixes above).

### Deferred (flagged, not done this round)
Full chart visual redesign, vertical Charts subtabs, per-project
analytics pages, additional chart types (heatmap, hourly productivity,
average session length), resizable settings sidebar, and a general
dashboard layout/whitespace pass are all real, reasonable asks that
didn't make this release given its size — say the word and any of these
can be the focus of a following round rather than a shallow pass here.
The periodic "Currently Tracking: X" reminder popup was explicitly
flagged as optional/future and isn't built.

## What changed in v7.0.0

- **Work Summary replaces the Notes tab.** Clicking a Timesheet Summary
  cell (or a project's card in Day-wise History) now opens a single large
  editable text area — one line per comment logged, no timestamps, no
  session grouping, matching exactly what the Timesheet Summary already
  showed. It auto-populates from logged comments until the first Save;
  after that, editing is authoritative — reorder, reword, delete lines
  freely, and future comments only ever get appended to the bottom
  instead of silently overwriting or hiding what you edited. **Copy**
  copies exactly what's in the box, ready to paste into Replicon. The
  old timestamped-note-card system (and the Notes tab) is gone.
- **New Charts tab.** Time per project (bar), time per site (bar),
  project distribution (donut), daily active time (line), and weekly
  trend (bar) — with a date range picker and project/site filters.
  Hand-rolled SVG rather than a bundled charting library, to keep the
  extension's footprint the same as it's always been.
- **"Currently working on" now defaults to your last active project
  globally**, not just per-domain. Reopening the popup on a different
  site than the one you were just working on picks up where you left
  off instead of that site's own (possibly stale) remembered project.
- **Chrome-active reconciliation now also runs on the once-a-minute
  heartbeat**, not just on tab/window/idle events — closes a gap where a
  long stretch with none of those events firing could leave the stat
  stale until the next one did.
- **Clarified that Pause (icon menu) and the master tracking switch
  (Settings) only stop PROJECT time** — Chrome active time keeps
  counting either way. This was already true; the UI just didn't say so.
- **Dashboard no longer re-fetches the entire archived history on every
  routine reload.** `archives` is the one collection that grows without
  bound over months of use, and the dashboard used to re-read all of it
  on every single storage change (which happens very often during active
  tracking, since every session append writes `entries`). It's now only
  re-fetched when something in `archives` itself actually changed —
  weekly rollover, an explicit restore, or a delete — which is rare.
  Everything else still refreshes on every change as before.
- **Investigated the "Gmail only shows ~2 hours despite being open all
  day" report**: this matches the tracker's by-design behavior — only
  the tab that's actually frontmost in the focused window accumulates
  time, not every open tab. A background tab sitting open all day
  correctly contributes 0 additional time beyond the stretches it was
  actually the active tab. If `mail.google.com` (or any site) is in
  Settings → Excluded sites, it won't be tracked at all, which is worth
  ruling out separately. Tracking *every open tab* regardless of focus
  would be a materially different feature — flag it if that's actually
  what's wanted and it can be scoped properly.

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

## Dashboard — five views

**Stat cards**: today's/this week's tracked time, Chrome active time,
productive %, projects touched, sessions.

**Day-wise history** — grouped by project. Each card's editor leads with
the **Work Summary** field (see below), a **Sites contributing** list
with per-site relink, and a collapsed **Advanced** section with the raw
tracked sessions — editable for start/end, plus add/merge/consolidate.

**Timeline** — chronological, color-coded blocks for a day.

**Timesheet summary** — project rows × day columns of hours + Total,
comment indicator per cell. Click a cell to open that project/day's
**Work Summary**: a single editable text area, one line per comment
logged, no timestamps, no session grouping — auto-populates until the
first Save, after which it's yours; new comments only ever get appended
to the bottom, never overwrite what you've edited. **Copy** copies
exactly what's shown, ready to paste into Replicon.

**Charts** — time per project (bar), time per site (bar), project
distribution (donut), daily active time (line), weekly trend (bar).
Date range picker plus project/site filters.

**Settings**: idle threshold, merge-gap threshold, screen-time grace,
prompt delay, global tracking on/off, theme, per-project renaming/
category, fully user-managed categories, excluded sites, always-prompt
sites, dismissed-prompt recovery, full backup/restore, delete old data,
three CSV export modes (daily summary, full session detail, notes log).

## Data model

**chrome.storage.local:**
```
projects:      { [projectId]: { name, category, hue, createdAt, lastUsedAt } }
domainMap:     { [domain]: projectId }                 -- permanent home link
taskContext:   { [domain]: { projectId } }              -- which project a NEW session bills to
lastActiveProjectId: projectId | null                   -- global "last confirmed" default for Currently Working On
manualAdjustments: { [date]: { [projectId]: ms } }
workSummaries: { [date]: { [projectId]: { text, lastSyncedTs } } } -- the editable Work Summary
excludedSites: { [domain]: { addedAt } }             -- opt-out list: never ask
alwaysPromptSites: { [domain]: { addedAt } }         -- opposite: ask every visit
idleExemptSites: { [domain]: { addedAt } }           -- skip the idle-pause check (meeting apps)
customCategories: [ "Client Meetings", ... ]         -- fully user-managed, no built-ins
settings:      { idleThresholdMinutes, mergeGapSeconds, screenTimeGraceMinutes,
                 popupDelaySeconds, manuallyPaused, autoTrackEnabled,
                 includeTimestampInNotes, theme, ... }
archives:      { [weekStart]: { entries, manualAdjustments, workSummaries } }
entriesVersion: timestamp   -- bumped on every IndexedDB entries write, purely so
                                chrome.storage.onChanged listeners still fire (see Architecture)
```

**IndexedDB** (`lib/db.js`, database `orgclock`, object store `entries`, keyPath `date`):
```
{ date: "2026-07-28", byDomain: { [domain]: { sessions: [
    { id, start, end, projectId, comment, manual, isNote? }
  ] } } }
```
One record per date — this is the collection written to on nearly every
tracked action, so it's the one place a single giant JSON blob (the
pre-v8.0.0 design) actually hurt performance over weeks of use.

A comment is always a standalone session — `isNote: true` means it's a
zero-duration note (start === end, contributes no tracked time). Raw
comments still accumulate exactly as before (`getDayCommentLog()`
reconstructs the full chronological log); `workSummaries` sits on top as
the actually-edited, Replicon-ready version of that log for a given
project/day — `computeWorkSummaryText()` in `lib/storage.js` is the pure
function that merges the two (auto-populate when nothing's saved yet,
append-only-what's-new once something is).

## Architecture

```
manifest.json          MV3 manifest; broad host permissions; default_popup
                        for the icon menu
background.js           Service worker — the only place tracking decisions
                         are made. Owns the settle window (redirect-chain
                         absorption), same-org silent carry-over, screen-
                         time grace period, manual pause / auto-track gate,
                         a settings cache, debounced SPA-churn handling,
                         and the message bridge that lets content.js reach
                         IndexedDB (see lib/db.js below — content scripts
                         can't reach it directly).
content.js               Injected into every page. Defers all work behind
                          a configurable delay. Owns the setup overlay —
                          no floating on-page button anymore. No ES module
                          imports (unsupported reliably in content
                          scripts) — talks to chrome.storage directly for
                          small data, and messages background.js for
                          entries reads/writes (IndexedDB, extension-
                          origin-only — see lib/db.js).
lib/
  storage.js              All persistence reads/writes (chrome.storage.local
                           for most things, IndexedDB via db.js for
                           entries), session merge/consolidation, day
                           aggregation, custom categories, work summaries.
  db.js                    IndexedDB wrapper for `entries` — one record
                            per date instead of one ever-growing blob.
  domains.js               URL parsing, same-org label guessing, exclusion
                            check (minimal built-in list + user's own).
  dateUtils.js               Local-time date/week/duration formatting.
  id.js                       Small id generator.
pages/
  dashboard.html/.js/.css      History / Timeline / Timesheet Summary /
                                Charts / Export views, settings drawer.
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

- **Search and filters** — filtering `state.entries` before render.
- **Excel (.xlsx) export** — swap the CSV writer; row shapes are flat.
- **JIRA/Salesforce sync** — would be the first exception to the "no
  network calls" guarantee above; flag clearly if ever added.
