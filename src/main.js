'use strict';
/**
 * Clausage — main process
 *
 * Data sources:
 *   web  : sign in to claude.ai inside the app, read /api/organizations/{org}/usage
 *          (same data as claude.ai → Settings → Usage)
 *   code : read Claude Code's OAuth credentials, call api.anthropic.com/api/oauth/usage
 *
 * Both are undocumented endpoints and may change at any time.
 */
const {
  app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, dialog,
  Notification, screen, powerMonitor, shell, globalShortcut, nativeTheme, net,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { History } = require('./history');
const { Updater } = require('./updater');
const { CodeStats } = require('./code-stats');
const { FullscreenWatcher } = require('./fullscreen');
const { writeFileAtomic, Debounced } = require('./store');
const usage = require('./usage');
const { planOf, hasUsage } = usage;

const IS_MAC = process.platform === 'darwin';
const PARTITION = 'persist:claude';
const CLAUDE = 'https://claude.ai';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const CHROME_UA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

if (!app.requestSingleInstanceLock()) {
  console.log('Clausage is already running (check the system tray). Quit it from the tray menu first.');
  app.quit(); process.exit(0);
}
// Transparent windows on Linux need this switch
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

// ---------------------------------------------------------------- config
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  source: 'web',          // 'web' | 'code'
  language: 'auto',       // 'auto' | locale code from src/locales
  intervalSec: 120,
  opacity: 0.95,
  alwaysOnTop: true,
  compact: false,
  notify: true,
  notifyReset: true,      // notify when the 5-hour / weekly limit resets
  notifyThresholds: [80, 95], // usage % that trigger a notification (the highest one plays a sound)
  quietEnabled: false,    // no notifications during quiet hours
  quietStart: '23:00',
  quietEnd: '08:00',
  showBreakdown: true,
  showCodeStats: true,    // Claude Code token usage per model (only when Claude Code is installed)
  trayMetric: 'five_hour', // number in the tray icon: 'five_hour' | 'seven_day' | 'max' | 'off'
  openAtLogin: false,
  autoUpdate: true,
  hotkey: 'CommandOrControl+Alt+C', // show / hide the widget ('' = off)
  clickThrough: false,    // widget ignores the mouse (toggle from the tray or Ctrl+Alt+Shift+C)
  theme: 'dark',          // 'dark' | 'light' | 'system'
  scale: 1,               // widget size 0.8 – 1.5
  hideOnFullscreen: false, // hide while another app is full screen (Windows; macOS uses full-screen Spaces)
  snapEdges: true,        // snap to screen edges when dragged close
  bounds: null,
  orgId: null,
  accounts: [],          // extra claude.ai accounts: [{ partition, email }]
  mainEmail: '',         // label for the main account when several are shown
};
let config = { ...DEFAULTS };
function loadConfig() {
  try { config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) }; }
  catch { config = { ...DEFAULTS }; }
}
const configSaver = new Debounced(() => {
  try { writeFileAtomic(CONFIG_PATH(), JSON.stringify(config, null, 2)); } catch (e) { console.error(e); }
}, 300);
function saveConfig() { configSaver.schedule(); }

