// lib/storage.js
// Single source of truth for everything persisted in chrome.storage.local.
//
// Schema (v6)
// -----------
// settings:      { idleThresholdMinutes, theme, lastWeeklyResetCheck }
// projects:      { [projectId]: { id, name, category, hue, createdAt, archived } }
// domainMap:     { [domain]: projectId }        -- permanent "home project" per domain
// taskContext:   { [domain]: { projectId, updatedAt } }
//                -- which project a NEW auto-tracked session on this domain
//                   bills to; defaults to the domain's home project, but can
//                   be overridden for a work block (e.g. referencing another
//                   org's project while sitting on this domain's tab)
// entries:       { [dateStr]: { [domain]: { sessions: Session[] } } }
// manualAdjustments: { [dateStr]: { [projectId]: ms } }
// archives:      { [weekStartStr]: { weekStart, weekEnd, entries, manualAdjustments, archivedAt } }
// activeSession: { tabId, windowId, domain, date, startTs, lastFlushTs } | null
//
// Session = { id, start, end, projectId, comment, manual, isNote? }
//
// Why sessions (not the whole domain-day) carry the project: a domain has
// one permanent "home" project, but any individual work block on it can be
// billed elsewhere (e.g. you're on Org A's tab but actually referencing it
// while doing work for Org B). Session-level tagging is what makes that
// correct, and it's also what lets the dashboard group by PROJECT across
// however many domains contributed to it, rather than by domain.
//
// v6 removed the separate `taskName` field and the old `dayNotes` — a
// single freeform per-project-per-day string that a dashboard edit
// silently made the PERMANENT source of truth for display, blocking any
// later comment additions from the popup. Comments are now always
// independent, immediately-saved, timestamped entries (see addQuickNote
// below) — never a persistent "current context" that something else can
// silently override. `getDayCommentLog()` reconstructs the full
// chronological history by just reading every session's comment, so
// there's nothing to fall out of sync.

import { newId } from './id.js';
import { dateStr, parseDateStr, weekStartStr, weekEndStr } from './dateUtils.js';

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

// The domain bucket used for comments added from the dashboard (which
// isn't tied to any one site). Comments added from the in-page popup use
// the REAL current domain instead, so "Sites contributing" stays accurate
// for those.
export const MANUAL_NOTE_DOMAIN = 'manual-notes';

