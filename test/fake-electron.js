// Minimal Electron stand-in so test/smoke.test.js can run src/main.js under plain Node.
// Env: FIXTURE (usage JSON), OFFLINE, NETFAIL, PRECONFIG (config.json contents), VERBOSE.
const os = require('os'), path = require('path'), fs = require('fs');
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const log = (...a) => { if (process.env.VERBOSE) console.log('[fake]', ...a); };
const sent = global.__sent = [];
const handlers = global.__ipc = {};
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clausage-ud-'));
if (process.env.PRECONFIG) fs.writeFileSync(path.join(userData, 'config.json'), process.env.PRECONFIG);
const listeners = {};
let readyResolve; const ready = new Promise(r => (readyResolve = r));
const app = {
  isPackaged: false, dock: { hide() {} }, commandLine: { appendSwitch() {} },
  requestSingleInstanceLock: () => true, getPath: (n) => userData, getVersion: () => '0.1.0',
  getLocale: () => 'zh-TW', getPreferredSystemLanguages: () => ['zh-TW'],
  whenReady: () => ready, on: (e, f) => (listeners[e] = f), quit() {}, setAppUserModelId() {},
  setLoginItemSettings() {},
};
setTimeout(() => readyResolve(), 10);
class WebContents {
  constructor() { this.handlers = {}; }
  send(ch, ...a) { sent.push([ch, ...a]); }
  on(e, f) { this.handlers[e] = f; if (e === 'did-finish-load') setTimeout(f, 5); }
  async executeJavaScript(js) { if (js.includes('toDataURL')) return 'data:image/png;base64,AAAA'; return { status: 200, body: '{}' }; }
  setZoomFactor() {} isLoading() { return false; } setWindowOpenHandler() {} getURL() { return 'https://claude.ai/new'; } reload() {}
}
class BrowserWindow {
  constructor(o) { this.o = o; this.webContents = new WebContents(); this.visible = false; this.bounds = { x: 0, y: 0, width: o.width || 280, height: o.height || 160 }; this.ev = {}; }
  loadFile() { setTimeout(() => this.ev['ready-to-show']?.(), 5); return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  once(e, f) { this.ev[e] = f; } on(e, f) { this.ev[e] = f; }
  showInactive() { this.visible = true; } show() { this.visible = true; } hide() { this.visible = false; } isVisible() { return this.visible; }
  isDestroyed() { return false; } destroy() {} close() {} focus() {}
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setOpacity() {} setIgnoreMouseEvents(v) { this.ignore = v; }
  getBounds() { return { ...this.bounds }; } setBounds(b) { Object.assign(this.bounds, b); } setTitle() {}
}
const img = () => ({ isEmpty: () => false, resize() { return this; }, setTemplateImage() {}, addRepresentation() {} });
const cookieJar = { sessionKey: 'sk-test', lastActiveOrg: 'org-1' };
const responses = {
  '/api/organizations': [{ uuid: 'org-1', name: 'Test Org', capabilities: ['chat', 'claude_pro'], rate_limit_tier: 'default_claude_ai' }],
  '/api/organizations/org-1/usage': fixture,
  '/api/account': { email_address: 'me@example.com' },
};
const session = { fromPartition: (p) => ({
  cookies: { get: async ({ name }) => (cookieJar[name] ? [{ value: cookieJar[name] }] : []), set: async () => {} },
  fetch: async (url) => { if (process.env.NETFAIL) throw new TypeError('fetch failed'); const u = new URL(url); const body = responses[u.pathname]; log('fetch', u.pathname);
    return { status: body ? 200 : 404, ok: !!body, text: async () => JSON.stringify(body ?? {}) }; },
  setUserAgent() {}, clearStorageData: async () => {},
}) };
class Notification { static isSupported() { return true; } constructor(o) { this.o = o; } show() { (global.__notes ||= []).push(this.o); } }
class Tray { constructor() {} on() {} setToolTip(t) { global.__tooltip = t; } setContextMenu() {} setImage() { global.__trayImage = true; } setTitle(t) { global.__trayTitle = t; } }
const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
module.exports = {
  app, BrowserWindow, Tray, Notification, session,
  Menu: { buildFromTemplate: (t) => ({ t, popup() {} }) },
  ipcMain: { handle: (c, f) => (handlers[c] = f), on: (c, f) => (handlers[c] = f) },
  nativeImage: { createFromPath: img, createFromDataURL: img },
  screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display], getDisplayMatching: () => display },
  powerMonitor: { on() {} }, shell: { openExternal() {}, showItemInFolder() {} },
  globalShortcut: { register: () => true, unregisterAll() {} },
  nativeTheme: { on() {}, shouldUseDarkColors: true },
  net: { isOnline: () => !process.env.OFFLINE }, dialog: { showSaveDialog: async () => ({ canceled: true }) },
};
