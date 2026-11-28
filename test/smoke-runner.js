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
  const usageFetches = global.__usageFetches || 0;
  // Sign-in window: Google's page is stopped (redirect and popup) and explained instead
  let google = null;
  if (process.env.GOOGLE) {
    const before = global.__windows.length;
    ipc.login();
    const lw = global.__windows.slice(before).find(w => w.o.webPreferences?.partition === 'persist:claude');
    let prevented = 0;
    const ev = (url, isMainFrame = true) => ({ url, isMainFrame, preventDefault: () => prevented++ });
    lw.webContents.handlers['will-redirect'](ev('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'));
    lw.webContents.handlers['will-navigate'](ev('https://accounts.google.com/v3/signin/identifier'));
    lw.webContents.handlers['will-navigate'](ev('https://claude.ai/login?step=email'));
    lw.webContents.handlers['will-navigate'](ev('https://accounts.google.com/gsi/iframe', false));
    const popup = lw.webContents.openHandler({ url: 'https://accounts.google.com/o/oauth2/auth' }).action;
    const other = lw.webContents.openHandler({ url: 'https://login.example.com/sso' }).action;
    await new Promise(r => setTimeout(r, 20));
    google = { prevented, popup, other, dialogs: (global.__dialogs || []).map(d => d.message) };
  }
  const settings = await ipc['settings:get']();
  await ipc['settings:set']({}, { notifyThresholds: [95, 50, 200, 'x'], accounts: [{ partition: 'persist:claude-acct-evil' }] });
  await ipc['settings:set']({}, null);
  const after = await ipc['settings:get']();
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({
    state, tooltip: global.__tooltip, trayImage: !!global.__trayImage, trayImageKind: global.__trayImage, trayTitle: global.__trayTitle || '', platform: process.platform,
    languages: settings.languages.length, notes: (global.__notes || []).map(n => n.title), thresholds: after.config.notifyThresholds, accountsAfter: after.config.accounts.length, config: after.config, usageFetches, google,
  }));
  process.exit(0);
}, Number(process.env.WAIT_MS || 800));
