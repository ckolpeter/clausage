'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { normalize, addEta, planOf, hasUsage, spendOf } = require('../src/usage');

const H = 3600e3, D = 24 * H;
const fixture = require('./fixtures/usage-pro.json');
const byKey = (st, k) => st.windows.find(w => w.key === k);

test('real Pro response: 5-hour and weekly from the limits array', () => {
  const st = normalize({ raw: fixture, plan: 'Pro', orgName: '' });
  assert.equal(st.status, 'ok');
  assert.equal(byKey(st, 'five_hour').pct, 45);
  assert.equal(byKey(st, 'seven_day').pct, 16);
  assert.equal(byKey(st, 'five_hour').durationMs, 5 * H);
  assert.equal(byKey(st, 'seven_day').durationMs, 7 * D);
  // legacy five_hour / seven_day are not duplicated
  assert.equal(st.windows.length, 2);
  // weekly breakdown by product
  const cowork = st.breakdown.rows.find(r => r.key === 'cowork');
  assert.equal(cowork.share, 100);
  assert.equal(cowork.ofLimit, 16);
  // extra usage disabled → no spend row
  assert.equal(st.spend, null);
});

test('per-model weekly limits from the limits array, deduped with legacy fields', () => {
  const resets = '2026-11-23T10:59:59Z';
  const raw = {
    ...fixture,
    limits: [...fixture.limits,
      { kind: 'weekly_scoped', group: 'weekly', percent: 62, resets_at: resets, scope: 'opus' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 8, resets_at: resets, scope: 'sonnet' }],
    seven_day_opus: { utilization: 62, resets_at: resets },
  };
  const st = normalize({ raw, plan: 'Max', orgName: '' });
  const models = st.windows.filter(w => w.kind === 'model');
  assert.deepEqual(models.map(w => w.labelVars.name), ['Opus', 'Sonnet']);
  assert.deepEqual(models.map(w => w.pct), [62, 8]);
  // order: session, weekly, then models
  assert.deepEqual(st.windows.map(w => w.kind), ['session', 'weekly', 'model', 'model']);
});

test('legacy-only response (no limits array)', () => {
  const st = normalize({
    raw: { five_hour: { utilization: '30', resets_at: null }, seven_day: { utilization: null }, seven_day_sonnet: { utilization: 5 }, limits: [] },
    plan: 'Pro', orgName: '',
  });
  assert.equal(byKey(st, 'five_hour').pct, 30);   // numeric string accepted
  assert.equal(byKey(st, 'seven_day').pct, 0);    // null → 0
  assert.equal(byKey(st, 'seven_day_sonnet').labelKey, 'label.seven_day_sonnet');
});

test('values are clamped to 0–100', () => {
  const st = normalize({ raw: { five_hour: { utilization: 140 }, seven_day: { utilization: -5 } }, plan: '', orgName: '' });
  assert.equal(byKey(st, 'five_hour').pct, 100);
  assert.equal(byKey(st, 'seven_day').pct, 0);
});

test('spend: newer `spend` object and legacy `extra_usage`', () => {
  assert.deepEqual(
    spendOf({ spend: { enabled: true, used: { amount_minor: 320, currency: 'USD', exponent: 2 }, limit: { amount_minor: 5000, currency: 'USD', exponent: 2 }, percent: 6.4 } }),
    { used: 3.2, limit: 50, pct: 6.4, currency: 'USD' },
  );
  assert.deepEqual(
    spendOf({ extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 5000, utilization: null, currency: 'EUR', decimal_places: 2 } }),
    { used: 12.5, limit: 50, pct: 25, currency: 'EUR' },
  );
  assert.equal(spendOf({ spend: { enabled: false }, extra_usage: { is_enabled: false } }), null);
});

test('planOf and hasUsage', () => {
  assert.equal(planOf({ capabilities: ['chat', 'claude_pro'], rate_limit_tier: 'default_claude_ai' }), 'Pro');
  assert.equal(planOf({ capabilities: ['chat'], rate_limit_tier: 'default_claude_max_20x' }), 'Max');
  assert.equal(planOf({ capabilities: ['chat'], rate_limit_tier: 'default_claude_ai' }), '');  // Free
  assert.equal(hasUsage(fixture), true);
  assert.equal(hasUsage({ five_hour: null, seven_day: null, limits: [] }), false);
});

test('run-out prediction: average pace, recent pace, exhausted, idle', () => {
  const { History } = require('../src/history');
  const os = require('os');
  const now = Date.now();
  const reset = new Date(now + 3 * H).toISOString(); // 2h into a 5h window
  const mk = (pct) => ({ windows: [{ key: 'five_hour', pct, resetsAt: reset, durationMs: 5 * H, primary: true }] });

  // No history: 45% in 2h → runs out in ~2.44h, before the reset in 3h
  let st = mk(45); addEta(st, null, now);
  assert.equal(st.windows[0].eta.basis, 'average');
  assert.equal(st.windows[0].eta.beforeReset, true);
  assert.ok(Math.abs((st.windows[0].eta.at - now) / H - 2.444) < 0.01);

  // Recent history: +5% in 30 min → 10%/h → 5.5h, after the reset
  const h = new History(path.join(os.tmpdir(), `clausage-test-${process.pid}.json`)); h.clear();
  h.add(mk(40), now - 30 * 60e3); h.add(mk(45), now);
  st = mk(45); addEta(st, h, now);
  assert.equal(st.windows[0].eta.basis, 'recent');
  assert.equal(st.windows[0].eta.beforeReset, false);

  st = mk(100); addEta(st, null, now);
  assert.deepEqual(st.windows[0].eta, { exhausted: true });

  h.clear(); h.add(mk(45), now - 40 * 60e3); h.add(mk(45), now);
  st = mk(45); addEta(st, h, now);
  assert.equal(st.windows[0].eta.at, null);
});
