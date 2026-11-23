'use strict';
// Runs src/main.js with test/fake-electron.js in place of Electron, then prints the
// last state pushed to the widget plus a few IPC results as JSON on stdout.
process.env.CLAUSAGE_TEST = '1'; // don't overwrite the developer's debug/ folder
const fs = require('fs');
const os = require('os');
const path = require('path');
// Keep the developer's real ~/.claude (Claude Code stats and credentials) out of the test
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clausage-cc-'));
// Pretend to be another OS (e.g. SIM_PLATFORM=darwin) to test platform-specific paths anywhere.
// os.tmpdir() looks at process.platform (win32 → %TEMP%), so pin the real one first.
if (process.env.SIM_PLATFORM) {
  const tmp = os.tmpdir();
  os.tmpdir = () => tmp;
  Object.defineProperty(process, 'platform', { value: process.env.SIM_PLATFORM });
}
const Module = require('module');
const fake = path.join(__dirname, 'fake-electron.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'electron' ? fake : resolve.call(this, request, ...rest);
};
require('../src/main.js');
setTimeout(async () => {
  const ipc = global.__ipc;
  for (let i = 0; i < Number(process.env.REFRESHES || 0); i++) await ipc.refresh();
  const state = global.__sent.filter(s => s[0] === 'usage').pop()?.[1];
  const settings = await ipc['settings:get']();
  await ipc['settings:set']({}, { notifyThresholds: [95, 50, 200, 'x'] });
  const after = await ipc['settings:get']();
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({
    state, tooltip: global.__tooltip, trayImage: !!global.__trayImage, trayImageKind: global.__trayImage, trayTitle: global.__trayTitle || '', platform: process.platform,
    languages: settings.languages.length, notes: (global.__notes || []).map(n => n.title), thresholds: after.config.notifyThresholds,
  }));
  process.exit(0);
}, Number(process.env.WAIT_MS || 800));
