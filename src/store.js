'use strict';
/**
 * Crash-safe file writes (main process, no Electron imports).
 *
 * writeFileAtomic writes to "<file>.tmp" and then renames it over the target, so a crash or
 * power loss mid-write leaves either the old file or the new one, never a half-written file
 * that would make config.json / history.json unreadable on the next start.
 *
 * Debounced wraps a save function: schedule() coalesces bursts, flush() runs a pending save now
 * (used on quit so the last change is not lost).
 */
const fs = require('fs');

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows: the target can be briefly locked (antivirus, indexer). Fall back to a direct write.
    try { fs.writeFileSync(file, data); } finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
  }
}

class Debounced {
  constructor(fn, ms) { this.fn = fn; this.ms = ms; this.timer = null; }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.ms);
  }
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.fn();
  }
}

module.exports = { writeFileAtomic, Debounced };
