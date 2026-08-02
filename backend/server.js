const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { body, validationResult } = require('express-validator');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const logger = require('./config/logger');
const mailer = require('./config/mailer');

const app = express();
const PORT = process.env.PORT || 8000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://cuedu.cutm.ac.in').split(',');

app.use(helmet());
app.use(compression());

app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

// Keep the raw body: Razorpay's signature is an HMAC over the exact bytes sent,
// so it cannot be recomputed from the re-serialised JSON.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, '../frontend/public'), { dotfiles: 'ignore' }));
app.use('/assets', express.static(path.join(__dirname, '../frontend/assets')));
app.use('/programme-detail', express.static(path.join(__dirname, '../frontend/programme-detail')));

async function postToCRM(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(process.env.CRM_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      signal: controller.signal,
      body: new URLSearchParams(payload).toString()
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// Pushes a completed payment to the CRM. The student is identified by mobile
// number, email address, or both - at least one is required by the CRM.
async function postPaymentToCRM({ mobile, email, paymentId, status, amount }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = process.env.CRM_PAYMENT_STATUS_URL || 'https://crm.cutmap.ac.in/api/public/payments/cuedu/status';
    const apiKey = process.env.CRM_PAYMENT_API_KEY || '7b9f2356c3755131e68b230a32cf9957ce2890781c102173a749298d4b848f55';

    const parsedAmount = typeof amount === 'number' ? amount : (parseFloat(amount) || 0);
    const statusStr = String(status || 'Paid');
    const formattedStatus = (statusStr.toLowerCase() === 'paid' || statusStr.toLowerCase() === 'success') ? 'Paid' : statusStr;

    const payload = {
      paymentId: String(paymentId || ''),
      status: formattedStatus,
      amount: parsedAmount
    };
    const normalizedMobile = normalizeMobile(mobile);
    if (normalizedMobile) payload.mobile = normalizedMobile;
    const normalizedEmail = normalizeEmail(email);
    if (normalizedEmail) payload.email = normalizedEmail;

    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      signal: controller.signal,
      body: JSON.stringify(payload)
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Each attempt gets its own timeout budget. Sharing one AbortController across
// the retry loop meant a slow first URL left no time for the second, surfacing
// as "This operation was aborted".
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function lookupInCRM(query) {
  const headers = {
    'X-API-Key': process.env.CRM_API_KEY || '',
    'Accept': 'application/json'
  };
  const params = new URLSearchParams();
  Object.keys(query).forEach((k) => {
    if (query[k]) params.set(k, query[k]);
  });

  const baseUrls = [
    process.env.CRM_LOOKUP_URL || 'https://crm.cutmap.ac.in/api/public/inquiry/cuedu/lookup',
    'https://crm.cutmap.ac.in/api/inquiry/cuedu/lookup'
  ];
  const perAttemptMs = Number(process.env.CRM_LOOKUP_TIMEOUT_MS) || 10000;

  let lastError = null;
  for (const base of baseUrls) {
    const url = new URL(base);
    url.search = params.toString();
    try {
      const resp = await fetchWithTimeout(url.toString(), { headers }, perAttemptMs);
      const contentType = resp.headers.get('content-type') || '';
      // An HTML body means the request fell through to the CRM's SPA, i.e. the
      // route does not exist - try the next base URL.
      if (!contentType.includes('text/html')) {
        return resp;
      }
      logger.warn('CRM lookup returned HTML, trying next base URL', { base });
    } catch (err) {
      lastError = err;
      logger.warn('CRM lookup attempt failed', {
        base,
        error: err.name === 'AbortError' ? `timed out after ${perAttemptMs}ms` : err.message
      });
    }
  }

  if (lastError) throw lastError;
  return new Response('', { status: 204 });
}

// The CRM payment API rejects a payload without a mobile number ("mobile,
// paymentId, and status are required"), even though it accepts email as an
// extra field. When a student is identified only by email - which is what the
// payment gateway usually hands back - resolve their mobile from the lead
// lookup first.
async function resolveMobileFromEmail(email) {
  try {
    const resp = await lookupInCRM({ email });
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok || !contentType.includes('json')) return '';
    const data = await resp.json();
    const lead = data.lead || data.data || data.inquiry || data;
    if (!lead) return '';
    return normalizeMobile(lead.mobile || lead.phone || lead.mobile_number || lead.contact);
  } catch (err) {
    logger.warn('Mobile lookup by email failed', { error: err.message, email });
    return '';
  }
}

function sendConfirmationEmail({ name, email, course, leadId, phone }) {
  const subject = 'Registration Confirmation - Centurion University';
  const text =
    `Dear ${name},\n\n` +
    `You have successfully registered for ${course}.\n\n` +
    `Your Registration ID: ${leadId}\n\n` +
    `Thank you for registering with Centurion University. Our admissions team will contact you within 24 hours.\n\n` +
    `Warm regards,\nCenturion University Online`;

  mailer.sendMail({ to: email, subject, text })
    .then(() => logger.info('Confirmation email sent', { email, leadId, via: mailer.getMailerVia() }))
    .catch((err) => logger.error('Confirmation email failed', { error: err.message, email }));

  if (mailer.ADMIN_EMAIL.length) {
    const adminSubject = `New Registration - ${course} - ${name}`;
    const adminText =
      `New student registration received:\n\n` +
      `Name: ${name}\n` +
      `Email: ${email}\n` +
      `Phone: ${phone}\n` +
      `Course: ${course}\n` +
      `Registration ID: ${leadId}\n`;

    mailer.sendMail({ to: mailer.ADMIN_EMAIL.join(', '), subject: adminSubject, text: adminText })
      .then(() => logger.info('Admin notification sent', { leadId }))
      .catch((err) => logger.error('Admin notification failed', { error: err.message, leadId }));
  }
}

app.post('/api/register',
  [
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
    // Lower-cased and trimmed only. normalizeEmail() would strip dots and
    // +tags from Gmail addresses, storing an address the student never typed
    // and breaking the payment page's lookup-by-email.
    body('email').trim().isEmail().withMessage('Valid email required').customSanitizer(normalizeEmail),
    // Accept what people actually type - "+91 98765 43210", "09876543210" -
    // and reduce it to the last 10 digits before validating.
    body('phone').customSanitizer(normalizeMobile).matches(/^\d{10}$/).withMessage('Valid 10-digit phone number required'),
    body('qualification').trim().isLength({ min: 2, max: 100 }).withMessage('Qualification required'),
    body('course').trim().isLength({ min: 2, max: 100 }).withMessage('Course required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Registration validation failed', { errors: errors.array() });
      // Surface the specific problem - the form shows this message verbatim.
      const firstError = errors.array()[0];
      return res.status(400).json({
        success: false,
        message: (firstError && firstError.msg) || 'Invalid input data',
        errors: errors.array()
      });
    }

    const { name, email, phone, qualification, course } = req.body;

    try {
      const crmResponse = await postToCRM({
        name: name,
        email: email,
        mobile: phone,
        course: course,
        source: 'CU EDU Website'
      });

      let crmData;
      try {
        crmData = await crmResponse.json();
      } catch (parseErr) {
        crmData = { message: (await crmResponse.text()) || `CRM responded with status ${crmResponse.status}` };
      }

      if (!crmResponse.ok) {
        logger.error('CRM webhook error (registration)', { status: crmResponse.status, email });
        return res.status(502).json({ success: false, message: 'Failed to submit to admissions. Please contact support.', crm: crmData });
      }

      const lead = crmData.lead || {};
      // The CRM returns both a numeric id and a human-facing reference; prefer
      // the reference, which is what the payment page shows as the admission
      // number, so the student sees one consistent ID everywhere.
      const leadRef = lead.leadId || lead.id || '';

      // A 2xx with no lead means the CRM accepted the request but stored
      // nothing, so the student is not newly registered. The common cause is
      // the CRM recognising an existing enquiry and replying { duplicate: true }.
      if (!leadRef) {
        const isDuplicate = crmData.duplicate === true || /already/i.test(crmData.message || '');

        if (isDuplicate) {
          logger.warn('CRM reported a duplicate registration', { email, phone, course, crm: crmData });
          return res.status(409).json({
            success: false,
            duplicate: true,
            message: crmData.message || 'You have already registered with these details. Our admissions team will contact you shortly.',
            crm: crmData
          });
        }

        // Anything else is unexpected - log the whole body, since the CRM's
        // message is the only clue as to why nothing was stored.
        logger.error('CRM returned no lead for registration', {
          email, phone, course, status: crmResponse.status, crm: crmData
        });
        return res.status(502).json({
          success: false,
          message: crmData.message
            ? `Registration was not completed: ${crmData.message}`
            : 'Your registration could not be completed. Please contact admissions on +91-7846850060.',
          crm: crmData
        });
      }

      logger.info('Registration forwarded to CRM', { email, leadRef });

      // The lead is saved by this point. Email is strictly best-effort: a mail
      // failure must never turn a successful registration into an error.
      try {
        sendConfirmationEmail({ name, email, course, leadId: leadRef, phone });
      } catch (mailErr) {
        logger.error('Confirmation email could not be queued', { error: mailErr.message, leadRef });
      }

      res.json({
        success: true,
        message: crmData.message || 'Registration submitted successfully',
        crm: crmData,
        submitted: { name, email, phone, qualification, course }
      });
    } catch (err) {
      logger.error('CRM request error (registration)', { error: err.message });
      res.status(502).json({ success: false, message: 'Failed to reach admissions. Please contact support.' });
    }
  }
);

app.post('/api/contact',
  [
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name required'),
    body('email').trim().isEmail().withMessage('Valid email required').customSanitizer(normalizeEmail),
    body('phone').customSanitizer(normalizeMobile).matches(/^\d{10}$/).withMessage('Valid phone number required'),
    body('message').trim().isLength({ min: 10, max: 1000 }).withMessage('Message must be 10-1000 characters')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Contact validation failed', { errors: errors.array() });
      const firstError = errors.array()[0];
      return res.status(400).json({
        success: false,
        message: (firstError && firstError.msg) || 'Invalid input data'
      });
    }

    const { name, email, phone, message } = req.body;

    try {
      const crmResponse = await postToCRM({
        name: name,
        email: email,
        mobile: phone,
        course: 'General Enquiry',
        source: 'CU EDU Website'
      });

      let crmData;
      try {
        crmData = await crmResponse.json();
      } catch (parseErr) {
        crmData = { message: (await crmResponse.text()) || `CRM responded with status ${crmResponse.status}` };
      }

      if (!crmResponse.ok) {
        logger.error('CRM webhook error (contact)', { status: crmResponse.status, email });
        return res.status(502).json({ success: false, message: 'Failed to submit. Please try again later.' });
      }

      logger.info('Contact message forwarded to CRM', { email });
      res.json({ success: true, message: crmData.message || 'Message received. We will get back to you shortly.', crm: crmData });
    } catch (err) {
      logger.error('CRM request error (contact)', { error: err.message });
      res.status(502).json({ success: false, message: 'Failed to submit. Please try again later.' });
    }
  }
);

