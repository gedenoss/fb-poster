'use strict';
const { sleep, randInt } = require('./human');

async function retry(fn, opts = {}) {
  const tries = opts.tries ?? 3;
  const base  = opts.baseMs ?? 1500;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (opts.onError) opts.onError(err, attempt);
      if (attempt === tries) break;
      await sleep(base * 2 ** (attempt - 1) + randInt(0, 500));
    }
  }
  throw lastErr;
}

module.exports = { retry };
