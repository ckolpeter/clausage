'use strict';
// Runs src/main.js with test/fake-electron.js in place of Electron, then prints the
// last state pushed to the widget plus a few IPC results as JSON on stdout.
process.env.CLAUSAGE_TEST = '1'; // don't overwrite the developer's debug/ folder
// Pretend to be another OS (e.g. SIM_PLATFORM=darwin) to test platform-specific paths anywhere
if (process.env.SIM_PLATFORM) Object.defineProperty(process, 'platform', { value: process.env.SIM_PLATFORM });
const Module = require('module');
const path = require('path');
const fake = path.join(__dirname, 'fake-electron.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'electron' ? fake : resolve.call(this, request, ...rest);
};
require('../src/main.js');
setTimeout(async () => {
  const state = global.__sent.filter(s => s[0] === 'usage').pop()?.[1];
  const ipc = global.__ipc;
  const settings = await ipc['settings:get']();
  await ipc['settings:set']({}, { notifyThresholds: [95, 50, 200, 'x'] });
  const after = await ipc['settings:get']();
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({
    state, tooltip: global.__tooltip, trayImage: !!global.__trayImage, trayTitle: global.__trayTitle || '', platform: process.platform,
    languages: settings.languages.length, thresholds: after.config.notifyThresholds,
  }));
  process.exit(0);
}, Number(process.env.WAIT_MS || 800));