app.post('/api/confirm-payment',
  [
    body('payment_id').trim().notEmpty().withMessage('Payment ID is required'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Valid email address required'),
    body().custom((value) => {
      if (!normalizeMobile(value.phone) && !normalizeEmail(value.email)) {
        throw new Error('A registered mobile number or email address is required');
      }
      return true;
    })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Payment confirmation validation failed', { errors: errors.array() });
      return res.status(400).json({ success: false, message: 'Invalid payment data', errors: errors.array() });
    }

    const { phone, email, payment_id, status = 'Paid', amount } = req.body;
    const finalAmount = (amount && parseFloat(amount) > 0) ? parseFloat(amount) : (parseFloat(process.env.PAYMENT_AMOUNT) || 1000);

    try {
      let mobile = normalizeMobile(phone);
      if (!mobile && email) {
        mobile = await resolveMobileFromEmail(email);
        if (!mobile) {
          logger.warn('No registration found for email during payment confirmation', { email, payment_id });
          return res.status(404).json({
            success: false,
            message: 'We could not find a registration for that email address. Please use your registered mobile number, or contact support with your Payment ID.'
          });
        }
        logger.info('Resolved mobile from email for payment confirmation', { email, payment_id });
      }

      const crmResponse = await postPaymentToCRM({
        mobile: mobile,
        email: email,
        paymentId: payment_id,
        status: status,
        amount: finalAmount
      });

      let crmData;
      try {
        crmData = await crmResponse.json();
      } catch (parseErr) {
        crmData = { message: (await crmResponse.text()) || `CRM responded with status ${crmResponse.status}` };
      }

      if (!crmResponse.ok) {
        logger.error('CRM payment status error', { status: crmResponse.status, mobile, email, payment_id, crmData });
        // Surface the CRM's own wording - "No application found for this mobile
        // number in this tenant" is actionable; "Failed to update" is not. The
        // payment itself has already been taken, so say so explicitly.
        const crmReason = crmData && (crmData.error || crmData.message);
        return res.status(502).json({
          success: false,
          message: crmReason
            ? `Your payment was received, but the CRM could not be updated: ${crmReason} Please contact admissions on +91-7846850060 with your Payment ID.`
            : 'Your payment was received, but the CRM could not be updated. Please contact admissions on +91-7846850060 with your Payment ID.',
          payment_id: payment_id,
          crm: crmData
        });
      }

      logger.info('Payment status forwarded to CRM successfully', {
        mobile, email, payment_id, status, amount: finalAmount, overallPayStatus: crmData.overallPayStatus
      });
      res.json({
        success: true,
        message: crmData.message || 'Payment confirmation sent to CRM successfully.',
        payment_id: payment_id,
        phone: mobile,
        email: email,
        status: status,
        amount: finalAmount,
        payment: crmData.payment || null,
        overallPayStatus: crmData.overallPayStatus || null,
        crm: crmData
      });
    } catch (err) {
      logger.error('Payment confirmation error', { error: err.message, phone, email, payment_id });
      res.status(502).json({ success: false, message: 'Failed to notify CRM. Please try again.' });
    }
  }
);

