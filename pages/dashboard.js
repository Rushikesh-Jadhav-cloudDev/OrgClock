// pages/dashboard.js — the main OrgClock dashboard.

import {
  getProjects, getDomainMap, getTaskContext, getEntries, getArchives,
  getSettings, updateSettings, getActiveSession, getManualAdjustments,
  linkDomainToProject, editSession, deleteSession,
  mergeSessions, addManualSession, setManualAdjustment, renameProject,
  setProjectCategory, restoreArchivedWeek, createProject, flattenDaySessions,
  groupDayByProject, getDayCommentLog, consolidateProjectSessions, getExcludedSites,
  addExcludedSite, removeExcludedSite, getGlobalActivity, getGlobalActiveSession,
  getAllDismissedThisSession, clearDismissal, getAllCategories, addCustomCategory,
  renameCategory, deleteCategory, deleteProjectPermanently, getAlwaysPromptSites,
  addAlwaysPromptSite, removeAlwaysPromptSite, deleteSessionsInRange, deleteSessionsOlderThan,
  exportFullBackup, importFullBackup, addQuickNote, MANUAL_NOTE_DOMAIN
} from '../lib/storage.js';
import {
  dateStr, parseDateStr, weekStartStr, weekEndStr, friendlyDate, friendlyWeekRange,
  formatDuration, formatClock
} from '../lib/dateUtils.js';

// ------------------------------------------------------------------ state

let state = {
  projects: {},
  domainMap: {},
  taskContext: {},
  entries: {},
  archives: {},
  manualAdjustments: {},
  settings: {},
  activeSession: null,
  excludedSites: {},
  alwaysPromptSites: {},
  globalActivity: {},
  globalActiveSession: null
};
let todayBaseMs = 0;
let weekBaseMs = 0;
let chromeActiveBaseMs = 0;
let collapsedDays = new Set();
let currentView = 'history';
let timelineDate = dateStr();
let sessionSummaryDate = dateStr();
let tsWeekStart = weekStartStr();
let allCategories = [];

const $ = (id) => document.getElementById(id);
const el = {
  statusPill: $('statusPill'), statusText: $('statusText'), statusTimer: $('statusTimer'),
  statToday: $('statToday'), statWeek: $('statWeek'), statOrgs: $('statOrgs'), statSessions: $('statSessions'),
  statChromeActive: $('statChromeActive'), statProductive: $('statProductive'),
  history: $('history'), emptyState: $('emptyState'), rolloverBanner: $('rolloverBanner'), dismissBanner: $('dismissBanner'),
  exportBtn: $('exportBtn'), themeBtn: $('themeBtn'), settingsBtn: $('settingsBtn'),
  entryModalOverlay: $('entryModalOverlay'), entryModalBody: $('entryModalBody'), entryModalTitle: $('entryModalTitle'),
  closeEntryModal: $('closeEntryModal'),
  settingsOverlay: $('settingsOverlay'), closeSettings: $('closeSettings'),
  idleSlider: $('idleSlider'), idleValue: $('idleValue'),
  mergeGapSlider: $('mergeGapSlider'), mergeGapValue: $('mergeGapValue'),
  screenGraceSlider: $('screenGraceSlider'), screenGraceValue: $('screenGraceValue'),
  popupDelaySlider: $('popupDelaySlider'), popupDelayValue: $('popupDelayValue'),
  autoTrackToggle: $('autoTrackToggle'), autoTrackValue: $('autoTrackValue'),
  themeSelect: $('themeSelect'),
  settingsProjectList: $('settingsProjectList'),
  categoriesList: $('categoriesList'),
  newCategoryInput: $('newCategoryInput'), addCategoryBtn: $('addCategoryBtn'),
  exportWeekBtn: $('exportWeekBtn'), exportAllBtn: $('exportAllBtn'),
  exportWeekDetailBtn: $('exportWeekDetailBtn'), exportAllDetailBtn: $('exportAllDetailBtn'),
  exportSessionsBtn: $('exportSessionsBtn'),
  excludedSitesList: $('excludedSitesList'), newExcludeInput: $('newExcludeInput'),
  addExcludeBtn: $('addExcludeBtn'), addExcludeHint: $('addExcludeHint'),
  alwaysPromptSitesList: $('alwaysPromptSitesList'), newAlwaysPromptInput: $('newAlwaysPromptInput'),
  addAlwaysPromptBtn: $('addAlwaysPromptBtn'), addAlwaysPromptHint: $('addAlwaysPromptHint'),
  deleteLastWeekBtn: $('deleteLastWeekBtn'), deleteLastMonthBtn: $('deleteLastMonthBtn'),
  deleteOlderMonthsInput: $('deleteOlderMonthsInput'), deleteOlderMonthsBtn: $('deleteOlderMonthsBtn'),
  deleteRangeStart: $('deleteRangeStart'), deleteRangeEnd: $('deleteRangeEnd'),
  deleteCustomRangeBtn: $('deleteCustomRangeBtn'), deleteDataHint: $('deleteDataHint'),
  downloadBackupBtn: $('downloadBackupBtn'), restoreBackupBtn: $('restoreBackupBtn'),
  restoreBackupInput: $('restoreBackupInput'), backupHint: $('backupHint'),
  pendingPromptsField: $('pendingPromptsField'), pendingPromptsList: $('pendingPromptsList'),
  viewTabs: document.querySelectorAll('.view-tab'),
  timelineView: $('timelineView'), timelineTrack: $('timelineTrack'),
  timelineDateLabel: $('timelineDateLabel'), timelinePrevDay: $('timelinePrevDay'), timelineNextDay: $('timelineNextDay'),
  sessionSummaryView: $('sessionSummaryView'), sessionSummaryList: $('sessionSummaryList'),
  sessionsDateLabel: $('sessionsDateLabel'), sessionsPrevDay: $('sessionsPrevDay'), sessionsNextDay: $('sessionsNextDay'),
  notesCopyBtn: $('notesCopyBtn'),
  timesheetView: $('timesheetView'), tsWeekLabel: $('tsWeekLabel'),
  tsPrevWeek: $('tsPrevWeek'), tsNextWeek: $('tsNextWeek'), tsCopyBtn: $('tsCopyBtn'),
  tsHeadRow: $('tsHeadRow'), tsBody: $('tsBody'), tsFootRow: $('tsFootRow')
};

// ------------------------------------------------------------------ init

async function loadState() {
  const [projects, domainMap, taskContext, entries, archives, manualAdjustments,
    settings, activeSession, excludedSites, alwaysPromptSites, globalActivity, globalActiveSession, categories] = await Promise.all([
    getProjects(), getDomainMap(), getTaskContext(), getEntries(), getArchives(), getManualAdjustments(),
    getSettings(), getActiveSession(), getExcludedSites(), getAlwaysPromptSites(), getGlobalActivity(), getGlobalActiveSession(),
    getAllCategories()
  ]);
  state = { projects, domainMap, taskContext, entries, archives, manualAdjustments, settings, activeSession, excludedSites, alwaysPromptSites, globalActivity, globalActiveSession };
  allCategories = categories;
}

async function init() {
  await loadState();
  applyTheme();
  renderAll();
  wireStaticEvents();
  await checkRolloverNotice();
  setInterval(tick, 1000);
  chrome.storage.onChanged.addListener(onStorageChanged);
}

async function checkRolloverNotice() {
  const { pendingRolloverNotice } = await chrome.storage.local.get('pendingRolloverNotice');
  if (pendingRolloverNotice) el.rolloverBanner.classList.remove('hidden');
}

