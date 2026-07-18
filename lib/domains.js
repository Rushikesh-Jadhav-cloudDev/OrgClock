// lib/domains.js
// Detects whether a URL belongs to a Salesforce org, and extracts the
// domain used as the raw tracking key. Grouping of related domains
// (production/sandbox/lightning/classic for the SAME org) is done by the
// user linking them to a shared project during setup — see storage.js —
// because Salesforce domain naming is not reliably pattern-matchable
// (e.g. "acme.my.salesforce.com" vs "acme--uat.sandbox.my.salesforce.com"
// vs a fully custom "My Domain" like "acme-dev-ed.develop.lightning.force.com").

const SF_HOST_SUFFIXES = [
  '.salesforce.com',
  '.force.com',
  '.salesforce-setup.com',
  '.visualforce.com'
];

// A handful of Salesforce-owned marketing/help hosts that aren't org UI —
// used only by isSalesforceUrl() below (a "does this look like a
// Salesforce org" check, kept for possible future default-category
// detection). It deliberately does NOT affect isTrackableUrl() — tracking
// is opt-out now, so these pages ARE tracked by default like anything
// else unless the user excludes them.
const SF_MARKETING_HOSTS = [
  'www.salesforce.com',
  'trailhead.salesforce.com',
  'trust.salesforce.com',
  'appexchange.salesforce.com',
  'status.salesforce.com'
];

// Sites that are almost never meaningfully "a project" and would just add
// noise if prompted for by default. The user can still remove these from
// (or add to) the exclusion list in Settings — this is just a sane
// starting point, not a hard block.
const BUILT_IN_EXCLUDED_HOSTS = [
  'accounts.google.com',
  'chrome.google.com'
];

export function isSalesforceUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    if (SF_MARKETING_HOSTS.includes(host)) return false;
    return SF_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/** The raw domain used as the storage key for a tab. */
export function getDomain(url) {
  const u = new URL(url);
  return u.hostname.toLowerCase();
}

/**
 * True if this URL should be tracked. With broad tracking enabled, EVERY
 * http(s) site is trackable by default — except the user's own
 * `excludedSites` list (Settings → Excluded sites, e.g. Gmail) and a small
 * built-in noise list. This is the inverse of the old allow-list model:
 * previously only Salesforce + explicitly-added sites were seen at all;
 * now everything is seen, and exclusion is opt-out rather than opt-in.
 */
export function isTrackableUrl(url, excludedSites = {}) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    if (BUILT_IN_EXCLUDED_HOSTS.includes(host)) return false;
    if (excludedSites[host]) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort human-friendly guess at an org's "base name", used only to
 * pre-fill the project-name field on first setup (never used for automatic
 * grouping/matching — that stays an explicit user choice).
 * e.g. "acme--uat.sandbox.my.salesforce.com" -> "acme"
 *      "acme-dev-ed.develop.lightning.force.com" -> "acme-dev-ed"
 */
export function guessOrgLabel(domain) {
  const first = domain.split('.')[0];
  return first.split('--')[0];
}
