// lib/id.js
// Small, dependency-free unique id generator (no crypto.randomUUID reliance
// needed, but we use it when available since MV3 service workers support it).

export function newId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