// ---------------------------------------------------------------- i18n
// Every *.json in src/locales is a language. To add one, copy en.json and translate it.
const LOCALE_DIR = path.join(__dirname, 'locales');
const LOCALES = {};
for (const f of fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith('.json'))) {
  LOCALES[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf8'));
}
const FALLBACK = 'en';
let lang = FALLBACK;

function resolveLang(pref) {
  const codes = Object.keys(LOCALES);
  const candidates = pref && pref !== 'auto'
    ? [pref]
    : [...(app.getPreferredSystemLanguages?.() || []), app.getLocale()];
  for (const c of candidates) {
    if (!c) continue;
    const exact = codes.find(x => x.toLowerCase() === c.toLowerCase());
    if (exact) return exact;
    // zh-Hant / zh-HK / zh-MO → zh-TW. Add zh-CN.json later for Simplified Chinese.
    if (/^zh[-_](hant|tw|hk|mo)/i.test(c) && LOCALES['zh-TW']) return 'zh-TW';
    if (/^zh/i.test(c) && LOCALES['zh-CN']) return 'zh-CN';
    if (/^zh/i.test(c) && LOCALES['zh-TW']) return 'zh-TW';
    const base = c.split(/[-_]/)[0].toLowerCase();
    const byBase = codes.find(x => x.split('-')[0].toLowerCase() === base);
    if (byBase) return byBase;
  }
  return FALLBACK;
}

function t(key, vars = {}) {
  const s = LOCALES[lang]?.[key] ?? LOCALES[FALLBACK]?.[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

function setLanguage(pref) {
  config.language = pref; saveConfig();
  lang = resolveLang(pref);
  for (const w of [widget, settingsWin, historyWin]) if (w && !w.isDestroyed()) w.webContents.reload();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(t('win.settings'));
  updateTray();
}

// ---------------------------------------------------------------- state
let widget = null, tray = null, settingsWin = null, historyWin = null;
const loginWins = new Map();   // partition → login window
const fetcherWins = new Map(); // partition → hidden claude.ai page used as a fetch fallback
let pollTimer = null;
let resetTimer = null;
let retryTimer = null;
let failCount = 0;      // consecutive non-auth failures, for retry backoff
let lastFormatWarn = '';  // last logged format-issue set, so each change is logged once
let refreshing = null;  // in-flight refresh, so overlapping triggers share one request
let history = null;
let updater = null;
const codeStats = new CodeStats();
let hotkeyOk = true;
let hiddenForFullscreen = false;
const fullscreen = new FullscreenWatcher((isFs) => {
  if (!widget || widget.isDestroyed()) return;
  if (isFs && widget.isVisible()) { hiddenForFullscreen = true; widget.hide(); }
  else if (!isFs && hiddenForFullscreen) { hiddenForFullscreen = false; widget.showInactive(); }
  updateTray();
});

function applyFullscreenMode() {
  if (config.hideOnFullscreen) fullscreen.start(); else fullscreen.stop();
  applyTopmost();
}
let lastState = { status: 'loading' };
const notified = new Set();

function ses(part = PARTITION) { return session.fromPartition(part); }

/** Errors carry an i18n key so the UI can re-translate when the language changes */
class AppError extends Error {
  constructor(key, vars = {}) { super(key); this.key = key; this.vars = vars; }
}
class AuthError extends AppError {}

// ---------------------------------------------------------------- fetch: claude.ai
async function getCookie(name, part = PARTITION) {
  const list = await ses(part).cookies.get({ url: CLAUDE, name });
  return list[0]?.value || null;
}

/** Try session.fetch first; if Cloudflare blocks it, fetch same-origin inside a hidden claude.ai page */
async function claudeGetJson(pathname, part = PARTITION) {
  const url = CLAUDE + pathname;
  try {
    const r = await ses(part).fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    });
    if (r.status === 401) throw new AuthError('err.sessionExpired');
    const text = await r.text();
    if (r.ok) return JSON.parse(text);
    if (r.status === 403 && /permission_error|account_session_invalid/i.test(text)) throw new AuthError('err.sessionInvalid');
    // Anything else (usually a Cloudflare 403/503) → fall back to in-page fetch
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (isNetworkError(e)) throw e; // no connection: the in-page fetch would fail too
  }
  return pageFetchJson(url, part);
}

async function ensureFetcherWin(part) {
  const existing = fetcherWins.get(part);
  if (existing && !existing.isDestroyed()) return existing;
  const w = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { partition: part, contextIsolation: true, sandbox: true },
  });
  fetcherWins.set(part, w);
  await w.loadURL(CLAUDE + '/robots.txt').catch(() => {});
  return w;
}

function destroyFetcher(part) {
  const w = fetcherWins.get(part);
  if (w && !w.isDestroyed()) w.destroy();
  fetcherWins.delete(part);
}

async function pageFetchJson(url, part = PARTITION) {
  const w = await ensureFetcherWin(part);
  const res = await w.webContents.executeJavaScript(
    `fetch(${JSON.stringify(url)}, {credentials:'include', headers:{accept:'application/json'}})
       .then(async r => ({ status: r.status, body: await r.text() }))
       .catch(e => ({ status: 0, body: String(e) }))`,
    true,
  );
  if (res.status === 0) throw new TypeError(`fetch failed: ${res.body}`);
  if (res.status === 401 || res.status === 403) throw new AuthError('err.sessionExpired');
  if (res.status < 200 || res.status >= 300) throw new AppError('err.http', { host: 'claude.ai', status: res.status });
  return JSON.parse(res.body);
}

const autoOrgIds = new Map(); // partition → org found to have usage data, cached until sign-out

/**
 * Usage for one claude.ai account (one session partition).
 * The main account uses config.orgId and writes debug files; extra accounts pick their org automatically.
 */
async function fetchWebUsage(part = PARTITION) {
  const isMain = part === PARTITION;
  const prefOrg = isMain ? config.orgId : null;
  const debug = isMain ? dumpDebug : () => {};
  if (!(await getCookie('sessionKey', part))) throw new AuthError('err.notLoggedIn');
  const lastActive = await getCookie('lastActiveOrg', part);

  let orgs = [];
  try {
    const list = await claudeGetJson('/api/organizations', part);
    if (Array.isArray(list)) orgs = list;
  } catch (e) {
    if (e instanceof AuthError || isNetworkError(e)) throw e;
  }
  debug('organizations.json', orgs);
  if (isMain && !app.isPackaged) {
    // Which account is signed in, and its plan as claude.ai reports it (local debug file only)
    claudeGetJson('/api/account').then(a => dumpDebug('account.json', {
      email: a?.email_address, full_name: a?.full_name,
      memberships: (a?.memberships || []).map(m => ({ role: m.role, org: m.organization?.name, uuid: m.organization?.uuid })),
      keys: a ? Object.keys(a) : [],
    })).catch(e => dumpDebug('account.json', { error: e.key || e.message }));
  }

  // Candidate order: user's choice → cached → subscription orgs → last active → the rest
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  if (prefOrg) add(prefOrg);
  else {
    // Only orgs with chat access have claude.ai usage limits (API console orgs don't)
    const chatOrgs = orgs.filter(o => (o.capabilities || []).includes('chat'));
    add(autoOrgIds.get(part));
    chatOrgs.filter(o => planOf(o)).forEach(o => add(o.uuid));
    if (chatOrgs.some(o => o.uuid === lastActive)) add(lastActive);
    chatOrgs.forEach(o => add(o.uuid));
    if (!orgs.length) add(lastActive);
  }
  if (!ids.length) throw new AppError('err.noOrg');

  let first = null;
  const tried = [];
  for (const id of ids.slice(0, 8)) {
    const org = orgs.find(o => o.uuid === id) || {};
    let raw;
    try {
      raw = await claudeGetJson(`/api/organizations/${id}/usage`, part);
    } catch (e) {
      // The org list loaded, so the session is valid: a 403 here only means this org has no usage page
      if (!orgs.length || isNetworkError(e)) throw e;
      tried.push({ orgId: id, name: org.name, error: e.key || e.message });
      continue;
    }
    tried.push({ orgId: id, name: org.name, hasUsage: hasUsage(raw), raw });
    const result = { raw, plan: planOf(org), orgName: org.name || '' };
    if (!first) first = result;
    if (hasUsage(raw)) {
      if (!prefOrg) autoOrgIds.set(part, id);
      debug('web-usage.json', { fetchedAt: new Date().toISOString(), picked: id, tried });
      return result;
    }
    if (prefOrg) break; // user picked an org explicitly: don't try others
  }
  debug('web-usage.json', { fetchedAt: new Date().toISOString(), picked: null, tried });
  // Every chat org came back empty: most likely the Free plan, which has no usage limits page
  const chat = orgs.filter(o => (o.capabilities || []).includes('chat'));
  if (chat.length && chat.every(o => !planOf(o))) throw new AppError('err.freePlan');
  throw new AppError('err.noSubscription');
}

