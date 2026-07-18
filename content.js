// content.js — injected into every http(s) page (broad tracking).
//
// Dependency-free by design: content scripts can't reliably use ES module
// imports across every supported Chrome version, so this talks to
// chrome.storage directly using the same shapes as lib/storage.js.
//
// Owns the first-visit-of-the-day setup overlay, and (on request from the
// action popup's "Log New Task") a follow-up overlay for retagging what
// NEW sessions on this domain should count toward, without waiting for a
// new day. There is deliberately no floating on-page button anymore — that
// affordance lives entirely in the extension icon's popup now.
//
// Two things worth knowing about how this file is structured:
//  1. ALL work — including the excluded-sites check — is deferred behind
//     a configurable delay (Settings, default ~2.5s) after the page has
//     finished loading. This keeps the extension from ever touching the
//     page during its own initial render/bootstrap, which is both a
//     performance concern and the likely cause of some Salesforce org
//     pages failing to load correctly when this ran immediately.
//  2. Every field in the overlay stops propagation on keyboard events.
//     Because the overlay lives in a closed Shadow DOM, a host page's own
//     global keyboard-shortcut handlers (Salesforce Lightning has several)
//     see events retargeted to our outer container rather than the actual
//     input — so a handler checking "is the user typing in a field?" can
//     wrongly conclude they aren't, and swallow keystrokes meant for us.

