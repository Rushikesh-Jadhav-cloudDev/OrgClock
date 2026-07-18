// lib/storage.js
// Single source of truth for everything persisted in chrome.storage.local.
//
// Schema (v3)
// -----------
// settings:      { idleThresholdMinutes, theme, lastWeeklyResetCheck }
// projects:      { [projectId]: { id, name, category, hue, createdAt, archived } }
// domainMap:     { [domain]: projectId }        -- permanent "home project" per domain
// taskContext:   { [domain]: { projectId, comment, updatedAt } }
//                -- what a NEW session on this domain should currently be
//                   tagged as; defaults to the domain's home project, but can
//                   be overridden for a work block (e.g. referencing another
//                   org's project while sitting on this domain's tab)
// entries:       { [dateStr]: { [domain]: { sessions: Session[] } } }
// manualAdjustments: { [dateStr]: { [projectId]: ms } }
// archives:      { [weekStartStr]: { weekStart, weekEnd, entries, manualAdjustments, archivedAt } }
// activeSession: { tabId, windowId, domain, date, startTs, lastFlushTs } | null
//
// Session = { id, start, end, projectId, comment, manual }
//
// Why sessions (not the whole domain-day) carry the project: a domain has
// one permanent "home" project, but any individual work block on it can be
// billed elsewhere (e.g. you're on Org A's tab but actually referencing it
// while doing work for Org B). Session-level tagging is what makes that
// correct, and it's also what lets the dashboard group by PROJECT across
// however many domains contributed to it, rather than by domain.

import { newId } from './id.js';
import { dateStr, weekStartStr, weekEndStr } from './dateUtils.js';

const DEFAULT_SETTINGS = {
  idleThresholdMinutes: 5,
  screenTimeGraceMinutes: 10,
  mergeGapSeconds: 90,
  popupDelaySeconds: 2.5,
  manuallyPaused: false,
  autoTrackEnabled: true,
  theme: 'system',
  lastWeeklyResetCheck: weekStartStr()
};

export const CATEGORIES = [
  'Salesforce Development',
  'JIRA / Task Management',
  'AI Research',
  'Web Research',
  'Email / Communication',
  'Admin / Other'
];

// ---------------------------------------------------------------- low level

async function getKeys(keys) {
  return chrome.storage.local.get(keys);
}
async function setKeys(obj) {
  return chrome.storage.local.set(obj);
}

export async function initDefaultsIfNeeded() {
  const existing = await getKeys([
    'settings', 'projects', 'domainMap', 'taskContext', 'entries',
    'manualAdjustments', 'archives', 'excludedSites', 'dayNotes', 'globalActivity', 'customCategories'
  ]);
  const patch = {};
  if (!existing.settings) patch.settings = DEFAULT_SETTINGS;
  if (!existing.projects) patch.projects = {};
  if (!existing.domainMap) patch.domainMap = {};
  if (!existing.taskContext) patch.taskContext = {};
  if (!existing.entries) patch.entries = {};
  if (!existing.manualAdjustments) patch.manualAdjustments = {};
  if (!existing.archives) patch.archives = {};
  if (!existing.excludedSites) {
    // Seed a couple of obvious always-on, not-project-specific defaults.
    // The user can add/remove freely from Settings.
    patch.excludedSites = { 'mail.google.com': { addedAt: Date.now() } };
  }
  if (!existing.dayNotes) patch.dayNotes = {};
  if (!existing.globalActivity) patch.globalActivity = {};
  if (!existing.customCategories) patch.customCategories = [];
  if (Object.keys(patch).length) await setKeys(patch);
}

// ------------------------------------------------------------------ settings

