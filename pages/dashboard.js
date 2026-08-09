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
  renameCategory, deleteCategory, deleteProjectPermanently, mergeProjectsInto, getAlwaysPromptSites,
  addAlwaysPromptSite, removeAlwaysPromptSite, getIdleExemptSites, addIdleExemptSite, removeIdleExemptSite,
  deleteSessionsInRange, deleteSessionsOlderThan,
  exportFullBackup, importFullBackup, MANUAL_NOTE_DOMAIN,
  getWorkSummaries, saveWorkSummary, computeWorkSummaryText
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
  workSummaries: {},
  settings: {},
  activeSession: null,
  excludedSites: {},
  alwaysPromptSites: {},
  idleExemptSites: {},
  globalActivity: {},
  globalActiveSession: null
};
let todayBaseMs = 0;
let weekBaseMs = 0;
let chromeActiveBaseMs = 0;
let collapsedDays = new Set();
let currentView = 'history';
let timelineDate = dateStr();
let tsWeekStart = weekStartStr();
let allCategories = [];
let chartType = 'project-bar';
let chartRangeStart = weekStartStr();
let chartRangeEnd = dateStr();
let chartProjectFilter = null; // null = all
let chartSiteFilter = null;    // null = all

const $ = (id) => document.getElementById(id);
const el = {
  statusPill: $('statusPill'), statusText: $('statusText'), statusTimer: $('statusTimer'),
  dailySummaryBanner: $('dailySummaryBanner'),
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
  timestampToggle: $('timestampToggle'), timestampValue: $('timestampValue'),
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
  idleExemptSitesList: $('idleExemptSitesList'), newIdleExemptInput: $('newIdleExemptInput'),
  addIdleExemptBtn: $('addIdleExemptBtn'), addIdleExemptHint: $('addIdleExemptHint'),
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
  timesheetView: $('timesheetView'), tsWeekLabel: $('tsWeekLabel'),
  tsPrevWeek: $('tsPrevWeek'), tsNextWeek: $('tsNextWeek'), tsCopyBtn: $('tsCopyBtn'),
  tsHeadRow: $('tsHeadRow'), tsBody: $('tsBody'), tsFootRow: $('tsFootRow'),
  chartsView: $('chartsView'), chartsContainer: $('chartsContainer'), exportView: $('exportView'),
  chartTypeSelect: $('chartTypeSelect'), chartRangeStart: $('chartRangeStart'), chartRangeEnd: $('chartRangeEnd'),
  chartFiltersToggle: $('chartFiltersToggle'), chartsFiltersPanel: $('chartsFiltersPanel'),
  chartProjectFilters: $('chartProjectFilters'), chartSiteFilters: $('chartSiteFilters'),
  chartProjectsAllBtn: $('chartProjectsAllBtn'), chartSitesAllBtn: $('chartSitesAllBtn')
};

// ------------------------------------------------------------------ init

