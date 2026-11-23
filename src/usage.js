'use strict';
/**
 * Pure functions that turn claude.ai / Anthropic usage responses into what the widget shows.
 * No Electron imports, so they can be unit-tested with plain Node (see test/).
 */

// Legacy fields that have their own translated label (label.<key> in src/locales)
const KNOWN_LEGACY = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_cowork']);

function planOf(o = {}) {
  const caps = o.capabilities || [];
  const tier = String(o.rate_limit_tier || '').toLowerCase();
  if (caps.includes('claude_max') || tier.includes('max')) return 'Max';
  if (caps.includes('claude_pro') || tier.includes('pro')) return 'Pro';
  if (caps.includes('raven') || o.raven_type) return 'Team';
  if (caps.includes('enterprise')) return 'Enterprise';
  return '';
}

/** Does this usage response contain at least one usage window? */
function hasUsage(raw) {
  if (Array.isArray(raw?.limits) && raw.limits.length) return true;
  return Object.entries(raw || {}).some(([k, v]) =>
    k !== 'extra_usage' && v && typeof v === 'object' && !Array.isArray(v) && 'utilization' in v);
}

const HOUR = 3600e3, DAY = 24 * HOUR;
const pctOf = (x) => { const u = Number(x); return Number.isFinite(u) ? Math.max(0, Math.min(100, u)) : 0; };
const pretty = (s) => String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
// Known model names inside a scope / legacy key, e.g. "seven_day_opus" or scope "opus_4"
const MODEL_RE = /(opus|sonnet|haiku|fable|mythos)/i;

/**
 * claude.ai computes resets_at on every request, so the same window comes back as
 * 14:59:59.547, 15:00:00.199, 15:00:00.431… Round to the minute so a window keeps one id
 * (history, notifications and the reset check all compare it). Unparseable values pass through.
 */
function stableReset(v) {
  if (v == null || v === '') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(Math.round(ms / 60e3) * 60e3).toISOString() : v;
}

/** Same usage window? Reset times within a few minutes of each other (windows are hours long) */
const SAME_RESET_MS = 5 * 60e3;
function sameReset(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a === b) return true;
  const d = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isFinite(d) && d < SAME_RESET_MS;
}

/**
 * Readable name of a limit's scope. Seen so far: a string ('opus'), or an object such as
 * { model: { id: null, display_name: 'Fable' }, surface: null }. Returns null if nothing readable.
 */
function scopeName(scope) {
  if (scope == null) return null;
  if (typeof scope !== 'object') return String(scope);
  const named = (o) => (o && typeof o === 'object'
    ? o.display_name || o.name || o.id || o.key || null
    : (typeof o === 'string' && o) || null);
  return named(scope) || named(scope.model) || named(scope.surface) || named(scope.product) || null;
}

/**
 * A usage window:
 *   key        stable id ('five_hour' and 'seven_day' are the two primary windows)
 *   labelKey   i18n key, labelVars for {placeholders}
 *   pct, resetsAt, durationMs (for the pace marker), primary, kind ('session'|'weekly'|'model'|'other')
 */
function windowsFromLimits(limits) {
  const out = [];
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue;
    const kind = String(l.kind || '');
    const group = String(l.group || '');
    const scope = scopeName(l.scope);
    const modelScoped = !!(l.scope && typeof l.scope === 'object' && l.scope.model);
    const base = { pct: pctOf(l.percent ?? l.utilization), resetsAt: stableReset(l.resets_at), severity: l.severity || null };
    if (kind === 'session' || group === 'session') {
      out.push({ ...base, key: 'five_hour', labelKey: 'label.five_hour', durationMs: 5 * HOUR, primary: true, kind: 'session' });
    } else if (kind === 'weekly_all') {
      out.push({ ...base, key: 'seven_day', labelKey: 'label.seven_day', durationMs: 7 * DAY, primary: true, kind: 'weekly' });
    } else {
      const name = scope || kind.replace(/^weekly_?/, '') || kind;
      const isModel = modelScoped || MODEL_RE.test(name) || /model/i.test(kind);
      const weekly = group === 'weekly' || /^weekly/.test(kind);
      out.push({
        ...base,
        key: `limit:${kind}:${scope ?? ''}`,
        labelKey: weekly ? 'label.weeklyScoped' : 'label.scoped',
        labelVars: { name: pretty(name) },
        durationMs: weekly ? 7 * DAY : null,
        primary: false,
        kind: isModel ? 'model' : 'other',
      });
    }
  }
  return out;
}