export async function getSettings() {
  const { settings } = await getKeys('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await setKeys({ settings: next });
  return next;
}

// ------------------------------------------------------------------ projects

export async function getProjects() {
  const { projects } = await getKeys('projects');
  return projects || {};
}

export async function createProject(name, category = 'Admin / Other') {
  const projects = await getProjects();
  const id = newId('proj');
  const hue = Math.floor(Math.random() * 360);
  projects[id] = { id, name: name.trim(), category, hue, createdAt: Date.now(), archived: false };
  await setKeys({ projects });
  return projects[id];
}

export async function renameProject(projectId, name) {
  const projects = await getProjects();
  if (!projects[projectId]) return null;
  projects[projectId].name = name.trim();
  await setKeys({ projects });
  return projects[projectId];
}

export async function setProjectCategory(projectId, category) {
  const projects = await getProjects();
  if (!projects[projectId]) return null;
  projects[projectId].category = category;
  await setKeys({ projects });
  return projects[projectId];
}

// ------------------------------------------------------------- categories
// CATEGORIES (above) are the built-in defaults. Users can add their own —
// stored separately so a future update to the built-in list never clobbers
// what someone has customized.

export async function getCustomCategories() {
  const { customCategories } = await getKeys('customCategories');
  return customCategories || [];
}
export async function addCustomCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const customCategories = await getCustomCategories();
  if (!customCategories.includes(trimmed) && !CATEGORIES.includes(trimmed)) {
    customCategories.push(trimmed);
    await setKeys({ customCategories });
  }
}
export async function getAllCategories() {
  return [...CATEGORIES, ...(await getCustomCategories())];
}

// ---------------------------------------------------------------- domain map

export async function getDomainMap() {
  const { domainMap } = await getKeys('domainMap');
  return domainMap || {};
}

export async function linkDomainToProject(domain, projectId) {
  const domainMap = await getDomainMap();
  domainMap[domain] = projectId;
  await setKeys({ domainMap });
}

// --------------------------------------------------------------- task context

export async function getTaskContext() {
  const { taskContext } = await getKeys('taskContext');
  return taskContext || {};
}

export async function setTaskContext(domain, projectId, taskName, comment) {
  const taskContext = await getTaskContext();
  taskContext[domain] = { projectId, taskName: taskName || '', comment: comment || '', updatedAt: Date.now() };
  await setKeys({ taskContext });
}

// ------------------------------------------------------------------ entries

export async function getEntries() {
  const { entries } = await getKeys('entries');
  return entries || {};
}
async function saveEntries(entries) {
  await setKeys({ entries });
}

function ensureDomainContainer(entries, date, domain) {
  entries[date] = entries[date] || {};
  entries[date][domain] = entries[date][domain] || { sessions: [] };
  return entries[date][domain];
}

/** True if this domain has never been set up at all today (first visit). */
export async function needsDailySetup(domain, date = dateStr()) {
  const entries = await getEntries();
  return !entries[date]?.[domain];
}

/**
 * Saves the setup/"log task" overlay: links the domain's PERMANENT home
 * project (creating it if `newHomeProjectName` given), sets the task
 * context used to tag the next session(s), and ensures today's container
 * exists so needsDailySetup() flips false immediately even before any
 * session has actually been appended yet.
 */
export async function saveTaskSetup({
  domain, date = dateStr(),
  homeProjectId, newHomeProjectName,
  workingProjectId, newWorkingProjectName,
  taskName, comment
}) {
  let finalHomeId = homeProjectId;
  if (!finalHomeId && newHomeProjectName) {
    const p = await createProject(newHomeProjectName, 'Salesforce Development');
    finalHomeId = p.id;
  }
  if (!finalHomeId) throw new Error('A project is required.');
  await linkDomainToProject(domain, finalHomeId);

  let finalWorkingId = workingProjectId;
  if (!finalWorkingId && newWorkingProjectName) {
    const existing = Object.values(await getProjects()).find(
      (p) => p.name.toLowerCase() === newWorkingProjectName.trim().toLowerCase()
    );
    finalWorkingId = existing ? existing.id : (await createProject(newWorkingProjectName)).id;
  }
  if (!finalWorkingId) finalWorkingId = finalHomeId;

  await setTaskContext(domain, finalWorkingId, taskName || '', comment || '');

  const entries = await getEntries();
  ensureDomainContainer(entries, date, domain);
  await saveEntries(entries);

  return finalWorkingId;
}

/**
 * Appends a completed [start, end) session slice, tagged with whatever
 * project/comment is currently set as this domain's task context (falling
 * back to its permanent home project if no context was ever set).
 */
