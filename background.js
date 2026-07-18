// background.js — MV3 service worker.
//
// This is the ONLY place time-tracking decisions are made. Event-driven
// (no polling), all state lives in chrome.storage (survives service-worker
// restarts, which killed the old in-memory-Map approach). See lib/storage.js
// for the data model.
//
// One extra piece of logic lives here that's easy to miss: a "settle
// window". Salesforce itself briefly bounces a tab through 2-3 different
// hostnames when it hands off between the Lightning app and Setup (or other
// internal redirects) — often within the same second. Reacting to every one
// of those as a real domain switch fragmented the timesheet into a wall of
// 0-2 second sessions. Now a same-tab domain change waits ~2s and re-checks
// before committing; genuine tab/window switches still commit immediately
// since those really should pause tracking right away.

import { isTrackableUrl, getDomain, guessOrgLabel } from './lib/domains.js';
import {
  initDefaultsIfNeeded,
  getSettings,
  getActiveSession,
  setActiveSession,
  clearActiveSession,
  appendSession,
  needsDailySetup,
  carryOverSetup,
  runWeeklyRolloverIfNeeded,
  getExcludedSites,
  getGlobalActiveSession,
  setGlobalActiveSession,
  clearGlobalActiveSession,
  addGlobalActiveMs
} from './lib/storage.js';
import { dateStr } from './lib/dateUtils.js';

const HEARTBEAT_ALARM = 'heartbeat';
const DASHBOARD_PATH = 'pages/dashboard.html';
const SETTLE_WINDOW_MS = 2000;
const UPDATE_DEBOUNCE_MS = 300;

// Best-effort cache only — always re-derived from chrome.idle.queryState()
// on wake, so losing it on a service-worker restart is harmless.
let lastKnownIdleState = 'active';

// A cached copy of settings, refreshed on startup and whenever
// chrome.storage fires a change to the `settings` key. Reconcile logic
// runs very frequently (every tab switch, every SPA route change on sites
// like Salesforce Lightning) — re-fetching settings from storage on each
// call adds up, so this avoids that for the checks that need it every time
// (manual pause, global auto-track toggle, idle threshold).
let cachedSettings = null;
async function getCachedSettings() {
  if (!cachedSettings) cachedSettings = await getSettings();
  return cachedSettings;
}

// Per-tab debounce timers for the settle window. Memory-only by design:
// worst case if a service-worker restart wipes one mid-flap, the next
// event just re-schedules it — no tracked time is lost either way, since
// the previous session is never stopped until a switch actually commits.
const pendingSwitchTimers = new Map();

// Serializes every storage-mutating operation (event handlers AND the
// settle-window timer callback) so they can't race each other.
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.then(() => {}, () => {});
  return run;
}

// ------------------------------------------------------------ lifecycle

chrome.runtime.onInstalled.addListener(() => withLock(async () => {
  await initDefaultsIfNeeded();
  await ensureIdleDetectionInterval();
  await recoverFromUncleanShutdown();
  await injectIntoExistingTabs();
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  await openOrFocusDashboard();
  await reconcileAll();
}));

chrome.runtime.onStartup.addListener(() => withLock(async () => {
  await initDefaultsIfNeeded();
  await ensureIdleDetectionInterval();
  await recoverFromUncleanShutdown();
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  await reconcileAll();
}));

async function ensureIdleDetectionInterval() {
  cachedSettings = await getSettings();
  const seconds = Math.max(15, Math.round(cachedSettings.idleThresholdMinutes * 60));
  chrome.idle.setDetectionInterval(seconds);
  try {
    lastKnownIdleState = await chrome.idle.queryState(seconds);
  } catch {
    lastKnownIdleState = 'active';
  }
}

/** Makes the setup overlay available immediately in tabs already open before install/update. */
async function injectIntoExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  } catch {
    // Non-fatal — new navigations will still pick up the content script.
  }
}

/**
 * If the service worker (or the whole browser) died while a session was
 * active, don't credit the full downtime as tracked time — only trust
 * elapsed time up to the last recorded heartbeat/flush checkpoint.
 */
async function recoverFromUncleanShutdown() {
  const active = await getActiveSession();
  if (active) {
    const safeEnd = active.lastFlushTs || active.startTs;
    if (safeEnd > active.startTs) await appendSession(active.date, active.domain, active.startTs, safeEnd);
    await clearActiveSession();
  }
  const globalActive = await getGlobalActiveSession();
  if (globalActive) {
    const safeEnd = globalActive.lastFlushTs || globalActive.startTs;
    if (safeEnd > globalActive.startTs) await addGlobalActiveMs(globalActive.date, safeEnd - globalActive.startTs);
    await clearGlobalActiveSession();
  }
}

