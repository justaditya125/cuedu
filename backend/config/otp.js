const crypto = require('crypto');

const OTP_LENGTH = 6;
const HOUR_MS = 60 * 60 * 1000;

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS) || 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = Number(process.env.OTP_RESEND_COOLDOWN_MS) || 60 * 1000;
const MAX_VERIFY_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const MAX_SENDS_PER_HOUR = Number(process.env.OTP_MAX_SENDS_PER_HOUR) || 5;
const TOKEN_TTL_MS = Number(process.env.OTP_TOKEN_TTL_MS) || 30 * 60 * 1000;

// Proof-of-verification is an HMAC-signed token rather than server state, so a
// restart between "verified" and "submitted" does not strand the applicant.
// Without OTP_TOKEN_SECRET the key is random per boot, which is safe but
// invalidates outstanding tokens on every restart.
const TOKEN_SECRET = process.env.OTP_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_SECRET_IS_EPHEMERAL = !process.env.OTP_TOKEN_SECRET;

// channel:value -> { salt, hash, expiresAt, attempts, lastSentAt, sends[] }
// In-memory by design: this app has no datastore, and the process runs as a
// single PM2 fork. Moving to cluster mode would need shared storage.
const pending = new Map();

function keyFor(channel, value) {
  return channel + ':' + value;
}

function hashOtp(otp, salt) {
  return crypto.createHmac('sha256', salt).update(String(otp)).digest('hex');
}

function generateOtp() {
  // randomInt avoids the modulo bias a naive random()*1e6 would introduce.
  return String(crypto.randomInt(0, 1000000)).padStart(OTP_LENGTH, '0');
}

function equalConstantTime(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Throttles both a per-send cooldown and an hourly cap, per destination, so a
// single number or address cannot be used to run up SMS cost or spam someone.
function canSend(channel, value) {
  const rec = pending.get(keyFor(channel, value));
  const now = Date.now();
  if (!rec) return { ok: true };

  const recent = (rec.sends || []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= MAX_SENDS_PER_HOUR) {
    return {
      ok: false,
      reason: 'hourly_limit',
      retryAfterSec: Math.ceil((recent[0] + HOUR_MS - now) / 1000)
    };
  }
  if (rec.lastSentAt && now - rec.lastSentAt < RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - (now - rec.lastSentAt)) / 1000)
    };
  }
  return { ok: true };
}

function issue(channel, value) {
  const key = keyFor(channel, value);
  const now = Date.now();
  const prev = pending.get(key) || {};
  const otp = generateOtp();
  const salt = crypto.randomBytes(16).toString('hex');

  const sends = (prev.sends || []).filter((t) => now - t < HOUR_MS);
  sends.push(now);

  // Only the hash is retained - the plaintext exists just long enough to send.
  pending.set(key, {
    salt: salt,
    hash: hashOtp(otp, salt),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
    sends: sends
  });

  return otp;
}

function verify(channel, value, otp) {
  const key = keyFor(channel, value);
  const rec = pending.get(key);

  if (!rec || !rec.hash) return { ok: false, reason: 'not_requested' };
  if (Date.now() > rec.expiresAt) {
    rec.hash = null;
    return { ok: false, reason: 'expired' };
  }
  if (rec.attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  rec.attempts += 1;
  if (!equalConstantTime(rec.hash, hashOtp(otp, rec.salt))) {
    return {
      ok: false,
      reason: 'mismatch',
      attemptsLeft: Math.max(0, MAX_VERIFY_ATTEMPTS - rec.attempts)
    };
  }

  // Single use: burn the code but keep the send history for rate limiting.
  rec.hash = null;
  return { ok: true, token: signToken(channel, value) };
}

function signToken(channel, value) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET)
    .update(channel + ':' + value + ':' + exp)
    .digest('hex');
  return exp + '.' + sig;
}

function verifyToken(channel, value, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;

  const exp = Number(parts[0]);
  if (!exp || Date.now() > exp) return false;

  const expected = crypto.createHmac('sha256', TOKEN_SECRET)
    .update(channel + ':' + value + ':' + exp)
    .digest('hex');
  return equalConstantTime(expected, parts[1]);
}

// Drop records once both the code and the rate-limit window have lapsed.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of pending) {
    const rateWindowActive = (rec.sends || []).some((t) => now - t < HOUR_MS);
    if (now > rec.expiresAt && !rateWindowActive) pending.delete(key);
  }
}, 5 * 60 * 1000);
sweeper.unref();

module.exports = {
  canSend,
  issue,
  verify,
  verifyToken,
  TOKEN_SECRET_IS_EPHEMERAL,
  OTP_TTL_MS,
  RESEND_COOLDOWN_MS,
  pendingCount: () => pending.size
};