let reloadQueued = false;
function onStorageChanged(changes, area) {
  if (area !== 'local' && area !== 'session') return;
  if (reloadQueued) return;
  reloadQueued = true;
  setTimeout(async () => {
    reloadQueued = false;
    await loadState();
    renderAll();
  }, 250);
}

// ------------------------------------------------------------------ theme

function applyTheme() {
  const theme = state.settings.theme || 'system';
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
  $('themeIcon').innerHTML = resolved === 'dark'
    ? '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="currentColor"/>'
    : '<circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
}

// ------------------------------------------------------------------ shared data helpers

function getByDomainForDate(date) {
  if (state.entries[date]) return state.entries[date];
  for (const archive of Object.values(state.archives)) {
    if (archive.entries[date]) return archive.entries[date];
  }
  return {};
}
function getManualAdjustmentsForDate(date) {
  if (state.manualAdjustments[date]) return state.manualAdjustments[date];
  for (const archive of Object.values(state.archives)) {
    if (archive.entries[date]) return archive.manualAdjustments?.[date] || {};
  }
  return {};
}
function isArchivedDate(date) {
  if (state.entries[date]) return null;
  for (const [weekStart, archive] of Object.entries(state.archives)) {
    if (archive.entries[date]) return weekStart;
  }
  return null;
}
function projectGroupsForDate(date) {
  return groupDayByProject(getByDomainForDate(date), getManualAdjustmentsForDate(date));
}
function shiftDateStr(ds, deltaDays) {
  const d = parseDateStr(ds);
  d.setDate(d.getDate() + deltaDays);
  return dateStr(d);
}
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : str;
  return d.innerHTML;
}

// ------------------------------------------------------------------ render dispatch

function renderAll() {
  renderStatusPill();
  renderStats();
  renderHistory();
  renderTimeline();
  renderSessionSummary();
  renderTimesheet();
  if (!el.settingsOverlay.classList.contains('hidden')) renderSettingsPanel();
}

function currentBilledProjectId(activeSession) {
  if (!activeSession) return null;
  const ctx = state.taskContext[activeSession.domain];
  return ctx?.projectId || state.domainMap[activeSession.domain] || null;
}

function renderStatusPill() {
  const active = state.activeSession;
  if (active) {
    const projectId = currentBilledProjectId(active);
    const project = projectId ? state.projects[projectId] : null;
    el.statusPill.dataset.state = 'tracking';
    el.statusText.textContent = `Tracking · ${project ? project.name : active.domain}`;
    el.statusTimer.classList.remove('hidden');
  } else {
    el.statusPill.dataset.state = 'idle';
    el.statusText.textContent = 'Not tracking';
    el.statusTimer.textContent = '';
    el.statusTimer.classList.add('hidden');
  }
}

function renderStats() {
  const today = dateStr();
  const wStart = weekStartStr();
  const wEnd = weekEndStr(wStart);

  const todayGroups = projectGroupsForDate(today);
  todayBaseMs = todayGroups.reduce((sum, g) => sum + g.totalMs, 0);
  const sessionsToday = flattenDaySessions(state.entries[today] || {}).length;

  let weekSum = 0;
  const cursor = parseDateStr(wStart);
  for (let i = 0; i < 7; i++) {
    const ds = dateStr(cursor);
    if (ds <= wEnd) weekSum += projectGroupsForDate(ds).reduce((s, g) => s + g.totalMs, 0);
    cursor.setDate(cursor.getDate() + 1);
  }
  weekBaseMs = weekSum;

  chromeActiveBaseMs = state.globalActivity[today] || 0;

  el.statToday.textContent = formatDuration(todayBaseMs);
  el.statWeek.textContent = formatDuration(weekBaseMs);
  el.statOrgs.textContent = String(todayGroups.length);
  el.statSessions.textContent = String(sessionsToday);
  el.statChromeActive.textContent = formatDuration(chromeActiveBaseMs);
  el.statProductive.textContent = productivePct(todayBaseMs, chromeActiveBaseMs);
}

function productivePct(trackedMs, totalMs) {
  if (!totalMs) return '—';
  return `${Math.min(100, Math.round((trackedMs / totalMs) * 100))}%`;
}

// ------------------------------------------------------------------ history (project-grouped)

function groupRange(group) {
  if (!group.sessions.length) return '—';
  const starts = group.sessions.map((s) => s.start);
  const ends = group.sessions.map((s) => s.end);
  return `${formatClock(Math.min(...starts))} – ${formatClock(Math.max(...ends))}`;
}

function buildProjectCard(date, group, { archived, weekStart }) {
  const project = state.projects[group.projectId];
  const active = state.activeSession;
  const isLive = !archived && active && active.date === date && currentBilledProjectId(active) === group.projectId;

  const card = document.createElement('div');
  card.className = 'entry-card' + (isLive ? ' live' : '');
  card.style.setProperty('--entry-hue', project ? `hsl(${project.hue}, 60%, 50%)` : 'var(--primary)');

  const domainsLabel = group.domains.join(', ');

  card.innerHTML = `
    <div class="entry-main">
      <div class="entry-top">
        <span class="entry-project">${escapeHtml(project ? project.name : '(unknown project)')}</span>
        ${project?.category ? `<span class="entry-domain">${escapeHtml(project.category)}</span>` : ''}
        ${isLive ? '<span class="live-tag">LIVE</span>' : ''}
      </div>
      <p class="entry-domain" style="margin-top:3px;">${escapeHtml(domainsLabel)}</p>
      <p class="entry-desc">${escapeHtml(group.displayNote || '(no comments)')}</p>
      <div class="entry-meta">
        <span>${groupRange(group)}</span>
        <span>${group.sessions.length} session${group.sessions.length === 1 ? '' : 's'}</span>
      </div>
    </div>
    <div class="entry-side">
      <span class="entry-total mono ${isLive ? 'live-elapsed' : ''}" data-base-ms="${group.totalMs}">${formatDuration(group.totalMs)}</span>
      <button class="entry-edit-btn" type="button">${archived ? 'View' : 'Edit'}</button>
    </div>
  `;

  card.querySelector('.entry-edit-btn').addEventListener('click', () => openProjectModal(date, group, { archived, weekStart }));
  return card;
}

function buildDayGroup(date, { archived, weekStart }) {
  const groups = projectGroupsForDate(date).sort((a, b) => {
    const pa = state.projects[a.projectId]?.name || '';
    const pb = state.projects[b.projectId]?.name || '';
    return pa.localeCompare(pb);
  });
  const dayTotal = groups.reduce((s, g) => s + g.totalMs, 0);
  const chromeMs = state.globalActivity[date] || 0;

  const group = document.createElement('div');
  group.className = 'day-group';
  const key = date + (archived ? ':a' : '');
  if (collapsedDays.has(key)) group.classList.add('collapsed');

  const head = document.createElement('div');
  head.className = 'day-head';
  head.innerHTML = `
    <span class="chevron">▾</span>
    <h3>${friendlyDate(date)}</h3>
    <span class="day-total mono">${formatDuration(dayTotal)}${chromeMs ? `<span class="day-total-sub">/ ${formatDuration(chromeMs)} Chrome active</span>` : ''}</span>
  `;
  head.addEventListener('click', () => {
    group.classList.toggle('collapsed');
    if (group.classList.contains('collapsed')) collapsedDays.add(key); else collapsedDays.delete(key);
  });

  const list = document.createElement('div');
  list.className = 'entry-list';
  for (const g of groups) list.appendChild(buildProjectCard(date, g, { archived, weekStart }));
  if (!groups.length) list.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary);padding:4px;">No sessions.</p>';

  group.append(head, list);
  return group;
}