/**
 * Windows from the older per-key fields (five_hour, seven_day, seven_day_opus…).
 * knownOnly: skip unknown keys. The response also carries internal codenames (e.g. harbor_lantern,
 * a dollar allowance) that claude.ai itself doesn't show; when the limits array is present, it is the
 * list claude.ai displays, so only the keys we understand are used to fill its gaps.
 */
function windowsFromLegacy(raw, knownOnly = false) {
  const out = [];
  for (const [key, v] of Object.entries(raw || {})) {
    if (key === 'extra_usage' || !v || typeof v !== 'object' || Array.isArray(v) || !('utilization' in v)) continue;
    if (knownOnly && !KNOWN_LEGACY.has(key)) continue;
    const known = `label.${key}`;
    const hasLabel = KNOWN_LEGACY.has(key);
    out.push({
      key,
      labelKey: hasLabel ? known : 'label.weeklyScoped',
      labelVars: hasLabel ? undefined : { name: pretty(key.replace(/^seven_day_?/, '')) },
      pct: pctOf(v.utilization),
      resetsAt: stableReset(v.resets_at),
      durationMs: key === 'five_hour' ? 5 * HOUR : key.startsWith('seven_day') ? 7 * DAY : null,
      primary: key === 'five_hour' || key === 'seven_day',
      kind: key === 'five_hour' ? 'session' : key === 'seven_day' ? 'weekly' : MODEL_RE.test(key) ? 'model' : 'other',
    });
  }
  return out;
}

const KIND_ORDER = { session: 0, weekly: 1, model: 2, other: 3 };

/**
 * Signs that the (undocumented) response format changed in a way that would show wrong numbers
 * instead of failing loudly. null values are fine (an unused window); missing or unparseable ones are not.
 * Returns a sorted list of issue codes, empty when everything looks as expected.
 */
function formatIssues(raw, windows) {
  const issues = new Set();
  const badNumber = (v) => v != null && !Number.isFinite(Number(v));
  const badDate = (v) => v != null && !Number.isFinite(Date.parse(v));
  if (raw && 'limits' in raw && raw.limits != null && !Array.isArray(raw.limits)) issues.add('limits-not-array');
  for (const l of Array.isArray(raw?.limits) ? raw.limits : []) {
    if (!l || typeof l !== 'object') { issues.add('limit-not-object'); continue; }
    if (!l.kind && !l.group) issues.add('limit-no-kind');
    if (l.scope != null && !scopeName(l.scope)) issues.add('scope-unnamed');
    if (!('percent' in l) && !('utilization' in l)) issues.add('limit-no-percent');
    else if (badNumber(l.percent ?? l.utilization)) issues.add('bad-percent');
    if (badDate(l.resets_at)) issues.add('bad-reset');
  }
  for (const [k, v] of Object.entries(raw || {})) {
    if (k === 'extra_usage' || !v || typeof v !== 'object' || Array.isArray(v) || !('utilization' in v)) continue;
    if (badNumber(v.utilization)) issues.add('bad-percent');
    if (badDate(v.resets_at)) issues.add('bad-reset');
  }
  if (windows.length && !windows.some(w => w.primary)) issues.add('no-primary');
  return [...issues].sort();
}

