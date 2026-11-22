'use strict';
/**
 * Give up on a request that hangs. Without this, one stuck request (half-open connection after
 * sleep, a challenge page that never answers) would block every later refresh, since overlapping
 * refreshes share one in-flight request.
 *
 * fn receives an AbortSignal to cancel the underlying request. On timeout the promise rejects with
 * a TypeError ("fetch failed: timed out"), which the caller treats as a network error and retries.
 */
function withTimeout(fn, ms) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new TypeError(`fetch failed: timed out after ${Math.round(ms / 1000)}s`));
      ac.abort();
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => fn(ac.signal)), timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