function renderHistory() {
  el.history.innerHTML = '';
  const liveDates = Object.keys(state.entries)
    .filter((d) => Object.values(state.entries[d]).some((c) => c.sessions.length))
    .sort().reverse();
  const archiveWeeks = Object.keys(state.archives).sort().reverse();

  const hasAnything = liveDates.length > 0 || archiveWeeks.length > 0;
  el.emptyState.classList.toggle('hidden', hasAnything || currentView !== 'history');
  if (currentView !== 'history') return;
  if (!hasAnything) return;

  for (const date of liveDates) {
    el.history.appendChild(buildDayGroup(date, { archived: false, weekStart: null }));
  }
  for (const weekStart of archiveWeeks) {
    const archive = state.archives[weekStart];
    const header = document.createElement('div');
    header.className = 'week-super';
    header.innerHTML = `<span>Week of ${friendlyWeekRange(weekStart)}</span><span class="archived-tag">Archived</span>`;
    el.history.appendChild(header);
    const dates = Object.keys(archive.entries).sort().reverse();
    for (const date of dates) el.history.appendChild(buildDayGroup(date, { archived: true, weekStart }));
  }
}

// ------------------------------------------------------------------ ticking

function tick() {
  const active = state.activeSession;
  const globalActive = state.globalActiveSession;
  const today = dateStr();

  let liveChromeMs = chromeActiveBaseMs;
  if (globalActive && globalActive.date === today) {
    liveChromeMs = chromeActiveBaseMs + (Date.now() - globalActive.startTs);
    el.statChromeActive.textContent = formatDuration(liveChromeMs);
  }

  if (!active) {
    el.statProductive.textContent = productivePct(todayBaseMs, liveChromeMs);
    return;
  }
  const elapsed = Date.now() - active.startTs;
  el.statusTimer.textContent = formatDuration(elapsed, { seconds: true });

  if (active.date === today) {
    el.statToday.textContent = formatDuration(todayBaseMs + elapsed);
    el.statWeek.textContent = formatDuration(weekBaseMs + elapsed);
    el.statProductive.textContent = productivePct(todayBaseMs + elapsed, liveChromeMs);
  }

  document.querySelectorAll('.live-elapsed').forEach((node) => {
    const base = Number(node.dataset.baseMs || 0);
    node.textContent = formatDuration(base + elapsed);
  });
}

// ------------------------------------------------------------------ entry modal