/** Extra usage (pay-as-you-go beyond the plan): prefer the newer `spend`, fall back to `extra_usage` */
function spendOf(raw) {
  const money = (m) => (m && m.amount_minor != null ? m.amount_minor / 10 ** (m.exponent ?? 2) : null);
  const sp = raw?.spend;
  if (sp && sp.enabled) {
    const used = money(sp.used), limit = money(sp.limit);
    const pct = sp.percent != null ? pctOf(sp.percent) : (limit ? pctOf(used / limit * 100) : null);
    return { used, limit, pct, currency: sp.used?.currency || sp.limit?.currency || 'USD' };
  }
  const ex = raw?.extra_usage;
  if (ex && ex.is_enabled) {
    const dp = ex.decimal_places ?? 2;
    const used = ex.used_credits != null ? ex.used_credits / 10 ** dp : null;
    const limit = ex.monthly_limit != null ? ex.monthly_limit / 10 ** dp : null;
    const pct = ex.utilization != null ? pctOf(ex.utilization) : (limit ? pctOf(used / limit * 100) : null);
    return { used, limit, pct, currency: ex.currency || 'USD' };
  }
  return null;
}

function normalize({ raw, plan, orgName }, source = 'web', now = Date.now()) {
  // Prefer the newer `limits` array; fill in anything it lacks from the legacy fields
  const fromLimits = Array.isArray(raw?.limits) ? windowsFromLimits(raw.limits) : [];
  const windows = [...fromLimits];
  for (const w of windowsFromLegacy(raw, fromLimits.length > 0)) {
    const dupe = windows.some(x => x.key === w.key
      || (w.kind === 'model' && x.kind === 'model'
        && (w.key.match(MODEL_RE) || [])[0]?.toLowerCase() === (x.key.match(MODEL_RE) || [])[0]?.toLowerCase()));
    if (!dupe) windows.push(w);
  }
  windows.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));

  const spend = spendOf(raw);

  // This week's usage by product (Claude Code / chat / Cowork / other)
  const bd = raw?.seven_day_breakdown;
  const breakdown = bd && Array.isArray(bd.rows) && bd.rows.length
    ? {
      asOf: bd.as_of || null,
      rows: bd.rows.map(r => ({
        key: String(r.key || ''),
        name: r.display_name || pretty(r.key || ''),
        share: pctOf(r.percent),               // share of this week's usage
        ofLimit: pctOf(r.percent_of_limit),    // share of the weekly limit
      })),
    }
    : null;

  const state = { status: 'ok', windows, spend, breakdown, plan, orgName, source, fetchedAt: now };
  const issues = formatIssues(raw, windows);
  if (issues.length) state.formatIssues = issues;
  return state;
}

// ---------------------------------------------------------------- run-out prediction
/**
 * For each primary window, estimate when it runs out at the current pace.
 * Pace = the last hour of local history if available, otherwise the average since the window began.
 * Adds w.eta = { at, beforeReset, basis } or { exhausted: true }.
 */
function addEta(state, history = null, now = Date.now()) {
  for (const w of state.windows) {
    if (!w.primary) continue;
    if (w.pct >= 100) { w.eta = { exhausted: true }; continue; }
    if (!w.resetsAt || w.pct <= 0) continue;
    const reset = new Date(w.resetsAt).getTime();
    if (!Number.isFinite(reset) || reset <= now) continue;
    let rate = history?.recentRate(w.key === 'five_hour' ? 'f' : 'w', w.resetsAt, now) ?? null;
    let basis = 'recent';
    if (rate == null && w.durationMs) {
      const elapsed = w.durationMs - (reset - now);
      if (elapsed > 10 * 60e3) { rate = w.pct / elapsed; basis = 'average'; }
    }
    if (rate == null) continue;
    if (rate <= 0) { w.eta = { at: null, beforeReset: false, basis }; continue; }
    const at = now + (100 - w.pct) / rate;
    w.eta = { at, beforeReset: at < reset, basis };
  }
}

module.exports = {
  planOf, hasUsage, normalize, addEta, spendOf, windowsFromLimits, windowsFromLegacy, pctOf, formatIssues,
  stableReset, sameReset, scopeName,
};
