const nodemailer = require('nodemailer');
const fs = require('fs');

const SMTP_EMAIL = process.env.SMTP_EMAIL || 'alertsemail@cutmap.ac.in';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').split(',').map(function(e) { return e.trim(); }).filter(Boolean);

let transporter = null;

function findSendmail() {
  const candidates = [
    process.env.MSMTP_BIN,
    '/usr/sbin/sendmail',
    '/usr/bin/msmtp',
    '/usr/local/bin/msmtp'
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getTransporter() {
  if (transporter) return transporter;

  const sendmail = findSendmail();
  if (sendmail) {
    transporter = nodemailer.createTransport({
      sendmail: true,
      newline: 'unix',
      path: sendmail
    });
    transporter.mailerVia = 'sendmail (' + sendmail + ')';
  } else if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: SMTP_EMAIL, pass: process.env.SMTP_PASSWORD }
    });
    transporter.mailerVia = 'smtp (' + process.env.SMTP_HOST + ')';
  } else {
    transporter = {
      mailerVia: 'none',
      sendMail: function() {
        return Promise.reject(new Error('No mail transport configured. Install msmtp or set SMTP_HOST.'));
      }
    };
  }
  return transporter;
}

async function sendMail(options) {
  const t = getTransporter();
  return t.sendMail({
    from: SMTP_EMAIL,
    to: options.to,
    subject: options.subject,
    text: options.text,
    html: options.html || undefined
  });
}

function getMailerVia() {
  return getTransporter().mailerVia;
}

module.exports = { sendMail, getMailerVia, SMTP_EMAIL, ADMIN_EMAIL };
