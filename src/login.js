'use strict';
/**
 * Sign-in window helpers (pure, unit-tested).
 * Google refuses to sign in inside embedded browsers such as Electron windows: it shows
 * "JavaScript is disabled" or "This browser or app may not be secure". We spot the hand-off to
 * Google's sign-in page and explain the email sign-in instead of letting the user hit that page.
 */
function isGoogleSignIn(url) {
  try {
    const u = new URL(url);
    // /gsi/ is the One Tap / button script and iframe inside claude.ai's own page — leave those alone
    return u.protocol === 'https:' && u.hostname === 'accounts.google.com' && !u.pathname.startsWith('/gsi/');
  } catch { return false; }
}

module.exports = { isGoogleSignIn };