export async function appendSession(date, domain, start, end) {
  if (end <= start) return;
  const entries = await getEntries();
  const container = entries[date]?.[domain];
  if (!container) return; // setup must exist before sessions can be recorded

  const taskContext = await getTaskContext();
  const domainMap = await getDomainMap();
  const ctx = taskContext[domain];
  const projectId = ctx?.projectId || domainMap[domain] || null;
  if (!projectId) return;
  const taskName = ctx?.taskName || '';
  const comment = ctx?.comment || '';

  const settings = await getSettings();
  const mergeGapMs = Math.max(0, (settings.mergeGapSeconds ?? 90) * 1000);

  // Find the most recently-ended NON-manual session for this SAME PROJECT
  // *and* SAME TASK across ANY domain today (not just this one) — covers
  // rapid switching between e.g. JIRA and the org tab that are both billed
  // to the same project/task. Matching on task too (not just project)
  // keeps two different tasks under one project from being blended into
  // a single block.
  let best = null;
  for (const [d, c] of Object.entries(entries[date])) {
    for (const s of c.sessions) {
      if (s.projectId === projectId && (s.taskName || '') === taskName && !s.manual && (!best || s.end > best.session.end)) {
        best = { domain: d, session: s };
      }
    }
  }

  if (best && start >= best.session.end && start - best.session.end <= mergeGapMs) {
    best.session.end = end;
    if (comment && comment !== best.session.comment) {
      best.session.comment = best.session.comment ? `${best.session.comment}\n${comment}` : comment;
    }
    await saveEntries(entries);
    return;
  }

  container.sessions.push({ id: newId('sess'), start, end, projectId, taskName, comment, manual: false });
  await saveEntries(entries);
}

/**
 * Retroactively collapses a project's already-recorded sessions on a given
 * day: any non-manual sessions (regardless of which domain they're stored
 * under) that are within `gapSeconds` of each other get merged into one,
 * keeping the domain of whichever contributed the most time and combining
 * comments. Manual sessions are left untouched (they were deliberately
 * added/edited, not raw tracking noise). Returns how many sessions were
 * removed by the merge.
 */
export async function consolidateProjectSessions(date, projectId, gapSeconds = 90) {
  const entries = await getEntries();
  const byDomain = entries[date];
  if (!byDomain) return 0;
  const gapMs = Math.max(0, gapSeconds * 1000);

  const all = [];
  for (const [domain, container] of Object.entries(byDomain)) {
    for (const s of container.sessions) {
      if (s.projectId === projectId) all.push({ ...s, domain });
    }
  }
  const automatic = all.filter((s) => !s.manual).sort((a, b) => a.start - b.start);
  if (automatic.length < 2) return 0;

  const merged = [];
  let current = { ...automatic[0], domains: { [automatic[0].domain]: automatic[0].end - automatic[0].start } };
  for (let i = 1; i < automatic.length; i++) {
    const next = automatic[i];
    const sameTask = (next.taskName || '') === (current.taskName || '');
    if (sameTask && next.start - current.end <= gapMs) {
      current.end = Math.max(current.end, next.end);
      current.domains[next.domain] = (current.domains[next.domain] || 0) + (next.end - next.start);
      if (next.comment && next.comment !== current.comment) {
        current.comment = current.comment ? `${current.comment}\n${next.comment}` : next.comment;
      }
    } else {
      merged.push(current);
      current = { ...next, domains: { [next.domain]: next.end - next.start } };
    }
  }
  merged.push(current);

  const removedCount = automatic.length - merged.length;
  if (removedCount <= 0) return 0;

  // Remove all original automatic sessions for this project from their containers.
  for (const [domain, container] of Object.entries(byDomain)) {
    container.sessions = container.sessions.filter((s) => s.projectId !== projectId || s.manual);
  }
  // Re-insert merged blocks under the domain that contributed the most time to each.
  for (const block of merged) {
    const primaryDomain = Object.entries(block.domains).sort((a, b) => b[1] - a[1])[0][0];
    ensureDomainContainer(entries, date, primaryDomain);
    entries[date][primaryDomain].sessions.push({
      id: newId('sess'), start: block.start, end: block.end, projectId, taskName: block.taskName || '', comment: block.comment, manual: false
    });
  }
  await saveEntries(entries);
  return removedCount;
}

