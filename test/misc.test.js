'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('history: samples, CSV export, pruning', () => {
  const { History } = require('../src/history');
  const file = path.join(os.tmpdir(), `clausage-hist-${process.pid}.json`);
  const h = new History(file); h.clear();
  const now = Date.now();
  const st = (f, w) => ({ windows: [{ key: 'five_hour', pct: f, resetsAt: 'R1' }, { key: 'seven_day', pct: w, resetsAt: 'W1' }] });
  h.add(st(10, 5), now - 9 * 24 * 3600e3); // older than 8 days → pruned
  h.add(st(12, 6), now - 120e3);
  h.add(st(13, 6), now - 100e3);           // within 50s of the last → replaces it
  h.add(st(15, 7), now);
  assert.equal(h.samples.length, 2);
  assert.deepEqual(h.series('f', now - 3600e3).map(p => p.v), [13, 15]);
  const csv = h.toCSV().trim().split('\r\n');
  assert.equal(csv[0], 'time_local,time_utc,five_hour_pct,five_hour_resets_at,weekly_pct,weekly_resets_at');
  assert.equal(csv.length, 3);
});

test('store: atomic write replaces the file and leaves no temp file; debounce + flush', () => {
  const { writeFileAtomic, Debounced } = require('../src/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clausage-store-'));
  const file = path.join(dir, 'config.json');
  writeFileAtomic(file, '{"a":1}');
  writeFileAtomic(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);

  let runs = 0;
  const d = new Debounced(() => runs++, 60e3);
  d.schedule(); d.schedule(); d.schedule();
  assert.equal(runs, 0);
  d.flush();                 // pending → runs once, now
  d.flush();                 // nothing pending → no-op
  assert.equal(runs, 1);
});

test('withTimeout: passes results through, gives up on hung requests', async () => {
  const { withTimeout } = require('../src/timeout');
  assert.equal(await withTimeout(async () => 42, 1000), 42);
  await assert.rejects(withTimeout(async () => { throw new Error('boom'); }, 1000), /boom/);
  let sig;
  await assert.rejects(withTimeout((s) => { sig = s; return new Promise(() => {}); }, 30),
    (e) => e instanceof TypeError && /timed out/.test(e.message));
  assert.equal(sig.aborted, true); // the underlying request is cancelled too
});

test('history: old unrounded reset times are merged into one window for the recent pace', () => {
  const { History } = require('../src/history');
  const file = path.join(os.tmpdir(), `clausage-hist-jitter-${process.pid}.json`);
  const now = Date.now();
  // As 0.2.x stored them: every sample has a slightly different resets_at
  fs.writeFileSync(file, JSON.stringify([
    { t: now - 30 * 60e3, f: 10, fr: '2026-11-22T14:59:59.547793+00:00', w: 5, wr: null },
    { t: now - 15 * 60e3, f: 15, fr: '2026-11-22T15:00:00.199518+00:00', w: 5, wr: null },
    { t: now, f: 20, fr: '2026-11-22T15:00:00.431568+00:00', w: 5, wr: null },
  ]));
  const h = new History(file);
  assert.deepEqual([...new Set(h.samples.map(s => s.fr))], ['2026-11-22T15:00:00.000Z']);
  const rate = h.recentRate('f', '2026-11-22T15:00:00.000Z', now);
  assert.ok(Math.abs(rate - 10 / (30 * 60e3)) < 1e-12); // 10 points in 30 minutes
  fs.unlinkSync(file);
});

test('history: flush() writes a pending sample immediately (quit)', () => {
  const { History } = require('../src/history');
  const file = path.join(os.tmpdir(), `clausage-hist-flush-${process.pid}.json`);
  try { fs.unlinkSync(file); } catch { /* none */ }
  const h = new History(file);
  h.add({ windows: [{ key: 'five_hour', pct: 42, resetsAt: 'R' }] });
  assert.equal(fs.existsSync(file), false); // still debounced
  h.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].f, 42);
  assert.equal(new History(file).samples.length, 1);
  fs.unlinkSync(file);
});

test('config: values from a bad config.json fall back to valid ones', () => {
  const { sanitize, applyPatch } = require('../src/config');
  const D = { source: 'web', language: 'auto', intervalSec: 120, opacity: 0.95, notify: true, notifyThresholds: [80, 95],
    quietStart: '23:00', quietEnd: '08:00', theme: 'dark', scale: 1, hotkey: 'CommandOrControl+Alt+C', trayMetric: 'five_hour',
    bounds: null, orgId: null, accounts: [], mainEmail: '' };
  const c = sanitize({ ...D, source: 'x', intervalSec: 5, opacity: 'lots', notify: 'yes', notifyThresholds: [200, '50', 50, 'x', 79.6],
    quietStart: '25:00', theme: 123, scale: 9, hotkey: 42, trayMetric: 'week', bounds: { x: 1, y: 2, width: 'w', height: 3 },
    orgId: '../../etc', accounts: [{ partition: 'persist:claude-acct-k1', email: 'a@b' }, { partition: 'persist:claude' }, null],
    language: '<script>', mainEmail: 7, junk: true }, D);
  assert.deepEqual(c, { ...D, intervalSec: 30, scale: 1.5, notifyThresholds: [50, 80],
    accounts: [{ partition: 'persist:claude-acct-k1', email: 'a@b' }] });
  assert.equal('junk' in c, false);
  // Settings window: user settings only; internal fields are ignored
  const after = applyPatch(c, { theme: 'light', intervalSec: '300', accounts: [], bounds: { x: 0, y: 0, width: 9, height: 9 }, mainEmail: 'x' }, D);
  assert.equal(after.theme, 'light');
  assert.equal(after.intervalSec, 300);
  assert.equal(after.accounts.length, 1);
  assert.equal(after.bounds, null);
  assert.equal(after.mainEmail, '');
  assert.deepEqual(applyPatch(c, null, D), c);
});