// ---------------------------------------------------------------- fetch: Claude Code
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readKeychain() {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 }, (err, out) => resolve(err ? null : out.trim()));
  });
}

async function readClaudeCodeCreds() {
  let text = null;
  const file = path.join(claudeConfigDir(), '.credentials.json');
  if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
  else if (IS_MAC) text = await readKeychain();
  if (!text) throw new AuthError('err.ccNoCreds');
  let o;
  try { const j = JSON.parse(text); o = j.claudeAiOauth || j; } catch { throw new AuthError('err.ccBadFormat'); }
  if (!o.accessToken) throw new AuthError('err.ccBadFormat');
  if (o.expiresAt && Date.now() > o.expiresAt) throw new AuthError('err.ccExpired');
  const plan = o.subscriptionType ? o.subscriptionType[0].toUpperCase() + o.subscriptionType.slice(1) : '';
  return { token: o.accessToken, plan };
}

async function fetchCodeUsage() {
  const { token, plan } = await readClaudeCodeCreds();
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': `clausage/${app.getVersion()}`,
    },
  });
  if (r.status === 401) throw new AuthError('err.ccInvalid');
  if (!r.ok) throw new AppError('err.http', { host: 'api.anthropic.com', status: r.status });
  const raw = await r.json();
  dumpDebug('code-usage.json', { fetchedAt: new Date().toISOString(), plan, raw });
  return { raw, plan, orgName: '' };
}