function toLocalInputValue(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInputValue(v) {
  return new Date(v).getTime();
}

function openProjectModal(date, group, { archived, weekStart }) {
  const project = state.projects[group.projectId];
  el.entryModalTitle.textContent = `${project ? project.name : '(unknown)'} — ${friendlyDate(date, { noRelative: true })}`;
  el.entryModalBody.innerHTML = '';
  if (archived) {
    el.entryModalBody.appendChild(buildArchivedProjectView(group, weekStart));
  } else {
    el.entryModalBody.appendChild(buildLiveProjectEditView(date, group));
  }
  el.entryModalOverlay.classList.remove('hidden');
}

function buildArchivedProjectView(group, weekStart) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field"><label>Sites</label><p class="mono" style="font-size:12.5px;">${escapeHtml(group.domains.join(', '))}</p></div>
    <div class="field"><label>Comments</label><p style="white-space:pre-wrap;font-size:13px;">${escapeHtml(group.displayNote || '(none)')}</p></div>
    <div class="field"><label>Sessions</label>
      <div class="session-table">
        ${group.sessions.map((s) => `<div class="session-row" style="grid-template-columns:auto 1fr auto;">
          <span class="mono" style="font-size:11px;color:var(--text-tertiary);">${escapeHtml(s.domain)}</span>
          <span>${formatClock(s.start)} – ${formatClock(s.end)}</span>
          <span class="session-duration mono">${formatDuration(s.end - s.start)}</span>
        </div>`).join('') || '<p style="font-size:12.5px;color:var(--text-tertiary)">No sessions recorded.</p>'}
      </div>
    </div>
    <p style="font-size:12px;color:var(--text-tertiary)">This week has been archived and is read-only. Restore it to make edits.</p>
    <div class="modal-footer">
      <button class="btn btn-text" id="restoreWeekBtn">Restore this week for editing</button>
      <button class="btn btn-primary" id="closeArchivedView">Done</button>
    </div>
  `;
  wrap.querySelector('#restoreWeekBtn').addEventListener('click', async () => {
    await restoreArchivedWeek(weekStart);
    await loadState();
    renderAll();
    closeEntryModal();
  });
  wrap.querySelector('#closeArchivedView').addEventListener('click', closeEntryModal);
  return wrap;
}

function buildLiveProjectEditView(date, group) {
  const wrap = document.createElement('div');

  // --- Add a note: always blank, saved instantly as its own standalone
  // timestamped entry — never a persistent field something else can
  // silently override or block. That silent-override was exactly the bug
  // (the old single "overall notes" field permanently won over anything
  // added afterward from the popup).
  const addNoteField = document.createElement('div');
  addNoteField.className = 'field';
  addNoteField.innerHTML = `<label for="quickNoteArea">Add a note</label>
    <textarea id="quickNoteArea" rows="2" placeholder="What's happening right now?"></textarea>
    <div style="display:flex;justify-content:flex-end;margin-top:6px;">
      <button type="button" class="btn btn-primary" id="quickNoteAddBtn">Add</button>
    </div>`;
  addNoteField.querySelector('#quickNoteAddBtn').addEventListener('click', async () => {
    const textarea = addNoteField.querySelector('#quickNoteArea');
    const text = textarea.value.trim();
    if (!text) return;
    await addQuickNote(date, MANUAL_NOTE_DOMAIN, group.projectId, text);
    await loadState();
    reopenThisProjectModal(date, group.projectId);
  });

  // --- Today's full comment history, in order. Always complete — every
  // note shows up, nothing here can silently block a later one.
  const historyField = document.createElement('div');
  historyField.className = 'field';
  const log = getDayCommentLog(getByDomainForDate(date)).filter((n) => n.projectId === group.projectId);
  historyField.innerHTML = `<label>Today's notes${log.length ? ` <span style="font-weight:400;color:var(--text-tertiary)">(${log.length})</span>` : ''}</label>`;
  const historyList = document.createElement('div');
  historyList.className = 'note-history';
  for (const entry of log) {
    const row = document.createElement('div');
    row.className = 'note-entry';
    row.innerHTML = `<span class="mono note-entry-time">${formatClock(entry.ts)}</span>
      <span class="note-entry-text">${escapeHtml(entry.comment)}</span>
      <button type="button" class="row-btn" title="Delete note">✕</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      await deleteSession(date, entry.domain, entry.id);
      await loadState();
      reopenThisProjectModal(date, group.projectId);
    });
    historyList.appendChild(row);
  }
  if (!log.length) historyList.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary);">No notes yet today for this project.</p>';
  historyField.appendChild(historyList);

  // --- Linked sites (permanent home project per domain)
  const sitesField = document.createElement('div');
  sitesField.className = 'field';
  sitesField.innerHTML = `<label>Sites contributing today <span style="font-weight:400;color:var(--text-tertiary)">(each site's permanent project link)</span></label>`;
  const sitesList = document.createElement('div');
  sitesList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  for (const domain of group.domains) {
    if (domain === MANUAL_NOTE_DOMAIN) continue; // not a real site, nothing to relink
    const homeId = state.domainMap[domain];
    const homeProject = homeId ? state.projects[homeId] : null;
    const row = document.createElement('div');
    row.className = 'linked-chip';
    row.innerHTML = `<span class="dot" style="background:hsl(${homeProject ? homeProject.hue : 0},60%,50%)"></span>
      <span class="mono" style="font-size:11.5px;flex:1;">${escapeHtml(domain)}</span>
      <span style="font-size:11.5px;color:var(--text-tertiary);">→ ${escapeHtml(homeProject ? homeProject.name : '?')}</span>
      <button type="button" class="text-btn" data-domain="${escapeHtml(domain)}">Relink</button>`;
    row.querySelector('button').addEventListener('click', (e) => openRelinkPicker(e.target, domain));
    sitesList.appendChild(row);
  }
  sitesField.appendChild(sitesList);

  // --- Advanced: individual tracked sessions (collapsed by default).
  // Notes (isNote) are excluded here — they live in "Today's notes"
  // above; this table is genuine tracked time only.
  const trackedSessions = () => group.sessions.filter((s) => !s.isNote);
  const details = document.createElement('details');
  details.className = 'advanced-details';
  const summary = document.createElement('summary');
  summary.textContent = `Advanced: ${trackedSessions().length} raw session${trackedSessions().length === 1 ? '' : 's'} & times`;
  details.appendChild(summary);

  const table = document.createElement('div');
  table.className = 'session-table';

  const toolbar = document.createElement('div');
  toolbar.className = 'session-toolbar';
  const domainOptions = group.domains.filter((d) => d !== MANUAL_NOTE_DOMAIN).map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  toolbar.innerHTML = `
    <select id="addSessionDomain" style="font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border-strong);">${domainOptions}</select>
    <button type="button" class="btn btn-text" id="addSessionBtn">+ Add manual session</button>
    <button type="button" class="btn btn-text" id="mergeBtn" disabled>Merge selected (same site)</button>
    <button type="button" class="btn btn-text" id="consolidateBtn">Consolidate nearby sessions</button>
  `;

  let localSessions = trackedSessions().map((s) => ({ ...s }));

  function renderSessions() {
    table.innerHTML = '';
    const sorted = [...localSessions].sort((a, b) => a.start - b.start);
    for (const s of sorted) {
      const row = document.createElement('div');
      row.className = 'session-row';
      row.innerHTML = `
        <input type="checkbox" class="mergeCheck" data-id="${s.id}" data-domain="${escapeHtml(s.domain)}" />
        <input type="datetime-local" class="startInput" value="${toLocalInputValue(s.start)}" />
        <input type="datetime-local" class="endInput" value="${toLocalInputValue(s.end)}" />
        <span class="session-duration mono">${formatDuration(s.end - s.start)}</span>
        <span class="manual-tag" title="${escapeHtml(s.domain)}">${escapeHtml(s.domain.split('.')[0])}${s.manual ? ' · manual' : ''}</span>
        <button type="button" class="row-btn" title="Delete session">✕</button>
      `;
      const [checkbox, startInput, endInput] = row.querySelectorAll('input[type="datetime-local"], input[type="checkbox"]');
      const delBtn = row.querySelector('.row-btn');

      const commit = async () => {
        try {
          await editSession(date, s.domain, s.id, { start: fromLocalInputValue(startInput.value), end: fromLocalInputValue(endInput.value) });
          await loadState();
          refreshGroupAndRerender();
        } catch (err) { alert(err.message); }
      };
      startInput.addEventListener('change', commit);
      endInput.addEventListener('change', commit);
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this session?')) return;
        await deleteSession(date, s.domain, s.id);
        await loadState();
        refreshGroupAndRerender();
      });
      checkbox.addEventListener('change', updateMergeButton);
      table.appendChild(row);
    }
    if (!sorted.length) table.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary)">No sessions yet.</p>';
  }

  function updateMergeButton() {
    const checked = [...table.querySelectorAll('.mergeCheck:checked')];
    const btn = toolbar.querySelector('#mergeBtn');
    btn.disabled = !(checked.length === 2 && checked[0].dataset.domain === checked[1].dataset.domain);
  }

  toolbar.querySelector('#mergeBtn').addEventListener('click', async () => {
    const checked = [...table.querySelectorAll('.mergeCheck:checked')];
    if (checked.length !== 2) return;
    await mergeSessions(date, checked[0].dataset.domain, checked[0].dataset.id, checked[1].dataset.id);
    await loadState();
    refreshGroupAndRerender();
  });

  toolbar.querySelector('#addSessionBtn').addEventListener('click', async () => {
    const domain = toolbar.querySelector('#addSessionDomain').value;
    const now = Date.now();
    try {
      await addManualSession(date, domain, now - 30 * 60 * 1000, now, group.projectId, '');
      await loadState();
      refreshGroupAndRerender();
    } catch (err) { alert(err.message); }
  });

  toolbar.querySelector('#consolidateBtn').addEventListener('click', async () => {
    const removed = await consolidateProjectSessions(date, group.projectId, state.settings.mergeGapSeconds ?? 90);
    await loadState();
    refreshGroupAndRerender();
    toolbar.querySelector('#consolidateBtn').textContent = removed ? `Merged ${removed} session${removed === 1 ? '' : 's'}` : 'Nothing to merge';
    setTimeout(() => { toolbar.querySelector('#consolidateBtn').textContent = 'Consolidate nearby sessions'; }, 2000);
  });

  function refreshGroupAndRerender() {
    const fresh = projectGroupsForDate(date).find((g) => g.projectId === group.projectId);
    group.sessions = fresh ? fresh.sessions : [];
    localSessions = trackedSessions().map((s) => ({ ...s }));
    summary.textContent = `Advanced: ${localSessions.length} raw session${localSessions.length === 1 ? '' : 's'} & times`;
    renderSessions();
    renderAll();
  }

  renderSessions();
  details.append(toolbar, table);

  // --- Manual adjustment
  const adjField = document.createElement('div');
  adjField.className = 'field';
  adjField.innerHTML = `<label>Manual adjustment (minutes, +/-)</label>
    <div class="adjustment-row">
      <input type="number" id="adjInput" value="${Math.round((group.adjustmentMs || 0) / 60000)}" />
      <span style="font-size:12px;color:var(--text-tertiary)">Nudges the project's total for this day without altering session rows.</span>
    </div>`;
  adjField.querySelector('#adjInput').addEventListener('change', async (e) => {
    const minutes = Number(e.target.value) || 0;
    await setManualAdjustment(date, group.projectId, minutes * 60000);
    await loadState();
    renderAll();
  });

  // --- Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `
    <button type="button" class="btn btn-text" id="deleteEntryBtn" style="color:var(--error)">Delete all of today's time for this project</button>
    <button type="button" class="btn btn-primary" id="doneBtn">Done</button>
  `;
  footer.querySelector('#deleteEntryBtn').addEventListener('click', async () => {
    if (!confirm('Delete all tracked time and notes for this project on this day? This cannot be undone.')) return;
    for (const s of group.sessions) await deleteSession(date, s.domain, s.id);
    await loadState();
    renderAll();
    closeEntryModal();
  });
  footer.querySelector('#doneBtn').addEventListener('click', closeEntryModal);

  wrap.append(addNoteField, historyField, sitesField, details, adjField, footer);
  return wrap;
}

/** Re-finds the project's fresh group after a note add/delete and re-opens the modal on it, so the edit stays visible without a jarring full close/reopen. */
function reopenThisProjectModal(date, projectId) {
  renderAll();
  const fresh = projectGroupsForDate(date).find((g) => g.projectId === projectId);
  if (fresh) {
    openProjectModal(date, fresh, { archived: false, weekStart: null });
  } else {
    closeEntryModal();
  }
}

function openRelinkPicker(anchorBtn, domain) {
  const currentName = state.projects[state.domainMap[domain]]?.name || '';
  const typedRaw = prompt(`Relink ${domain} to which project? Type the exact project name (existing or new).`, currentName);
  if (typedRaw == null) return;
  const typed = typedRaw.trim();
  if (!typed) return;
  (async () => {
    const existing = Object.values(state.projects).find((p) => p.name.toLowerCase() === typed.toLowerCase());
    const projectId = existing ? existing.id : (await createProject(typed)).id;
    await linkDomainToProject(domain, projectId);
    await loadState();
    renderAll();
  })();
}

function closeEntryModal() {
  el.entryModalOverlay.classList.add('hidden');
}

// ------------------------------------------------------------------ timeline view

function renderTimeline() {
  if (currentView !== 'timeline') return;
  el.timelineDateLabel.textContent = friendlyDate(timelineDate, { noRelative: true }) + (timelineDate === dateStr() ? ' (Today)' : '');
  const byDomain = getByDomainForDate(timelineDate);
  const sessions = flattenDaySessions(byDomain).sort((a, b) => a.start - b.start);

  el.timelineTrack.innerHTML = '';
  if (!sessions.length) {
    el.timelineTrack.innerHTML = '<p style="font-size:13px;color:var(--text-tertiary);padding:20px 4px;">No tracked time on this day.</p>';
    return;
  }
  const track = document.createElement('div');
  track.className = 'timeline-track-row';
  for (const s of sessions) {
    const project = state.projects[s.projectId];
    const block = document.createElement('div');
    block.className = 'timeline-block';
    block.style.setProperty('--entry-hue', project ? `hsl(${project.hue}, 60%, 50%)` : 'var(--primary)');
    block.innerHTML = `
      <span class="tl-time">${formatClock(s.start)} – ${formatClock(s.end)}</span>
      <div class="tl-main">
        <span class="tl-project">${escapeHtml(project ? project.name : '(unknown)')} <span class="mono" style="font-weight:400;font-size:11px;color:var(--text-tertiary);">· ${escapeHtml(s.domain)}</span></span>
        ${s.comment ? `<p class="tl-comment">${escapeHtml(s.comment)}</p>` : ''}
      </div>
      <span class="tl-duration">${formatDuration(s.end - s.start)}</span>
    `;
    track.appendChild(block);
  }
  el.timelineTrack.appendChild(track);
}

function renderSessionSummary() {
  if (currentView !== 'sessions') return;
  el.sessionsDateLabel.textContent = friendlyDate(sessionSummaryDate, { noRelative: true }) + (sessionSummaryDate === dateStr() ? ' (Today)' : '');
  const byDomain = getByDomainForDate(sessionSummaryDate);
  const notes = getDayCommentLog(byDomain);

  el.sessionSummaryList.innerHTML = '';
  if (!notes.length) {
    el.sessionSummaryList.innerHTML = '<p style="font-size:13px;color:var(--text-tertiary);padding:20px 4px;">No notes on this day.</p>';
    return;
  }
  for (const n of notes) {
    const project = state.projects[n.projectId];
    const block = document.createElement('div');
    block.className = 'task-block';
    block.style.setProperty('--entry-hue', project ? `hsl(${project.hue}, 60%, 50%)` : 'var(--primary)');
    block.innerHTML = `
      <div class="task-main">
        <p class="task-title">${escapeHtml(project ? project.name : '(unknown)')}</p>
        <p class="task-sites">${escapeHtml(n.comment)}</p>
      </div>
      <span class="task-duration mono" style="font-size:12.5px;font-weight:600;">${formatClock(n.ts)}</span>
    `;
    block.addEventListener('click', () => {
      const projectGroups = projectGroupsForDate(sessionSummaryDate);
      const group = projectGroups.find((g) => g.projectId === n.projectId);
      if (group) openProjectModal(sessionSummaryDate, group, { archived: Boolean(isArchivedDate(sessionSummaryDate)), weekStart: isArchivedDate(sessionSummaryDate) });
    });
    el.sessionSummaryList.appendChild(block);
  }
}

// ------------------------------------------------------------------ timesheet summary view

function decimalHours(ms) {
  return (ms / 3600000).toFixed(2);
}

function renderTimesheet() {
  if (currentView !== 'timesheet') return;
  el.tsWeekLabel.textContent = friendlyWeekRange(tsWeekStart);

  const days = [];
  const cursor = parseDateStr(tsWeekStart);
  for (let i = 0; i < 7; i++) { days.push(dateStr(cursor)); cursor.setDate(cursor.getDate() + 1); }

  const perDayGroups = {};
  for (const d of days) perDayGroups[d] = projectGroupsForDate(d);

  const projectIds = new Set();
  for (const d of days) for (const g of perDayGroups[d]) projectIds.add(g.projectId);

  el.tsHeadRow.innerHTML = '<th>Project</th>' +
    days.map((d) => `<th>${parseDateStr(d).toLocaleDateString(undefined, { weekday: 'short' })}<br><span style="font-weight:400;">${parseDateStr(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span></th>`).join('') +
    '<th>Total</th>';

  el.tsBody.innerHTML = '';
  const dayTotals = days.map(() => 0);
  let grandTotal = 0;

  const sortedProjectIds = [...projectIds].sort((a, b) => (state.projects[a]?.name || '').localeCompare(state.projects[b]?.name || ''));

  for (const projectId of sortedProjectIds) {
    const project = state.projects[projectId];
    let rowTotal = 0;
    const cells = days.map((d, i) => {
      const g = perDayGroups[d].find((x) => x.projectId === projectId);
      const ms = g ? g.totalMs : 0;
      rowTotal += ms;
      dayTotals[i] += ms;
      const hasNote = g && g.displayNote;
      return { ms, date: d, hasNote, group: g };
    });
    grandTotal += rowTotal;

    const tr = document.createElement('tr');
    const projectCell = document.createElement('td');
    projectCell.innerHTML = `<div class="ts-project-cell"><span class="swatch" style="background:hsl(${project ? project.hue : 0},60%,50%)"></span>
      <span>${escapeHtml(project ? project.name : '(unknown)')}${project?.category ? `<span class="ts-category">${escapeHtml(project.category)}</span>` : ''}</span></div>`;
    tr.appendChild(projectCell);

    for (const cell of cells) {
      const td = document.createElement('td');
      td.className = 'mono ts-hour-cell';
      td.innerHTML = (cell.ms ? formatDuration(cell.ms) : '—') + (cell.hasNote ? '<span class="ts-comment-dot" title="Has a comment"></span>' : '');
      td.title = cell.group?.displayNote || '';
      td.addEventListener('click', () => {
        if (cell.group) openProjectModal(cell.date, cell.group, { archived: Boolean(isArchivedDate(cell.date)), weekStart: isArchivedDate(cell.date) });
      });
      tr.appendChild(td);
    }
    const totalTd = document.createElement('td');
    totalTd.className = 'mono';
    totalTd.textContent = formatDuration(rowTotal);
    tr.appendChild(totalTd);
    el.tsBody.appendChild(tr);
  }

  if (!sortedProjectIds.length) {
    el.tsBody.innerHTML = `<tr><td colspan="${days.length + 2}" style="text-align:center;color:var(--text-tertiary);padding:24px;">No tracked time this week.</td></tr>`;
  }

  el.tsFootRow.innerHTML = '<td>Total</td>' +
    dayTotals.map((ms) => `<td class="mono">${formatDuration(ms)}</td>`).join('') +
    `<td class="mono">${formatDuration(grandTotal)}</td>`;

  el.tsCopyBtn.onclick = () => copyTimesheetForReplicon(days, sortedProjectIds, perDayGroups, dayTotals, grandTotal);
}

function copyTimesheetForReplicon(days, projectIds, perDayGroups, dayTotals, grandTotal) {
  const header = ['Project', ...days.map((d) => parseDateStr(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })), 'Total', 'Comments'];
  const rows = [header];
  for (const projectId of projectIds) {
    const project = state.projects[projectId];
    let rowTotal = 0;
    const notes = [];
    const cells = days.map((d) => {
      const g = perDayGroups[d].find((x) => x.projectId === projectId);
      const ms = g ? g.totalMs : 0;
      rowTotal += ms;
      if (g && g.displayNote) notes.push(`${parseDateStr(d).toLocaleDateString(undefined, { weekday: 'short' })}: ${g.displayNote}`);
      return decimalHours(ms);
    });
    rows.push([project ? project.name : '(unknown)', ...cells, decimalHours(rowTotal), notes.join(' | ')]);
  }
  rows.push(['Total', ...dayTotals.map(decimalHours), decimalHours(grandTotal), '']);

  const tsv = rows.map((r) => r.map((c) => String(c).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t')).join('\n');
  navigator.clipboard.writeText(tsv).then(() => {
    el.tsCopyBtn.textContent = 'Copied!';
    setTimeout(() => { el.tsCopyBtn.textContent = 'Copy'; }, 1500);
  }).catch(() => {
    alert('Could not copy automatically — select and copy the table manually.');
  });
}

// ------------------------------------------------------------------ settings panel

function populateCategorySelect(selectEl, selected) {
  selectEl.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '(none)';
  if (!selected) blank.selected = true;
  selectEl.appendChild(blank);
  for (const c of allCategories) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    if (c === selected) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function renderSettingsPanel() {
  el.idleSlider.value = state.settings.idleThresholdMinutes;
  el.idleValue.textContent = `${state.settings.idleThresholdMinutes} min`;
  el.mergeGapSlider.value = state.settings.mergeGapSeconds ?? 90;
  el.mergeGapValue.textContent = `${state.settings.mergeGapSeconds ?? 90} s`;
  el.screenGraceSlider.value = state.settings.screenTimeGraceMinutes ?? 10;
  el.screenGraceValue.textContent = `${state.settings.screenTimeGraceMinutes ?? 10} min`;
  el.popupDelaySlider.value = state.settings.popupDelaySeconds ?? 2.5;
  el.popupDelayValue.textContent = `${state.settings.popupDelaySeconds ?? 2.5} s`;
  el.autoTrackToggle.checked = state.settings.autoTrackEnabled !== false;
  el.autoTrackValue.textContent = state.settings.autoTrackEnabled !== false ? 'On' : 'Off';
  el.themeSelect.value = state.settings.theme;

  el.settingsProjectList.innerHTML = '';
  const projectList = Object.values(state.projects).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of projectList) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="proj-row-top">
        <span class="swatch" style="background:hsl(${p.hue},60%,50%)"></span>
        <input type="text" value="${escapeHtml(p.name)}" data-id="${p.id}" style="flex:1;" />
      </div>
      <div class="proj-row-bottom">
        <select class="category-select" data-id="${p.id}"></select>
        <button type="button" class="remove-btn" data-id="${p.id}">Delete permanently</button>
      </div>`;
    const input = li.querySelector('input');
    const select = li.querySelector('select');
    populateCategorySelect(select, p.category);
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        await renameProject(p.id, input.value || p.name);
        await loadState();
        renderHistory(); renderTimeline(); renderTimesheet();
      }, 500);
    });
    select.addEventListener('change', async () => {
      await setProjectCategory(p.id, select.value);
      await loadState();
      renderHistory(); renderTimesheet();
    });
    li.querySelector('.remove-btn').addEventListener('click', async () => {
      const confirmed = confirm(
        `Permanently delete "${p.name}"? This removes ALL its tracked time (live and archived), everywhere. This cannot be undone.`
      );
      if (!confirmed) return;
      await deleteProjectPermanently(p.id);
      await loadState();
      renderAll();
    });
    el.settingsProjectList.appendChild(li);
  }
  if (!projectList.length) {
    el.settingsProjectList.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary)">No projects yet — they appear here once you set up your first site.</p>';
  }

  renderCategoriesList();
  renderExcludedSitesList();
  renderAlwaysPromptSitesList();
  renderPendingPrompts();
}