// Verifies Razorpay's X-Razorpay-Signature: HMAC-SHA256 of the raw request
// body, keyed with the webhook secret. Returns { skipped: true } when no secret
// is configured, so enabling verification is a deployment step, not a code change.
function verifyRazorpaySignature(req) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return { ok: true, skipped: true };

  const signature = req.get('X-Razorpay-Signature') || '';
  if (!signature || !req.rawBody || !req.rawBody.length) {
    return { ok: false, reason: 'missing signature or body' };
  }

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

app.all('/api/razorpay-webhook', async (req, res) => {
  const body = req.body || {};
  const query = req.query || {};

  // Only POSTs come from Razorpay and carry a signature; the GET leg is the
  // browser being redirected back and cannot be signed.
  if (req.method === 'POST') {
    const check = verifyRazorpaySignature(req);
    if (!check.ok) {
      logger.warn('Rejected Razorpay webhook', { reason: check.reason, ip: req.ip });
      return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
    }
    if (check.skipped) {
      logger.warn('RAZORPAY_WEBHOOK_SECRET is not set - webhook accepted WITHOUT verification');
    }
  }

  const entity = (body.payload && body.payload.payment && body.payload.payment.entity) ? body.payload.payment.entity : {};
  
  const rawMobile = entity.contact || body.mobile || body.phone || query.mobile || query.phone || query.contact || '';
  const mobile = normalizeMobile(rawMobile);

  const rawEmail = entity.email || body.email || body.email_id || query.email || query.email_id || '';
  const email = normalizeEmail(rawEmail);

  const paymentId = entity.id || body.razorpay_payment_id || body.payment_id || body.paymentId || query.razorpay_payment_id || query.payment_id || query.pay_id || query.txnId || '';

  let rawAmount = entity.amount ? (entity.amount / 100) : (body.amount || query.amount || 1000);
  const amount = (rawAmount && parseFloat(rawAmount) > 0) ? parseFloat(rawAmount) : 1000;

  // Trust the payment's real state rather than assuming success. Only
  // "captured" means the money was actually taken; the GET redirect carries no
  // entity, so it keeps the previous optimistic default.
  const entityStatus = String(entity.status || '').toLowerCase();
  const isCaptured = !entityStatus || entityStatus === 'captured' || entityStatus === 'paid';
  const status = 'Paid';

  logger.info('Razorpay Callback/Webhook received', {
    mobile, email, paymentId, amount, method: req.method, event: body.event, entityStatus
  });

  // Never write a non-captured payment to the CRM: a later failed attempt would
  // otherwise overwrite an earlier successful one.
  if (!isCaptured) {
    logger.warn('Ignoring non-captured Razorpay payment', { paymentId, entityStatus, event: body.event });
    return res.json({ success: true, ignored: true, reason: `payment status is ${entityStatus}`, paymentId });
  }

  if ((mobile || email) && paymentId) {
    try {
      // Razorpay often returns only the email; the CRM requires a mobile.
      const resolvedMobile = mobile || (email ? await resolveMobileFromEmail(email) : '');
      if (!resolvedMobile) {
        logger.warn('Could not resolve a mobile for payment webhook', { email, paymentId });
      }
      const crmResponse = await postPaymentToCRM({
        mobile: resolvedMobile,
        email: email,
        paymentId: paymentId,
        status: status,
        amount: amount
      });
      let crmData;
      try { crmData = await crmResponse.json(); } catch (e) { crmData = {}; }
      logger.info('Payment pushed directly to CRM DB via Razorpay Webhook', { mobile, email, paymentId, status, amount, crmRes: crmData });
    } catch (err) {
      logger.error('Failed pushing payment to CRM DB via Webhook', { error: err.message, mobile, email, paymentId });
    }
  }

  if (req.method === 'GET') {
    const params = new URLSearchParams({ payment_id: paymentId, status: status, amount: String(amount) });
    if (mobile) params.set('phone', mobile);
    if (email) params.set('email', email);
    return res.redirect(`/payment.html?${params.toString()}`);
  }

  res.json({ success: true, message: 'Payment data processed and pushed to CRM DB.', paymentId, mobile, email });
});