// ---------------------------------------------------------------- debug
// When running from source (npm start), save raw API responses to ./debug/ to help diagnose format changes.
// Contains usage numbers and org IDs only — no cookies or tokens. The folder is gitignored.
function dumpDebug(name, data) {
  if (app.isPackaged || process.env.CLAUSAGE_TEST) return;
  try {
    const dir = path.join(__dirname, '..', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  } catch (e) { console.error('[debug]', e); }
}

// ---------------------------------------------------------------- normalize

function normalize(data) { return usage.normalize(data, config.source); }
function addEta(state, now = Date.now()) { return usage.addEta(state, history, now); }

/** Translated label of a window */
function labelOf(w) {
  if (typeof w === 'string') w = { labelKey: `label.${w}` };
  return t(w.labelKey, w.labelVars);
}

// ---------------------------------------------------------------- main loop
const ISSUES_URL = 'https://github.com/ckolpeter/clausage/issues/new?template=bug_report.yml';

/** Bug-report link prefilled with the version and what went wrong (error key / format issue codes only — no personal data) */
function issueUrl(state) {
  const what = state?.formatIssues?.length
    ? `Usage format check failed: ${state.formatIssues.join(', ')}`
    : state?.msgKey ? `Error: ${state.msgKey}${state.msgVars?.status ? ` (${state.msgVars.status})` : ''}` : '';
  const q = new URLSearchParams({ version: `v${app.getVersion()}`, ...(what ? { what } : {}) });
  return `${ISSUES_URL}&${q}`;
}

/** Network-level failures (no response at all) as opposed to HTTP errors */
function isNetworkError(e) {
  const m = String(e?.message || e || '');
  return e?.name === 'TypeError' || /fetch failed|net::ERR_|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|network/i.test(m);
}

/**
 * After a failure, retry sooner than the normal interval: 15s, 30s, 60s, 120s…
 * capped at the normal interval. Sign-in problems don't retry (they need the user).
 */
function scheduleRetry() {
  clearTimeout(retryTimer);
  const normal = Math.max(30, Number(config.intervalSec) || 120) * 1000;
  const wait = Math.min(normal, 15e3 * 2 ** Math.max(0, failCount - 1));
  if (wait >= normal) return null; // the regular poll will handle it
  retryTimer = setTimeout(refresh, wait);
  return Date.now() + wait;
}

function refresh() {
  // Collapse overlapping triggers (timer + resume + manual click) into one request
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh() {
  clearTimeout(retryTimer);
  if (!net.isOnline()) {
    failCount++;
    const prev = lastState.status === 'ok' ? lastState : lastState.prev;
    lastState = { status: 'error', msgKey: 'err.offline', prev, others: lastState.others, email: lastState.email, code: lastState.code };
    lastState.retryAt = scheduleRetry();
    push(lastState); updateTray();
    return;
  }
  push({ ...lastState, refreshing: true });
  // Extra accounts are fetched in parallel with the main one and never throw
  const othersP = fetchOthers();
  try {
    const data = config.source === 'code' ? await fetchCodeUsage() : await fetchWebUsage();
    const prevOk = lastState.status === 'ok' ? lastState : lastState.prev;
    lastState = normalize(data);
    if (!lastState.windows.length) lastState = { status: 'error', msgKey: 'err.noData', reportable: true };
    else {
      failCount = 0;
      if (lastState.formatIssues) {
        // Still show the numbers, but warn that they may be wrong and offer a report link
        lastState.reportable = true;
        const key = lastState.formatIssues.join(',');
        if (key !== lastFormatWarn) { console.warn('[usage] response format changed:', key); lastFormatWarn = key; }
      } else lastFormatWarn = '';
      history?.add(lastState);
      addEta(lastState);
      maybeNotify(lastState);
      checkResets(prevOk, lastState);
      scheduleResetCheck(lastState);
    }
  } catch (e) {
    console.error('[refresh]', e);
    const msg = e instanceof AppError
      ? { msgKey: e.key, msgVars: e.vars }
      : { message: e.message || String(e) };
    if (e instanceof AuthError) {
      failCount = 0;
      lastState = { status: 'auth', source: config.source, ...msg };
    } else {
      failCount++;
      const isNet = isNetworkError(e);
      lastState = {
        status: 'error',
        ...(isNet ? { msgKey: 'err.network' } : msg),
        prev: lastState.windows ? lastState : lastState.prev,
        reportable: !isNet && !(e instanceof AppError && e.key === 'err.http' && e.vars?.status >= 500),
      };
      lastState.retryAt = scheduleRetry();
    }
  }
  lastState.others = await othersP;
  if (lastState.others.length && config.source === 'web' && !config.mainEmail && lastState.status === 'ok') {
    rememberEmail(PARTITION).then(() => { lastState.email = config.mainEmail; push(lastState); });
  }
  lastState.email = config.source === 'web' ? config.mainEmail : '';
  if (config.showCodeStats) {
    try { lastState.code = codeStats.compute(); } catch (e) { console.error('[code-stats]', e); lastState.code = null; }
  } else lastState.code = null;
  push(lastState);
  updateTray();
}

function schedule() {
  clearInterval(pollTimer);
  const sec = Math.max(30, Number(config.intervalSec) || 120);
  pollTimer = setInterval(refresh, sec * 1000);
}

function resolvedTheme() {
  return config.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : config.theme;
}
function viewOpts() {
  return { compact: config.compact, showBreakdown: config.showBreakdown, showCodeStats: config.showCodeStats, theme: resolvedTheme(), clickThrough: config.clickThrough };
}

function push(state) {
  if (widget && !widget.isDestroyed()) widget.webContents.send('usage', state, viewOpts());
}

function stateMessage(s) {
  return s.msgKey ? t(s.msgKey, s.msgVars) : (s.message || '');
}

/** "HH:MM" → minutes since midnight, or null */
function hm(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

/** Inside quiet hours? Handles ranges that cross midnight (e.g. 23:00 → 08:00) */
function inQuietHours(now = new Date()) {
  if (!config.quietEnabled) return false;
  const a = hm(config.quietStart), b = hm(config.quietEnd);
  if (a == null || b == null || a === b) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** All notifications go through here so quiet hours apply everywhere */
function notify(opts) {
  if (!Notification.isSupported() || inQuietHours()) return;
  new Notification(opts).show();
}

function thresholds() {
  const list = (Array.isArray(config.notifyThresholds) ? config.notifyThresholds : [80, 95])
    .map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 100);
  return [...new Set(list)].sort((a, b) => a - b).slice(0, 5);
}

function maybeNotify(state, who = '') {
  if (!config.notify) return;
  const ths = thresholds();
  const loudest = ths[ths.length - 1];
  for (const w of state.windows.filter(x => x.primary)) {
    // Only announce the highest threshold crossed; mark the lower ones as done too
    const crossed = ths.filter(th => w.pct >= th);
    const top = crossed[crossed.length - 1];
    if (top == null) continue;
    const id = (th) => `${who}|${w.key}|${w.resetsAt}|${th}`;
    if (notified.has(id(top))) continue;
    crossed.forEach(th => notified.add(id(th)));
    notify({
      title: (who ? `${who} · ` : '') + t('notify.title', { label: labelOf(w), pct: Math.round(w.pct) }),
      body: w.resetsAt ? t('notify.body', { time: new Date(w.resetsAt).toLocaleString(lang) }) : '',
      silent: top < loudest,
    });
  }
}

// ---------------------------------------------------------------- run-out prediction
// ---------------------------------------------------------------- reset notifications
function checkResets(prev, cur) {
  if (!prev?.windows || !config.notifyReset) return;
  const now = Date.now();
  for (const key of ['five_hour', 'seven_day']) {
    const p = prev.windows.find(w => w.key === key);
    const c = cur.windows.find(w => w.key === key);
    if (!p || !c || p.pct < 20) continue; // nothing worth announcing
    const prevEnded = p.resetsAt && new Date(p.resetsAt).getTime() <= now;
    const newWindow = p.resetsAt && c.resetsAt && c.resetsAt !== p.resetsAt;
    if ((prevEnded || newWindow) && c.pct < p.pct - 5) {
      notify({
        title: t('notify.resetTitle', { label: labelOf(c) }),
        body: t('notify.resetBody', { pct: Math.round(c.pct) }),
      });
    }
  }
}

/** Refresh right after the next reset so the widget and notification are timely */
function scheduleResetCheck(state) {
  clearTimeout(resetTimer);
  const now = Date.now();
  const next = state.windows
    .filter(w => w.primary && w.resetsAt)
    .map(w => new Date(w.resetsAt).getTime())
    .filter(x => Number.isFinite(x) && x > now)
    .sort((a, b) => a - b)[0];
  if (next && next - now < 2 ** 31 - 1) resetTimer = setTimeout(refresh, next - now + 20e3);
}

// ---------------------------------------------------------------- windows
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - 300, y: wa.y + 20, width: 280, height: 160 };
}

function boundsVisible(b) {
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x + 40 > a.x && b.x < a.x + a.width - 40 && b.y + 20 > a.y && b.y < a.y + a.height - 20;
  });
}

