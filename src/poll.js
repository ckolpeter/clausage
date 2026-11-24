'use strict';
/**
 * When the regular poll should actually fetch (pure, unit-tested).
 * While the computer is idle or locked nobody is looking at the widget, so refresh at most every
 * AWAY_MS instead of every interval — fewer requests to an undocumented endpoint, less battery.
 * Back at the computer, the next tick (or unlock) catches up.
 */
const AWAY_AFTER_SEC = 15 * 60; // no input for this long → "away"
const AWAY_MS = 10 * 60e3;

/**
 * @param {{ now: number, lastAt: number, intervalMs: number, idleState?: string }} o
 *   lastAt: start of the last refresh from any trigger (tick, manual, reset, resume)
 *   idleState: powerMonitor.getSystemIdleState() → 'active' | 'idle' | 'locked' | 'unknown'
 */
function pollDue({ now, lastAt, intervalMs, idleState }) {
  if (!lastAt) return true;
  const away = idleState === 'idle' || idleState === 'locked';
  const every = away ? Math.max(intervalMs, AWAY_MS) : intervalMs;
  // Half an interval of slack: ticks don't line up exactly with refreshes from other triggers
  return now - lastAt >= every - intervalMs / 2;
}

module.exports = { pollDue, AWAY_AFTER_SEC, AWAY_MS };