function renderCategoriesList() {
  el.categoriesList.innerHTML = '';
  for (const c of allCategories) {
    const li = document.createElement('li');
    li.innerHTML = `<input type="text" value="${escapeHtml(c)}" data-original="${escapeHtml(c)}" style="flex:1;" />
      <button type="button" class="remove-btn" data-name="${escapeHtml(c)}">Delete</button>`;
    const input = li.querySelector('input');
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const original = input.dataset.original;
        const next = input.value.trim();
        if (!next || next === original) return;
        await renameCategory(original, next);
        await loadState();
        renderSettingsPanel();
      }, 600);
    });
    li.querySelector('.remove-btn').addEventListener('click', async () => {
      if (!confirm(`Delete category "${c}"? Projects using it will show "(none)" — their tracked time is untouched.`)) return;
      await deleteCategory(c);
      await loadState();
      renderSettingsPanel();
    });
    el.categoriesList.appendChild(li);
  }
  if (!allCategories.length) {
    el.categoriesList.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary)">No categories yet — add one below, or leave projects uncategorized.</p>';
  }
}

function renderAlwaysPromptSitesList() {
  el.alwaysPromptSitesList.innerHTML = '';
  const domains = Object.keys(state.alwaysPromptSites).sort();
  for (const domain of domains) {
    const li = document.createElement('li');
    li.innerHTML = `<span style="flex:1;font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(domain)}</span>
      <button type="button" class="remove-btn" data-domain="${escapeHtml(domain)}">Remove</button>`;
    li.querySelector('.remove-btn').addEventListener('click', async () => {
      await removeAlwaysPromptSite(domain);
      await loadState();
      renderAlwaysPromptSitesList();
    });
    el.alwaysPromptSitesList.appendChild(li);
  }
  if (!domains.length) {
    el.alwaysPromptSitesList.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary)">No sites set to always ask yet.</p>';
  }
}

