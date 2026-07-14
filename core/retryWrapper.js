'use strict';

/**
 * retryWrapper — exponential-backoff retry for provider calls.
 *
 * Pattern 3 defense: a single network blip never surfaces as total failure.
 * One retry with 500ms → 1000ms backoff is enough for transient timeouts.
 *
 * @param {function}  fn           async function to call
 * @param {object}    options
 * @param {number}    options.maxRetries   default 2
 * @param {number}    options.baseDelay    ms, default 500
 * @param {function}  options.onRetry      (attempt, err) callback for logging
 * @returns {Promise<any>}
 */
async function withRetry(fn, options = {}) {
  const {
    maxRetries = 2,
    baseDelay  = 500,
    onRetry    = () => {},
  } = options;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);  // 500, 1000, 2000…
        onRetry(attempt + 1, err);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

module.exports = { withRetry };