async function loadState({ skipArchives = false } = {}) {
  const archives = skipArchives ? state.archives : await getArchives();
  const [projects, domainMap, taskContext, entries, manualAdjustments, workSummaries,
    settings, activeSession, excludedSites, alwaysPromptSites, idleExemptSites, globalActivity, globalActiveSession, categories] = await Promise.all([
    getProjects(), getDomainMap(), getTaskContext(), getEntries(), getManualAdjustments(), getWorkSummaries(),
    getSettings(), getActiveSession(), getExcludedSites(), getAlwaysPromptSites(), getIdleExemptSites(), getGlobalActivity(), getGlobalActiveSession(),
    getAllCategories()
  ]);
  state = { projects, domainMap, taskContext, entries, archives, manualAdjustments, workSummaries, settings, activeSession, excludedSites, alwaysPromptSites, idleExemptSites, globalActivity, globalActiveSession };
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

// `archives` is the one collection that grows without bound over months of
// use — everything else (entries, manualAdjustments, workSummaries, etc.)
// stays small since weekly rollover already keeps the LIVE working set to
// roughly the current week. Re-reading months of archived history on
// every single storage-triggered reload — which happens very often during
// active tracking, since every session append writes `entries` — is
// exactly the kind of thing that would get slower the longer this has
// been installed. Since archives only actually change on a rare weekly
// rollover or an explicit restore/delete, this accumulates every key that
// changed across the debounce window and only re-fetches archives if it
// was genuinely one of them; otherwise the already-loaded copy is reused.
let reloadTimer = null;
let pendingChangedKeys = new Set();
function onStorageChanged(changes, area) {
  if (area !== 'local' && area !== 'session') return;
  for (const key of Object.keys(changes)) pendingChangedKeys.add(key);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const skipArchives = !pendingChangedKeys.has('archives');
    pendingChangedKeys = new Set();
    await loadState({ skipArchives });
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
function getWorkSummariesForDate(date) {
  if (state.workSummaries[date]) return state.workSummaries[date];
  for (const archive of Object.values(state.archives)) {
    if (archive.entries[date]) return archive.workSummaries?.[date] || {};
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
  renderTimesheet();
  renderCharts();
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

  renderDailySummary(today, todayGroups);
}

/**
 * Template-based "daily summary" — not real AI, just plugging today's
 * numbers into a sentence template, but reads similarly to one. Skipped
 * once tracked time is trivial (under a few minutes) since a summary
 * sentence about 2 minutes of activity isn't useful.
 */
function renderDailySummary(date, groups) {
  const totalMs = groups.reduce((s, g) => s + g.totalMs, 0);
  if (totalMs < 5 * 60000) { el.dailySummaryBanner.classList.add('hidden'); return; }

  const sorted = [...groups].sort((a, b) => b.totalMs - a.totalMs);
  const top = sorted[0];
  const topProject = state.projects[top.projectId];

  const sessions = flattenDaySessions(getByDomainForDate(date));
  const timedSessions = sessions.filter((s) => !s.isNote);
  const noteCount = sessions.filter((s) => s.comment).length;

  const hourMs = new Array(24).fill(0);
  for (const s of timedSessions) {
    hourMs[new Date(s.start).getHours()] += Math.max(0, s.end - s.start);
  }
  let peakHour = -1, peakMs = 0;
  hourMs.forEach((ms, h) => { if (ms > peakMs) { peakMs = ms; peakHour = h; } });

  const parts = [];
  parts.push(`Today you spent ${formatDuration(totalMs)} across ${groups.length} project${groups.length === 1 ? '' : 's'}.`);
  if (topProject && groups.length > 1) parts.push(`Most of your time (${formatDuration(top.totalMs)}) was on ${topProject.name}.`);
  if (peakHour >= 0 && peakMs >= 15 * 60000) parts.push(`Your peak activity was around ${formatHourRange(peakHour)}.`);
  parts.push(`You switched between ${timedSessions.length} tracked activit${timedSessions.length === 1 ? 'y' : 'ies'}${noteCount ? ` and added ${noteCount} note${noteCount === 1 ? '' : 's'}` : ''}.`);

  el.dailySummaryBanner.textContent = parts.join(' ');
  el.dailySummaryBanner.classList.remove('hidden');
}

function formatHourRange(hour) {
  const start = new Date(); start.setHours(hour, 0, 0, 0);
  const end = new Date(); end.setHours((hour + 1) % 24, 0, 0, 0);
  return `${start.toLocaleTimeString(undefined, { hour: 'numeric' })}–${end.toLocaleTimeString(undefined, { hour: 'numeric' })}`;
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

/**
 * The single editable Work Summary textarea — shared by the lightweight
 * Timesheet Summary modal and the fuller Day-wise History editor. Auto-
 * populates from the day's comment log until the first Save; after that,
 * only genuinely new comments get appended to the bottom of whatever the
 * user has edited (see storage.js's computeWorkSummaryText for the exact
 * rule) — editing is authoritative, nothing here can silently overwrite
 * or hide it the way the old dayNotes field used to.
 */
function buildWorkSummaryField(date, projectId) {
  const commentLog = getDayCommentLog(getByDomainForDate(date));
  const saved = getWorkSummariesForDate(date)[projectId] || null;
  const text = computeWorkSummaryText(commentLog, projectId, saved);

  const field = document.createElement('div');
  field.className = 'field';
  field.innerHTML = `
    <label>Work Summary <span class="ws-hint">(auto-fills from logged comments — edit freely; new comments append below next time you open this, after Save)</span></label>
    <textarea class="ws-textarea" rows="9" placeholder="Nothing logged yet today.">${escapeHtml(text)}</textarea>
    <div class="ws-actions">
      <button type="button" class="btn btn-text ws-copy-btn">Copy</button>
      <button type="button" class="btn btn-primary ws-save-btn">Save</button>
    </div>
  `;
  const textarea = field.querySelector('.ws-textarea');
  const copyBtn = field.querySelector('.ws-copy-btn');
  const saveBtn = field.querySelector('.ws-save-btn');

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(textarea.value).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
    }).catch(() => {
      alert('Could not copy automatically — select and copy the text manually.');
    });
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    await saveWorkSummary(date, projectId, textarea.value);
    await loadState();
    renderHistory(); renderTimesheet();
    saveBtn.disabled = false;
    saveBtn.textContent = 'Saved!';
    setTimeout(() => { saveBtn.textContent = originalLabel; }, 1200);
  });

  return field;
}