test('version comparison', () => {
  const { newer } = require('../src/version');
  assert.equal(newer('v0.2.0', '0.1.0'), true);
  assert.equal(newer('0.1.0', '0.1.0'), false);
  assert.equal(newer('0.1.9', '0.2.0'), false);
  assert.equal(newer('1.0.0', '0.99.99'), true);
});

test('Claude Code stats: per-model totals, dedupe, today vs 7 days', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clausage-cc-'));
  fs.mkdirSync(path.join(dir, 'projects', 'p'), { recursive: true });
  const now = Date.now(), D = 24 * 3600e3;
  const line = (t, model, id, i, o) => JSON.stringify({
    type: 'assistant', timestamp: new Date(t).toISOString(), requestId: 'r' + id,
    message: { id, model, usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  fs.writeFileSync(path.join(dir, 'projects', 'p', 's.jsonl'), [
    line(now - 60e3, 'claude-opus-4-5-20251101', 'a', 100, 900),
    line(now - 60e3, 'claude-opus-4-5-20251101', 'a', 100, 900), // duplicate
    line(now - 3 * D, 'claude-sonnet-4-20250514', 'b', 10, 90),
    line(now - 10 * D, 'claude-haiku-4-5', 'c', 1, 1),            // outside 7 days
    '{broken json',
  ].join('\n'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { CodeStats, prettyModel } = require('../src/code-stats');
    const r = await new CodeStats().compute(now);
    assert.deepEqual(r.week.map(x => [x.name, x.total]), [['Opus 4.5', 1000], ['Sonnet 4', 100]]);
    assert.deepEqual(r.today.map(x => x.name), ['Opus 4.5']);
    assert.equal(prettyModel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
    assert.equal(prettyModel('claude-fable-5-2'), 'Fable 5.2');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('Claude Code stats: appended lines are read incrementally, half-written lines wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clausage-cc-'));
  fs.mkdirSync(path.join(dir, 'projects', 'p'), { recursive: true });
  const file = path.join(dir, 'projects', 'p', 's.jsonl');
  const now = Date.now();
  const line = (id, o) => JSON.stringify({
    type: 'assistant', timestamp: new Date(now - 60e3).toISOString(), requestId: 'r' + id, note: '測試 ✓',
    message: { id, model: 'claude-opus-4-5', usage: { input_tokens: 0, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { CodeStats } = require('../src/code-stats');
    const cs = new CodeStats();
    const total = async (t) => (await cs.compute(t)).week[0].total;
    const second = line('b', 20);
    fs.writeFileSync(file, line('a', 10) + '\n' + second.slice(0, 25)); // second line still being written
    assert.equal(await total(now), 10);
    const offset = [...cs.cache.values()][0].offset;
    fs.appendFileSync(file, second.slice(25) + '\n' + line('c', 30) + '\n');
    let readFrom = null;
    const orig = cs.parseFile.bind(cs);
    cs.parseFile = (f, from, size) => { readFrom = from; return orig(f, from, size); };
    assert.equal(await total(now + 1), 60);
    assert.equal(readFrom, offset);                   // only the new bytes were read
    fs.writeFileSync(file, line('d', 5) + '\n');      // file rewritten (shrunk) → full re-read
    assert.equal(await total(now + 2), 5);

    // Small chunks: lines (with multi-byte text) split across chunk boundaries are still read whole
    fs.writeFileSync(file, [line('e', 1), line('f', 2), line('g', 4)].join('\n') + '\n');
    const small = new CodeStats(); small.chunk = 37;
    assert.equal((await small.compute(now + 3)).week[0].total, 7);
    // Overlapping calls share one run
    assert.equal(small.compute(now + 4), small.compute(now + 4));
    assert.equal(readFrom, 0);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('locales: same keys, placeholders and tags as English', () => {
  const dir = path.join(__dirname, '..', 'src', 'locales');
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  const tags = (s) => (s.match(/<\/?b>/g) || []).sort().join();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(Object.keys(d).sort(), Object.keys(en).sort(), `${f}: keys differ from en.json`);
    for (const k of Object.keys(en)) {
      assert.equal(ph(d[k]), ph(en[k]), `${f} ${k}: placeholders differ`);
      assert.equal(tags(d[k]), tags(en[k]), `${f} ${k}: <b> tags differ`);
    }
  }
});
