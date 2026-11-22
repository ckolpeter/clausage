'use strict';
/**
 * Claude Code local token stats (main process).
 *
 * Claude Code writes one JSONL file per session under <config>/projects/<project>/<session>.jsonl.
 * Each assistant entry carries message.model and message.usage
 * ({ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }).
 * We sum those per model for "today" and "last 7 days". Everything stays on this computer.
 *
 * Files are cached by (size, mtime); when a file grows, only the appended bytes are read.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DAY = 24 * 3600e3;
const WINDOW_MS = 7 * DAY;

function configDirs() {
  // Like Claude Code itself: CLAUDE_CONFIG_DIR (comma-separated) replaces the default locations.
  const dirs = (process.env.CLAUDE_CONFIG_DIR || '').split(',').map(d => d.trim()).filter(Boolean);
  if (!dirs.length) dirs.push(path.join(os.homedir(), '.config', 'claude'), path.join(os.homedir(), '.claude'));
  return [...new Set(dirs)].map(d => path.join(d, 'projects')).filter(d => fs.existsSync(d));
}

/** "claude-opus-4-5-20251101" → "Opus 4.5", "claude-sonnet-4-20250514" → "Sonnet 4" */
function prettyModel(id) {
  const m = String(id).match(/claude-(?:(\d+(?:-\d)?)-)?([a-z]+)(?:-(\d{1,2})(?!\d))?(?:-(\d{1,2})(?!\d))?/i);
  if (!m) return String(id);
  const family = m[2][0].toUpperCase() + m[2].slice(1);
  // Old ids put the version first: claude-3-5-sonnet
  const ver = m[1] ? m[1].replace('-', '.') : [m[3], m[4]].filter(Boolean).join('.');
  return ver ? `${family} ${ver}` : family;
}

class CodeStats {
  constructor() {
    this.cache = new Map(); // file → { size, mtimeMs, offset, entries: [{ t, id, model, tokens }] }
  }

  available() { return configDirs().length > 0; }

  /** List .jsonl files touched within the window */
  listFiles(since) {
    const out = [];
    for (const root of configDirs()) {
      let projects = [];
      try { projects = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
      for (const p of projects) {
        const dir = path.join(root, p.name);
        let files = [];
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
        for (const f of files) {
          const file = path.join(dir, f);
          try {
            const st = fs.statSync(file);
            if (st.mtimeMs >= since) out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
          } catch { /* vanished */ }
        }
      }
    }
    return out;
  }

  /**
   * Parse complete lines from byte `from` to `size`. Returns { entries, offset }, where offset is just past
   * the last newline read, so a line still being written is picked up next time.
   */
  parseFile(file, from = 0, size = Infinity) {
    const entries = [];
    let buf;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.max(0, Math.min(size, fs.fstatSync(fd).size) - from);
        buf = Buffer.alloc(len);
        let got = 0;
        while (got < len) {
          const n = fs.readSync(fd, buf, got, len - got, from + got);
          if (!n) break;
          got += n;
        }
        buf = buf.subarray(0, got);
      } finally { fs.closeSync(fd); }
    } catch { return { entries, offset: from }; }
    const end = buf.lastIndexOf(0x0a) + 1; // cut on a byte boundary: '\n' never occurs inside a UTF-8 sequence
    const text = buf.toString('utf8', 0, end);
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"usage"') < 0) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const msg = j.message;
      const u = msg?.usage;
      if (!u || !msg.model || msg.model === '<synthetic>') continue;
      const t = Date.parse(j.timestamp);
      if (!Number.isFinite(t)) continue;
      const tokens = {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      };
      // The same response can be logged more than once (streaming / resumed sessions)
      const id = msg.id && j.requestId ? `${msg.id}:${j.requestId}` : msg.id || null;
      entries.push({ t, id, model: msg.model, tokens });
    }
    return { entries, offset: from + end };
  }

  /**
   * Returns { today: [{ model, name, tokens:{...}, total }], week: [...], updatedAt } or null if no data.
   * "today" starts at local midnight.
   */
  compute(now = Date.now()) {
    if (!this.available()) return null;
    const since = now - WINDOW_MS;
    const files = this.listFiles(since);
    const live = new Set();
    for (const f of files) {
      live.add(f.file);
      const c = this.cache.get(f.file);
      if (c && c.size === f.size && c.mtimeMs === f.mtimeMs) continue;
      if (c && f.size > c.size) {
        // Claude Code only appends: read just the new bytes
        const r = this.parseFile(f.file, c.offset, f.size);
        for (const e of r.entries) c.entries.push(e);
        Object.assign(c, { size: f.size, mtimeMs: f.mtimeMs, offset: r.offset });
      } else {
        // New, shrunk or rewritten file: read it all
        const r = this.parseFile(f.file, 0, f.size);
        this.cache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, offset: r.offset, entries: r.entries });
      }
    }
    for (const k of this.cache.keys()) if (!live.has(k)) this.cache.delete(k);

    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const seen = new Set();
    const today = new Map(), week = new Map();
    const bump = (map, e) => {
      const cur = map.get(e.model) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      for (const k of Object.keys(cur)) cur[k] += e.tokens[k];
      map.set(e.model, cur);
    };
    for (const { entries } of this.cache.values()) {
      for (const e of entries) {
        if (e.t < since || e.t > now + 60e3) continue;
        if (e.id) { if (seen.has(e.id)) continue; seen.add(e.id); }
        bump(week, e);
        if (e.t >= midnight.getTime()) bump(today, e);
      }
    }
    const rows = (map) => [...map.entries()]
      .map(([model, tokens]) => ({ model, name: prettyModel(model), tokens, total: tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead }))
      .sort((a, b) => b.total - a.total);
    if (!week.size) return null;
    return { today: rows(today), week: rows(week), updatedAt: now };
  }
}

module.exports = { CodeStats, prettyModel };
