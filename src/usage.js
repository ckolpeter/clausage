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
    const scope = l.scope == null ? null : (typeof l.scope === 'object' ? (l.scope.name || l.scope.key || l.scope.model || JSON.stringify(l.scope)) : String(l.scope));
    const base = { pct: pctOf(l.percent ?? l.utilization), resetsAt: l.resets_at || null, severity: l.severity || null };
    if (kind === 'session' || group === 'session') {
      out.push({ ...base, key: 'five_hour', labelKey: 'label.five_hour', durationMs: 5 * HOUR, primary: true, kind: 'session' });
    } else if (kind === 'weekly_all') {
      out.push({ ...base, key: 'seven_day', labelKey: 'label.seven_day', durationMs: 7 * DAY, primary: true, kind: 'weekly' });
    } else {
      const name = scope || kind.replace(/^weekly_?/, '') || kind;
      const isModel = MODEL_RE.test(name) || /model/i.test(kind);
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

function windowsFromLegacy(raw) {
  const out = [];
  for (const [key, v] of Object.entries(raw || {})) {
    if (key === 'extra_usage' || !v || typeof v !== 'object' || Array.isArray(v) || !('utilization' in v)) continue;
    const known = `label.${key}`;
    const hasLabel = KNOWN_LEGACY.has(key);
    out.push({
      key,
      labelKey: hasLabel ? known : 'label.weeklyScoped',
      labelVars: hasLabel ? undefined : { name: pretty(key.replace(/^seven_day_?/, '')) },
      pct: pctOf(v.utilization),
      resetsAt: v.resets_at || null,
      durationMs: key === 'five_hour' ? 5 * HOUR : key.startsWith('seven_day') ? 7 * DAY : null,
      primary: key === 'five_hour' || key === 'seven_day',
      kind: key === 'five_hour' ? 'session' : key === 'seven_day' ? 'weekly' : MODEL_RE.test(key) ? 'model' : 'other',
    });
  }
  return out;
}

const KIND_ORDER = { session: 0, weekly: 1, model: 2, other: 3 };

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
  for (const w of windowsFromLegacy(raw)) {
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

  return { status: 'ok', windows, spend, breakdown, plan, orgName, source, fetchedAt: now };
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
  planOf, hasUsage, normalize, addEta, spendOf, windowsFromLimits, windowsFromLegacy, pctOf,
};
