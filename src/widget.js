'use strict';
const $ = (id) => document.getElementById(id);
// Fixed colors per product in the weekly breakdown; unknown products cycle through FALLBACK
const PRODUCT_COLORS = { claude_code: '#d97757', chat: '#6ea8fe', cowork: '#b48ce6', other: '#8a8178' };
const FALLBACK = ['#5fc4b8', '#e8b04a', '#e58fb0', '#9fb36b'];

let state = { status: 'loading' };
let opts = { compact: false, showBreakdown: true };
let LANG = 'en';
let DICT = {};

function t(key, vars = {}) {
  const s = DICT[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}
function labelOf(w) {
  if (w.label) return w.label;
  if (w.labelKey) return t(w.labelKey, w.labelVars || {});
  return String(w.key || '').replace(/_/g, ' ');
}
function productName(r) {
  const k = `product.${r.key}`;
  return DICT[k] ?? r.name;
}
function msgOf(s) { return s.msgKey ? t(s.msgKey, s.msgVars) : (s.message || ''); }

function color(p) {
  if (p >= 90) return 'var(--bad)';
  if (p >= 70) return 'var(--warn)';
  return 'var(--ok)';
}

function fmtLeft(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return '';
  if (ms <= 0) return t('w.soon');
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const left = d ? t('w.dur.dh', { d, h }) : h ? t('w.dur.hm', { h, m: mm }) : t('w.dur.m', { m: mm });
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  const when = at.toLocaleString(LANG, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return t('w.resetIn', { left, when });
}

function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? t('w.dur.dh', { d, h }) : h ? t('w.dur.hm', { h, m: mm }) : t('w.dur.m', { m: mm });
}

/** Run-out prediction line under a usage bar */
function etaHtml(w) {
  const e = w.eta;
  if (!e) return '';
  if (e.exhausted) return `<div class="eta bad">${esc(t('w.exhausted'))}</div>`;
  if (e.beforeReset && e.at) {
    const left = e.at - Date.now();
    if (left <= 0) return `<div class="eta bad">${esc(t('w.exhausted'))}</div>`;
    return `<div class="eta warn" title="${esc(t(e.basis === 'recent' ? 'w.etaRecent' : 'w.etaAverage'))}">${esc(t('w.etaRunOut', { left: fmtDur(left) }))}</div>`;
  }
  return `<div class="eta ok" title="${esc(t(e.basis === 'recent' ? 'w.etaRecent' : 'w.etaAverage'))}">${esc(t('w.etaSafe'))}</div>`;
}

function fmtMoney(v, currency) {
  if (v == null) return '–';
  try { return new Intl.NumberFormat(LANG, { style: 'currency', currency: currency || 'USD' }).format(v); }
  catch { return `${v.toFixed(2)} ${currency || ''}`; }
}

/** Extra usage (pay-as-you-go) spending this month */
function spendHtml(sp) {
  const amount = sp.limit != null
    ? `${fmtMoney(sp.used, sp.currency)} / ${fmtMoney(sp.limit, sp.currency)}`
    : `${fmtMoney(sp.used, sp.currency)} · ${t('w.noCap')}`;
  const bar = sp.pct != null
    ? `<div class="bar"><div class="fill" style="width:${sp.pct}%;background:${color(sp.pct)}"></div></div>` : '';
  return `<div class="row secondary">
    <div class="line"><span class="label">${esc(t('label.extra'))}</span><span class="pct money">${esc(amount)}</span></div>
    ${bar}
  </div>`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function rowHtml(w) {
  const p = Math.round(w.pct);
  let pace = '';
  const dur = w.durationMs;
  if (dur && w.resetsAt) {
    const elapsed = 1 - (new Date(w.resetsAt).getTime() - Date.now()) / dur;
    if (elapsed > 0 && elapsed < 1) {
      pace = `<div class="pace" style="left:${(elapsed * 100).toFixed(1)}%" title="${esc(t('w.pace', { pct: Math.round(elapsed * 100) }))}"></div>`;
    }
  }
  return `<div class="row ${w.primary ? '' : 'secondary'}">
    <div class="line"><span class="label">${esc(labelOf(w))}</span><span class="pct">${p}%</span></div>
    <div class="bar"><div class="fill" style="width:${w.pct}%;background:${color(w.pct)}"></div>${pace}</div>
    <div class="reset">${esc(fmtLeft(w.resetsAt))}</div>
    ${etaHtml(w)}
  </div>`;
}

function breakdownHtml(bd) {
  const rows = bd.rows.filter(r => r.share > 0 || r.ofLimit > 0);
  if (!rows.length) return '';
  let fb = 0;
  const colored = rows.map(r => ({ ...r, color: PRODUCT_COLORS[r.key] || FALLBACK[fb++ % FALLBACK.length] }));
  const segs = colored.map(r =>
    `<div class="seg" style="width:${r.share}%;background:${r.color}" title="${esc(productName(r))} ${Math.round(r.share)}%"></div>`).join('');
  const legend = colored.map(r => `<div class="lg" title="${esc(t('b.ofLimit', { pct: Math.round(r.ofLimit) }))}">
      <span class="dot" style="background:${r.color}"></span>
      <span class="lgname">${esc(productName(r))}</span>
      <span class="lgpct">${Math.round(r.share)}%</span>
    </div>`).join('');
  return `<div class="bd">
    <div class="bdtitle">${esc(t('b.title'))}</div>
    <div class="stack">${segs}</div>
    <div class="legend">${legend}</div>
  </div>`;
}

/** Extra accounts: compact block per account with its 5-hour and weekly bars */
function othersHtml(others) {
  return others.map((o, i) => {
    const name = o.email || t('a.unnamed', { n: i + 2 });
    let body;
    if (o.status === 'ok') {
      body = o.windows.map(w => {
        const p = Math.round(w.pct);
        return `<div class="mrow"><span class="mlabel">${esc(labelOf(w))}</span>
          <div class="bar mbar"><div class="fill" style="width:${w.pct}%;background:${color(w.pct)}"></div></div>
          <span class="mpct">${p}%</span></div>`;
      }).join('');
    } else if (o.status === 'auth') {
      body = `<div class="mmsg">${esc(msgOf(o))} <a href="#" class="mlogin" data-part="${esc(o.partition)}">${esc(t('w.loginBtn'))}</a></div>`;
    } else {
      body = `<div class="mmsg">${esc(msgOf(o))}</div>`;
    }
    return `<div class="acct"><div class="aname">${esc(name)}${o.plan ? ` <span class="aplan">${esc(o.plan)}</span>` : ''}</div>${body}</div>`;
  }).join('');
}

function fmtTokens(n) {
  try { return new Intl.NumberFormat(LANG, { notation: 'compact', maximumSignificantDigits: 3 }).format(n); }
  catch { return String(n); }
}

/** Claude Code tokens per model: today and last 7 days */
function codeHtml(code) {
  const today = new Map(code.today.map(r => [r.model, r]));
  const rows = code.week.slice(0, 5).map(r => {
    const td = today.get(r.model);
    const tip = t('c.tip', {
      input: fmtTokens(r.tokens.input), output: fmtTokens(r.tokens.output),
      cacheWrite: fmtTokens(r.tokens.cacheWrite), cacheRead: fmtTokens(r.tokens.cacheRead),
    });
    return `<div class="crow" title="${esc(tip)}"><span class="cname">${esc(r.name)}</span>
      <span class="cnum">${td ? esc(fmtTokens(td.total)) : '–'}</span>
      <span class="cnum muted">${esc(fmtTokens(r.total))}</span></div>`;
  }).join('');
  return `<div class="bd">
    <div class="crow chead"><span class="cname">${esc(t('c.title'))}</span><span class="cnum">${esc(t('c.today'))}</span><span class="cnum">${esc(t('c.week'))}</span></div>
    ${rows}
  </div>`;
}

function render() {
  const card = $('card');
  document.body.classList.toggle('light', opts.theme === 'light');
  document.body.classList.toggle('ghost', !!opts.clickThrough);
  card.classList.toggle('compact', !!opts.compact);
  $('btnRefresh').innerHTML = state.refreshing ? '<span class="spin">⟳</span>' : '⟳';
  $('footErr').textContent = '';

  let data = state.status === 'ok' ? state : (state.status === 'error' ? state.prev : null);
  if (state.refreshing && !data && state.windows) data = state;

  if (data && data.windows) {
    $('plan').textContent = [data.plan, data.orgName && data.orgName.length < 18 ? data.orgName : ''].filter(Boolean).join(' · ');
    let ws = data.windows;
    if (opts.compact) ws = ws.filter(w => w.primary);
    let html = ws.map(rowHtml).join('');
    if (state.others && state.others.length && state.email) html = `<div class="aname">${esc(state.email)}</div>` + html;
    if (!opts.compact && data.spend) html += spendHtml(data.spend);
    if (!opts.compact && opts.showBreakdown && data.breakdown) html += breakdownHtml(data.breakdown);
    if (!opts.compact && opts.showCodeStats && state.code) html += codeHtml(state.code);
    // claude.ai changed the response format in a way that may make these numbers wrong
    if (data.formatIssues) {
      html = `<div class="fwarn" title="${esc(data.formatIssues.join(', '))}">⚠ ${esc(t('w.formatChanged'))} `
        + `<a id="lnkReport">${esc(t('w.report'))}</a></div>` + html;
    }
    $('content').innerHTML = html;
    $('lnkReport')?.addEventListener('click', () => window.api.openIssue());
    $('updated').textContent = data.fetchedAt
      ? t('w.updatedAt', { time: new Date(data.fetchedAt).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' }) })
      : '';
    if (state.status === 'error') {
      const left = state.retryAt ? Math.max(1, Math.round((state.retryAt - Date.now()) / 1000)) : null;
      $('footErr').textContent = state.msgKey === 'err.offline' ? t('w.offline')
        : left ? t('w.retrying', { s: left }) : t('w.updateFailed');
    }
    $('footErr').title = msgOf(state);
  } else if (state.status === 'auth') {
    $('plan').textContent = '';
    const isWeb = state.source !== 'code';
    $('content').innerHTML = `<div class="msg"><b>${esc(t('w.needLogin'))}</b><br>${esc(msgOf(state))}</div>
      ${isWeb
        ? `<button class="action" id="btnLogin">${esc(t('w.loginBtn'))}</button>`
        : `<button class="action" id="btnOpenSet">${esc(t('w.openSettings'))}</button>`}`;
    $('updated').textContent = '';
    $('btnLogin')?.addEventListener('click', () => window.api.login());
    $('btnOpenSet')?.addEventListener('click', () => window.api.openSettings());
  } else if (state.status === 'error') {
    $('content').innerHTML = `<div class="msg"><b>${esc(t('w.cantFetch'))}</b><br>${esc(msgOf(state))}</div>`
      + (state.reportable ? `<button class="action" id="btnReport">${esc(t('w.report'))}</button>` : '');
    $('btnReport')?.addEventListener('click', () => window.api.openIssue());
  } else {
    $('content').innerHTML = `<div class="msg">${esc(t('w.loading'))}</div>`;
  }
  if (state.others && state.others.length) {
    $('content').insertAdjacentHTML('beforeend', othersHtml(state.others));
    $('content').querySelectorAll('.mlogin').forEach(a => a.addEventListener('click', (e) => {
      e.preventDefault(); window.api.accounts.login(a.dataset.part);
    }));
  }
  requestAnimationFrame(() => window.api.resize(document.body.scrollHeight));
}

function applyStaticI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

$('btnRefresh').addEventListener('click', () => window.api.refresh());
$('btnSettings').addEventListener('click', () => window.api.openSettings());
$('btnHistory').addEventListener('click', () => window.api.openHistory());
$('btnHide').addEventListener('click', () => window.api.hide());
document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.api.contextMenu(); });
$('content').addEventListener('dblclick', () => window.api.toggleCompact());

(async () => {
  ({ lang: LANG, dict: DICT } = await window.api.i18n());
  applyStaticI18n();
  window.api.onUsage((s, o) => { state = s; opts = o || opts; render(); });
  const { state: s, opts: o } = await window.api.getState();
  state = s; opts = o; render();
  setInterval(render, 30000); // countdown + pace marker
})();
