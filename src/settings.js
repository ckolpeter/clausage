'use strict';
const $ = (id) => document.getElementById(id);
const S = window.api.settings;
let DICT = {};
const t = (k, v = {}) => (DICT[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? `{${x}}`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function applyI18n() {
  const { lang, dict } = await window.api.i18n();
  DICT = dict;
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  // Only our own locale files feed innerHTML (for <b> tags); never user/remote data
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.body.classList.add('ready');
}

async function load() {
  const info = await S.get();
  const c = info.config;

  const langSel = $('language');
  langSel.innerHTML = `<option value="auto">${esc(t('menu.langAuto'))}</option>`
    + info.languages.map(l => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
  langSel.value = c.language || 'auto';

  document.querySelectorAll('input[name=source]').forEach(r => { r.checked = r.value === c.source; });
  $('interval').value = c.intervalSec;
  $('opacity').value = c.opacity;
  $('trayMetric').value = c.trayMetric || 'five_hour';
  $('theme').value = c.theme || 'dark';
  $('thresholds').value = (c.notifyThresholds || [80, 95]).join(', ');
  $('quietStart').value = c.quietStart || '23:00';
  $('quietEnd').value = c.quietEnd || '08:00';
  $('codeHint').textContent = info.hasCodeLogs ? '' : t('s.codeMissing');
  $('scale').value = c.scale || 1;
  $('scaleVal').textContent = Math.round((c.scale || 1) * 100) + '%';
  $('hotkey').value = c.hotkey || '';
  $('hotkeyHint').innerHTML = c.hotkey && !info.hotkeyOk
    ? `<span class="bad">${esc(t('s.hotkeyFail'))}</span>` : esc(t('s.hotkeyHint'));
  for (const k of ['alwaysOnTop', 'compact', 'showBreakdown', 'notify', 'notifyReset', 'openAtLogin', 'autoUpdate', 'clickThrough', 'showCodeStats', 'quietEnabled', 'hideOnFullscreen', 'snapEdges']) $(k).checked = !!c[k];
  $('sessStatus').innerHTML = info.hasSession
    ? `<span class="ok">${esc(t('s.loggedIn'))}</span>` : `<span class="bad">${esc(t('s.loggedOut'))}</span>`;
  $('srcHint').textContent = c.source === 'code'
    ? t(info.hasClaudeCode ? 's.hintCode' : 's.hintCodeMissing')
    : t('s.hintWeb');
  $('webBox').style.display = c.source === 'web' ? '' : 'none';
  $('foot').textContent = `Clausage v${info.version} · ${info.platform}`;
  if (info.hasSession && c.source === 'web') loadOrgs(c.orgId);
  loadAccounts();
}

async function loadAccounts() {
  const list = await window.api.accounts.list();
  const box = $('acctList');
  box.textContent = '';
  list.forEach((a, i) => {
    const row = document.createElement('div'); row.className = 'acctRow';
    const nm = document.createElement('span'); nm.className = 'nm';
    nm.textContent = (a.email || t('a.unnamed', { n: i + 2 })) + ' · ' + t(a.signedIn ? 'a.signedIn' : 'a.signedOut');
    const login = document.createElement('button'); login.textContent = t('s.login');
    login.addEventListener('click', () => window.api.accounts.login(a.partition));
    const rm = document.createElement('button'); rm.textContent = t('a.remove');
    rm.addEventListener('click', async () => { await window.api.accounts.remove(a.partition); loadAccounts(); });
    row.append(nm, login, rm);
    box.appendChild(row);
  });
}

async function loadOrgs(current) {
  const orgs = await S.listOrgs();
  const sel = $('org');
  sel.length = 1;
  if (!Array.isArray(orgs)) return;
  for (const o of orgs) {
    const opt = document.createElement('option');
    opt.value = o.uuid; opt.textContent = `${o.name}${o.plan ? ' (' + o.plan + ')' : ''}`;
    if (o.uuid === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

const set = (patch) => S.set(patch);

$('language').addEventListener('change', e => set({ language: e.target.value })); // main reloads this window
document.querySelectorAll('input[name=source]').forEach(r =>
  r.addEventListener('change', async () => { await set({ source: r.value }); load(); }));
$('interval').addEventListener('change', e => set({ intervalSec: Number(e.target.value) }));
$('opacity').addEventListener('input', e => set({ opacity: Number(e.target.value) }));
for (const k of ['alwaysOnTop', 'compact', 'showBreakdown', 'notify', 'notifyReset', 'openAtLogin', 'autoUpdate', 'clickThrough', 'showCodeStats', 'quietEnabled', 'hideOnFullscreen', 'snapEdges']) {
  $(k).addEventListener('change', e => set({ [k]: e.target.checked }));
}
$('thresholds').addEventListener('change', async e => {
  const list = e.target.value.split(/[,，\s]+/).map(Number).filter(n => n >= 1 && n <= 100);
  const c = await set({ notifyThresholds: list });
  e.target.value = c.notifyThresholds.join(', ');
});
$('quietStart').addEventListener('change', e => set({ quietStart: e.target.value }));
$('quietEnd').addEventListener('change', e => set({ quietEnd: e.target.value }));
$('theme').addEventListener('change', e => set({ theme: e.target.value }));
$('scale').addEventListener('input', e => { $('scaleVal').textContent = Math.round(e.target.value * 100) + '%'; });
$('scale').addEventListener('change', e => set({ scale: Number(e.target.value) }));
$('hotkey').addEventListener('change', async e => { await set({ hotkey: e.target.value.trim() }); load(); });
$('acctAdd').addEventListener('click', () => window.api.accounts.add());
$('trayMetric').addEventListener('change', e => set({ trayMetric: e.target.value }));
$('org').addEventListener('change', e => set({ orgId: e.target.value || null }));
$('login').addEventListener('click', () => S.login());
$('logout').addEventListener('click', () => { S.logout(); setTimeout(load, 500); });
$('skSave').addEventListener('click', async () => {
  $('skStatus').textContent = t('s.skChecking');
  const r = await S.setSessionKey($('sk').value);
  $('skStatus').innerHTML = `<span class="${r.ok ? 'ok' : 'bad'}">${esc(r.message)}</span>`;
  if (r.ok) { $('sk').value = ''; load(); }
});
window.addEventListener('focus', load);

applyI18n().then(load);