function createWidget() {
  const b = config.bounds && boundsVisible(config.bounds) ? config.bounds : defaultBounds();
  widget = new BrowserWindow({
    ...b,
    width: widgetWidth(),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  applyTopmost();
  widget.setOpacity(config.opacity);
  widget.loadFile(path.join(__dirname, 'widget.html'));
  widget.webContents.on('did-finish-load', () => widget.webContents.setZoomFactor(scaleOf()));
  applyClickThrough();
  widget.once('ready-to-show', () => { widget.showInactive(); push(lastState); trayIconKey = ''; updateTrayIcon(); });
  const remember = () => {
    if (widget.isDestroyed()) return;
    if (config.snapEdges) snapToEdges();
    config.bounds = widget.getBounds(); saveConfig();
  };
  widget.on('moved', remember);
  widget.on('closed', () => { widget = null; });
}

/** If the widget was dropped within SNAP px of a work-area edge, stick it to that edge */
const SNAP = 24;
function snapToEdges() {
  const b = widget.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  let { x, y } = b;
  if (Math.abs(b.x - a.x) <= SNAP) x = a.x;
  else if (Math.abs(a.x + a.width - (b.x + b.width)) <= SNAP) x = a.x + a.width - b.width;
  if (Math.abs(b.y - a.y) <= SNAP) y = a.y;
  else if (Math.abs(a.y + a.height - (b.y + b.height)) <= SNAP) y = a.y + a.height - b.height;
  if (x !== b.x || y !== b.y) widget.setBounds({ ...b, x, y });
}

const BASE_WIDTH = 280;
function scaleOf() { return Math.max(0.8, Math.min(1.5, Number(config.scale) || 1)); }
function widgetWidth() { return Math.round(BASE_WIDTH * scaleOf()); }

function applyScale() {
  if (!widget || widget.isDestroyed()) return;
  widget.webContents.setZoomFactor(scaleOf());
  const b = widget.getBounds();
  widget.setBounds({ ...b, width: widgetWidth() });
  push(lastState); // renderer re-measures its height
}

function applyClickThrough() {
  if (!widget || widget.isDestroyed()) return;
  widget.setIgnoreMouseEvents(!!config.clickThrough, { forward: true });
  push(lastState);
}

function toggleClickThrough() {
  config.clickThrough = !config.clickThrough; saveConfig();
  applyClickThrough(); updateTray();
}

/** Global hotkeys: config.hotkey toggles the widget; Ctrl/Cmd+Alt+Shift+C toggles click-through */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  let ok = true;
  if (config.hotkey) {
    try { ok = globalShortcut.register(config.hotkey, toggleWidget); } catch { ok = false; }
  }
  try { globalShortcut.register('CommandOrControl+Alt+Shift+C', toggleClickThrough); } catch { /* taken */ }
  return ok;
}

function applyTopmost() {
  if (!widget) return;
  if (config.alwaysOnTop) {
    widget.setAlwaysOnTop(true, IS_MAC ? 'floating' : 'screen-saver');
    if (IS_MAC) widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !config.hideOnFullscreen });
  } else {
    widget.setAlwaysOnTop(false);
    if (IS_MAC) widget.setVisibleOnAllWorkspaces(false);
  }
}

function toggleWidget() {
  hiddenForFullscreen = false;
  if (!widget) return createWidget();
  widget.isVisible() ? widget.hide() : widget.showInactive();
  updateTray();
}

