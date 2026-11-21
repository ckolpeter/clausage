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

test('version comparison', () => {
  const { newer } = require('../src/version');
  assert.equal(newer('v0.2.0', '0.1.0'), true);
  assert.equal(newer('0.1.0', '0.1.0'), false);
  assert.equal(newer('0.1.9', '0.2.0'), false);
  assert.equal(newer('1.0.0', '0.99.99'), true);
});

test('Claude Code stats: per-model totals, dedupe, today vs 7 days', () => {
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
    const r = new CodeStats().compute(now);
    assert.deepEqual(r.week.map(x => [x.name, x.total]), [['Opus 4.5', 1000], ['Sonnet 4', 100]]);
    assert.deepEqual(r.today.map(x => x.name), ['Opus 4.5']);
    assert.equal(prettyModel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
    assert.equal(prettyModel('claude-fable-5-2'), 'Fable 5.2');
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