/**
 * Lightweight modal for the Timesheet Summary's per-cell click — just the
 * Work Summary field, nothing else. The fuller Day-wise History editor
 * (buildLiveProjectEditView, below) embeds the same field alongside Sites/
 * Advanced/Adjustment for when more than the summary text is needed.
 */
function openWorkSummaryModal(date, projectId) {
  const project = state.projects[projectId];
  el.entryModalTitle.textContent = `${project ? project.name : '(unknown)'} — ${friendlyDate(date, { noRelative: true })}`;
  el.entryModalBody.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.appendChild(buildWorkSummaryField(date, projectId));
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.innerHTML = `<span></span><button type="button" class="btn btn-primary" id="wsCloseBtn">Done</button>`;
  footer.querySelector('#wsCloseBtn').addEventListener('click', closeEntryModal);
  wrap.appendChild(footer);
  el.entryModalBody.appendChild(wrap);
  el.entryModalOverlay.classList.remove('hidden');
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

  // --- Work Summary: the one editable surface for this project's day,
  // shared with the lightweight Timesheet Summary modal (see
  // buildWorkSummaryField above). Replaces the old timestamped-note-card
  // list entirely — auto-populates from logged comments, stays editable,
  // new comments append rather than overwrite once saved once.
  const workSummaryField = buildWorkSummaryField(date, group.projectId);

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

  wrap.append(workSummaryField, sitesField, details, adjField, footer);
  return wrap;
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

  // Daily summary header: first-to-last span and total tracked time, so
  // "when did today actually start/end" doesn't require scrolling to the
  // very bottom of a long list to find the earliest entry.
  const timedSessions = sessions.filter((s) => !s.isNote);
  if (timedSessions.length) {
    const dayStart = Math.min(...timedSessions.map((s) => s.start));
    const dayEnd = Math.max(...timedSessions.map((s) => s.end));
    const totalMs = timedSessions.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    const header = document.createElement('div');
    header.className = 'timeline-day-summary';
    header.innerHTML = `
      <div><span class="timeline-day-summary-label">Start at</span><span class="mono">${formatClock(dayStart)}</span></div>
      <div><span class="timeline-day-summary-label">End at</span><span class="mono">${formatClock(dayEnd)}</span></div>
      <div><span class="timeline-day-summary-label">Tracked</span><span class="mono">${formatDuration(totalMs)}</span></div>
    `;
    el.timelineTrack.appendChild(header);
  }

  const track = document.createElement('div');
  track.className = 'timeline-track-row';
  // Newest first — recent activity is almost always what you're looking
  // for, and a long day shouldn't require scrolling past hours of older
  // entries to reach it.
  for (const s of [...sessions].reverse()) {
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
        const archivedWeek = isArchivedDate(cell.date);
        if (archivedWeek) {
          if (cell.group) openProjectModal(cell.date, cell.group, { archived: true, weekStart: archivedWeek });
        } else {
          openWorkSummaryModal(cell.date, projectId);
        }
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
  el.timestampToggle.checked = Boolean(state.settings.includeTimestampInNotes);
  el.timestampValue.textContent = state.settings.includeTimestampInNotes ? 'On' : 'Off';
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
        <button type="button" class="text-btn" data-id="${p.id}" data-action="merge">Merge into…</button>
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
    li.querySelector('[data-action="merge"]').addEventListener('click', async () => {
      const otherNames = projectList.filter((x) => x.id !== p.id).map((x) => x.name).join(', ');
      const typed = prompt(`Merge "${p.name}" into which existing project? All its time, sessions, and work summaries move over, and "${p.name}" is then deleted.\n\nExisting projects: ${otherNames}`, '');
      if (typed == null) return;
      const target = projectList.find((x) => x.name.toLowerCase() === typed.trim().toLowerCase() && x.id !== p.id);
      if (!target) { alert(`No other project named "${typed.trim()}" — check the spelling and try again.`); return; }
      if (!confirm(`Merge "${p.name}" into "${target.name}"? This cannot be undone.`)) return;
      await mergeProjectsInto(p.id, target.id);
      await loadState();
      renderAll();
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
  renderIdleExemptSitesList();
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

function renderIdleExemptSitesList() {
  el.idleExemptSitesList.innerHTML = '';
  const domains = Object.keys(state.idleExemptSites).sort();
  for (const domain of domains) {
    const li = document.createElement('li');
    li.innerHTML = `<span style="flex:1;font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(domain)}</span>
      <button type="button" class="remove-btn" data-domain="${escapeHtml(domain)}">Remove</button>`;
    li.querySelector('.remove-btn').addEventListener('click', async () => {
      await removeIdleExemptSite(domain);
      await loadState();
      renderIdleExemptSitesList();
    });
    el.idleExemptSitesList.appendChild(li);
  }
  if (!domains.length) {
    el.idleExemptSitesList.innerHTML = '<p style="font-size:12.5px;color:var(--text-tertiary)">No sites set to keep tracking through idle yet.</p>';
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

// ------------------------------------------------------------------ charts

function truncateLabel(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Aggregates tracked time over [startDate, endDate] by project and by site, respecting the active filters. */
function collectChartData(startDate, endDate) {
  const perProjectMs = new Map();
  const perSiteMs = new Map();
  const perDayMs = new Map();
  if (!startDate || !endDate || startDate > endDate) return { perProjectMs, perSiteMs, perDayMs };

  const cursor = parseDateStr(startDate);
  const end = parseDateStr(endDate);
  while (cursor <= end) {
    const d = dateStr(cursor);
    const byDomain = getByDomainForDate(d);
    const groups = groupDayByProject(byDomain, getManualAdjustmentsForDate(d));
    let dayMs = 0;
    for (const g of groups) {
      if (chartProjectFilter && !chartProjectFilter.has(g.projectId)) continue;
      perProjectMs.set(g.projectId, (perProjectMs.get(g.projectId) || 0) + g.totalMs);
      dayMs += g.totalMs;
    }
    for (const s of flattenDaySessions(byDomain)) {
      if (s.isNote || s.domain === MANUAL_NOTE_DOMAIN) continue;
      if (chartProjectFilter && !chartProjectFilter.has(s.projectId)) continue;
      if (chartSiteFilter && !chartSiteFilter.has(s.domain)) continue;
      const ms = Math.max(0, s.end - s.start);
      perSiteMs.set(s.domain, (perSiteMs.get(s.domain) || 0) + ms);
    }
    perDayMs.set(d, dayMs);
    cursor.setDate(cursor.getDate() + 1);
  }
  return { perProjectMs, perSiteMs, perDayMs };
}

/** Horizontal bar chart — reads well with long project/site name labels. */
function buildBarChartSvg(items) {
  const width = 640;
  const rowH = 30;
  const height = items.length * rowH + 24;
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const labelW = 150;
  const chartW = width - labelW - 74;

  let bars = '';
  items.forEach((item, i) => {
    const y = 12 + i * rowH;
    const barW = Math.max(2, (item.value / maxVal) * chartW);
    const tooltip = `${item.label} — ${formatDuration(item.value)}`;
    bars += `
      <text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" class="chart-bar-label">${escapeHtml(truncateLabel(item.label, 22))}<title>${escapeHtml(tooltip)}</title></text>
      <rect class="chart-bar-rect" x="${labelW}" y="${y + 4}" width="${barW}" height="${rowH - 12}" rx="4" fill="${item.color}"><title>${escapeHtml(tooltip)}</title></rect>
      <text x="${labelW + barW + 8}" y="${y + rowH / 2 + 4}" class="chart-value-label">${escapeHtml(formatDuration(item.value))}</text>
    `;
  });
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Donut chart + a separate HTML legend (SVG text for a dozen thin slice labels reads poorly, a legend doesn't). */
function buildDonutChartSvg(items) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return '';
  const size = 260;
  const cx = size / 2, cy = size / 2, r = 100, innerR = 58;
  let angle = -90;
  let paths = '';
  for (const item of items) {
    const frac = item.value / total;
    const sweep = Math.max(frac * 360, items.length === 1 ? 359.99 : 0.5);
    const largeArc = sweep > 180 ? 1 : 0;
    const startAngle = angle;
    const endAngle = angle + sweep;
    const [x1, y1] = polarToCartesian(cx, cy, r, startAngle);
    const [x2, y2] = polarToCartesian(cx, cy, r, endAngle);
    const [ix1, iy1] = polarToCartesian(cx, cy, innerR, endAngle);
    const [ix2, iy2] = polarToCartesian(cx, cy, innerR, startAngle);
    const tooltip = `${item.label} — ${formatDuration(item.value)} (${Math.round(frac * 100)}%)`;
    paths += `<path class="chart-donut-slice" d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2} Z" fill="${item.color}"><title>${escapeHtml(tooltip)}</title></path>`;
    angle = endAngle;
  }
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function buildLegendHtml(items) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return `<div class="chart-legend">${items.map((i) => `
    <div class="chart-legend-item">
      <span class="chart-legend-swatch" style="background:${i.color}"></span>
      ${escapeHtml(i.label)} — ${formatDuration(i.value)} (${Math.round((i.value / total) * 100)}%)
    </div>`).join('')}</div>`;
}

/** Line chart with a filled area, for a day-by-day trend. */
function buildLineChartSvg(points) {
  const width = 640, height = 260;
  const padL = 46, padR = 16, padT = 16, padB = 34;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const maxVal = Math.max(...points.map((p) => p.value), 1);
  const stepX = points.length > 1 ? chartW / (points.length - 1) : 0;

  const coords = points.map((p, i) => [padL + i * stepX, padT + chartH - (p.value / maxVal) * chartH]);
  const pathD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${coords[coords.length - 1][0].toFixed(1)} ${(padT + chartH).toFixed(1)} L ${coords[0][0].toFixed(1)} ${(padT + chartH).toFixed(1)} Z`;

  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  let dots = '', labels = '';
  points.forEach((p, i) => {
    const [x, y] = coords[i];
    const tooltip = `${p.label} — ${formatDuration(p.value)}`;
    dots += `<circle class="chart-line-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="var(--primary)"><title>${escapeHtml(tooltip)}</title></circle>`;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="transparent"><title>${escapeHtml(tooltip)}</title></circle>`;
    if (i % labelEvery === 0 || i === points.length - 1) {
      labels += `<text x="${x.toFixed(1)}" y="${height - 12}" text-anchor="middle" class="chart-bar-label">${escapeHtml(p.label)}</text>`;
    }
  });

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${padL}" y1="${padT + chartH}" x2="${width - padR}" y2="${padT + chartH}" class="chart-axis-line" />
    <path d="${areaD}" fill="var(--primary-100)" />
    <path d="${pathD}" fill="none" stroke="var(--primary)" stroke-width="2.5" />
    ${dots}${labels}
  </svg>`;
}

/** Two overlaid lines for a day-by-day comparison (Chrome active vs. tracked project time). */
function buildDualLineChartSvg(seriesA, seriesB, labelA, labelB) {
  const width = 640, height = 260;
  const padL = 46, padR = 16, padT = 16, padB = 34;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const maxVal = Math.max(...seriesA.map((p) => p.value), ...seriesB.map((p) => p.value), 1);
  const stepX = seriesA.length > 1 ? chartW / (seriesA.length - 1) : 0;

  const toCoords = (series) => series.map((p, i) => [padL + i * stepX, padT + chartH - (p.value / maxVal) * chartH]);
  const toPath = (coords) => coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

  const coordsA = toCoords(seriesA);
  const coordsB = toCoords(seriesB);

  const labelEvery = Math.max(1, Math.ceil(seriesA.length / 10));
  let dots = '', labels = '';
  seriesA.forEach((p, i) => {
    const [xa, ya] = coordsA[i];
    const [, yb] = coordsB[i];
    dots += `<circle r="3" fill="var(--primary)" cx="${xa.toFixed(1)}" cy="${ya.toFixed(1)}"><title>${escapeHtml(`${labelA} — ${p.label}: ${formatDuration(p.value)}`)}</title></circle>`;
    dots += `<circle r="3" fill="var(--accent)" cx="${xa.toFixed(1)}" cy="${yb.toFixed(1)}"><title>${escapeHtml(`${labelB} — ${seriesB[i].label}: ${formatDuration(seriesB[i].value)}`)}</title></circle>`;
    if (i % labelEvery === 0 || i === seriesA.length - 1) {
      labels += `<text x="${xa.toFixed(1)}" y="${height - 12}" text-anchor="middle" class="chart-bar-label">${escapeHtml(p.label)}</text>`;
    }
  });

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${padL}" y1="${padT + chartH}" x2="${width - padR}" y2="${padT + chartH}" class="chart-axis-line" />
    <path d="${toPath(coordsA)}" fill="none" stroke="var(--primary)" stroke-width="2.5" />
    <path d="${toPath(coordsB)}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-dasharray="5 3" />
    ${dots}${labels}
  </svg>`;
}

function renderChartFilters() {
  const allProjects = Object.values(state.projects).sort((a, b) => a.name.localeCompare(b.name));
  el.chartProjectFilters.innerHTML = allProjects.map((p) => `
    <label class="chart-filter-item">
      <input type="checkbox" data-project-id="${p.id}" ${(!chartProjectFilter || chartProjectFilter.has(p.id)) ? 'checked' : ''} />
      <span class="swatch" style="width:8px;height:8px;border-radius:50%;display:inline-block;background:hsl(${p.hue},60%,50%);"></span>
      ${escapeHtml(p.name)}
    </label>`).join('') || '<p style="font-size:12px;color:var(--text-tertiary);">No projects yet.</p>';
  el.chartProjectFilters.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const boxes = [...el.chartProjectFilters.querySelectorAll('input[type="checkbox"]')];
      chartProjectFilter = boxes.every((c) => c.checked) ? null : new Set(boxes.filter((c) => c.checked).map((c) => c.dataset.projectId));
      renderCharts();
    });
  });

  const domainSet = new Set();
  for (const byDomain of Object.values(state.entries)) {
    for (const domain of Object.keys(byDomain)) {
      if (domain !== MANUAL_NOTE_DOMAIN) domainSet.add(domain);
    }
  }
  const allSites = [...domainSet].sort();
  el.chartSiteFilters.innerHTML = allSites.map((d) => `
    <label class="chart-filter-item">
      <input type="checkbox" data-site="${escapeHtml(d)}" ${(!chartSiteFilter || chartSiteFilter.has(d)) ? 'checked' : ''} />
      <span class="mono" style="font-size:11px;">${escapeHtml(d)}</span>
    </label>`).join('') || '<p style="font-size:12px;color:var(--text-tertiary);">No sites tracked yet.</p>';
  el.chartSiteFilters.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const boxes = [...el.chartSiteFilters.querySelectorAll('input[type="checkbox"]')];
      chartSiteFilter = boxes.every((c) => c.checked) ? null : new Set(boxes.filter((c) => c.checked).map((c) => c.dataset.site));
      renderCharts();
    });
  });
}