/** Sign-in window for an account (default: the main account) */
function openLogin(part = PARTITION) {
  const open = loginWins.get(part);
  if (open && !open.isDestroyed()) { open.focus(); return; }
  const acct = accountOf(part);
  const win = new BrowserWindow({
    width: 480, height: 760, title: t('win.login') + (acct?.email ? ` · ${acct.email}` : ''),
    autoHideMenuBar: true,
    webPreferences: { partition: part, contextIsolation: true, sandbox: true },
  });
  loginWins.set(part, win);
  // Google and other SSO providers open popups; keep them in the same session
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: part } },
  }));
  win.loadURL(CLAUDE + '/login');
  // Already signed in → keep the window open (lets the user switch accounts);
  // auto-close only once a new sign-in happens.
  let initialKey;
  getCookie('sessionKey', part).then(k => { initialKey = k; });
  const check = setInterval(async () => {
    if (win.isDestroyed()) return clearInterval(check);
    if (initialKey === undefined) return;
    const url = win.webContents.getURL();
    const key = await getCookie('sessionKey', part);
    if (key && key !== initialKey && !/\/login|\/magic-link|\/onboarding/.test(url)) {
      clearInterval(check);
      win.close();
      autoOrgIds.delete(part);
      if (part === PARTITION) { config.source = 'web'; config.mainEmail = ''; saveConfig(); }
      await rememberEmail(part);
      refresh();
    }
  }, 1500);
  win.on('closed', () => { clearInterval(check); loginWins.delete(part); });
}

async function logout(part = PARTITION) {
  await ses(part).clearStorageData();
  destroyFetcher(part);
  autoOrgIds.delete(part);
  if (part === PARTITION) {
    config.mainEmail = ''; saveConfig();
    lastState = { status: 'auth', msgKey: 'msg.loggedOut', source: config.source, others: lastState.others };
    push(lastState);
    updateTray();
  } else {
    refresh();
  }
}

// ---------------------------------------------------------------- extra accounts
// config.accounts = [{ partition, email }]: accounts shown below the main one.
function accountOf(part) { return (config.accounts || []).find(a => a.partition === part); }

async function rememberEmail(part) {
  try {
    const a = await claudeGetJson('/api/account', part);
    if (!a?.email_address) return;
    if (part === PARTITION) config.mainEmail = a.email_address;
    else { const acct = accountOf(part); if (acct) acct.email = a.email_address; }
    saveConfig();
  } catch { /* label stays empty */ }
}

function addAccount() {
  const part = `persist:claude-acct-${Date.now().toString(36)}`;
  config.accounts = [...(config.accounts || []), { partition: part, email: '' }];
  saveConfig();
  ses(part).setUserAgent(IS_MAC ? CHROME_UA_MAC : CHROME_UA);
  openLogin(part);
}

async function removeAccount(part) {
  if (part === PARTITION) return;
  await ses(part).clearStorageData().catch(() => {});
  destroyFetcher(part);
  autoOrgIds.delete(part);
  config.accounts = (config.accounts || []).filter(a => a.partition !== part);
  saveConfig();
  if (lastState.others) lastState.others = lastState.others.filter(o => o.partition !== part);
  push(lastState);
}

/** Fetch every extra account (in parallel). Failures become per-account status, never throw. */
async function fetchOthers() {
  return Promise.all((config.accounts || []).map(async (acct) => {
    const base = { partition: acct.partition, email: acct.email || '' };
    try {
      const st = normalize(await fetchWebUsage(acct.partition));
      addEta(st);
      maybeNotify(st, acct.email);
      return { ...base, status: 'ok', plan: st.plan, windows: st.windows.filter(w => w.primary) };
    } catch (e) {
      return { ...base, status: e instanceof AuthError ? 'auth' : 'error', msgKey: e.key, msgVars: e.vars, message: e.key ? undefined : e.message };
    }
  }));
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 800, title: t('win.settings'),
    resizable: false, autoHideMenuBar: true, minimizable: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('page-title-updated', (e) => e.preventDefault());
  settingsWin.on('closed', () => { settingsWin = null; });
}

