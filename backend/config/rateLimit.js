// Sliding-window limiter held in memory. Like the OTP store this is per
// process, which is fine for the single PM2 fork this app runs as.
//
//   const limiter = createLimiter({ windowMs: 600000, max: 10 });
//   const gate = limiter.check(key);     // { blocked, retryAfterSec }
//   limiter.record(key);                 // count one event against the key
//
// check() and record() are separate so a caller can decide WHAT counts: the
// results lookup records every request in one limiter but only the misses in a
// stricter one, which is what slows down someone guessing registration numbers.
function createLimiter(options) {
  const windowMs = options.windowMs;
  const max = options.max;
  const hits = new Map(); // key -> [timestamps]

  function live(key, now) {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  function check(key) {
    const now = Date.now();
    const list = live(key, now);
    if (list.length >= max) {
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
    }
    return { blocked: false, retryAfterSec: 0 };
  }

  function record(key) {
    const now = Date.now();
    const list = live(key, now);
    list.push(now);
    hits.set(key, list);
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const key of Array.from(hits.keys())) live(key, now);
  }, Math.max(windowMs, 60 * 1000));
  sweeper.unref();

  return { check, record, size: () => hits.size };
}

module.exports = { createLimiter };
