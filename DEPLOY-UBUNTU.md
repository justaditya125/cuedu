# Centurion University Website — Ubuntu Deployment Guide

Complete step-by-step commands to deploy this website on a fresh Ubuntu server.

**Production URL:** `https://cuedu.cutm.ac.in`
**Backend port:** `8000` (reverse-proxied by Nginx on port 80)

> Note: This guide assumes HTTP on port 80 only (no SSL). If you add SSL later,
> install certbot after Step 10.

---

## Step 1 — System update & install packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git zip unzip build-essential nginx msmtp msmtp-mta
```

## Step 2 — Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # should show v20.x
npm -v
```

## Step 3 — Install PM2 (process manager)

```bash
sudo npm install -g pm2
```

## Step 4 — Upload the project zip

Upload `cuedu.zip` to the server, e.g. into `/var/www`:

```bash
# From your local machine:
#   scp cuedu.zip user@SERVER_IP:/var/www/

cd /var/www
sudo unzip cuedu.zip -d cuedu
cd cuedu
```

## Step 5 — Remove bundled node_modules & install clean

The zip contains Windows-built packages. Reinstall for Linux:

```bash
rm -rf node_modules
npm install
```

## Step 6 — Create the production `.env`

This is required — the `.env` shipped in the zip contains **local/development**
values (localhost origins) and must be overwritten.

```bash
cat > .env << 'EOF'
PORT=8000
NODE_ENV=production

ALLOWED_ORIGINS=https://cuedu.cutm.ac.in

CRM_WEBHOOK_URL=https://crm.cutmap.ac.in/api/public/inquiry/cuedu

PAYMENT_AMOUNT=1000
CRM_PAYMENT_STATUS_URL=https://crm.cutmap.ac.in/api/public/payments/cuedu/status
CRM_PAYMENT_API_KEY=<crm-payment-api-key>

# Mobile + email OTP verification on the registration form (see Step 6.5)
OTP_REQUIRED=true
OTP_TOKEN_SECRET=<generate with: openssl rand -hex 32>

SMS_USERNAME=gramtarang
SMS_APIKEY=2279de0891389c8d3a33
SMS_SENDERID=GTIDSM
SMS_TEMPLATEID=1007161519960183117

LOG_LEVEL=info
EOF
```

> No database is required. Registration and contact data are sent directly to
> the CRM webhook above. There is no local MySQL dependency.

## Step 6.5 — OTP verification (mobile + email)

The registration form on `admissionportal.html` already has the full OTP UI
built in (Send OTP / Verify buttons on both the email and phone fields), and
the backend already implements both channels:

- **Mobile** — `config/sms.js` calls `https://smslogin.co/v3/api.php` with
  `username`, `apikey`, `senderid`, `templateid`, `mobile`, `message` — the
  exact same gateway/params as the existing Java integration. The message
  text (`Dear User,Your OTP for login is:{otp} With Regards,GTIDS IT Team`)
  already matches the registered DLT template, so it doesn't need to be
  overridden with `SMS_OTP_TEMPLATE`.
- **Email** — sent via the same mailer (msmtp, configured in Step 7) already
  used for confirmation emails; no extra setup needed.

Nothing to code — this is purely the `.env` block above. Once it's in place:

```bash
pm2 restart cuedu
```

Verify at boot (`pm2 logs cuedu`):
- `OTP verification is REQUIRED for registration` — confirms `OTP_REQUIRED` took effect.
- No `OTP is required but the SMS gateway is not configured` / `...no mail transport is configured` lines — confirms both channels are wired.

Until `OTP_REQUIRED=true` is set, registrations are accepted **without**
verifying either mobile or email (the send/verify buttons still work, but
skipping them is not blocked).

## Step 7 — Configure msmtp for email

The app sends a confirmation email to the student (with their registration ID)
and a notification to the admin emails. In production this is delivered via
msmtp (sendmail interface).

Create the config file for the `www-data` / deploy user:

```bash
mkdir -p ~/.config/msmtp
cat > ~/.config/msmtp/config << 'EOF'
defaults
auth           on
tls            on
tls_trust_file /etc/ssl/certs/ca-certificates.crt
logfile        ~/.msmtp.log

account        default
host           smtp.gmail.com
port           587
from           alertsemail@cutmap.ac.in
user           alertsemail@cutmap.ac.in
password       aenuaqtlofasxgqq
EOF
chmod 600 ~/.config/msmtp/config
```

Test it:

```bash
echo -e "Subject: test\n\nhello" | msmtp -a default aditya.sah@thegttech.com
```

If you deploy via PM2 under your own user, run the above as that same user.
The app uses `/usr/bin/msmtp` automatically (via `sendmail`), so no code
changes are needed.

## Step 8 — Test the app directly (before PM2)

```bash
sudo node server.js
```

In another terminal:

```bash
curl http://localhost:8000/health     # expect {"status":"healthy",...}
curl -I http://localhost:8000/        # expect HTTP/1.1 200
```

Then stop the test server with `Ctrl+C`.

## Step 9 — Run under PM2 (auto-restart + start on boot)

```bash
pm2 start server.js --name cuedu
pm2 save

# Enable PM2 to start on boot (run the command it prints)
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME
sudo systemctl enable pm2-${USER}
```

## Step 10 — Nginx reverse proxy (HTTP, port 80)

> Note: This guide assumes HTTP on port 80 only (no SSL). If you add SSL later,
> install certbot and update this server block after enabling it.

```bash
sudo nano /etc/nginx/sites-available/cuedu
```

Paste this config:

```nginx
server {
    listen 80;
    server_name cuedu.cutm.ac.in;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Save, then enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/cuedu /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # optional: remove default site
sudo nginx -t
sudo systemctl restart nginx
```

## Step 11 — Firewall (if UFW enabled)

```bash
sudo ufw allow 'Nginx HTTP'
sudo ufw allow OpenSSH
sudo ufw enable
```

## Step 12 — Final verification

```bash
curl http://localhost:8000/health
curl -I http://cuedu.cutm.ac.in/
curl -I http://cuedu.cutm.ac.in/admissionportal.html
```

Expected:
- `/health` → `{"status":"healthy",...}`
- Pages → `HTTP/1.1 200`

---

## Common troubleshooting

| Problem | Fix |
|---------|-----|
| `502 Bad Gateway` from Nginx | PM2 not running → `pm2 restart cuedu` and `pm2 save` |
| API returns 502 on register/contact | CRM unreachable → check outbound network from server and `CRM_WEBHOOK_URL` in `.env`; check logs `cat logs/error.log` |
| CORS errors in browser | `.env` `ALLOWED_ORIGINS` must be exactly `https://cuedu.cutm.ac.in`; restart PM2 after changing `.env` (`pm2 restart cuedu`) |
| Port 8000 already in use | `pm2 kill`, then repeat Step 9 |
| Changes not reflecting | Restart PM2: `pm2 restart cuedu` |

Logs:
- App logs: `logs/combined.log`, `logs/error.log`
- PM2: `pm2 logs cuedu`

---

## App behavior (for reference)

- **Apply Now** → student registers → data sent directly to the CRM (no local database, no payment in between); a confirmation email with the CRM Registration ID is sent to the student; full CRM response is shown on a registration-success page.
- **Pay Now** (homepage header) → `payment.html`: the student retrieves their
  registered details by email **or** mobile, then proceeds to the Razorpay page.
- **Payment confirmation** → on return from Razorpay (either the
  `/api/razorpay-webhook` callback or the `payment_id` query parameters on
  `payment.html`), the payment ID is posted to `CRM_PAYMENT_STATUS_URL` together
  with the student's mobile and/or email, and the CRM receipt is shown on screen.
  Only one of mobile/email is required; the page remembers whichever was used
  for the lookup, so the gateway does not have to echo it back.
- **Contact form** → sent directly to the CRM.
- All data is sent to the CRM at registration/contact time via `https://crm.cutmap.ac.in/api/public/inquiry/cuedu`.
- Confirmation/admin emails are delivered via msmtp (sendmail interface); see Step 7.
