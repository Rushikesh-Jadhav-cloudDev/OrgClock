// content.js — injected into every http(s) page (broad tracking).
//
// Dependency-free by design: content scripts can't reliably use ES module
// imports across every supported Chrome version, so this talks to
// chrome.storage directly using the same shapes as lib/storage.js.
//
// Owns the first-visit-of-the-day setup overlay, and (on request from the
// action popup's "Add Note") a follow-up overlay for adding a comment
// and/or retagging which project NEW sessions on this domain should
// count toward, without waiting for a new day. There is deliberately no
// floating on-page button anymore — that affordance lives entirely in
// the extension icon's popup now.
//
// v6 removed the separate Task field. A comment is now always a
// standalone, immediately-saved, timestamped note — not a "current
// context" that persists forward and can go stale or get silently
// overridden the way the old taskContext.comment (and the dashboard's
// old dayNotes field) could. The Comments box always starts blank; "So
// far today" below it is read-only history built straight from what's
// actually been saved, so there's nothing that can fall out of sync
// with it.
//
// Four things worth knowing about how this file is structured:
//  1. ALL work — including the excluded-sites check — is deferred behind
//     a configurable delay (Settings, default ~2.5s) after the page has
//     finished loading. This keeps the extension from ever touching the
//     page during its own initial render/bootstrap, which is both a
//     performance concern and the likely cause of some Salesforce org
//     pages failing to load correctly when this ran immediately.
//  2. The overlay renders in LIGHT DOM, not a closed Shadow DOM. It used
//     to use a closed shadow root for style isolation, but that had a
//     real cost: while focus is inside a shadow tree, `document.
//     activeElement` — as seen by any script OUTSIDE that tree — reports
//     the shadow HOST element, never the actual focused input. Sites that
//     gate their own global keyboard shortcuts on "is document.
//     activeElement an editable field?" (a legitimate, common pattern —
//     Salesforce Lightning included) would see a plain <div> and
//     conclude it's safe to fire the shortcut, silently eating keys like
//     "e"/"h" before they ever reached our field. Rendering in light DOM
//     makes `document.activeElement` correctly point at our real <input>/
//     <textarea>, so that class of check backs off correctly. The
//     trade-off is losing shadow DOM's style isolation — mitigated by
//     scoping every rule in overlay.css under `.orbit-root` plus
//     `!important` on the properties most likely to collide with a
//     host page's own global resets. This narrows the keystroke-eating
//     problem substantially but can't be a 100% guarantee: if a site's
//     shortcut handler fires unconditionally regardless of focus (some
//     Lightning list-view shortcuts are reported to behave this way),
//     no client-side trick in an extension can fully prevent it.
//  3. Every field ALSO stops propagation on keyboard events in the BUBBLE
//     phase only (guardKeyEvents, called on mount) — this is safe by
//     construction since bubble phase only runs after the field has
//     already processed the keystroke normally. v6.0.1 briefly added a
//     CAPTURE-phase version of this on `document` too, which turned out
//     to block typing in our own fields entirely once light DOM made
//     `e.target` resolve correctly (see the comment where it used to
//     live, just below, for the full story) — removed in v6.0.2.
//  4. Saving a comment writes a note straight into `entries` here
//     (mirroring lib/storage.js's addQuickNote — this file can't import
//     it, see the dependency-free note above), rather than going through
//     any persistent per-domain state. That's deliberate: it's what makes
//     "every comment is independent and nothing can silently block a
//     later one" true by construction, not just by convention.