/**
 * Silently sets up `toDomain` using the same task context already active
 * for `fromDomain` today, with no prompt. Used when a site itself redirects
 * the SAME TAB between its own subdomains (e.g. Salesforce's Lightning app
 * to Setup) — from the user's point of view that's one continuous piece of
 * work, not a new site. Returns false if fromDomain has no context yet.
 */
export async function carryOverSetup(fromDomain, toDomain, date) {
  const taskContext = await getTaskContext();
  const ctx = taskContext[fromDomain];
  if (!ctx) return false;

  const domainMap = await getDomainMap();
  if (!domainMap[toDomain]) {
    domainMap[toDomain] = domainMap[fromDomain] || ctx.projectId;
    await setKeys({ domainMap });
  }
  await setTaskContext(toDomain, ctx.projectId, ctx.taskName || '', ctx.comment);

  const entries = await getEntries();
  ensureDomainContainer(entries, date, toDomain);
  await saveEntries(entries);
  return true;
}

export async function addManualSession(date, domain, start, end, projectId, comment = '', taskName = '') {
  if (end <= start) throw new Error('End time must be after start time.');
  const entries = await getEntries();
  const container = entries[date]?.[domain];
  if (!container) throw new Error('No entry for that site/day yet.');
  container.sessions.push({ id: newId('sess'), start, end, projectId, taskName, comment, manual: true });
  await saveEntries(entries);
}

export async function editSession(date, domain, sessionId, patch) {
  if (patch.start != null && patch.end != null && patch.end <= patch.start) {
    throw new Error('End time must be after start time.');
  }
  const entries = await getEntries();
  const container = entries[date]?.[domain];
  if (!container) return;
  const session = container.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  Object.assign(session, patch, { manual: true });
  await saveEntries(entries);
}

export async function deleteSession(date, domain, sessionId) {
  const entries = await getEntries();
  const container = entries[date]?.[domain];
  if (!container) return;
  container.sessions = container.sessions.filter((s) => s.id !== sessionId);
  await saveEntries(entries);
}

export async function mergeSessions(date, domain, sessionIdA, sessionIdB) {
  const entries = await getEntries();
  const container = entries[date]?.[domain];
  if (!container) return;
  const a = container.sessions.find((s) => s.id === sessionIdA);
  const b = container.sessions.find((s) => s.id === sessionIdB);
  if (!a || !b) return;
  const merged = {
    id: newId('sess'),
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    projectId: a.projectId,
    comment: [a.comment, b.comment].filter(Boolean).join(' / '),
    manual: true
  };
  container.sessions = container.sessions.filter((s) => s.id !== sessionIdA && s.id !== sessionIdB);
  container.sessions.push(merged);
  await saveEntries(entries);
}

export async function deleteDomainDay(date, domain) {
  const entries = await getEntries();
  if (entries[date]?.[domain]) {
    delete entries[date][domain];
    await saveEntries(entries);
  }
}

// ---------------------------------------------------------- manual adjustments

export async function getManualAdjustments() {
  const { manualAdjustments } = await getKeys('manualAdjustments');
  return manualAdjustments || {};
}
export async function setManualAdjustment(date, projectId, adjustmentMs) {
  const manualAdjustments = await getManualAdjustments();
  manualAdjustments[date] = manualAdjustments[date] || {};
  manualAdjustments[date][projectId] = adjustmentMs;
  await setKeys({ manualAdjustments });
}

// -------------------------------------------------------------- computation

/** All sessions for a given day, flattened across domains, each tagged with its domain. */
export function flattenDaySessions(byDomain) {
  const out = [];
  for (const [domain, container] of Object.entries(byDomain || {})) {
    for (const s of container.sessions) out.push({ ...s, domain });
  }
  return out;
}

/** Groups a day's flattened sessions by projectId. */
export function groupDayByProject(byDomain, manualAdjustmentsForDay = {}, dayNotesForDay = {}) {
  const sessions = flattenDaySessions(byDomain);
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.projectId)) byProject.set(s.projectId, []);
    byProject.get(s.projectId).push(s);
  }
  const result = [];
  for (const [projectId, sessionList] of byProject.entries()) {
    const sessionMs = sessionList.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    const adjustmentMs = manualAdjustmentsForDay[projectId] || 0;
    const domains = [...new Set(sessionList.map((s) => s.domain))];
    const comments = [...new Set(sessionList.map((s) => s.comment).filter(Boolean))];
    const note = dayNotesForDay[projectId] || '';
    result.push({
      projectId,
      sessions: sessionList.sort((a, b) => a.start - b.start),
      domains,
      comments,
      note,
      displayNote: note || comments.join('\n'),
      totalMs: Math.max(0, sessionMs + adjustmentMs),
      adjustmentMs
    });
  }
  return result;
}

