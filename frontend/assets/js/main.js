document.addEventListener('DOMContentLoaded', function() {

  // Hamburger toggle
  const hamburger = document.querySelector('.hamburger');
  const nav = document.querySelector('.nav');
  if (hamburger) {
    hamburger.addEventListener('click', function() {
      nav.classList.toggle('open');
    });
    // Close nav when clicking outside
    document.addEventListener('click', function(e) {
      if (!hamburger.contains(e.target) && !nav.contains(e.target)) {
        nav.classList.remove('open');
      }
    });
  }

  const closeBtn = document.querySelector('.top-banner-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      this.closest('.top-banner').style.display = 'none';
    });
  }

  // Tab switching
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      const parent = this.closest('.why-section, .section');
      if (!parent) return;
      parent.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
      parent.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
      this.classList.add('active');
      const target = document.getElementById(this.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // Accordion — smooth slide with exact-height calculation
  const accordionHeaders = document.querySelectorAll('.accordion-header');
  accordionHeaders.forEach(function(header) {
    header.addEventListener('click', function() {
      const item = this.closest('.accordion-item');
      const body = item.querySelector('.accordion-body');
      if (item.classList.contains('active')) {
        // Collapse
        body.style.maxHeight = body.scrollHeight + 'px';
        requestAnimationFrame(function() {
          body.style.maxHeight = '0';
        });
        item.classList.remove('active');
      } else {
        // Expand
        item.classList.add('active');
        body.style.maxHeight = body.scrollHeight + 'px';
      }
    });
  });

  // ---- OTP verification for the registration form -------------------------
  // Each channel is verified independently; the server returns a signed token
  // that /api/register checks, so the step cannot be skipped client-side.
  const otpTokens = { email: '', mobile: '' };
  const otpRows = document.querySelectorAll('.otp-row');

  function otpEnabled() {
    return otpRows.length > 0;
  }

  function otpBothVerified() {
    return Boolean(otpTokens.email && otpTokens.mobile);
  }

  function otpFieldFor(channel) {
    return document.getElementById(channel === 'mobile' ? 'phone' : 'email');
  }

  function otpTargetValue(channel) {
    const field = otpFieldFor(channel);
    if (!field) return '';
    return channel === 'mobile'
      ? field.value.replace(/\D/g, '').slice(-10)
      : field.value.trim().toLowerCase();
  }

  function setOtpStatus(row, text, kind) {
    const el = row.querySelector('.otp-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'otp-status' + (kind ? ' ' + kind : '');
  }

  function startResendCountdown(button, seconds, restoreLabel) {
    let left = seconds;
    const idleLabel = restoreLabel || 'Resend';
    button.disabled = true;
    button.textContent = 'Resend in ' + left + 's';
    const tick = setInterval(function() {
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        button.disabled = false;
        button.textContent = idleLabel;
      } else {
        button.textContent = 'Resend in ' + left + 's';
      }
    }, 1000);
  }

  // Sends one channel's code and reveals its verify controls. Returns a promise
  // resolving to whether it went out, so the combined button can report on both.
  function requestOtp(channel) {
    const row = document.querySelector('.otp-row[data-channel="' + channel + '"]');
    if (!row) return Promise.resolve({ channel: channel, ok: false });

    const codeInput = row.querySelector('.otp-code');
    const verifyBtn = row.querySelector('.otp-verify');
    const resendBtn = row.querySelector('.otp-resend');
    const value = otpTargetValue(channel);

    if (otpTokens[channel]) return Promise.resolve({ channel: channel, ok: true, skipped: true });
    if (!value) {
      setOtpStatus(row, channel === 'mobile' ? 'Enter your mobile number first.' : 'Enter your email first.', 'err');
      return Promise.resolve({ channel: channel, ok: false });
    }

    setOtpStatus(row, 'Sending code...', '');
    return fetch('/api/otp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: channel, value: value })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          codeInput.hidden = false;
          verifyBtn.hidden = false;
          verifyBtn.disabled = false;
          resendBtn.hidden = false;
          setOtpStatus(row, data.message, '');
          startResendCountdown(resendBtn, data.resendInSec || 60);
        } else {
          setOtpStatus(row, data.message || 'Could not send the code.', 'err');
        }
        return { channel: channel, ok: Boolean(data.success) };
      })
      .catch(function() {
        setOtpStatus(row, 'Network error. Please try again.', 'err');
        return { channel: channel, ok: false };
      });
  }

  // One click sends both codes; each is then verified separately below.
  const sendAllBtn = document.getElementById('otpSendAll');
  const sendAllStatus = document.getElementById('otpSendAllStatus');

  function setSendAllStatus(text, kind) {
    if (!sendAllStatus) return;
    sendAllStatus.textContent = text || '';
    sendAllStatus.className = 'otp-status' + (kind ? ' ' + kind : '');
  }

  if (sendAllBtn) {
    sendAllBtn.addEventListener('click', function() {
      const missing = [];
      if (!otpTargetValue('email')) missing.push('email address');
      if (otpTargetValue('mobile').length !== 10) missing.push('10-digit mobile number');
      if (missing.length) {
        setSendAllStatus('Enter your ' + missing.join(' and ') + ' first.', 'err');
        return;
      }

      sendAllBtn.disabled = true;
      setSendAllStatus('Sending codes...', '');

      Promise.all([requestOtp('email'), requestOtp('mobile')]).then(function(results) {
        const sent = results.filter(function(r) { return r.ok; }).length;
        if (sent === 2) {
          setSendAllStatus('Codes sent to your email and mobile. Enter each one above.', 'ok');
        } else if (sent === 1) {
          setSendAllStatus('One code could not be sent - see the message next to that field.', 'err');
        } else {
          setSendAllStatus('Could not send the codes. Please check your details and try again.', 'err');
        }
        startResendCountdown(sendAllBtn, 60, 'Send OTP to Email & Phone');
      });
    });
  }

  otpRows.forEach(function(row) {
    const channel = row.dataset.channel;
    const codeInput = row.querySelector('.otp-code');
    const verifyBtn = row.querySelector('.otp-verify');
    const resendBtn = row.querySelector('.otp-resend');
    const field = otpFieldFor(channel);
    if (!channel || !codeInput || !verifyBtn || !resendBtn || !field) return;

    // Changing the address or number after verifying invalidates the proof -
    // otherwise someone could verify one value and register another.
    field.addEventListener('input', function() {
      if (otpTokens[channel]) {
        otpTokens[channel] = '';
        field.closest('.form-group').classList.remove('verified');
        codeInput.value = '';
        codeInput.hidden = true;
        verifyBtn.hidden = true;
        resendBtn.hidden = true;
        setOtpStatus(row, 'Details changed - please verify again.', 'err');
        if (sendAllBtn) sendAllBtn.disabled = false;
      }
    });

    resendBtn.addEventListener('click', function() { requestOtp(channel); });

    verifyBtn.addEventListener('click', function() {
      const code = codeInput.value.trim();
      if (code.length !== 6) {
        setOtpStatus(row, 'Enter the 6-digit code.', 'err');
        return;
      }
      verifyBtn.disabled = true;
      setOtpStatus(row, 'Verifying...', '');

      fetch('/api/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel, value: otpTargetValue(channel), otp: code })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success && data.token) {
            otpTokens[channel] = data.token;
            field.closest('.form-group').classList.add('verified');
            codeInput.hidden = true;
            verifyBtn.hidden = true;
            resendBtn.hidden = true;
            setOtpStatus(row, '✓ Verified', 'ok');
            if (otpBothVerified()) setSendAllStatus('Both verified - you can submit the form.', 'ok');
          } else {
            verifyBtn.disabled = false;
            setOtpStatus(row, data.message || 'Verification failed.', 'err');
          }
        })
        .catch(function() {
          verifyBtn.disabled = false;
          setOtpStatus(row, 'Network error. Please try again.', 'err');
        });
    });

    codeInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); verifyBtn.click(); }
    });
  });

  // ---- State / District dependent dropdowns ---------------------------
  const stateSelect = document.getElementById('state');
  const districtSelect = document.getElementById('district');
  if (stateSelect && districtSelect && window.INDIA_STATES) {
    window.INDIA_STATES.forEach(function(state) {
      const opt = document.createElement('option');
      opt.value = state;
      opt.textContent = state;
      stateSelect.appendChild(opt);
    });

    stateSelect.addEventListener('change', function() {
      // "Other" (and any state with no district list) gets a single "Other"
      // option rather than an empty, unusable dropdown.
      const districts = (window.INDIA_STATE_DISTRICTS && window.INDIA_STATE_DISTRICTS[stateSelect.value]) || ['Other'];
      districtSelect.innerHTML = '';
      if (!stateSelect.value) {
        districtSelect.appendChild(new Option('Select State first', ''));
        districtSelect.disabled = true;
        return;
      }
      districtSelect.disabled = false;
      districtSelect.appendChild(new Option('Select District', ''));
      districts.forEach(function(d) { districtSelect.appendChild(new Option(d, d)); });
    });
  }

  // Registration form: forward directly to CRM, then show response
  const regForm = document.getElementById('registrationForm');
  if (regForm) {
    let submitting = false;
    regForm.addEventListener('submit', function(e) {
      e.preventDefault();
      if (submitting) return;
      submitting = true;
      const submitBtn = regForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      if (otpEnabled() && !otpBothVerified()) {
        alert('Please verify both your email address and mobile number before submitting.');
        submitting = false;
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      const formData = {
        name: document.getElementById('name').value.trim(),
        email: document.getElementById('email').value.trim(),
        // Strip spaces, dashes and a +91 prefix so common formats submit
        // cleanly; the server normalises again as the authority.
        phone: document.getElementById('phone').value.replace(/\D/g, '').slice(-10),
        state: document.getElementById('state').value,
        district: document.getElementById('district').value,
        qualification: document.getElementById('qualification').value,
        course: document.getElementById('program').value,
        email_otp_token: otpTokens.email,
        phone_otp_token: otpTokens.mobile
      };
      fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          sessionStorage.setItem('registrationResult', JSON.stringify({
            crm: data.crm,
            submitted: data.submitted
          }));
          window.location.href = 'registration-success.html';
        } else if (data.duplicate) {
          // Already on file at the CRM - not an error the student can act on.
          submitting = false;
          if (submitBtn) submitBtn.disabled = false;
          alert(data.message);
        } else {
          submitting = false;
          if (submitBtn) submitBtn.disabled = false;
          alert('Registration Error: ' + data.message);
        }
      })
      .catch(function(err) {
        submitting = false;
        if (submitBtn) submitBtn.disabled = false;
        console.error('Registration failed:', err);
        alert('Failed to connect to the server. Please try again.');
      });
    });
  }

  // Contact form handler
  const contactForm = document.getElementById('contactForm');
  if (contactForm) {
    contactForm.addEventListener('submit', function(e) {
      e.preventDefault();
      const formData = {
        name: this.querySelector('input[name="name"]').value.trim(),
        email: this.querySelector('input[name="email"]').value.trim(),
        phone: this.querySelector('input[name="phone"]').value.replace(/\D/g, '').slice(-10),
        message: this.querySelector('textarea[name="message"]').value.trim()
      };
      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          alert(data.message);
          contactForm.reset();
        } else {
          alert('Error: ' + data.message);
        }
      })
      .catch(function(err) {
        console.error('Contact submission failed:', err);
        alert('Failed to connect to the server. Please try again.');
      });
    });
  }

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(function(anchor) {
    anchor.addEventListener('click', function(e) {
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // Elective tab switching in Programme Syllabus Accordion
  const electiveTabs = document.querySelectorAll('.elective-tab');
  electiveTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      const parent = this.closest('.accordion-body');
      if (!parent) return;
      
      const targetElective = this.dataset.elective;
      
      // Deactivate other tabs and contents inside the same parent accordion
      parent.querySelectorAll('.elective-tab').forEach(function(btn) {
        btn.classList.remove('active');
      });
      parent.querySelectorAll('.elective-content').forEach(function(content) {
        content.classList.remove('active');
      });
      
      // Activate selected tab and content
      this.classList.add('active');
      const targetContent = parent.querySelector(`.elective-content[data-elective="${targetElective}"]`);
      if (targetContent) {
        targetContent.classList.add('active');
      }
      
      // Recalculate accordion height after content swap
      const accordionItem = parent.closest('.accordion-item');
      if (accordionItem && accordionItem.classList.contains('active')) {
        parent.style.maxHeight = parent.scrollHeight + 'px';
      }
    });
  });
});
