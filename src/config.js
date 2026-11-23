'use strict';
/**
 * Settings validation (pure, unit-tested). Used when config.json is loaded and on every change from
 * the settings window, so a hand-edited or outdated file, or an unexpected IPC message, can't put
 * wrong types or out-of-range values into the app.
 */

// Set by the main process only (window position, extra accounts); the settings window can't change them
const INTERNAL = new Set(['bounds', 'accounts', 'mainEmail']);

const ENUMS = {
  source: ['web', 'code'],
  theme: ['dark', 'light', 'system'],
  trayMetric: ['five_hour', 'seven_day', 'max', 'off'],
};

const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const isHm = (s) => typeof s === 'string' && /^\d{1,2}:\d{2}$/.test(s.trim())
  && +s.trim().split(':')[0] <= 23 && +s.trim().split(':')[1] <= 59;

/** Up to 5 distinct whole percentages in 1–100, ascending */
function cleanThresholds(list, dflt) {
  if (!Array.isArray(list)) return dflt;
  const nums = list.map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 100).map(Math.round);
  return [...new Set(nums)].sort((a, b) => a - b).slice(0, 5);
}

function cleanBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const out = {};
  for (const k of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(b[k])) return null;
    out[k] = Math.round(b[k]);
  }
  return out.width > 0 && out.height > 0 ? out : null;
}

function cleanAccounts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter(a => a && typeof a.partition === 'string' && /^persist:claude-acct-[a-z0-9]+$/.test(a.partition)
    && !seen.has(a.partition) && seen.add(a.partition))
    .map(a => ({ partition: a.partition, email: typeof a.email === 'string' ? a.email.slice(0, 200) : '' }));
}

/** Every known key with a valid value (falling back to the default); unknown keys are dropped */
function sanitize(cfg, defaults) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const out = {};
  for (const [k, d] of Object.entries(defaults)) {
    const v = c[k];
    if (typeof d === 'boolean') out[k] = typeof v === 'boolean' ? v : d;
    else if (ENUMS[k]) out[k] = ENUMS[k].includes(v) ? v : d;
    else out[k] = d;
  }
  out.language = typeof c.language === 'string' && /^[a-zA-Z-]{2,12}$/.test(c.language) ? c.language : defaults.language;
  out.intervalSec = Math.round(clamp(c.intervalSec, 30, 3600, defaults.intervalSec));
  out.opacity = clamp(c.opacity, 0.3, 1, defaults.opacity);
  out.scale = clamp(c.scale, 0.8, 1.5, defaults.scale);
  out.notifyThresholds = cleanThresholds(c.notifyThresholds, defaults.notifyThresholds);
  out.quietStart = isHm(c.quietStart) ? c.quietStart.trim() : defaults.quietStart;
  out.quietEnd = isHm(c.quietEnd) ? c.quietEnd.trim() : defaults.quietEnd;
  out.hotkey = typeof c.hotkey === 'string' && c.hotkey.length <= 64 ? c.hotkey.trim() : defaults.hotkey;
  out.orgId = typeof c.orgId === 'string' && /^[\w-]{1,64}$/.test(c.orgId) ? c.orgId : null;
  out.bounds = cleanBounds(c.bounds);
  out.accounts = cleanAccounts(c.accounts);
  out.mainEmail = typeof c.mainEmail === 'string' ? c.mainEmail.slice(0, 200) : '';
  return out;
}

/** A change from the settings window: only user settings, then validated together with the rest */
function applyPatch(cfg, patch, defaults) {
  const allowed = {};
  for (const [k, v] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (k in defaults && !INTERNAL.has(k)) allowed[k] = v;
  }
  return sanitize({ ...cfg, ...allowed }, defaults);
}

module.exports = { sanitize, applyPatch, cleanThresholds };