/**
 * Groups a day's flattened sessions by (projectId, taskName) pair — this is
 * the finer-grained view for "Session Summary": e.g. "ATLAS – Validation
 * Rule Fix – 1h 45m" as a distinct row from "ATLAS – Data Load – 40m",
 * rather than both being folded into one "ATLAS" total.
 */
export function groupDayByTask(byDomain) {
  const sessions = flattenDaySessions(byDomain);
  const byTask = new Map();
  for (const s of sessions) {
    const key = `${s.projectId}::${s.taskName || ''}`;
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key).push(s);
  }
  const result = [];
  for (const [key, sessionList] of byTask.entries()) {
    const [projectId, taskName] = key.split('::');
    const totalMs = sessionList.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    const domains = [...new Set(sessionList.map((s) => s.domain))];
    const comments = [...new Set(sessionList.map((s) => s.comment).filter(Boolean))];
    result.push({
      projectId,
      taskName,
      sessions: sessionList.sort((a, b) => a.start - b.start),
      domains,
      comments,
      totalMs
    });
  }
  return result.sort((a, b) => b.totalMs - a.totalMs);
}

// -------------------------------------------------------------- active session

export async function getActiveSession() {
  const { activeSession } = await getKeys('activeSession');
  return activeSession || null;
}
export async function setActiveSession(session) {
  await setKeys({ activeSession: session });
}
export async function clearActiveSession() {
  await setKeys({ activeSession: null });
}

// ------------------------------------------------------------------ archives

export async function getArchives() {
  const { archives } = await getKeys('archives');
  return archives || {};
}

/**
 * If a new ISO week has started since the last check, move the entries
 * belonging to the previous week into `archives` (keyed by that week's
 * Monday) and remove them from the live `entries` bucket. Non-destructive:
 * archived weeks remain fully browsable/exportable/editable from the
 * dashboard's history view, only the "live" working set stays lean.
 * Returns the archived week key if a rollover happened, else null.
 */
export async function runWeeklyRolloverIfNeeded() {
  const settings = await getSettings();
  const currentWeek = weekStartStr();
  if (settings.lastWeeklyResetCheck === currentWeek) return null;

  const entries = await getEntries();
  const manualAdjustments = await getManualAdjustments();
  const dayNotes = await getDayNotes();
  const archives = await getArchives();
  const previousWeek = settings.lastWeeklyResetCheck;
  const previousWeekEnd = weekEndStr(previousWeek);

  const toArchiveEntries = {};
  const toArchiveAdjustments = {};
  const toArchiveNotes = {};
  for (const [date, byDomain] of Object.entries(entries)) {
    if (date >= previousWeek && date <= previousWeekEnd) {
      toArchiveEntries[date] = byDomain;
      delete entries[date];
      if (manualAdjustments[date]) {
        toArchiveAdjustments[date] = manualAdjustments[date];
        delete manualAdjustments[date];
      }
      if (dayNotes[date]) {
        toArchiveNotes[date] = dayNotes[date];
        delete dayNotes[date];
      }
    }
  }

  if (Object.keys(toArchiveEntries).length) {
    archives[previousWeek] = {
      weekStart: previousWeek,
      weekEnd: previousWeekEnd,
      entries: toArchiveEntries,
      manualAdjustments: toArchiveAdjustments,
      dayNotes: toArchiveNotes,
      archivedAt: Date.now()
    };
  }

  await setKeys({ entries, manualAdjustments, dayNotes, archives });
  await updateSettings({ lastWeeklyResetCheck: currentWeek });
  return Object.keys(toArchiveEntries).length ? previousWeek : null;
}

