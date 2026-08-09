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
  getIdleExemptSites,
  getGlobalActiveSession,
  setGlobalActiveSession,
  clearGlobalActiveSession,
  addGlobalActiveMs,
  getEntriesForDate,
  ensureEntryContainer,
  addQuickNote
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
    // Re-evaluate "is Chrome actively in the foreground" on every
    // heartbeat too, not just on discrete tab/window/idle events. Those
    // events cover the common cases, but a long stretch with none of them
    // firing (e.g. idle state technically unchanged, no tab switches)
    // could otherwise leave the Chrome-active session open or closed
    // longer than it should be before the next real event re-checks it.
    await reconcileGlobalSession();
    await handleDateAndWeekRollover();
    await updateBadge();
  });
});

// content.js writes setup results (and the dashboard writes edits/settings)
// straight to chrome.storage — react generically rather than requiring
// explicit messages.
let storageReconcileDebounce = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    cachedSettings = null;
    withLock(ensureIdleDetectionInterval);
  }
  if ((area === 'local' && (changes.entries || changes.domainMap || changes.taskContext)) || area === 'session') {
    // Every session append/edit writes `entries`, which used to trigger an
    // immediate full reconcile each time. On a busy day that's a lot of
    // extra storage reads back-to-back with no benefit — reconcile only
    // cares about "did the active tab/domain/setup-state change," which
    // doesn't need sub-300ms precision. Coalesced the same way SPA route
    // churn already is below.
    clearTimeout(storageReconcileDebounce);
    storageReconcileDebounce = setTimeout(() => withLock(reconcileAll), UPDATE_DEBOUNCE_MS);
  }
});

// content.js can't reach IndexedDB directly — content scripts run in the
// origin of whatever PAGE they're injected into, not the extension's own
// origin, so a content script calling indexedDB.open() would silently
// open a totally separate, isolated database per website rather than the
// one place background.js and the dashboard actually read from. These
// three handlers are the bridge: content.js sends a message, this runs in
// the extension's own context (where IndexedDB correctly resolves to the
// shared database), and sends the result back.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ORBIT_GET_TODAY_ENTRIES') {
    getEntriesForDate(message.date).then((byDomain) => sendResponse({ byDomain })).catch(() => sendResponse({ byDomain: {} }));
    return true; // keep the message channel open for the async response
  }
  if (message?.type === 'ORBIT_ENSURE_ENTRY_CONTAINER') {
    ensureEntryContainer(message.date, message.domain).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'ORBIT_SAVE_QUICK_NOTE') {
    addQuickNote(message.date, message.domain, message.projectId, message.comment)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// content.js sends this the instant a NEW "Currently working on" project
// is confirmed via Save, BEFORE it writes the new taskContext to storage
// (ordering matters — see content.js). If there's a currently-active
// session on that same domain (e.g. you've had a meeting tab open and
// active this whole time), its elapsed-so-far time gets flushed under the
// OLD project via an explicit override — NOT by re-reading taskContext,
// which would already show the new project by the time this runs — and
// the session clock restarts so only time from this point forward counts
// toward the new project. Without this, a 1-hour call split 30/30 between
// two projects would silently log the FULL hour to whichever project was
// picked last, since the session only ever gets tagged once, whenever it
// finally flushes (i.e. when the tab loses focus) — not at the moment you
// actually switched.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ORBIT_PROJECT_SWITCH_FLUSH') return;
  withLock(async () => {
    const active = await getActiveSession();
    if (!active || active.domain !== message.domain) return;
    const now = Date.now();
    if (now > active.startTs) {
      await appendSession(active.date, active.domain, active.startTs, now, {
        projectId: message.oldProjectId
      });
    }
    await setActiveSession({ ...active, startTs: now, lastFlushTs: now });
    await updateBadge();
  });
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
  const settings = await getCachedSettings();
  if (settings.manuallyPaused || settings.autoTrackEnabled === false) return null;

  // Chrome being the focused app is still required regardless of idle
  // exemption — that check is specifically about keyboard/mouse input,
  // not about whether you've switched to a completely different app.
  const win = await getFocusedNormalWindow();
  if (!win) return null;

  const tab = await getActiveTabInWindow(win);
  if (!tab || !tab.url) return null;

  const domain = getDomain(tab.url);

  // Meeting apps (Google Meet, Zoom, Teams, etc.) are the canonical case:
  // you can be actively in a call for an hour without touching the
  // keyboard or mouse once, and system-wide idle detection has no way to
  // tell that apart from actually stepping away. Domains on this list
  // skip the idle check entirely — everything else still pauses normally.
  if (lastKnownIdleState !== 'active' && !(await isIdleExemptDomain(domain))) return null;

  const excludedSites = await getExcludedSites();
  if (!isTrackableUrl(tab.url, excludedSites)) return null;

  return { tabId: tab.id, windowId: win.id, domain };
}

async function getActiveTabInWindow(win) {
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
    return tabs[0] || null;
  } catch {
    return null;
  }
}

async function isIdleExemptDomain(domain) {
  if (!domain) return false;
  const idleExemptSites = await getIdleExemptSites();
  return Boolean(idleExemptSites[domain]);
}

// Pending "actually stop counting screen time" timer — separate from, and
// more forgiving than, the idle threshold used to pause org-session
// billing. Billing should pause quickly and precisely; "was I at my desk"
// should tolerate a longer stretch of not touching the mouse/keyboard
// (reading, thinking) before it's counted as away.
let pendingGlobalStopTimer = null;

/**
 * Domain-agnostic: is the browser itself actively being used right now?
 * "Domain-agnostic" with ONE exception — idle-exempt sites (meetings).
 * This used to ignore idle-exemption entirely, checking ONLY system idle
 * state, while getCurrentOrgCandidate() (project billing) did honor it —
 * meaning on a long call on an idle-exempt domain, project time kept
 * accruing correctly but this "Chrome active" stat quietly paused after
 * the idle threshold anyway, making TRACKED time exceed "Chrome active"
 * time, which shouldn't be structurally possible (project time is
 * supposed to be a subset of active-Chrome time). Confirmed directly from
 * an exported CSV: a day showing more tracked minutes than Chrome-active
 * minutes despite normal, non-inflated session durations elsewhere.
 */
async function reconcileGlobalSession() {
  const win = await getFocusedNormalWindow();
  let idleExempt = false;
  if (win && lastKnownIdleState !== 'active') {
    const tab = await getActiveTabInWindow(win);
    idleExempt = await isIdleExemptDomain(tab?.url ? getDomain(tab.url) : null);
  }
  const shouldBeActive = Boolean(win) && (lastKnownIdleState === 'active' || idleExempt);
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
        const winNow = await getFocusedNormalWindow();
        let idleExemptNow = false;
        if (winNow && lastKnownIdleState !== 'active') {
          const tabNow = await getActiveTabInWindow(winNow);
          idleExemptNow = await isIdleExemptDomain(tabNow?.url ? getDomain(tabNow.url) : null);
        }
        const stillInactive = !winNow || (lastKnownIdleState !== 'active' && !idleExemptNow);
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