function openHistory() {
  if (historyWin && !historyWin.isDestroyed()) { historyWin.focus(); return; }
  historyWin = new BrowserWindow({
    width: 600, height: 560, title: t('h.title'), backgroundColor: '#1e1c1a',
    autoHideMenuBar: true, minWidth: 420, minHeight: 480,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  historyWin.loadFile(path.join(__dirname, 'history.html'));
  historyWin.on('closed', () => { historyWin = null; });
}

// ---------------------------------------------------------------- tray
function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) img.setTemplateImage(true);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function languageMenu() {
  return [
    { label: t('menu.langAuto'), type: 'radio', checked: config.language === 'auto', click: () => setLanguage('auto') },
    { type: 'separator' },
    ...Object.entries(LOCALES).map(([code, d]) => ({
      label: d._name || code, type: 'radio', checked: config.language === code, click: () => setLanguage(code),
    })),
  ];
}

function updateMenuItems() {
  const st = updater?.status;
  if (!st || st.state === 'idle') return [];
  return [
    { label: t(st.state === 'downloaded' ? 'menu.updateRestart' : 'menu.updateDownload', { version: st.version }), click: () => updater.apply() },
    { type: 'separator' },
  ];
}

function buildMenu() {
  return Menu.buildFromTemplate([
    ...updateMenuItems(),
    { label: widget && widget.isVisible() ? t('menu.hide') : t('menu.show'), click: toggleWidget },
    { label: t('menu.refresh'), click: refresh },
    { type: 'separator' },
    { label: t('menu.login'), click: openLogin, enabled: config.source === 'web' },
    { label: t('menu.history'), click: openHistory },
    { label: t('menu.openUsage'), click: () => shell.openExternal(CLAUDE + '/settings/usage') },
    { type: 'separator' },
    {
      label: t('menu.alwaysOnTop'), type: 'checkbox', checked: config.alwaysOnTop,
      click: (m) => { config.alwaysOnTop = m.checked; applyTopmost(); saveConfig(); },
    },
    {
      label: t('menu.compact'), type: 'checkbox', checked: config.compact,
      click: (m) => { config.compact = m.checked; saveConfig(); push(lastState); },
    },
    {
      label: t('menu.clickThrough'), type: 'checkbox', checked: !!config.clickThrough,
      accelerator: 'CommandOrControl+Alt+Shift+C', click: toggleClickThrough,
    },
    { label: t('menu.language'), submenu: languageMenu() },
    { label: t('menu.settings'), click: openSettings },
    { label: t('menu.resetPos'), click: () => { if (widget) { widget.setBounds(defaultBounds()); config.bounds = null; saveConfig(); } } },
    { type: 'separator' },
    { label: t('menu.quit'), click: () => app.quit() },
  ]);
}

const TRAY_COLORS = { ok: '#2f8f55', warn: '#c98411', bad: '#cc3f35' };

function trayMetricWindow() {
  const ws = lastState.status === 'ok' ? lastState.windows : null;
  if (!ws || config.trayMetric === 'off') return null;
  const five = ws.find(w => w.key === 'five_hour');
  const week = ws.find(w => w.key === 'seven_day');
  if (config.trayMetric === 'seven_day') return week || null;
  if (config.trayMetric === 'max') return [five, week].filter(Boolean).sort((a, b) => b.pct - a.pct)[0] || null;
  return five || null;
}

/** Draw the tray icon (rounded square + percentage) with a canvas in the widget page */
let trayIconKey = '';
async function updateTrayIcon() {
  if (!tray || IS_MAC) return; // macOS shows the number as menu bar text instead
  const w = trayMetricWindow();
  const key = w ? `${Math.round(w.pct)}` : 'default';
  if (key === trayIconKey) return;
  if (!w) { tray.setImage(trayImage()); trayIconKey = key; return; }
  if (!widget || widget.isDestroyed() || widget.webContents.isLoading()) return;
  const pct = Math.round(w.pct);
  const color = pct >= 90 ? TRAY_COLORS.bad : pct >= 70 ? TRAY_COLORS.warn : TRAY_COLORS.ok;
  const text = String(pct);
  const draw = (S) => `(() => {
    const S = ${S}, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = ${JSON.stringify(color)};
    g.beginPath(); g.roundRect(0, 0, S, S, S * 0.22); g.fill();
    const txt = ${JSON.stringify(text)};
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const size = txt.length >= 3 ? S * 0.5 : S * 0.68;
    g.font = '700 ' + size + 'px "Segoe UI", Arial, sans-serif';
    g.fillText(txt, S / 2, S / 2 + S * 0.04);
    return c.toDataURL('image/png');
  })()`;
  try {
    const [u16, u32] = await Promise.all([16, 32].map(S => widget.webContents.executeJavaScript(draw(S), true)));
    const img = nativeImage.createFromDataURL(u16);
    img.addRepresentation({ scaleFactor: 2, dataURL: u32 });
    tray.setImage(img);
    trayIconKey = key;
  } catch (e) { console.error('[tray]', e); }
}

function updateTray() {
  if (!tray) return;
  updateTrayIcon();
  const five = lastState.windows?.find(w => w.key === 'five_hour');
  const week = lastState.windows?.find(w => w.key === 'seven_day');
  const tip = five || week
    ? t('tray.tooltip', { five: five ? Math.round(five.pct) + '%' : '-', week: week ? Math.round(week.pct) + '%' : '-' })
      + (five?.eta?.beforeReset ? '\n' + t('tray.eta', { time: new Date(five.eta.at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) }) : '')
    : t('tray.tooltipMsg', { msg: stateMessage(lastState) || t('tray.loading') });
  tray.setToolTip(tip);
  if (IS_MAC) { const m = trayMetricWindow(); tray.setTitle(m ? ` ${Math.round(m.pct)}%` : ''); }
  tray.setContextMenu(buildMenu());
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('i18n', () => ({ lang, dict: { ...LOCALES[FALLBACK], ...LOCALES[lang] } }));
ipcMain.handle('get-state', () => ({ state: lastState, opts: viewOpts() }));
ipcMain.on('refresh', () => refresh());
ipcMain.on('login', () => openLogin());
ipcMain.on('open-settings', () => openSettings());
ipcMain.on('open-history', () => openHistory());
ipcMain.on('open-issue', () => shell.openExternal(issueUrl(lastState)));
ipcMain.handle('history:get', () => {
  const now = Date.now();
  return {
    now,
    five: history ? history.series('f', now - 24 * 3600e3) : [],
    fiveWeek: history ? history.series('f', now - 7 * 24 * 3600e3) : [],
    week: history ? history.series('w', now - 7 * 24 * 3600e3) : [],
  };
});
ipcMain.handle('history:clear', () => { history?.clear(); return true; });
ipcMain.handle('history:export', async () => {
  if (!history) return { ok: false };
  const d = new Date();
  const name = `clausage-history-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
  const r = await dialog.showSaveDialog(historyWin || undefined, {
    title: t('h.export'),
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  // BOM so Excel opens UTF-8 correctly
  fs.writeFileSync(r.filePath, '\ufeff' + history.toCSV(), 'utf8');
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
});
ipcMain.on('hide', () => { widget?.hide(); updateTray(); });
ipcMain.on('context-menu', () => buildMenu().popup({ window: widget }));
ipcMain.on('toggle-compact', () => { config.compact = !config.compact; saveConfig(); push(lastState); updateTray(); });
ipcMain.on('resize', (_e, h) => {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const height = Math.max(60, Math.min(900, Math.ceil(h * scaleOf())));
  if (b.height !== height) widget.setBounds({ ...b, height });
});

ipcMain.handle('settings:get', async () => ({
  config,
  languages: Object.entries(LOCALES).map(([code, d]) => ({ code, name: d._name || code })),
  hasSession: !!(await getCookie('sessionKey')),
  hasClaudeCode: fs.existsSync(path.join(claudeConfigDir(), '.credentials.json')) || IS_MAC,
  hasCodeLogs: codeStats.available(),
  platform: process.platform,
  version: app.getVersion(),
  hotkeyOk,
}));
ipcMain.handle('settings:set', async (_e, patch) => {
  if ('language' in patch) { setLanguage(patch.language); delete patch.language; }
  const prevSource = config.source;
  Object.assign(config, patch);
  config.intervalSec = Math.max(30, Number(config.intervalSec) || 120);
  if ('notifyThresholds' in patch) config.notifyThresholds = thresholds();
  config.opacity = Math.max(0.3, Math.min(1, Number(config.opacity) || 1));
  widget?.setOpacity(config.opacity);
  applyTopmost();
  app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin });
  if ('trayMetric' in patch) trayIconKey = '';
  if ('autoUpdate' in patch) updater?.start(config.autoUpdate);
  if ('scale' in patch) applyScale();
  if ('showCodeStats' in patch) { lastState.code = config.showCodeStats ? codeStats.compute() : null; }
  if ('clickThrough' in patch) applyClickThrough();
  if ('hideOnFullscreen' in patch) applyFullscreenMode();
  if ('hotkey' in patch) hotkeyOk = registerHotkeys();
  saveConfig(); schedule(); updateTray();
  if ('orgId' in patch) autoOrgIds.delete(PARTITION);
  if (prevSource !== config.source || 'orgId' in patch) refresh(); else push(lastState);
  return config;
});
ipcMain.handle('settings:session-key', async (_e, key) => {
  key = String(key || '').trim();
  if (!key) return { ok: false, message: t('s.skEmpty') };
  await ses().cookies.set({
    url: CLAUDE, domain: '.claude.ai', path: '/', name: 'sessionKey', value: key,
    secure: true, httpOnly: true, sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  });
  config.source = 'web'; saveConfig();
  await refresh();
  const ok = lastState.status === 'ok';
  return { ok, message: ok ? t('s.skOk') : stateMessage(lastState) };
});
ipcMain.handle('settings:list-orgs', async () => {
  try {
    const orgs = await claudeGetJson('/api/organizations');
    return orgs.map(o => ({ uuid: o.uuid, name: o.name, plan: planOf(o) }));
  } catch (e) { return { error: e.message }; }
});
ipcMain.on('settings:login', () => openLogin());
ipcMain.handle('accounts:list', async () => Promise.all((config.accounts || []).map(async a => ({
  partition: a.partition, email: a.email || '', signedIn: !!(await getCookie('sessionKey', a.partition)),
}))));
ipcMain.on('accounts:add', () => addAccount());
ipcMain.on('accounts:login', (_e, part) => { if (accountOf(part)) openLogin(part); });
ipcMain.handle('accounts:remove', async (_e, part) => { await removeAccount(part); return true; });
ipcMain.on('settings:logout', () => logout());

// ---------------------------------------------------------------- startup
app.on('second-instance', () => { if (widget) widget.showInactive(); else createWidget(); });
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll(); fullscreen.stop();
  configSaver.flush(); history?.flush(); // don't lose a change made just before quitting
});

app.whenReady().then(async () => {
  if (IS_MAC && app.dock) app.dock.hide();
  if (process.platform === 'win32') app.setAppUserModelId('io.github.ckolpeter.clausage');
  loadConfig();
  history = new History(path.join(app.getPath('userData'), 'history.json'));
  updater = new Updater((st) => {
    updateTray();
    notify({
      title: t(st.state === 'downloaded' ? 'notify.updateReady' : 'notify.updateAvailable', { version: st.version }),
      body: t(st.state === 'downloaded' ? 'notify.updateReadyBody' : 'notify.updateAvailableBody'),
    });
  });
  lang = resolveLang(config.language);
  for (const part of [PARTITION, ...(config.accounts || []).map(a => a.partition)]) {
    ses(part).setUserAgent(IS_MAC ? CHROME_UA_MAC : CHROME_UA);
  }

  tray = new Tray(trayImage());
  tray.on('click', toggleWidget);
  updateTray();

  createWidget();
  powerMonitor.on('resume', () => setTimeout(refresh, 5000));
  schedule();
  updater.start(config.autoUpdate);
  registerHotkeys();
  applyFullscreenMode();
  nativeTheme.on('updated', () => { if (config.theme === 'system') push(lastState); });
  await refresh();
  if (lastState.status === 'auth' && config.source === 'web') openLogin();
});