function renderCharts() {
  if (currentView !== 'charts') return;
  renderChartFilters();

  const { perProjectMs, perSiteMs, perDayMs } = collectChartData(chartRangeStart, chartRangeEnd);
  const empty = '<p class="chart-empty">Nothing tracked in this range yet.</p>';

  if (chartType === 'project-bar' || chartType === 'project-donut') {
    const items = [...perProjectMs.entries()]
      .map(([projectId, ms]) => ({
        label: state.projects[projectId]?.name || '(unknown)',
        value: ms,
        color: state.projects[projectId] ? `hsl(${state.projects[projectId].hue},60%,50%)` : '#999'
      }))
      .filter((i) => i.value > 0)
      .sort((a, b) => b.value - a.value);
    if (!items.length) { el.chartsContainer.innerHTML = empty; return; }
    el.chartsContainer.innerHTML = chartType === 'project-bar'
      ? buildBarChartSvg(items)
      : `<div style="display:flex;flex-direction:column;align-items:center;width:100%;">${buildDonutChartSvg(items)}${buildLegendHtml(items)}</div>`;
  } else if (chartType === 'site-bar') {
    const items = [...perSiteMs.entries()]
      .map(([domain, ms]) => ({ label: domain, value: ms, color: 'var(--primary)' }))
      .filter((i) => i.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 15);
    el.chartsContainer.innerHTML = items.length ? buildBarChartSvg(items) : empty;
  } else if (chartType === 'daily-line') {
    const points = [];
    const cursor = parseDateStr(chartRangeStart);
    const end = parseDateStr(chartRangeEnd);
    while (cursor <= end) {
      const d = dateStr(cursor);
      points.push({ label: parseDateStr(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: state.globalActivity[d] || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    el.chartsContainer.innerHTML = points.some((p) => p.value > 0) ? buildLineChartSvg(points) : '<p class="chart-empty">No Chrome-active data in this range.</p>';
  } else if (chartType === 'weekly-trend') {
    const byWeek = new Map();
    for (const [d, ms] of perDayMs.entries()) {
      const wk = weekStartStr(parseDateStr(d));
      byWeek.set(wk, (byWeek.get(wk) || 0) + ms);
    }
    const items = [...byWeek.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([wk, ms]) => ({ label: friendlyWeekRange(wk), value: ms, color: 'var(--accent)' }));
    el.chartsContainer.innerHTML = items.some((i) => i.value > 0) ? buildBarChartSvg(items) : empty;
  } else if (chartType === 'active-vs-tracked') {
    const tracked = [], active = [];
    const cursor = parseDateStr(chartRangeStart);
    const end = parseDateStr(chartRangeEnd);
    while (cursor <= end) {
      const d = dateStr(cursor);
      const label = parseDateStr(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      tracked.push({ label, value: perDayMs.get(d) || 0 });
      active.push({ label, value: state.globalActivity[d] || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    if (!tracked.some((p) => p.value > 0) && !active.some((p) => p.value > 0)) {
      el.chartsContainer.innerHTML = empty;
    } else {
      el.chartsContainer.innerHTML = buildDualLineChartSvg(active, tracked, 'Chrome active', 'Tracked') + buildLegendHtml([
        { label: 'Chrome active', value: active.reduce((s, p) => s + p.value, 0), color: 'var(--primary)' },
        { label: 'Tracked', value: tracked.reduce((s, p) => s + p.value, 0), color: 'var(--accent)' }
      ]);
    }
  }
}

// ------------------------------------------------------------------ view switching

function setView(view) {
  currentView = view;
  el.viewTabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  el.history.classList.toggle('hidden', view !== 'history');
  el.timelineView.classList.toggle('hidden', view !== 'timeline');
  el.timesheetView.classList.toggle('hidden', view !== 'timesheet');
  el.chartsView.classList.toggle('hidden', view !== 'charts');
  el.exportView.classList.toggle('hidden', view !== 'export');
  el.emptyState.classList.add('hidden');
  if (view === 'history') renderHistory();
  if (view === 'timeline') renderTimeline();
  if (view === 'timesheet') renderTimesheet();
  if (view === 'charts') renderCharts();
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

  el.timestampToggle.addEventListener('change', async () => {
    const enabled = el.timestampToggle.checked;
    state.settings = await updateSettings({ includeTimestampInNotes: enabled });
    el.timestampValue.textContent = enabled ? 'On' : 'Off';
  });

  el.addCategoryBtn.addEventListener('click', async () => {
    const name = el.newCategoryInput.value.trim();
    if (!name) return;
    await addCustomCategory(name);
    el.newCategoryInput.value = '';
    await loadState();
    renderSettingsPanel();
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

  el.addIdleExemptBtn.addEventListener('click', async () => {
    const domain = el.newIdleExemptInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!domain) return;
    await addIdleExemptSite(domain);
    el.newIdleExemptInput.value = '';
    el.addIdleExemptHint.textContent = `${domain} will keep tracking through idle now.`;
    await loadState();
    renderIdleExemptSitesList();
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

  el.chartRangeStart.value = chartRangeStart;
  el.chartRangeEnd.value = chartRangeEnd;
  el.chartTypeSelect.value = chartType;
  el.chartTypeSelect.addEventListener('change', () => { chartType = el.chartTypeSelect.value; renderCharts(); });
  el.chartRangeStart.addEventListener('change', () => { chartRangeStart = el.chartRangeStart.value || chartRangeStart; renderCharts(); });
  el.chartRangeEnd.addEventListener('change', () => { chartRangeEnd = el.chartRangeEnd.value || chartRangeEnd; renderCharts(); });
  el.chartFiltersToggle.addEventListener('click', () => { el.chartsFiltersPanel.classList.toggle('hidden'); });
  el.chartProjectsAllBtn.addEventListener('click', () => { chartProjectFilter = null; renderCharts(); });
  el.chartSitesAllBtn.addEventListener('click', () => { chartSiteFilter = null; renderCharts(); });

  document.querySelectorAll('.charts-preset-row [data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const today = dateStr();
      if (btn.dataset.preset === 'today') {
        chartRangeStart = today; chartRangeEnd = today;
      } else if (btn.dataset.preset === 'week') {
        chartRangeStart = weekStartStr(); chartRangeEnd = today;
      } else if (btn.dataset.preset === 'month') {
        const d = new Date(); d.setDate(1);
        chartRangeStart = dateStr(d); chartRangeEnd = today;
      }
      el.chartRangeStart.value = chartRangeStart;
      el.chartRangeEnd.value = chartRangeEnd;
      renderCharts();
    });
  });

  el.dismissBanner.addEventListener('click', () => {
    el.rolloverBanner.classList.add('hidden');
    chrome.storage.local.remove('pendingRolloverNotice');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeEntryModal(); el.settingsOverlay.classList.add('hidden'); }
  });
}

init();
