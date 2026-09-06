const SMS_ENDPOINT = process.env.SMS_ENDPOINT || 'https://smslogin.co/v3/api.php';

// The message must match the registered DLT template exactly, or the gateway
// rejects it. {otp} is the only substitution.
const DEFAULT_TEMPLATE = 'Dear User,Your OTP for login is:{otp} With Regards,GTIDS IT Team';

function isConfigured() {
  return Boolean(process.env.SMS_USERNAME && process.env.SMS_APIKEY && process.env.SMS_TEMPLATEID);
}

function missingConfig() {
  return ['SMS_USERNAME', 'SMS_APIKEY', 'SMS_TEMPLATEID'].filter((k) => !process.env[k]);
}

function buildOtpMessage(otp) {
  const template = process.env.SMS_OTP_TEMPLATE || DEFAULT_TEMPLATE;
  return template.replace('{otp}', otp);
}

async function sendSms(mobile, message) {
  const missing = missingConfig();
  if (missing.length) {
    throw new Error('SMS gateway not configured - missing ' + missing.join(', '));
  }

  // Built with URLSearchParams so the message's spaces, commas and colons are
  // percent-encoded; string concatenation would corrupt the template text and
  // fail the DLT match.
  const url = new URL(SMS_ENDPOINT);
  url.searchParams.set('username', process.env.SMS_USERNAME);
  url.searchParams.set('apikey', process.env.SMS_APIKEY);
  url.searchParams.set('senderid', process.env.SMS_SENDERID || 'GTIDSM');
  url.searchParams.set('templateid', process.env.SMS_TEMPLATEID);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('message', message);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.SMS_TIMEOUT_MS) || 10000);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    const body = (await resp.text()).trim();

    if (!resp.ok) {
      throw new Error('SMS gateway HTTP ' + resp.status + ': ' + body.slice(0, 200));
    }
    // The gateway answers 200 with a plain-text body even for failures, so the
    // body has to be inspected rather than trusting the status code.
    if (/error|invalid|fail|denied|insufficient/i.test(body)) {
      throw new Error('SMS gateway rejected the request: ' + body.slice(0, 200));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendSms, buildOtpMessage, isConfigured, missingConfig };