/** Moves an archived week's data back into the live `entries` set for editing. */
export async function restoreArchivedWeek(weekStart) {
  const archives = await getArchives();
  const archived = archives[weekStart];
  if (!archived) return;
  const entries = await getEntries();
  const manualAdjustments = await getManualAdjustments();
  const dayNotes = await getDayNotes();
  for (const [date, byDomain] of Object.entries(archived.entries)) {
    entries[date] = { ...(entries[date] || {}), ...byDomain };
  }
  for (const [date, byProject] of Object.entries(archived.manualAdjustments || {})) {
    manualAdjustments[date] = { ...(manualAdjustments[date] || {}), ...byProject };
  }
  for (const [date, byProject] of Object.entries(archived.dayNotes || {})) {
    dayNotes[date] = { ...(dayNotes[date] || {}), ...byProject };
  }
  delete archives[weekStart];
  await setKeys({ entries, manualAdjustments, dayNotes, archives });
}

// ------------------------------------------------------------- excluded sites
// With broad tracking on, everything is trackable by default EXCEPT domains
// the user explicitly excludes (e.g. Gmail, which stays open all day and
// isn't tied to a project). No permission dance needed here — the browser
// wide permission is granted once, up front, at install.

export async function getExcludedSites() {
  const { excludedSites } = await getKeys('excludedSites');
  return excludedSites || {};
}
export async function addExcludedSite(domain) {
  const excludedSites = await getExcludedSites();
  excludedSites[domain] = { addedAt: Date.now() };
  await setKeys({ excludedSites });
}
export async function removeExcludedSite(domain) {
  const excludedSites = await getExcludedSites();
  delete excludedSites[domain];
  await setKeys({ excludedSites });
}

// ------------------------------------------------------------------ day notes
// A single freeform note per (date, project) — this is the "overall
// comment so far today" the user actually wants to edit, as opposed to
// picking through many small auto-recorded session comments one at a time.
// Session-level comments still exist (for provenance / detailed audit) and
// are shown as a fallback when no day note has been written yet.

export async function getDayNotes() {
  const { dayNotes } = await getKeys('dayNotes');
  return dayNotes || {};
}
export async function setDayNote(date, projectId, text) {
  const dayNotes = await getDayNotes();
  dayNotes[date] = dayNotes[date] || {};
  dayNotes[date][projectId] = text;
  await setKeys({ dayNotes });
}
export async function getDayNote(date, projectId) {
  const dayNotes = await getDayNotes();
  return dayNotes[date]?.[projectId] || '';
}

// ------------------------------------------------------------- global activity
// Total time the browser itself was actively used (focused + not idle),
// independent of which site was open. Requires no host permission at all —
// it never reads a URL, only focus/idle state — so it can safely cover
// ALL browsing without the extension ever seeing which sites you visited.

export async function getGlobalActivity() {
  const { globalActivity } = await getKeys('globalActivity');
  return globalActivity || {};
}
export async function addGlobalActiveMs(date, ms) {
  if (ms <= 0) return;
  const globalActivity = await getGlobalActivity();
  globalActivity[date] = (globalActivity[date] || 0) + ms;
  await setKeys({ globalActivity });
}
export async function getGlobalActiveSession() {
  const { globalActiveSession } = await getKeys('globalActiveSession');
  return globalActiveSession || null;
}
export async function setGlobalActiveSession(session) {
  await setKeys({ globalActiveSession: session });
}
export async function clearGlobalActiveSession() {
  await setKeys({ globalActiveSession: null });
}

// ------------------------------------------------------------- session dismissal
// "Not now" on the in-page setup prompt should stick for the rest of the
// browsing session (i.e. until Chrome fully closes), not forever and not
// just until the next tab switch. chrome.storage.session is purpose-built
// for exactly this: it behaves like storage.local but is automatically
// wiped when the browser closes.

export async function isDismissedThisSession(domain) {
  const result = await chrome.storage.session.get(`dismissed:${domain}`);
  return Boolean(result[`dismissed:${domain}`]);
}
export async function dismissForSession(domain) {
  await chrome.storage.session.set({ [`dismissed:${domain}`]: Date.now() });
}
export async function clearDismissal(domain) {
  await chrome.storage.session.remove(`dismissed:${domain}`);
}
export async function getAllDismissedThisSession() {
  const all = await chrome.storage.session.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith('dismissed:'))
    .map((k) => k.slice('dismissed:'.length));
}