// ------------------------------------------------------------ event wiring

chrome.tabs.onActivated.addListener(() => withLock(reconcileAll));

let updateDebounceTimer = null;
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!(changeInfo.url || changeInfo.status === 'complete')) return;
  // SPAs like Salesforce Lightning fire many of these per logical
  // navigation (pushState-based routing) — coalesce a burst into one
  // reconcile instead of running the full async candidate check per event.
  clearTimeout(updateDebounceTimer);
  updateDebounceTimer = setTimeout(() => withLock(reconcileAll), UPDATE_DEBOUNCE_MS);
});
chrome.tabs.onRemoved.addListener(() => withLock(reconcileAll));
chrome.windows.onFocusChanged.addListener(() => withLock(reconcileAll));

chrome.idle.onStateChanged.addListener((state) => {
  lastKnownIdleState = state;
  withLock(reconcileAll);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  withLock(async () => {
    await heartbeatFlush();
    await handleDateAndWeekRollover();
    await updateBadge();
  });
});

// content.js writes setup results (and the dashboard writes edits/settings)
// straight to chrome.storage — react generically rather than requiring
// explicit messages.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    cachedSettings = null;
    withLock(ensureIdleDetectionInterval);
  }
  if ((area === 'local' && (changes.entries || changes.domainMap || changes.taskContext)) || area === 'session') {
    withLock(reconcileAll);
  }
});

// ------------------------------------------------------------ core engine

async function reconcileAll() {
  await reconcileOrgSession();
  await reconcileGlobalSession();
  await updateBadge();
}

/**
 * Reconciles the single "which tracked domain is being actively worked on
 * right now" session. Same-tab domain changes go through the settle window
 * instead of committing immediately, to absorb redirect chains.
 */
async function reconcileOrgSession() {
  const candidate = await getCurrentOrgCandidate();
  const current = await getActiveSession();

  const sameTarget = current && candidate && current.tabId === candidate.tabId && current.domain === candidate.domain;
  if (sameTarget) {
    clearPendingSwitch(candidate.tabId);
    return;
  }

  const sameTabDomainChange = current && candidate && current.tabId === candidate.tabId;
  if (sameTabDomainChange) {
    schedulePendingSwitch(candidate.tabId);
    return;
  }

  if (current) clearPendingSwitch(current.tabId);
  await commitSwitch(candidate);
}

function schedulePendingSwitch(tabId) {
  if (pendingSwitchTimers.has(tabId)) return; // already waiting on this tab
  const timer = setTimeout(() => {
    pendingSwitchTimers.delete(tabId);
    withLock(async () => {
      const freshCandidate = await getCurrentOrgCandidate();
      if (freshCandidate && freshCandidate.tabId === tabId) {
        await commitSwitch(freshCandidate);
        await updateBadge();
      }
      // Otherwise the world moved on (a real tab switch happened during the
      // wait) — the event-driven reconcile for that already handled it.
    });
  }, SETTLE_WINDOW_MS);
  pendingSwitchTimers.set(tabId, timer);
}
function clearPendingSwitch(tabId) {
  if (tabId == null) return;
  const t = pendingSwitchTimers.get(tabId);
  if (t) { clearTimeout(t); pendingSwitchTimers.delete(tabId); }
}

async function commitSwitch(candidate) {
  const previous = await getActiveSession();
  if (previous) {
    await appendSession(previous.date, previous.domain, previous.startTs, Date.now());
    await clearActiveSession();
  }
  if (!candidate) return;

  // Same tab, domain settled to something new, and it looks like the same
  // underlying org (shared base label) — silently continue the same task
  // rather than prompting again. A genuinely different org typed into the
  // same tab won't match labels, so it still gets its own prompt.
  if (previous && previous.tabId === candidate.tabId && previous.domain !== candidate.domain &&
      guessOrgLabel(previous.domain) === guessOrgLabel(candidate.domain)) {
    await carryOverSetup(previous.domain, candidate.domain, previous.date);
  }

  const setupNeeded = await needsDailySetup(candidate.domain);
  if (!setupNeeded) {
    const now = Date.now();
    await setActiveSession({
      tabId: candidate.tabId,
      windowId: candidate.windowId,
      domain: candidate.domain,
      date: dateStr(),
      startTs: now,
      lastFlushTs: now
    });
  }
  // If setup IS needed, content.js owns showing the overlay for that tab —
  // we just don't start a session until storage says today's entry exists.
}