(function () {
  if (window.__orbitTimesheetInjected) return;
  window.__orbitTimesheetInjected = true;

  const domain = location.hostname.toLowerCase();

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
  function guessOrgLabel(host) {
    return host.split('.')[0].split('--')[0];
  }
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : str;
    return d.innerHTML;
  }
  // Stops the host page's own keyboard-shortcut handlers from seeing (and
  // potentially swallowing) keystrokes meant for our shadow-DOM fields —
  // see file header. Attach to every text input/textarea we create.
  function guardKeyEvents(el) {
    for (const type of ['keydown', 'keyup', 'keypress', 'input']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  async function loadAll() {
    return chrome.storage.local.get(['projects', 'domainMap', 'taskContext', 'entries', 'settings', 'excludedSites']);
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
    let dismissed = {};
    try { dismissed = await chrome.storage.session.get(dismissKey); } catch { /* ignore */ }
    if (dismissed[dismissKey]) return;

    const data = await loadAll();
    if (data.excludedSites && data.excludedSites[domain]) return;
    if (data.settings && data.settings.autoTrackEnabled === false) return;
    if (data.settings && data.settings.manuallyPaused) return;

    const today = todayStr();
    const alreadySetUpToday = Boolean(data.entries?.[today]?.[domain]);
    if (!alreadySetUpToday) {
      mountOverlay({ ...data, domain, today, dismissKey, mode: 'first-visit' });
    }
    // If already set up today, do nothing and wait quietly — retagging
    // now happens only via the extension icon's "Log New Task" action.
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'ORBIT_RECHECK') {
      runChecks();
    } else if (message?.type === 'FORCE_LOG_TASK') {
      loadAll().then((data) => {
        mountOverlay({ ...data, domain, today: todayStr(), dismissKey: `dismissed:${domain}`, mode: 'switch-task' });
      });
    }
  });

  // -------------------------------------------------------------- overlay

  async function mountOverlay(ctx) {
    if (document.getElementById('orbit-timesheet-overlay-host')) return;
    const { projects = {}, domainMap = {}, taskContext = {}, entries = {}, settings = {}, domain, today, mode } = ctx;

    const theme = settings.theme || 'system';
    const resolvedTheme = theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;

    const host = document.createElement('div');
    host.id = 'orbit-timesheet-overlay-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('pages/overlay.css');
    shadow.appendChild(link);

    const root = document.createElement('div');
    root.className = 'orbit-root';
    root.dataset.theme = resolvedTheme;

    const homeProjectId = domainMap[domain] || null;
    const homeProject = homeProjectId ? projects[homeProjectId] : null;
    const currentCtx = taskContext[domain];
    const workingProjectId = currentCtx?.projectId || homeProjectId || null;
    const workingProject = workingProjectId ? projects[workingProjectId] : null;

    // Fixing the "duplicate comments" bug: we used to prefill the comment
    // box with the FULL joined history for this project, so re-saving it
    // unchanged saved a growing blob as a "new" comment each time. Now we
    // only prefill with the CURRENT task's own last comment when
    // continuing that exact same task — otherwise the box starts empty,
    // and existing notes are shown as read-only reference text instead.
    const continuingSameTask = mode === 'switch-task' && currentCtx;
    const existingTaskName = continuingSameTask ? (currentCtx.taskName || '') : '';
    const existingComment = continuingSameTask ? (currentCtx.comment || '') : '';
    const referenceNote = summarizeExistingNotesForProject(entries, workingProjectId, today);

    root.innerHTML = `
      <div class="orbit-backdrop">
        <div class="orbit-card" role="dialog" aria-modal="true" aria-labelledby="orbitTitle">
          <div class="orbit-head">
            <div class="orbit-badge" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="9.25" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v5.2l3.4 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            </div>
            <div>
              <h1 id="orbitTitle">${mode === 'first-visit' ? 'New site detected' : 'Log a task'}</h1>
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
              <input type="text" id="orbitHomeSearch" placeholder="Search or type a new project name…" autocomplete="off" />
              <ul class="orbit-list" id="orbitHomeList"></ul>
              <p class="orbit-hint" id="orbitHomeHint"></p>
            </div>
          </div>

          <div class="orbit-field">
            <label>Currently working on <span class="orbit-sublabel">(defaults to project above — change if this block is for a different project)</span></label>
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

          <div class="orbit-field">
            <label for="orbitTaskName">Task <span class="orbit-sublabel">(short label, e.g. "Validation Rule Fix" — leave blank for general project time)</span></label>
            <input type="text" id="orbitTaskName" placeholder="What specifically?" value="${escapeHtml(existingTaskName)}" autocomplete="off" />
          </div>

          ${referenceNote ? `<div class="orbit-field"><label>So far today</label><p class="orbit-reference-note">${escapeHtml(referenceNote)}</p></div>` : ''}

          <div class="orbit-field">
            <label for="orbitComment">Comments ${continuingSameTask ? '<span class="orbit-sublabel">(continuing this task)</span>' : '<span class="orbit-sublabel">(new note for this task)</span>'}</label>
            <textarea id="orbitComment" rows="3" placeholder="What are you working on right now?">${escapeHtml(existingComment)}</textarea>
          </div>

          <div class="orbit-actions">
            <button type="button" class="orbit-btn orbit-btn-text" id="orbitCancelBtn">${mode === 'first-visit' ? 'Not now' : 'Cancel'}</button>
            <button type="button" class="orbit-btn orbit-btn-primary" id="orbitSaveBtn">${mode === 'first-visit' ? 'Start tracking' : 'Save'}</button>
          </div>
          ${mode === 'first-visit' ? '<p class="orbit-footnote">Won\'t ask again today for this site.</p>' : ''}
        </div>
      </div>
    `;

    shadow.appendChild(root);
    document.body.appendChild(host);
    requestAnimationFrame(() => root.querySelector('.orbit-backdrop').classList.add('visible'));

    // Guard every text field against the host page stealing keystrokes.
    root.querySelectorAll('input[type="text"], textarea').forEach(guardKeyEvents);

    let selectedHomeId = homeProjectId;
    let selectedWorkId = workingProjectId;
    let workTouchedByUser = false;

    const backdrop = root.querySelector('.orbit-backdrop');
    const comment = root.querySelector('#orbitComment');
    const taskNameInput = root.querySelector('#orbitTaskName');

    setupPicker({
      projects,
      chipEl: root.querySelector('#orbitHomeChip'), pickerEl: root.querySelector('#orbitHomePicker'),
      searchEl: root.querySelector('#orbitHomeSearch'), listEl: root.querySelector('#orbitHomeList'),
      hintEl: root.querySelector('#orbitHomeHint'), changeBtn: root.querySelector('#orbitChangeHomeBtn'),
      initialQuery: homeProject ? '' : guessOrgLabel(domain),
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
      if (mode === 'first-visit') {
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

      domainMap[domain] = finalHomeId;
      taskContext[domain] = {
        projectId: finalWorkId,
        taskName: taskNameInput.value.trim(),
        comment: comment.value.trim(),
        updatedAt: Date.now()
      };
      entries[today] = entries[today] || {};
      entries[today][domain] = entries[today][domain] || { sessions: [] };

      try {
        await chrome.storage.local.set({ projects, domainMap, taskContext, entries });
        teardown();
      } catch {
        saveBtn.disabled = false;
        saveBtn.textContent = mode === 'first-visit' ? 'Start tracking' : 'Save';
        homeHint.textContent = 'Something went wrong — try again.';
      }
    });
  }

  /** Read-only "so far today" reference text — never fed back into the editable box. */
  function summarizeExistingNotesForProject(entries, projectId, today) {
    if (!projectId) return '';
    const seen = new Set();
    const out = [];
    const byDomain = entries[today] || {};
    for (const container of Object.values(byDomain)) {
      for (const s of container.sessions || []) {
        if (s.projectId === projectId && s.comment && !seen.has(s.comment)) {
          seen.add(s.comment);
          const label = s.taskName ? `${s.taskName}: ${s.comment}` : s.comment;
          out.push(label);
        }
      }
    }
    return out.join('\n');
  }

  function findOrCreate(projects, typedName) {
    const existing = Object.values(projects).find((p) => p.name.toLowerCase() === typedName.toLowerCase());
    if (existing) return existing.id;
    const id = newId('proj');
    projects[id] = { id, name: typedName, category: 'Admin / Other', hue: Math.floor(Math.random() * 360), createdAt: Date.now(), archived: false };
    return id;
  }

  function setupPicker({ projects, chipEl, pickerEl, searchEl, listEl, hintEl, changeBtn, initialQuery, onSelect, onManualChangeClick }) {
    guardKeyEvents(searchEl);

    function renderList(query) {
      const q = query.trim().toLowerCase();
      const matches = Object.values(projects)
        .filter((p) => !p.archived && p.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name))
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
      renderList(initialQuery);
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