const NOT_FOUND_MESSAGE = 'No registered details found for those details. ' +
  'Please check your mobile number or email address, or register first. ' +
  'If you have already registered, contact admissions on +91-7846850060.';

app.get('/api/payment/lookup', async (req, res) => {
  const mobile = normalizeMobile(req.query.mobile);
  const email = normalizeEmail(req.query.email);

  if (mobile && email) {
    return res.status(400).json({ success: false, message: 'Provide either an email address or a mobile number, not both.' });
  }
  if (!mobile && !email) {
    return res.status(400).json({ success: false, message: 'Please provide a mobile number or email address.' });
  }

  try {
    const crmResponse = await lookupInCRM({ mobile, email });

    // 204 is the "no usable response" sentinel from lookupInCRM. Note 204 is a
    // 2xx, so this must not be guarded by !ok - that check never fired.
    if (crmResponse.status === 204) {
      logger.warn('CRM lookup returned no JSON data', { mobile, email });
      return res.json({ success: false, notFound: true, message: NOT_FOUND_MESSAGE });
    }

    // A 404 is the CRM saying "no such lead" - an ordinary outcome, not a
    // server fault. Returning 502 here made every unregistered visitor look
    // like a gateway error in the browser console.
    if (crmResponse.status === 404) {
      logger.info('No CRM lead found for lookup', { mobile, email });
      return res.json({ success: false, notFound: true, message: NOT_FOUND_MESSAGE });
    }

    const contentType = crmResponse.headers.get('content-type') || '';
    const bodyText = await crmResponse.text();

    let crmData;
    if (contentType.includes('text/html')) {
      logger.warn('CRM lookup returned HTML (no data found)', { mobile, email, status: crmResponse.status });
      return res.json({ success: false, notFound: true, message: NOT_FOUND_MESSAGE });
    }

    try {
      crmData = JSON.parse(bodyText);
    } catch (parseErr) {
      crmData = { message: 'Lookup returned an unreadable response.' };
    }

    if (!crmResponse.ok) {
      logger.error('CRM lookup error', { status: crmResponse.status, mobile, email });
      return res.status(502).json({ success: false, message: 'Unable to retrieve details. Please contact support.', crm: crmData });
    }
    res.json({ success: true, crm: crmData });
  } catch (err) {
    logger.error('CRM lookup request error', { error: err.message, mobile, email });
    res.status(502).json({ success: false, message: 'Unable to retrieve details. Please try again later.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  logger.warn('Not found', { path: req.path, method: req.method });
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(__dirname, '../frontend/public', '404.html'));
  } else {
    res.status(404).json({ success: false, message: 'Endpoint not found' });
  }
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    logger.warn('Malformed JSON body', { path: req.path });
    return res.status(400).json({ success: false, message: 'Invalid JSON body' });
  }
  if (err.status && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, message: 'An internal error occurred. Please try again later.' });
});

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