async function getCurrentOrgCandidate() {
  if (lastKnownIdleState !== 'active') return null;

  const settings = await getCachedSettings();
  if (settings.manuallyPaused || settings.autoTrackEnabled === false) return null;

  const win = await getFocusedNormalWindow();
  if (!win) return null;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, windowId: win.id });
  } catch {
    return null;
  }
  const tab = tabs[0];
  if (!tab || !tab.url) return null;

  const excludedSites = await getExcludedSites();
  if (!isTrackableUrl(tab.url, excludedSites)) return null;

  return { tabId: tab.id, windowId: win.id, domain: getDomain(tab.url) };
}

// Pending "actually stop counting screen time" timer — separate from, and
// more forgiving than, the idle threshold used to pause org-session
// billing. Billing should pause quickly and precisely; "was I at my desk"
// should tolerate a longer stretch of not touching the mouse/keyboard
// (reading, thinking) before it's counted as away.
let pendingGlobalStopTimer = null;

/** Domain-agnostic: is the browser itself actively being used right now? */
async function reconcileGlobalSession() {
  const shouldBeActive = lastKnownIdleState === 'active' && Boolean(await getFocusedNormalWindow());
  const current = await getGlobalActiveSession();

  if (shouldBeActive) {
    if (pendingGlobalStopTimer) {
      clearTimeout(pendingGlobalStopTimer);
      pendingGlobalStopTimer = null;
    }
    if (!current) {
      const now = Date.now();
      await setGlobalActiveSession({ date: dateStr(), startTs: now, lastFlushTs: now });
    }
    return;
  }

  if (current && !pendingGlobalStopTimer) {
    const settings = await getSettings();
    const graceMs = Math.max(0, (settings.screenTimeGraceMinutes ?? 10) * 60000);
    pendingGlobalStopTimer = setTimeout(() => {
      pendingGlobalStopTimer = null;
      withLock(async () => {
        const stillInactive = lastKnownIdleState !== 'active' || !(await getFocusedNormalWindow());
        const stillCurrent = await getGlobalActiveSession();
        if (stillInactive && stillCurrent) {
          await addGlobalActiveMs(stillCurrent.date, Date.now() - stillCurrent.startTs);
          await clearGlobalActiveSession();
        }
      });
    }, graceMs);
  }
}

async function getFocusedNormalWindow() {
  let win;
  try {
    win = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal', 'popup'] });
  } catch {
    return null;
  }
  if (!win || !win.focused || win.id === chrome.windows.WINDOW_ID_NONE) return null;
  return win;
}

/** Periodic checkpoint so a crash loses at most ~1 minute, not the whole session. */
async function heartbeatFlush() {
  const active = await getActiveSession();
  if (active) await setActiveSession({ ...active, lastFlushTs: Date.now() });
  const globalActive = await getGlobalActiveSession();
  if (globalActive) await setGlobalActiveSession({ ...globalActive, lastFlushTs: Date.now() });
}

/** Rolls a live session across midnight, and archives the prior week on Monday. */
async function handleDateAndWeekRollover() {
  const today = dateStr();

  const active = await getActiveSession();
  if (active && active.date !== today) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    await appendSession(active.date, active.domain, active.startTs, midnight.getTime());
    const setupNeeded = await needsDailySetup(active.domain, today);
    await clearActiveSession();
    if (!setupNeeded) {
      await setActiveSession({ ...active, date: today, startTs: midnight.getTime(), lastFlushTs: Date.now() });
    }
  }

  const globalActive = await getGlobalActiveSession();
  if (globalActive && globalActive.date !== today) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    await addGlobalActiveMs(globalActive.date, midnight.getTime() - globalActive.startTs);
    await setGlobalActiveSession({ date: today, startTs: midnight.getTime(), lastFlushTs: Date.now() });
  }

  const archivedWeek = await runWeeklyRolloverIfNeeded();
  if (archivedWeek) {
    await chrome.storage.local.set({ pendingRolloverNotice: archivedWeek });
  }
}

// ------------------------------------------------------------ UI surfaces

async function openOrFocusDashboard() {
  const url = chrome.runtime.getURL(DASHBOARD_PATH);
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

async function updateBadge() {
  const active = await getActiveSession();
  const settings = await getCachedSettings();
  if (settings.manuallyPaused) {
    chrome.action.setBadgeText({ text: '❚❚' });
    chrome.action.setBadgeBackgroundColor({ color: '#8A8DA0' });
    chrome.action.setTitle({ title: 'Paused (manual) — OrgClock' });
  } else if (active) {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#00B8A9' });
    chrome.action.setTitle({ title: `Tracking ${active.domain}` });
  } else if (lastKnownIdleState !== 'active') {
    chrome.action.setBadgeText({ text: '❚❚' });
    chrome.action.setBadgeBackgroundColor({ color: '#F2A93B' });
    chrome.action.setTitle({ title: 'Paused (idle) — OrgClock' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'OrgClock — click to open dashboard' });
  }
}
