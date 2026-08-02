const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { body, validationResult } = require('express-validator');
const path = require('path');
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

app.use(express.json({ limit: '10mb' }));
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

async function postPaymentToCRM({ mobile, paymentId, status, amount }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = process.env.CRM_PAYMENT_STATUS_URL || 'https://crm.cutmap.ac.in/api/public/payments/cutm/status';
    const apiKey = process.env.CRM_PAYMENT_API_KEY || '7b9f2356c3755131e68b230a32cf9957ce2890781c102173a749298d4b848f55';
    
    const parsedAmount = typeof amount === 'number' ? amount : (parseFloat(amount) || 0);
    const statusStr = String(status || 'Paid');
    const formattedStatus = (statusStr.toLowerCase() === 'paid' || statusStr.toLowerCase() === 'success') ? 'Paid' : statusStr;

    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        mobile: String(mobile || '').replace(/\D/g, ''),
        paymentId: String(paymentId || ''),
        status: formattedStatus,
        amount: parsedAmount
      })
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupInCRM(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
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

    for (const base of baseUrls) {
      const url = new URL(base);
      url.search = params.toString();
      const resp = await fetch(url.toString(), { headers, signal: controller.signal });
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return resp;
      }
    }
    return new Response('', { status: 204 });
  } finally {
    clearTimeout(timeout);
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
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('phone').matches(/^\d{10}$/).withMessage('Valid 10-digit phone number required'),
    body('qualification').trim().isLength({ min: 2, max: 100 }).withMessage('Qualification required'),
    body('course').trim().isLength({ min: 2, max: 100 }).withMessage('Course required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Registration validation failed', { errors: errors.array() });
      return res.status(400).json({ success: false, message: 'Invalid input data', errors: errors.array() });
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

      const leadId = crmData.lead && crmData.lead.id;
      logger.info('Registration forwarded to CRM', { email, leadId });

      if (leadId) {
        sendConfirmationEmail({ name, email, course, leadId, phone });
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
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('phone').matches(/^\d{10}$/).withMessage('Valid phone number required'),
    body('message').trim().isLength({ min: 10, max: 1000 }).withMessage('Message must be 10-1000 characters')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Invalid input data' });
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
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
    body('payment_id').trim().notEmpty().withMessage('Payment ID is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Payment confirmation validation failed', { errors: errors.array() });
      return res.status(400).json({ success: false, message: 'Invalid payment data', errors: errors.array() });
    }

    const { phone, payment_id, status = 'Paid', amount } = req.body;
    const finalAmount = (amount && parseFloat(amount) > 0) ? parseFloat(amount) : (parseFloat(process.env.PAYMENT_AMOUNT) || 1000);

    try {
      const crmResponse = await postPaymentToCRM({
        mobile: phone,
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
        logger.error('CRM payment status error', { status: crmResponse.status, phone, payment_id, crmData });
        return res.status(502).json({ success: false, message: 'Failed to update payment status in CRM.', crm: crmData });
      }

      logger.info('Payment status forwarded to CRM successfully', { phone, payment_id, status: status, amount: finalAmount });
      res.json({
        success: true,
        message: 'Payment confirmation sent to CRM successfully.',
        payment_id: payment_id,
        phone: phone,
        status: status,
        amount: finalAmount,
        crm: crmData
      });
    } catch (err) {
      logger.error('Payment confirmation error', { error: err.message, phone, payment_id });
      res.status(502).json({ success: false, message: 'Failed to notify CRM. Please try again.' });
    }
  }
);

app.all('/api/razorpay-webhook', async (req, res) => {
  const body = req.body || {};
  const query = req.query || {};

  const entity = (body.payload && body.payload.payment && body.payload.payment.entity) ? body.payload.payment.entity : {};
  
  const rawMobile = entity.contact || body.mobile || body.phone || query.mobile || query.phone || query.contact || '';
  const mobile = String(rawMobile).replace(/\D/g, '').slice(-10);

  const paymentId = entity.id || body.razorpay_payment_id || body.payment_id || body.paymentId || query.razorpay_payment_id || query.payment_id || query.pay_id || query.txnId || '';

  let rawAmount = entity.amount ? (entity.amount / 100) : (body.amount || query.amount || 1000);
  const amount = (rawAmount && parseFloat(rawAmount) > 0) ? parseFloat(rawAmount) : 1000;

  const status = 'Paid';

  logger.info('Razorpay Callback/Webhook received', { mobile, paymentId, amount, method: req.method });

  if (mobile && paymentId) {
    try {
      const crmResponse = await postPaymentToCRM({
        mobile: mobile,
        paymentId: paymentId,
        status: status,
        amount: amount
      });
      let crmData;
      try { crmData = await crmResponse.json(); } catch (e) { crmData = {}; }
      logger.info('Payment pushed directly to CRM DB via Razorpay Webhook', { mobile, paymentId, status, amount, crmRes: crmData });
    } catch (err) {
      logger.error('Failed pushing payment to CRM DB via Webhook', { error: err.message, mobile, paymentId });
    }
  }

  if (req.method === 'GET') {
    return res.redirect(`/payment.html?payment_id=${encodeURIComponent(paymentId)}&phone=${encodeURIComponent(mobile)}&status=${encodeURIComponent(status)}&amount=${encodeURIComponent(amount)}`);
  }

  res.json({ success: true, message: 'Payment data processed and pushed to CRM DB.', paymentId, mobile });
});


app.get('/api/payment/lookup', async (req, res) => {
  const mobile = (req.query.mobile || '').replace(/\D/g, '');
  const email = (req.query.email || '').trim().toLowerCase();

  if (mobile && email) {
    return res.status(400).json({ success: false, message: 'Provide either an email address or a mobile number, not both.' });
  }
  if (!mobile && !email) {
    return res.status(400).json({ success: false, message: 'Please provide a mobile number or email address.' });
  }

  try {
    const crmResponse = await lookupInCRM({ mobile, email });

    if (!crmResponse.ok && crmResponse.status === 204) {
      logger.warn('CRM lookup returned no JSON data', { mobile, email });
      return res.json({ success: false, message: 'No registered details found. Please check your details or register first.' });
    }

    const contentType = crmResponse.headers.get('content-type') || '';
    const bodyText = await crmResponse.text();

    let crmData;
    if (contentType.includes('text/html')) {
      crmData = { message: 'No registered details found for the provided mobile/email.' };
      logger.warn('CRM lookup returned HTML (no data found)', { mobile, email, status: crmResponse.status });
      return res.json({ success: false, message: 'No registered details found. Please check your details or register first.', crm: crmData });
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