function renderExcludedSitesList() {
  el.excludedSitesList.innerHTML = '';
  const domains = Object.keys(state.excludedSites).sort();
  for (const domain of domains) {
    const li = document.createElement('li');
    li.innerHTML = `<span style="flex:1;font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(domain)}</span>
      <button type="button" class="remove-btn" data-domain="${escapeHtml(domain)}">Remove</button>`;
    li.querySelector('.remove-btn').addEventListener('click', async () => {
      await removeExcludedSite(domain);
      await loadState();
      renderExcludedSitesList();
    });
    el.excludedSitesList.appendChild(li);
  }
  if (!domains.length) {
    el.excludedSitesList.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary)">No sites excluded yet.</p>';
  }
}

async function renderPendingPrompts() {
  let dismissed = [];
  try { dismissed = await getAllDismissedThisSession(); } catch { dismissed = []; }
  el.pendingPromptsField.classList.toggle('hidden', dismissed.length === 0);
  el.pendingPromptsList.innerHTML = '';
  for (const domain of dismissed) {
    const li = document.createElement('li');
    li.innerHTML = `<span style="flex:1;font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(domain)}</span>
      <button type="button" class="prompt-again-btn" data-domain="${escapeHtml(domain)}">Prompt again</button>`;
    li.querySelector('.prompt-again-btn').addEventListener('click', () => promptAgain(domain));
    el.pendingPromptsList.appendChild(li);
  }
}

