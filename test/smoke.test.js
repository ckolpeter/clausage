'use strict';
// End-to-end smoke test: the real src/main.js against a fake Electron (no GUI needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

function run(env = {}) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'smoke-runner.js')], {
    env: { ...process.env, FIXTURE: path.join(__dirname, 'fixtures', 'usage-pro.json'), ...env },
    encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'], // keep the app's expected error logs out of the test output
  });
  return JSON.parse(out.slice(out.lastIndexOf('@@RESULT@@') + '@@RESULT@@'.length));
}

test('startup → fetch → widget state, tray, settings', () => {
  const r = run();
  assert.equal(r.state.status, 'ok');
  assert.deepEqual(r.state.windows.map(w => [w.key, w.pct]), [['five_hour', 45], ['seven_day', 16]]);
  assert.equal(r.state.breakdown.rows.length, 4);
  assert.match(r.tooltip, /45%/);
  // Windows/Linux draw the number into the tray icon; macOS shows it as menu bar text
  if (r.platform === 'darwin') assert.match(r.trayTitle, /45%/);
  else assert.equal(r.trayImage, true);
  assert.equal(r.languages, 10);
  assert.deepEqual(r.thresholds, [50, 95]);
  assert.equal(r.accountsAfter, 0); // the settings window can't add accounts
});

test('a broken config.json still starts with valid settings', () => {
  const r = run({ PRECONFIG: JSON.stringify({ intervalSec: 'fast', theme: 7, scale: 'big', accounts: 'none', notifyThresholds: 'x' }) });
  assert.equal(r.state.status, 'ok');
  assert.equal(r.config.intervalSec, 120);
  assert.equal(r.config.theme, 'dark');
  assert.equal(r.config.scale, 1);
  assert.deepEqual(r.config.accounts, []);
});

test('tray number on each platform (simulated)', () => {
  const mac = run({ SIM_PLATFORM: 'darwin' });
  assert.equal(mac.platform, 'darwin');
  assert.equal(mac.trayTitle.trim(), '45%');
  assert.equal(mac.trayImage, false);
  const win = run({ SIM_PLATFORM: 'win32' });
  assert.equal(win.trayImage, true);
  assert.equal(win.trayTitle, '');
});

test('offline → offline message with a scheduled retry', () => {
  const r = run({ OFFLINE: '1' });
  assert.equal(r.state.status, 'error');
  assert.equal(r.state.msgKey, 'err.offline');
  assert.ok(r.state.retryAt);
});

test('network failure → network error, retry, not reportable', () => {
  const r = run({ NETFAIL: '1' });
  assert.equal(r.state.msgKey, 'err.network');
  assert.ok(r.state.retryAt);
  assert.equal(r.state.reportable, false);
});

test('hung request → gives up after the timeout, network error, retry', () => {
  const r = run({ HANG: '1', CLAUSAGE_TIMEOUT_MS: '150', WAIT_MS: '1200' });
  assert.equal(r.state.status, 'error');
  assert.equal(r.state.msgKey, 'err.network');
  assert.ok(r.state.retryAt);
  assert.equal(r.state.refreshing, undefined);
});

test('threshold notification fires once per window even though resets_at jitters', () => {
  const r = run({ JITTER: '1', REFRESHES: '4', PRECONFIG: JSON.stringify({ notifyThresholds: [40] }) });
  assert.equal(r.state.status, 'ok');
  assert.equal(r.notes.filter(t => /45%/.test(t)).length, 1);
  assert.match(r.state.windows[0].resetsAt, /:00.000Z$/); // rounded to the minute
});

test('regular poll fetches while in use, pauses while the computer is locked', () => {
  const active = run({ CLAUSAGE_POLL_MS: '60', WAIT_MS: '700' });
  assert.ok(active.usageFetches >= 3, `active: ${active.usageFetches} fetches`);
  const locked = run({ CLAUSAGE_POLL_MS: '60', WAIT_MS: '700', IDLE_STATE: 'locked' });
  assert.equal(locked.usageFetches, 1); // only the startup refresh
  assert.equal(locked.state.status, 'ok');
});

test('a failed refresh keeps the last number in the tray instead of the plain icon', () => {
  const win = run({ FAIL_AFTER: '1', REFRESHES: '1', SIM_PLATFORM: 'win32' });
  assert.equal(win.state.status, 'error');
  assert.equal(win.trayImageKind, 'drawn');
  const mac = run({ FAIL_AFTER: '1', REFRESHES: '1', SIM_PLATFORM: 'darwin' });
  assert.equal(mac.trayTitle.trim(), '45%');
});

test('extra accounts are fetched alongside the main one', () => {
  const r = run({ PRECONFIG: JSON.stringify({ accounts: [{ partition: 'persist:claude-acct-x', email: 'work@example.com' }] }) });
  assert.deepEqual(r.state.others.map(o => [o.email, o.status]), [['work@example.com', 'ok']]);
  assert.equal(r.state.email, 'me@example.com');
});

test('changed response format → numbers still shown, warning + report link', () => {
  const fs = require('fs'), os = require('os');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'usage-pro.json'), 'utf8'));
  raw.limits = raw.limits.map(({ percent, ...l }) => ({ ...l, pct_used: percent }));
  const file = path.join(os.tmpdir(), `clausage-changed-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(raw));
  try {
    const r = run({ FIXTURE: file });
    assert.equal(r.state.status, 'ok');
    assert.ok(r.state.windows.length);
    assert.deepEqual(r.state.formatIssues, ['limit-no-percent']);
    assert.equal(r.state.reportable, true);
  } finally { fs.unlinkSync(file); }
});