(function () {
  if (window.__orbitTimesheetInjected) return;
  window.__orbitTimesheetInjected = true;

  const domain = location.hostname.toLowerCase();

  // v6.0.1 added a capture-phase guard here that called
  // stopImmediatePropagation() on any keydown/keyup/keypress whose target
  // was inside the overlay, intended to beat a host page's own capture-
  // phase shortcut listener to the punch. That worked (sort of) back when
  // the overlay lived in a closed Shadow DOM, because `e.target` as seen
  // by a document-level listener was always retargeted to the shadow
  // HOST — never the real input. Once the overlay moved to light DOM (see
  // below), `e.target` correctly resolves to the actual focused field for
  // EVERY keystroke, including completely normal typing — so that same
  // guard started intercepting and halting propagation for our own
  // fields' own keystrokes before they could be processed, breaking
  // typing entirely. Removed. The field-level bubble-phase guard below
  // (guardKeyEvents) is the safe version of this same idea: it only stops
  // the event from bubbling further OUTWARD after the field has already
  // handled it, so it can't block typing, and light DOM's fix to
  // `document.activeElement` (see file header) is doing the real work of
  // getting the host page's own shortcut logic to back off in the first
  // place.

  // Mirrors lib/domains.js's built-in exclusions (kept in sync manually,
  // since content scripts can't import that module) — pages that are
  // never meaningfully "a project" even under broad tracking. Deliberately
  // minimal: Salesforce's own help/docs/admin pages are NOT excluded here
  // (they used to be, which was a real bug — those are exactly pages
  // someone would want tracked).
  const BUILT_IN_EXCLUDED = ['accounts.google.com', 'chrome.google.com'];

  function todayStr() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function newId(prefix) {
    if (window.crypto && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : str;
    return d.innerHTML;
  }

  let overlayStylesheetLoaded = false;
  function ensureOverlayStylesheetLoaded() {
    if (overlayStylesheetLoaded || document.getElementById('orbit-timesheet-overlay-styles')) {
      overlayStylesheetLoaded = true;
      return;
    }
    const link = document.createElement('link');
    link.id = 'orbit-timesheet-overlay-styles';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('pages/overlay.css');
    document.head.appendChild(link);
    overlayStylesheetLoaded = true;
  }
  // Stops the host page's own keyboard-shortcut handlers from seeing (and
  // potentially swallowing) keystrokes meant for our overlay's fields —
  // see file header. Attach to every text input/textarea we create.
  function guardKeyEvents(el) {
    for (const type of ['keydown', 'keyup', 'keypress', 'input']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  /** Promisified chrome.runtime.sendMessage, since content scripts can't use ES modules (see file header) and this needs to work without lib/storage.js. */
  function sendMessageAsync(message, fallback) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError || !response) { resolve(fallback); return; }
          resolve(response);
        });
      } catch {
        resolve(fallback);
      }
    });
  }

  /**
   * `entries` now lives in IndexedDB (see lib/db.js), reachable only from
   * the extension's own origin — a content script's own `indexedDB.open()`
   * would silently open an isolated database scoped to the PAGE's origin
   * instead, never touching what background.js/the dashboard see. So this
   * asks background.js for today's record instead of reading it directly,
   * and wraps it back into the same `{ [date]: byDomain }` shape the rest
   * of this file already expects.
   */
  async function loadAll(date) {
    const [storageData, todayResp] = await Promise.all([
      chrome.storage.local.get(['projects', 'domainMap', 'taskContext', 'settings', 'excludedSites', 'alwaysPromptSites', 'lastActiveProjectId']),
      sendMessageAsync({ type: 'ORBIT_GET_TODAY_ENTRIES', date }, { byDomain: {} })
    ]);
    return { ...storageData, entries: { [date]: todayResp.byDomain || {} } };
  }

  function init() {
    chrome.storage.local.get(['settings']).then(({ settings = {} }) => {
      const delayMs = Math.max(0, (settings.popupDelaySeconds ?? 2.5) * 1000);
      setTimeout(runChecks, delayMs);
    }).catch(() => setTimeout(runChecks, 2500));
  }

  async function runChecks() {
    if (document.getElementById('orbit-timesheet-overlay-host')) return;
    if (BUILT_IN_EXCLUDED.includes(domain)) return;

    const dismissKey = `dismissed:${domain}`;
    const today = todayStr();

    const data = await loadAll(today);
    if (data.excludedSites && data.excludedSites[domain]) return;
    if (data.settings && data.settings.autoTrackEnabled === false) return;
    if (data.settings && data.settings.manuallyPaused) return;

    const alwaysPrompt = Boolean(data.alwaysPromptSites && data.alwaysPromptSites[domain]);
    const alreadySetUpToday = Boolean(data.entries?.[today]?.[domain]);

    if (alwaysPrompt) {
      // Deliberately skips the "dismissed this session" check below — a
      // site marked Always Show Popup (meeting tools, etc.) should ask
      // every visit "regardless of previous selections," including a
      // prior Not-now on an earlier visit today.
      mountOverlay({ ...data, domain, today, dismissKey, mode: alreadySetUpToday ? 'add-note' : 'first-visit' });
      return;
    }

    let dismissed = {};
    try { dismissed = await chrome.storage.session.get(dismissKey); } catch { /* ignore */ }
    if (dismissed[dismissKey]) return;

    if (!alreadySetUpToday) {
      mountOverlay({ ...data, domain, today, dismissKey, mode: 'first-visit' });
    }
    // If already set up today, do nothing and wait quietly — adding a
    // note now happens only via the extension icon's "Add Note" action.
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'ORBIT_RECHECK') {
      runChecks();
    } else if (message?.type === 'ORBIT_ADD_NOTE') {
      const today = todayStr();
      loadAll(today).then((data) => {
        mountOverlay({ ...data, domain, today, dismissKey: `dismissed:${domain}`, mode: 'add-note' });
      });
    }
  });

  // -------------------------------------------------------------- overlay

  async function mountOverlay(ctx) {
    if (document.getElementById('orbit-timesheet-overlay-host')) return;
    const { projects = {}, domainMap = {}, taskContext = {}, entries = {}, settings = {}, alwaysPromptSites = {}, lastActiveProjectId = null, domain, today, mode } = ctx;
    const isAlwaysPrompt = Boolean(alwaysPromptSites[domain]);

    const theme = settings.theme || 'system';
    const resolvedTheme = theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;

    const host = document.createElement('div');
    host.id = 'orbit-timesheet-overlay-host';
    ensureOverlayStylesheetLoaded();

    const root = document.createElement('div');
    root.className = 'orbit-root';
    root.dataset.theme = resolvedTheme;

    const homeProjectId = domainMap[domain] || null;
    const homeProject = homeProjectId ? projects[homeProjectId] : null;
    const currentCtx = taskContext[domain];
    // "Currently working on" prefers the GLOBALLY most-recently-confirmed
    // project (across every domain) over this one domain's own remembered
    // context — but only when reopening the popup (add-note), not on a
    // brand-new site's first-visit setup, where defaulting to whatever
    // project you just linked as home makes more sense than a random
    // unrelated project from elsewhere. Falls back to per-domain memory,
    // then home, if there's no global last-active project (or it was
    // since deleted).
    const globalLastProject = mode !== 'first-visit' && lastActiveProjectId && projects[lastActiveProjectId] ? lastActiveProjectId : null;
    const workingProjectId = globalLastProject || currentCtx?.projectId || homeProjectId || null;
    const workingProject = workingProjectId ? projects[workingProjectId] : null;

    const referenceNote = summarizeExistingNotesForProject(entries, workingProjectId, today);

    root.innerHTML = `
      <div class="orbit-backdrop">
        <div class="orbit-card" role="dialog" aria-modal="true" aria-labelledby="orbitTitle">
          <div class="orbit-head">
            <div class="orbit-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5.2l3.4 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            </div>
            <div>
              <h1 id="orbitTitle">${mode === 'first-visit' ? 'New site detected' : 'Add a note'}</h1>
              <p class="orbit-domain">${escapeHtml(domain)}</p>
            </div>
          </div>

          <div class="orbit-field">
            <label>Project name <span class="orbit-sublabel">(remembered permanently for this site)</span></label>
            <div id="orbitHomeChip" class="orbit-chip" style="${homeProject ? '' : 'display:none;'}">
              <span class="dot" style="background:hsl(${homeProject ? homeProject.hue : 0},60%,50%)"></span>
              <span>${escapeHtml(homeProject ? homeProject.name : '')}</span>
              <button type="button" id="orbitChangeHomeBtn">Change</button>
            </div>
            <div id="orbitHomePicker" style="${homeProject ? 'display:none;' : ''}">
              <input type="text" id="orbitHomeSearch" placeholder="Search existing projects, or type a new name…" autocomplete="off" />
              <ul class="orbit-list" id="orbitHomeList"></ul>
              <p class="orbit-hint" id="orbitHomeHint"></p>
            </div>
          </div>

          <div class="orbit-field">
            <label>Currently working on <span class="orbit-sublabel">(change only if this is for a different project)</span></label>
            <div id="orbitWorkChip" class="orbit-chip" style="${workingProject ? '' : 'display:none;'}">
              <span class="dot" style="background:hsl(${workingProject ? workingProject.hue : 0},60%,50%)"></span>
              <span>${escapeHtml(workingProject ? workingProject.name : '')}</span>
              <button type="button" id="orbitChangeWorkBtn">Change</button>
            </div>
            <div id="orbitWorkPicker" style="${workingProject ? 'display:none;' : ''}">
              <input type="text" id="orbitWorkSearch" placeholder="Search or type a project name…" autocomplete="off" />
              <ul class="orbit-list" id="orbitWorkList"></ul>
              <p class="orbit-hint" id="orbitWorkHint"></p>
            </div>
          </div>

          ${referenceNote ? `<div class="orbit-field"><label>So far today</label><p class="orbit-reference-note">${escapeHtml(referenceNote)}</p></div>` : ''}

          <div class="orbit-field">
            <label for="orbitComment">Comments <span class="orbit-sublabel">(optional)</span></label>
            <textarea id="orbitComment" rows="3" placeholder="What are you working on right now?"></textarea>
          </div>

          <div class="orbit-actions">
            <button type="button" class="orbit-btn orbit-btn-text" id="orbitCancelBtn">${mode === 'first-visit' ? 'Not now' : 'Cancel'}</button>
            <button type="button" class="orbit-btn orbit-btn-primary" id="orbitSaveBtn">${mode === 'first-visit' ? 'Start tracking' : 'Save'}</button>
          </div>
          ${mode === 'first-visit' && !isAlwaysPrompt ? '<p class="orbit-footnote">Won\'t ask again today for this site.</p>' : ''}
          ${isAlwaysPrompt ? '<p class="orbit-footnote">Always asks on this site — change in Settings → Always Show Popup.</p>' : ''}
        </div>
      </div>
    `;

    host.appendChild(root);
    document.body.appendChild(host);
    requestAnimationFrame(() => root.querySelector('.orbit-backdrop').classList.add('visible'));

    // Guard every text field against the host page stealing keystrokes.
    root.querySelectorAll('input[type="text"], textarea').forEach(guardKeyEvents);

    let selectedHomeId = homeProjectId;
    let selectedWorkId = workingProjectId;
    let workTouchedByUser = false;

    const backdrop = root.querySelector('.orbit-backdrop');
    const comment = root.querySelector('#orbitComment');

    setupPicker({
      projects,
      chipEl: root.querySelector('#orbitHomeChip'), pickerEl: root.querySelector('#orbitHomePicker'),
      searchEl: root.querySelector('#orbitHomeSearch'), listEl: root.querySelector('#orbitHomeList'),
      hintEl: root.querySelector('#orbitHomeHint'), changeBtn: root.querySelector('#orbitChangeHomeBtn'),
      initialQuery: '',
      onSelect: (id, name) => {
        selectedHomeId = id;
        if (!workTouchedByUser) {
          selectedWorkId = id;
          const workChip = root.querySelector('#orbitWorkChip');
          workChip.querySelector('span:nth-child(2)').textContent = name;
          const proj = id && projects[id];
          if (proj) workChip.querySelector('.dot').style.background = `hsl(${proj.hue},60%,50%)`;
          workChip.style.display = '';
          root.querySelector('#orbitWorkPicker').style.display = 'none';
        }
      }
    });

    setupPicker({
      projects,
      chipEl: root.querySelector('#orbitWorkChip'), pickerEl: root.querySelector('#orbitWorkPicker'),
      searchEl: root.querySelector('#orbitWorkSearch'), listEl: root.querySelector('#orbitWorkList'),
      hintEl: root.querySelector('#orbitWorkHint'), changeBtn: root.querySelector('#orbitChangeWorkBtn'),
      initialQuery: '',
      onSelect: (id) => { selectedWorkId = id; workTouchedByUser = true; },
      onManualChangeClick: () => { workTouchedByUser = true; }
    });

    async function dismiss() {
      if (mode === 'first-visit' && !isAlwaysPrompt) {
        try { await chrome.storage.session.set({ [ctx.dismissKey]: Date.now() }); } catch { /* best effort */ }
      }
      teardown();
    }
    function teardown() {
      backdrop.classList.remove('visible');
      document.removeEventListener('keydown', onKeydown);
      setTimeout(() => host.remove(), 160);
    }
    function onKeydown(e) { if (e.key === 'Escape') dismiss(); }
    document.addEventListener('keydown', onKeydown);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
    root.querySelector('#orbitCancelBtn').addEventListener('click', dismiss);

    root.querySelector('#orbitSaveBtn').addEventListener('click', async () => {
      const saveBtn = root.querySelector('#orbitSaveBtn');
      const homeSearch = root.querySelector('#orbitHomeSearch');
      const workSearch = root.querySelector('#orbitWorkSearch');
      const homeHint = root.querySelector('#orbitHomeHint');

      let finalHomeId = selectedHomeId;
      if (!finalHomeId) {
        const typed = homeSearch.value.trim();
        if (!typed) { homeHint.textContent = 'Enter or select a project.'; return; }
        finalHomeId = findOrCreate(projects, typed);
      }
      let finalWorkId = selectedWorkId;
      if (!finalWorkId) {
        const typed = workSearch.value.trim();
        finalWorkId = typed ? findOrCreate(projects, typed) : finalHomeId;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      // Must happen BEFORE the storage write below, and only when the
      // working project actually changed. If sent after (or omitted
      // entirely), a session already running on this domain — e.g. a long
      // meeting tab that's been active and focused the whole time — would
      // never get split at the moment you switched: it only flushes once
      // when the tab loses focus, tagging the ENTIRE elapsed block with
      // whatever project is current by then, not what was true for the
      // earlier portion.
      if (workingProjectId && finalWorkId !== workingProjectId) {
        try {
          await chrome.runtime.sendMessage({
            type: 'ORBIT_PROJECT_SWITCH_FLUSH',
            domain,
            oldProjectId: workingProjectId
          });
        } catch { /* background may be asleep — best effort, not fatal */ }
      }

      domainMap[domain] = finalHomeId;
      taskContext[domain] = { projectId: finalWorkId, updatedAt: Date.now() };

      // Entries (today's container, and any comment) now live in
      // IndexedDB via background.js — see loadAll()'s comment above for
      // why this can't just be a local chrome.storage.local write.
      const ensureResp = await sendMessageAsync({ type: 'ORBIT_ENSURE_ENTRY_CONTAINER', date: today, domain }, { ok: false });
      let noteResp = { ok: true };
      let commentText = comment.value.trim();
      if (commentText && settings.includeTimestampInNotes) {
        commentText = `${formatClockLocal(Date.now())} — ${commentText}`;
      }
      // A comment is always its own instant, timestamped note now — not
      // something written into taskContext that persists forward and
      // could get silently relabeled by a later edit (that was the old
      // bug). Zero duration by design: it's a note, not tracked time.
      if (ensureResp.ok && commentText) {
        noteResp = await sendMessageAsync({
          type: 'ORBIT_SAVE_QUICK_NOTE', date: today, domain, projectId: finalWorkId, comment: commentText
        }, { ok: false });
      }

      if (!ensureResp.ok || !noteResp.ok) {
        saveBtn.disabled = false;
        saveBtn.textContent = mode === 'first-visit' ? 'Start tracking' : 'Save';
        homeHint.textContent = 'Something went wrong — try again.';
        return;
      }

      // Bump recency so the picker can surface these first next time,
      // instead of requiring the user to retype/re-search a project that
      // already exists just because it's linked to a different domain
      // (domain→project matching stays explicit-only by design — this
      // just makes the manual pick faster, see setupPicker below).
      const now = Date.now();
      if (projects[finalHomeId]) projects[finalHomeId].lastUsedAt = now;
      if (projects[finalWorkId]) projects[finalWorkId].lastUsedAt = now;

      try {
        await chrome.storage.local.set({ projects, domainMap, taskContext, lastActiveProjectId: finalWorkId });
        teardown();
      } catch {
        saveBtn.disabled = false;
        saveBtn.textContent = mode === 'first-visit' ? 'Start tracking' : 'Save';
        homeHint.textContent = 'Something went wrong — try again.';
      }
    });
  }

  /**
   * Collapses duplicate lines within a comment string. Mirrors
   * lib/storage.js's dedupeCommentLines (duplicated here, not imported —
   * this file is dependency-free by design, see header). Exists because
   * pre-v6 versions could concatenate the SAME line into one comment
   * string many times over via repeated same-task merges.
   */
  function dedupeCommentLines(text) {
    if (!text) return text;
    const seen = new Set();
    const out = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out.join('\n');
  }

  /**
   * Read-only "so far today" reference text — never fed back into the
   * editable box. This is now literally the complete comment history for
   * the project today: every session's comment (auto-tracked or a note),
   * in chronological order, each with a time so a run of similar-looking
   * entries stays distinguishable.
   */
  function summarizeExistingNotesForProject(entries, projectId, today) {
    if (!projectId) return '';
    const byDomain = entries[today] || {};
    const items = [];
    for (const container of Object.values(byDomain)) {
      for (const s of container.sessions || []) {
        if (s.projectId !== projectId || !s.comment) continue;
        const trimmed = dedupeCommentLines(s.comment.trim());
        if (!trimmed) continue;
        items.push({ ts: s.isNote ? s.start : s.end, text: trimmed });
      }
    }
    items.sort((a, b) => a.ts - b.ts);
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const label = `${formatClockLocal(item.ts)} — ${item.text}`;
      // Dedupe on the LABEL actually shown (trimmed text + time), not
      // just raw comment text — two sessions can have visually-identical
      // text that differs only by trailing/leading whitespace (e.g. a
      // retry after noticing dropped keystrokes).
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
    return out.join('\n');
  }

  function formatClockLocal(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function findOrCreate(projects, typedName) {
    const existing = Object.values(projects).find((p) => p.name.toLowerCase() === typedName.toLowerCase());
    if (existing) return existing.id;
    const id = newId('proj');
    const now = Date.now();
    projects[id] = { id, name: typedName, category: '', hue: Math.floor(Math.random() * 360), createdAt: now, lastUsedAt: now, archived: false };
    return id;
  }

  function setupPicker({ projects, chipEl, pickerEl, searchEl, listEl, hintEl, changeBtn, initialQuery, onSelect, onManualChangeClick }) {
    guardKeyEvents(searchEl);

    function renderList(query) {
      const q = query.trim().toLowerCase();
      // Recently-used first (not alphabetical) so the project you're
      // probably after — e.g. one already linked to several other
      // domains for the same org — is at the top without typing. This is
      // purely a UI convenience; it never auto-LINKS a domain, it just
      // orders the manual picker (domain→project linking stays explicit).
      const matches = Object.values(projects)
        .filter((p) => !p.archived && p.name.toLowerCase().includes(q))
        .sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0))
        .slice(0, 6);
      listEl.innerHTML = '';
      for (const p of matches) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="swatch" style="background:hsl(${p.hue},60%,50%)"></span><span>${escapeHtml(p.name)}</span>`;
        li.addEventListener('click', () => {
          searchEl.value = p.name;
          hintEl.textContent = `Linking to existing project "${p.name}".`;
          onSelect(p.id, p.name);
        });
        listEl.appendChild(li);
      }
      const exact = Object.values(projects).find((p) => p.name.toLowerCase() === q && q.length);
      if (exact) {
        hintEl.textContent = `Linking to existing project "${exact.name}".`;
        onSelect(exact.id, exact.name);
      } else if (q.length) {
        hintEl.textContent = `Will create a new project called "${query.trim()}".`;
        onSelect(null, query.trim());
      } else {
        hintEl.textContent = 'Search an existing project or type a new name.';
      }
    }

    if (pickerEl.style.display !== 'none') {
      searchEl.value = initialQuery;
      // Deliberately rendered against an EMPTY query, not the domain's
      // subdomain-derived guess — a guess like "synlawn2025" sitting in
      // the box looked like a valid answer and could get silently saved
      // as-is, creating a near-duplicate project distinct from the real
      // one ("Synlawn") instead of linking to it. Showing the real
      // recent projects up front makes the existing one a visible
      // one-click pick, and leaving the box genuinely empty means Save
      // requires an explicit choice instead of trusting a guess.
      renderList('');
    }
    searchEl.addEventListener('input', (e) => renderList(e.target.value));
    changeBtn?.addEventListener('click', () => {
      onManualChangeClick?.();
      chipEl.style.display = 'none';
      pickerEl.style.display = '';
      searchEl.value = '';
      renderList('');
      searchEl.focus();
    });
  }

  init();
})();