async function promptAgain(domain) {
  await clearDismissal(domain);
  const tabs = await chrome.tabs.query({ url: [`*://${domain}/*`, `*://www.${domain}/*`] });
  for (const tab of tabs) {
    if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'ORBIT_RECHECK' }).catch(() => {});
  }
  await renderPendingPrompts();
}

// ------------------------------------------------------------------ CSV export

/** One row per session — full detail, for audit purposes. */
function buildDetailCsvRows(scope) {
  const rows = [['Date', 'Day', 'Project', 'Category', 'Site', 'Comment', 'Start', 'End', 'Duration (min)', 'Manual', 'Note']];
  const pushDate = (date, byDomain) => {
    const sessions = flattenDaySessions(byDomain).sort((a, b) => a.start - b.start);
    const dow = parseDateStr(date).toLocaleDateString(undefined, { weekday: 'long' });
    for (const s of sessions) {
      const project = state.projects[s.projectId];
      rows.push([
        date, dow, project?.name || '', project?.category || '', s.domain, s.comment || '',
        new Date(s.start).toLocaleString(), new Date(s.end).toLocaleString(),
        String(Math.round((s.end - s.start) / 60000)), s.manual ? 'yes' : 'no', s.isNote ? 'yes' : 'no'
      ]);
    }
  };
  if (scope === 'week') {
    const wStart = weekStartStr();
    const wEnd = weekEndStr(wStart);
    for (const [date, byDomain] of Object.entries(state.entries)) {
      if (date >= wStart && date <= wEnd) pushDate(date, byDomain);
    }
  } else {
    for (const [date, byDomain] of Object.entries(state.entries)) pushDate(date, byDomain);
    for (const archive of Object.values(state.archives)) {
      for (const [date, byDomain] of Object.entries(archive.entries)) pushDate(date, byDomain);
    }
  }
  return rows;
}

/** One row per (date, project) — the actual timesheet-ready view. */
function buildDailySummaryCsvRows(scope) {
  const rows = [['Date', 'Day', 'Project', 'Category', 'Sites', 'Total (min)', 'Comment']];
  const pushDate = (date) => {
    const groups = projectGroupsForDate(date);
    const dow = parseDateStr(date).toLocaleDateString(undefined, { weekday: 'long' });
    for (const g of groups) {
      const project = state.projects[g.projectId];
      rows.push([
        date, dow, project?.name || '', project?.category || '', g.domains.join('; '),
        String(Math.round(g.totalMs / 60000)), g.displayNote || ''
      ]);
    }
  };
  let dates;
  if (scope === 'week') {
    const wStart = weekStartStr();
    const wEnd = weekEndStr(wStart);
    dates = Object.keys(state.entries).filter((d) => d >= wStart && d <= wEnd);
  } else {
    const archivedDates = Object.values(state.archives).flatMap((a) => Object.keys(a.entries));
    dates = [...new Set([...Object.keys(state.entries), ...archivedDates])];
  }
  for (const date of dates.sort()) pushDate(date);
  return rows;
}

/** One row per note — every comment recorded, in chronological order. Matches the Notes view. */
function buildNotesLogCsvRows() {
  const rows = [['Date', 'Day', 'Time', 'Project', 'Site', 'Comment']];
  const archivedDates = Object.values(state.archives).flatMap((a) => Object.keys(a.entries));
  const dates = [...new Set([...Object.keys(state.entries), ...archivedDates])].sort();
  for (const date of dates) {
    const byDomain = getByDomainForDate(date);
    const notes = getDayCommentLog(byDomain);
    const dow = parseDateStr(date).toLocaleDateString(undefined, { weekday: 'long' });
    for (const n of notes) {
      const project = state.projects[n.projectId];
      rows.push([date, dow, new Date(n.ts).toLocaleTimeString(), project?.name || '', n.domain, n.comment]);
    }
  }
  return rows;
}

