// pages/actionPopup.js — the menu shown when the extension icon is clicked.
// Replaces the old floating "Log task" on-page pill and the old
// click-icon-to-open-dashboard-directly behavior with an explicit menu:
// Log New Task / Continue Current Task / Open Dashboard / Pause / Resume.

import {
  getActiveSession, getTaskContext, getDomainMap, getProjects,
  getSettings, updateSettings
} from '../lib/storage.js';

const DASHBOARD_PATH = 'pages/dashboard.html';

const $ = (id) => document.getElementById(id);
const el = {
  status: $('apStatus'), dot: $('apDot'), statusLine: $('apStatusLine'), statusSub: $('apStatusSub'),
  logTask: $('apLogTask'), continueTask: $('apContinue'), dashboard: $('apDashboard'),
  pause: $('apPause'), resume: $('apResume')
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function currentBilledProject(activeSession, taskContext, domainMap, projects) {
  if (!activeSession) return null;
  const ctx = taskContext[activeSession.domain];
  const projectId = ctx?.projectId || domainMap[activeSession.domain] || null;
  return { project: projectId ? projects[projectId] : null, taskName: ctx?.taskName || '' };
}

async function render() {
  const [activeSession, taskContext, domainMap, projects, settings] = await Promise.all([
    getActiveSession(), getTaskContext(), getDomainMap(), getProjects(), getSettings()
  ]);

  if (settings.manuallyPaused) {
    el.status.dataset.state = 'paused';
    el.statusLine.textContent = 'Paused (manual)';
    el.statusSub.textContent = 'Tracking is off until you resume.';
    el.pause.classList.add('hidden');
    el.resume.classList.remove('hidden');
  } else if (activeSession) {
    const { project, taskName } = currentBilledProject(activeSession, taskContext, domainMap, projects);
    el.status.dataset.state = 'tracking';
    el.statusLine.textContent = project ? `Tracking · ${project.name}` : `Tracking · ${activeSession.domain}`;
    el.statusSub.textContent = taskName || activeSession.domain;
    el.pause.classList.remove('hidden');
    el.resume.classList.add('hidden');
  } else {
    el.status.dataset.state = 'idle';
    el.statusLine.textContent = 'Not tracking';
    el.statusSub.textContent = '';
    el.pause.classList.remove('hidden');
    el.resume.classList.add('hidden');
  }
}

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

el.logTask.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (tab?.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_LOG_TASK' }); } catch { /* no content script on this page (e.g. chrome:// or the store) */ }
  }
  window.close();
});

el.continueTask.addEventListener('click', () => window.close());

el.dashboard.addEventListener('click', async () => {
  await openOrFocusDashboard();
  window.close();
});

el.pause.addEventListener('click', async () => {
  await updateSettings({ manuallyPaused: true });
  window.close();
});

el.resume.addEventListener('click', async () => {
  await updateSettings({ manuallyPaused: false });
  window.close();
});

render();
