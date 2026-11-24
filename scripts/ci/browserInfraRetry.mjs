/**
 * Classifies a Vitest failure as the recurring headless Chromium socket drop.
 * A retry is allowed only when the browser connection closed and no test assertion failed.
 */
export function isBrowserConnectionDrop(log, exitCode) {
  if (exitCode === 0) return false;
  if (!log.includes("VITEST_BROWSER_CONNECTION_CLOSED")) return false;
  if (/\b\d+ failed\b/.test(log)) return false;
  if (log.includes("FAIL  ")) return false;
  return /Tests\s+\d+ passed/.test(log);
}