function toCsv(rows) {
  return rows.map((r) => r.map((cell) => {
    const s = String(cell ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

function exportCsv(rows, label) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const filename = `orgclock-timesheet-${label}-${dateStr()}.csv`;
  chrome.downloads.download({ url, filename, saveAs: true }, () => URL.revokeObjectURL(url));
}

// ------------------------------------------------------------------ view switching

function setView(view) {
  currentView = view;
  el.viewTabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  el.history.classList.toggle('hidden', view !== 'history');
  el.timelineView.classList.toggle('hidden', view !== 'timeline');
  el.sessionSummaryView.classList.toggle('hidden', view !== 'sessions');
  el.timesheetView.classList.toggle('hidden', view !== 'timesheet');
  el.emptyState.classList.add('hidden');
  if (view === 'history') renderHistory();
  if (view === 'timeline') renderTimeline();
  if (view === 'sessions') renderSessionSummary();
  if (view === 'timesheet') renderTimesheet();
}

// ------------------------------------------------------------------ static events

function wireStaticEvents() {
  el.viewTabs.forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));

  el.exportBtn.addEventListener('click', () => exportCsv(buildDailySummaryCsvRows('all'), 'daily-summary-all'));
  el.exportWeekBtn.addEventListener('click', () => exportCsv(buildDailySummaryCsvRows('week'), 'daily-summary-week'));
  el.exportAllBtn.addEventListener('click', () => exportCsv(buildDailySummaryCsvRows('all'), 'daily-summary-all'));
  el.exportWeekDetailBtn.addEventListener('click', () => exportCsv(buildDetailCsvRows('week'), 'detail-week'));
  el.exportAllDetailBtn.addEventListener('click', () => exportCsv(buildDetailCsvRows('all'), 'detail-all'));
  el.exportSessionsBtn.addEventListener('click', () => exportCsv(buildNotesLogCsvRows(), 'notes-log'));

  el.themeBtn.addEventListener('click', async () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    state.settings = await updateSettings({ theme: next });
    applyTheme();
  });

  el.settingsBtn.addEventListener('click', () => {
    el.settingsOverlay.classList.remove('hidden');
    renderSettingsPanel();
  });
  el.closeSettings.addEventListener('click', () => el.settingsOverlay.classList.add('hidden'));
  el.settingsOverlay.addEventListener('click', (e) => { if (e.target === el.settingsOverlay) el.settingsOverlay.classList.add('hidden'); });

  el.closeEntryModal.addEventListener('click', closeEntryModal);
  el.entryModalOverlay.addEventListener('click', (e) => { if (e.target === el.entryModalOverlay) closeEntryModal(); });

  el.idleSlider.addEventListener('input', () => { el.idleValue.textContent = `${el.idleSlider.value} min`; });
  el.idleSlider.addEventListener('change', async () => {
    state.settings = await updateSettings({ idleThresholdMinutes: Number(el.idleSlider.value) });
  });

  el.mergeGapSlider.addEventListener('input', () => { el.mergeGapValue.textContent = `${el.mergeGapSlider.value} s`; });
  el.mergeGapSlider.addEventListener('change', async () => {
    state.settings = await updateSettings({ mergeGapSeconds: Number(el.mergeGapSlider.value) });
  });

  el.screenGraceSlider.addEventListener('input', () => { el.screenGraceValue.textContent = `${el.screenGraceSlider.value} min`; });
  el.screenGraceSlider.addEventListener('change', async () => {
    state.settings = await updateSettings({ screenTimeGraceMinutes: Number(el.screenGraceSlider.value) });
  });

  el.popupDelaySlider.addEventListener('input', () => { el.popupDelayValue.textContent = `${el.popupDelaySlider.value} s`; });
  el.popupDelaySlider.addEventListener('change', async () => {
    state.settings = await updateSettings({ popupDelaySeconds: Number(el.popupDelaySlider.value) });
  });

  el.autoTrackToggle.addEventListener('change', async () => {
    const enabled = el.autoTrackToggle.checked;
    state.settings = await updateSettings({ autoTrackEnabled: enabled });
    el.autoTrackValue.textContent = enabled ? 'On' : 'Off';
  });

  el.addCategoryBtn.addEventListener('click', async () => {
    const name = el.newCategoryInput.value.trim();
    if (!name) return;
    await addCustomCategory(name);
    el.newCategoryInput.value = '';
    await loadState();
    renderSettingsPanel();
  });

  el.sessionsPrevDay.addEventListener('click', () => { sessionSummaryDate = shiftDateStr(sessionSummaryDate, -1); renderSessionSummary(); });
  el.sessionsNextDay.addEventListener('click', () => { sessionSummaryDate = shiftDateStr(sessionSummaryDate, 1); renderSessionSummary(); });

  el.notesCopyBtn.addEventListener('click', () => {
    const notes = getDayCommentLog(getByDomainForDate(sessionSummaryDate));
    if (!notes.length) {
      el.notesCopyBtn.textContent = 'Nothing to copy';
      setTimeout(() => { el.notesCopyBtn.textContent = 'Copy'; }, 1500);
      return;
    }
    // Grouped by project, chronological within each — this is "today's
    // comments in one place" ready to paste into Replicon or similar,
    // rather than having to open each project's modal separately.
    const byProject = new Map();
    for (const n of notes) {
      if (!byProject.has(n.projectId)) byProject.set(n.projectId, []);
      byProject.get(n.projectId).push(n);
    }
    const lines = [];
    for (const [projectId, projectNotes] of byProject.entries()) {
      const project = state.projects[projectId];
      lines.push(project ? project.name : '(unknown)');
      for (const n of projectNotes) lines.push(`  ${formatClock(n.ts)} — ${n.comment}`);
      lines.push('');
    }
    navigator.clipboard.writeText(lines.join('\n').trim()).then(() => {
      el.notesCopyBtn.textContent = 'Copied!';
      setTimeout(() => { el.notesCopyBtn.textContent = 'Copy'; }, 1500);
    }).catch(() => {
      alert('Could not copy automatically — select and copy the notes manually.');
    });
  });

  el.themeSelect.addEventListener('change', async () => {
    state.settings = await updateSettings({ theme: el.themeSelect.value });
    applyTheme();
  });

  el.addExcludeBtn.addEventListener('click', async () => {
    const domain = el.newExcludeInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!domain) return;
    await addExcludedSite(domain);
    el.newExcludeInput.value = '';
    el.addExcludeHint.textContent = `${domain} excluded — it won't ask for a project anymore.`;
    await loadState();
    renderExcludedSitesList();
  });

  el.addAlwaysPromptBtn.addEventListener('click', async () => {
    const domain = el.newAlwaysPromptInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!domain) return;
    await addAlwaysPromptSite(domain);
    el.newAlwaysPromptInput.value = '';
    el.addAlwaysPromptHint.textContent = `${domain} will now ask every visit.`;
    await loadState();
    renderAlwaysPromptSitesList();
  });

  async function runDeleteWithConfirm(label, action) {
    if (!confirm(`${label} This permanently deletes tracked sessions in that range and cannot be undone. Continue?`)) return;
    const count = await action();
    await loadState();
    renderAll();
    el.deleteDataHint.textContent = count
      ? `Deleted tracked data for ${count} day${count === 1 ? '' : 's'}.`
      : 'Nothing to delete in that range.';
  }

  el.deleteLastWeekBtn.addEventListener('click', () =>
    runDeleteWithConfirm('Delete everything older than 1 week?', () => deleteSessionsOlderThan(7)));
  el.deleteLastMonthBtn.addEventListener('click', () =>
    runDeleteWithConfirm('Delete everything older than 1 month?', () => deleteSessionsOlderThan(30)));
  el.deleteOlderMonthsBtn.addEventListener('click', () => {
    const months = Math.max(1, Number(el.deleteOlderMonthsInput.value) || 1);
    return runDeleteWithConfirm(`Delete everything older than ${months} month${months === 1 ? '' : 's'}?`, () => deleteSessionsOlderThan(months * 30));
  });
  el.deleteCustomRangeBtn.addEventListener('click', () => {
    const start = el.deleteRangeStart.value;
    const end = el.deleteRangeEnd.value;
    if (!start || !end) { el.deleteDataHint.textContent = 'Pick both a start and end date.'; return; }
    return runDeleteWithConfirm(`Delete tracked data from ${start} to ${end}?`, () => deleteSessionsInRange(start, end));
  });

  el.downloadBackupBtn.addEventListener('click', async () => {
    const backup = await exportFullBackup();
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
    chrome.downloads.download(
      { url, filename: `orgclock-backup-${stamp}.json`, saveAs: true },
      () => URL.revokeObjectURL(url)
    );
    el.backupHint.textContent = 'Backup downloaded.';
  });

  el.restoreBackupBtn.addEventListener('click', () => el.restoreBackupInput.click());
  el.restoreBackupInput.addEventListener('change', async () => {
    const file = el.restoreBackupInput.files?.[0];
    el.restoreBackupInput.value = '';
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      el.backupHint.textContent = "Couldn't read that file — is it a valid OrgClock backup .json?";
      return;
    }
    const confirmed = confirm(
      'Restore this backup? Anything currently tracked that overlaps with the backup\'s data will be overwritten by the backup\'s version. This cannot be undone.'
    );
    if (!confirmed) return;
    try {
      await importFullBackup(parsed);
      await loadState();
      renderAll();
      el.backupHint.textContent = `Restored — backup was from ${new Date(parsed.exportedAt).toLocaleString()}.`;
    } catch (err) {
      el.backupHint.textContent = err.message;
    }
  });

  el.timelinePrevDay.addEventListener('click', () => { timelineDate = shiftDateStr(timelineDate, -1); renderTimeline(); });
  el.timelineNextDay.addEventListener('click', () => { timelineDate = shiftDateStr(timelineDate, 1); renderTimeline(); });

  el.tsPrevWeek.addEventListener('click', () => { tsWeekStart = shiftDateStr(tsWeekStart, -7); renderTimesheet(); });
  el.tsNextWeek.addEventListener('click', () => { tsWeekStart = shiftDateStr(tsWeekStart, 7); renderTimesheet(); });

  el.dismissBanner.addEventListener('click', () => {
    el.rolloverBanner.classList.add('hidden');
    chrome.storage.local.remove('pendingRolloverNotice');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeEntryModal(); el.settingsOverlay.classList.add('hidden'); }
  });
}

init();