// Categories are now fully user-managed (no built-ins baked into the
// product). This list is used ONLY once, as a one-time seed for installs
// that already have projects tagged with these names from before this
// change — see the categoriesMigrated patch in initDefaultsIfNeeded()
// below. It is intentionally not exported.
const LEGACY_SEED_CATEGORIES = [
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
    'manualAdjustments', 'archives', 'excludedSites', 'alwaysPromptSites',
    'dayNotes', 'globalActivity', 'customCategories', 'categoriesMigrated', 'dayNotesMigrated'
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
  if (!existing.alwaysPromptSites) patch.alwaysPromptSites = {};
  if (!existing.globalActivity) patch.globalActivity = {};
  if (!existing.customCategories) patch.customCategories = [];
  if (!existing.categoriesMigrated) {
    // One-time only: categories used to be a fixed built-in list. Now
    // they're fully user-managed. For anyone upgrading, seed their
    // editable category list with the old built-ins PLUS whatever
    // category strings their existing projects already use, so nothing
    // already-tagged goes orphaned. Fresh installs get an empty list.
    const existingProjectCategories = Object.values(existing.projects || {})
      .map((p) => p.category)
      .filter(Boolean);
    const seed = [...new Set([
      ...(existing.projects ? LEGACY_SEED_CATEGORIES : []),
      ...existingProjectCategories,
      ...(existing.customCategories || [])
    ])];
    patch.customCategories = seed;
    patch.categoriesMigrated = true;
  }
  if (!existing.dayNotesMigrated && existing.dayNotes) {
    // One-time only: v6 retired the old single-freeform-per-day note
    // field entirely (it's what caused later comments to go invisible).
    // Convert every existing dayNotes entry into a normal timestamped
    // note so nothing typed is lost — it just becomes a regular part of
    // that day's comment history instead of a separate overriding field.
    const entries = existing.entries ? { ...existing.entries } : {};
    for (const [date, byProject] of Object.entries(existing.dayNotes)) {
      for (const [projectId, text] of Object.entries(byProject)) {
        if (!text || !text.trim()) continue;
        entries[date] = entries[date] || {};
        entries[date][MANUAL_NOTE_DOMAIN] = entries[date][MANUAL_NOTE_DOMAIN] || { sessions: [] };
        entries[date][MANUAL_NOTE_DOMAIN].sessions.push({
          id: newId('note'), start: Date.now(), end: Date.now(),
          projectId, comment: text.trim(), manual: true, isNote: true
        });
      }
    }
    patch.entries = entries;
  }
  if (!existing.dayNotesMigrated) patch.dayNotesMigrated = true;
  if (Object.keys(patch).length) await setKeys(patch);
  if (existing.dayNotes) await chrome.storage.local.remove('dayNotes');
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

export async function createProject(name, category = '') {
  const projects = await getProjects();
  const id = newId('proj');
  const hue = Math.floor(Math.random() * 360);
  const now = Date.now();
  projects[id] = { id, name: name.trim(), category, hue, createdAt: now, lastUsedAt: now, archived: false };
  await setKeys({ projects });
  return projects[id];
}

/**
 * Permanently removes a project and everything that references it: its
 * domain links, task context, every recorded session (live + archived),
 * manual adjustments, and every comment (comments are session-level now,
 * so they're removed as part of the entries cleanup below). Unlike
 * `archived: true` (soft-hide), this can't be undone — the dashboard
 * confirms before calling this.
 */
export async function deleteProjectPermanently(projectId) {
  const [projects, domainMap, taskContext, entries, archives, manualAdjustments] = await Promise.all([
    getProjects(), getDomainMap(), getTaskContext(), getEntries(), getArchives(), getManualAdjustments()
  ]);

  delete projects[projectId];

  for (const domain of Object.keys(domainMap)) {
    if (domainMap[domain] === projectId) delete domainMap[domain];
  }
  for (const domain of Object.keys(taskContext)) {
    if (taskContext[domain]?.projectId === projectId) delete taskContext[domain];
  }
  for (const byDomain of Object.values(entries)) {
    for (const container of Object.values(byDomain)) {
      container.sessions = container.sessions.filter((s) => s.projectId !== projectId);
    }
  }
  for (const archive of Object.values(archives)) {
    for (const byDomain of Object.values(archive.entries || {})) {
      for (const container of Object.values(byDomain)) {
        container.sessions = container.sessions.filter((s) => s.projectId !== projectId);
      }
    }
    for (const byProject of Object.values(archive.manualAdjustments || {})) delete byProject[projectId];
  }
  for (const byProject of Object.values(manualAdjustments)) delete byProject[projectId];

  await setKeys({ projects, domainMap, taskContext, entries, archives, manualAdjustments });
}

/** Bumps a project's recency so pickers can surface recently-used projects first. */
export async function touchProjectUsage(projectId) {
  if (!projectId) return;
  const projects = await getProjects();
  if (!projects[projectId]) return;
  projects[projectId].lastUsedAt = Date.now();
  await setKeys({ projects });
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
// Fully user-managed: no built-in list. Everything lives in
// `customCategories`; users create, rename, and delete freely.

export async function getCustomCategories() {
  const { customCategories } = await getKeys('customCategories');
  return customCategories || [];
}
export async function addCustomCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const customCategories = await getCustomCategories();
  if (!customCategories.includes(trimmed)) {
    customCategories.push(trimmed);
    await setKeys({ customCategories });
  }
}
export async function renameCategory(oldName, newName) {
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return;
  const customCategories = await getCustomCategories();
  const idx = customCategories.indexOf(oldName);
  if (idx === -1) return;
  if (customCategories.includes(trimmed)) {
    // Renaming onto an existing category: just drop the old one and let
    // projects fall through to the merge below.
    customCategories.splice(idx, 1);
  } else {
    customCategories[idx] = trimmed;
  }
  const projects = await getProjects();
  for (const p of Object.values(projects)) {
    if (p.category === oldName) p.category = trimmed;
  }
  await setKeys({ customCategories, projects });
}
export async function deleteCategory(name) {
  const customCategories = (await getCustomCategories()).filter((c) => c !== name);
  const projects = await getProjects();
  for (const p of Object.values(projects)) {
    if (p.category === name) p.category = '';
  }
  await setKeys({ customCategories, projects });
}
export async function getAllCategories() {
  return getCustomCategories();
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

export async function setTaskContext(domain, projectId) {
  const taskContext = await getTaskContext();
  taskContext[domain] = { projectId, updatedAt: Date.now() };
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
 * Saves the setup overlay: links the domain's PERMANENT home project
 * (creating it if `newHomeProjectName` given), sets which project NEW
 * sessions on this domain should bill to, and ensures today's container
 * exists so needsDailySetup() flips false immediately even before any
 * session has actually been appended yet.
 */
export async function saveTaskSetup({
  domain, date = dateStr(),
  homeProjectId, newHomeProjectName,
  workingProjectId, newWorkingProjectName
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

  await setTaskContext(domain, finalWorkingId);

  const entries = await getEntries();
  ensureDomainContainer(entries, date, domain);
  await saveEntries(entries);

  return finalWorkingId;
}

/**
 * Appends a completed [start, end) session slice for AUTO-TRACKED time,
 * tagged with whichever project is currently set as this domain's task
 * context. Auto-tracked sessions never carry a comment — comments are
 * always separate, immediately-saved notes (see addQuickNote below), so
 * there's nothing here that can go stale or get silently overridden by a
 * later edit, unlike the old per-domain "current comment" design.
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

  const settings = await getSettings();
  const mergeGapMs = Math.max(0, (settings.mergeGapSeconds ?? 90) * 1000);

  // Merge into the most recently-ended auto-tracked session for this SAME
  // PROJECT, across any domain today, if it's within the merge gap. This
  // covers both rapid switching between sites billed to the same project
  // AND short tracking "blips" (e.g. a tab focused under a second while
  // switching) — both used to fragment into a wall of tiny rows.
  let best = null;
  for (const [d, c] of Object.entries(entries[date])) {
    for (const s of c.sessions) {
      if (s.projectId !== projectId || s.manual || s.isNote) continue;
      if (!best || s.end > best.session.end) best = { domain: d, session: s };
    }
  }

  if (best && start >= best.session.end && start - best.session.end <= mergeGapMs) {
    best.session.end = end;
    await saveEntries(entries);
    return;
  }

  container.sessions.push({ id: newId('sess'), start, end, projectId, comment: '', manual: false });
  await saveEntries(entries);
}

/**
 * Adds a standalone, immediately-saved, timestamped comment — the ONLY
 * way comments get created now. Zero duration by design (it's a note,
 * not tracked time): `start === end` means it contributes nothing to the
 * project's total, while still showing up in the same chronological
 * session list everything else uses, so "today's full comment history"
 * just falls out of reading sessions in order — there's no separate
 * field to fall out of sync with it.
 * `domain` is the real site for popup-added notes (keeps "Sites
 * contributing" accurate), or MANUAL_NOTE_DOMAIN for dashboard-added ones.
 */
export async function addQuickNote(date, domain, projectId, comment) {
  const trimmed = (comment || '').trim();
  if (!trimmed || !projectId) return;
  const entries = await getEntries();
  const container = ensureDomainContainer(entries, date, domain);
  const now = Date.now();
  container.sessions.push({ id: newId('note'), start: now, end: now, projectId, comment: trimmed, manual: true, isNote: true });
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
    if (next.start - current.end <= gapMs) {
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
      id: newId('sess'), start: block.start, end: block.end, projectId, comment: block.comment, manual: false
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
  await setTaskContext(toDomain, ctx.projectId);

  const entries = await getEntries();
  ensureDomainContainer(entries, date, toDomain);
  await saveEntries(entries);
  return true;
}

export async function addManualSession(date, domain, start, end, projectId, comment = '') {
  if (end <= start) throw new Error('End time must be after start time.');
  const entries = await getEntries();
  const container = entries[date]?.[domain];
  if (!container) throw new Error('No entry for that site/day yet.');
  container.sessions.push({ id: newId('sess'), start, end, projectId, comment, manual: true });
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

// -------------------------------------------------------------- data cleanup

/**
 * Deletes all tracked data (sessions, manual adjustments) for dates within
 * [startDate, endDate] inclusive, across both live `entries` and any
 * `archives` weeks that overlap the range. Returns the number of dates
 * that had something removed. Projects themselves are untouched — this
 * only clears time entries, see deleteProjectPermanently() to also remove
 * a project.
 */
export async function deleteSessionsInRange(startDate, endDate) {
  const [entries, manualAdjustments, archives] = await Promise.all([
    getEntries(), getManualAdjustments(), getArchives()
  ]);
  let affected = 0;

  for (const date of Object.keys(entries)) {
    if (date >= startDate && date <= endDate) {
      delete entries[date];
      delete manualAdjustments[date];
      affected++;
    }
  }
  for (const [weekStart, archive] of Object.entries(archives)) {
    let touched = false;
    for (const date of Object.keys(archive.entries || {})) {
      if (date >= startDate && date <= endDate) {
        delete archive.entries[date];
        delete archive.manualAdjustments?.[date];
        affected++;
        touched = true;
      }
    }
    if (touched && Object.keys(archive.entries).length === 0) delete archives[weekStart];
  }

  await setKeys({ entries, manualAdjustments, archives });
  return affected;
}

/** Convenience wrapper: deletes everything older than N days from today. */
export async function deleteSessionsOlderThan(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  const cutoffStr = dateStr(cutoff);
  // 1970-01-01 as a safe lower bound — dates are simple YYYY-MM-DD strings
  // so lexicographic comparison works fine for range checks.
  return deleteSessionsInRange('0000-01-01', shiftForCleanup(cutoffStr));
}
function shiftForCleanup(cutoffStr) {
  const d = parseDateStr(cutoffStr);
  d.setDate(d.getDate() - 1);
  return dateStr(d);
}

// ------------------------------------------------------------- full backup
// A complete point-in-time snapshot of EVERYTHING OrgClock stores — every
// key in chrome.storage.local, not just tracked time. This exists mainly
// for one scenario: chrome.storage.local is scoped PER EXTENSION ID, and
// for an unpacked dev install, that ID is derived from the folder path it
// was loaded from. Load a new version from a different folder (e.g.
// re-downloading a new zip each release) and Chrome treats it as a
// different extension — your old data isn't deleted, it's just sitting
// invisible under the old extension's storage. Export before switching,
// import after, and everything (projects, sessions, settings, categories,
// domain links — all of it) comes back exactly as it was.

const BACKUP_SCHEMA = 'orgclock-backup-v1';

export async function exportFullBackup() {
  const all = await chrome.storage.local.get(null);
  return { schema: BACKUP_SCHEMA, exportedAt: Date.now(), data: all };
}

/**
 * Restores a previously exported backup. Uses `set()` (merge into
 * existing storage), NOT `clear()` first — this matters if the backup
 * predates a schema addition (e.g. a v5.1.0 backup won't have
 * `alwaysPromptSites`): after the merge, initDefaultsIfNeeded() backfills
 * anything the backup didn't have, instead of a clear()+set() risking an
 * empty gap if interrupted between the two steps.
 */
export async function importFullBackup(backup) {
  if (!backup || backup.schema !== BACKUP_SCHEMA || !backup.data || typeof backup.data !== 'object') {
    throw new Error("This doesn't look like an OrgClock backup file.");
  }
  await setKeys(backup.data);
  await initDefaultsIfNeeded();
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

/**
 * Collapses duplicate lines within a comment string, keeping the first
 * occurrence's position and dropping repeats. Exists for one specific,
 * confirmed-in-the-wild reason: pre-v6 versions merged same-task session
 * comments by concatenating with `\n` every time a session merged, and
 * if you kept returning to the same task/comment over a long stretch,
 * that could pile the SAME line into one comment string dozens of times
 * (seen directly in an exported CSV — one cell had a line repeated 19
 * times). v6+ never creates comments this way (each note is its own
 * standalone entry), so this only ever matters for old data — but old
 * data doesn't go away, so every place a comment is displayed or
 * exported runs it through this first.
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
 * Groups a day's flattened sessions by projectId. `comments`/`displayNote`
 * are now ALWAYS derived purely from session comments, in chronological
 * order — there's no separate freeform field that can silently block a
 * later comment from showing up (that was the old dayNotes bug: editing
 * it once made it the PERMANENT source of truth, and nothing added after
 * ever appeared). Time-only sessions (comment === '') just don't
 * contribute a line; note-only entries (isNote, zero duration) contribute
 * a line but no time.
 */
export function groupDayByProject(byDomain, manualAdjustmentsForDay = {}) {
  const sessions = flattenDaySessions(byDomain);
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.projectId)) byProject.set(s.projectId, []);
    byProject.get(s.projectId).push(s);
  }
  const result = [];
  for (const [projectId, sessionList] of byProject.entries()) {
    const sessionMs = sessionList.reduce((sum, s) => (s.isNote ? sum : sum + Math.max(0, s.end - s.start)), 0);
    const adjustmentMs = manualAdjustmentsForDay[projectId] || 0;
    const domains = [...new Set(sessionList.map((s) => s.domain))];
    const chronological = [...sessionList].sort((a, b) => (a.isNote ? a.start : a.end) - (b.isNote ? b.start : b.end));
    const rawComments = chronological.map((s) => s.comment).filter(Boolean).join('\n');
    const displayNote = dedupeCommentLines(rawComments);
    const comments = displayNote ? displayNote.split('\n') : [];
    result.push({
      projectId,
      sessions: sessionList.sort((a, b) => a.start - b.start),
      domains,
      comments,
      displayNote,
      totalMs: Math.max(0, sessionMs + adjustmentMs),
      adjustmentMs
    });
  }
  return result;
}

/**
 * Every non-empty comment recorded for a day, across every project,
 * flattened and sorted chronologically — this IS "today's complete
 * comment history." Powers the Notes dashboard view and, indirectly
 * (content.js reads entries directly, dependency-free), the in-page
 * popup's "So far today" reference list. Each entry's comment is
 * cleaned of internal duplicate lines (see dedupeCommentLines) — for
 * new data that's a no-op (one note = one line), for old data it
 * matters a lot.
 */
export function getDayCommentLog(byDomain) {
  const sessions = flattenDaySessions(byDomain);
  return sessions
    .filter((s) => s.comment && s.comment.trim())
    .map((s) => ({
      id: s.id,
      ts: s.isNote ? s.start : s.end,
      projectId: s.projectId,
      domain: s.domain,
      comment: dedupeCommentLines(s.comment.trim()),
      isNote: Boolean(s.isNote)
    }))
    .sort((a, b) => a.ts - b.ts);
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
  const archives = await getArchives();
  const previousWeek = settings.lastWeeklyResetCheck;
  const previousWeekEnd = weekEndStr(previousWeek);

  const toArchiveEntries = {};
  const toArchiveAdjustments = {};
  for (const [date, byDomain] of Object.entries(entries)) {
    if (date >= previousWeek && date <= previousWeekEnd) {
      toArchiveEntries[date] = byDomain;
      delete entries[date];
      if (manualAdjustments[date]) {
        toArchiveAdjustments[date] = manualAdjustments[date];
        delete manualAdjustments[date];
      }
    }
  }

  if (Object.keys(toArchiveEntries).length) {
    archives[previousWeek] = {
      weekStart: previousWeek,
      weekEnd: previousWeekEnd,
      entries: toArchiveEntries,
      manualAdjustments: toArchiveAdjustments,
      archivedAt: Date.now()
    };
  }

  await setKeys({ entries, manualAdjustments, archives });
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
  for (const [date, byDomain] of Object.entries(archived.entries)) {
    entries[date] = { ...(entries[date] || {}), ...byDomain };
  }
  for (const [date, byProject] of Object.entries(archived.manualAdjustments || {})) {
    manualAdjustments[date] = { ...(manualAdjustments[date] || {}), ...byProject };
  }
  delete archives[weekStart];
  await setKeys({ entries, manualAdjustments, archives });
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

// -------------------------------------------------------- always-prompt sites
// The inverse of excludedSites: normally a domain only asks once per day
// (needsDailySetup), but meeting sites (Meet/Zoom/Teams) or anything else
// where "which project is THIS visit for" genuinely changes every time
// benefit from being asked every visit regardless of today's existing setup.

export async function getAlwaysPromptSites() {
  const { alwaysPromptSites } = await getKeys('alwaysPromptSites');
  return alwaysPromptSites || {};
}
export async function addAlwaysPromptSite(domain) {
  const alwaysPromptSites = await getAlwaysPromptSites();
  alwaysPromptSites[domain] = { addedAt: Date.now() };
  await setKeys({ alwaysPromptSites });
}
export async function removeAlwaysPromptSite(domain) {
  const alwaysPromptSites = await getAlwaysPromptSites();
  delete alwaysPromptSites[domain];
  await setKeys({ alwaysPromptSites });
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
