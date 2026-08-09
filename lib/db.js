// lib/db.js — IndexedDB-backed storage for `entries`, the one collection
// written to on nearly every tracked action (every session append, every
// note, every edit). chrome.storage.local used to store the WHOLE
// `entries` object as a single JSON blob under one key — meaning even a
// single 2-second session merge had to deserialize, mutate, and
// reserialize potentially days of accumulated history just to touch one
// row. IndexedDB stores one record per DATE instead, so a normal write
// only ever touches that day's record, regardless of how much history
// has piled up around it.
//
// This module is used from lib/storage.js (imported normally — the
// background service worker and the dashboard page both load it as an ES
// module) AND duplicated inline, in miniature, inside content.js — content
// scripts run as classic (non-module) scripts and can't use `import`, the
// same reason content.js already duplicates a few other small helpers
// instead of importing lib/storage.js. content.js only ever needs TODAY's
// record though, so its copy is much smaller than this one.
//
// chrome.storage.onChanged has no IndexedDB equivalent, so writes here
// also bump a tiny `entriesVersion` timestamp in chrome.storage.local —
// see bumpEntriesVersion() below — purely so the existing
// storage.onChanged-based "something changed, reload" listeners in
// background.js and the dashboard keep working without needing a parallel
// notification system.

const DB_NAME = 'orgclock';
const DB_VERSION = 1;
const STORE = 'entries';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store))
      .then((r) => { result = r; })
      .catch((err) => { try { tx.abort(); } catch { /* already settled */ } reject(err); });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

/** Pings a tiny chrome.storage.local value so existing onChanged listeners still fire on entries writes. */
async function bumpEntriesVersion() {
  try {
    await chrome.storage.local.set({ entriesVersion: Date.now() });
  } catch {
    // Non-fatal — worst case, other open contexts don't auto-refresh
    // until their next unrelated reload.
  }
}

export async function dbGetAllEntries() {
  const rows = await withStore('readonly', (store) => reqToPromise(store.getAll()));
  const out = {};
  for (const row of rows) out[row.date] = row.byDomain;
  return out;
}

export async function dbGetEntriesForDate(date) {
  const row = await withStore('readonly', (store) => reqToPromise(store.get(date)));
  return row ? row.byDomain : null;
}

export async function dbSetEntriesForDate(date, byDomain) {
  await withStore('readwrite', (store) => reqToPromise(store.put({ date, byDomain })));
  await bumpEntriesVersion();
}

export async function dbDeleteEntriesForDate(date) {
  await withStore('readwrite', (store) => reqToPromise(store.delete(date)));
  await bumpEntriesVersion();
}

/** Replaces every date's record in one transaction — used for weekly rollover, range deletes, restore, and full-backup import. */
export async function dbSetManyEntries(entriesByDate) {
  await withStore('readwrite', async (store) => {
    for (const [date, byDomain] of Object.entries(entriesByDate)) {
      if (byDomain === null) store.delete(date);
      else store.put({ date, byDomain });
    }
  });
  await bumpEntriesVersion();
}

export async function dbClearAllEntries() {
  await withStore('readwrite', (store) => reqToPromise(store.clear()));
  await bumpEntriesVersion();
}
