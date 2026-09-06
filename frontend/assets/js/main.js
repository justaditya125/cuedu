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

  function startResendCountdown(button, seconds) {
    let left = seconds;
    button.disabled = true;
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    button.textContent = 'Resend in ' + left + 's';
    const tick = setInterval(function() {
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        button.disabled = false;
        button.textContent = 'Resend OTP';
      } else {
        button.textContent = 'Resend in ' + left + 's';
      }
    }, 1000);
  }

  otpRows.forEach(function(row) {
    const channel = row.dataset.channel;
    const sendBtn = row.querySelector('.otp-send');
    const codeInput = row.querySelector('.otp-code');
    const verifyBtn = row.querySelector('.otp-verify');
    const field = otpFieldFor(channel);
    if (!channel || !sendBtn || !codeInput || !verifyBtn || !field) return;

    // Changing the address or number after verifying invalidates the proof -
    // otherwise someone could verify one value and register another.
    field.addEventListener('input', function() {
      if (otpTokens[channel]) {
        otpTokens[channel] = '';
        field.closest('.form-group').classList.remove('verified');
        codeInput.value = '';
        codeInput.hidden = true;
        verifyBtn.hidden = true;
        sendBtn.hidden = false;
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send OTP';
        setOtpStatus(row, 'Details changed - please verify again.', 'err');
      }
    });

    sendBtn.addEventListener('click', function() {
      const value = otpTargetValue(channel);
      if (!value) {
        setOtpStatus(row, channel === 'mobile' ? 'Enter your mobile number first.' : 'Enter your email first.', 'err');
        return;
      }
      sendBtn.disabled = true;
      setOtpStatus(row, 'Sending code...', '');

      fetch('/api/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel, value: value })
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            codeInput.hidden = false;
            verifyBtn.hidden = false;
            codeInput.focus();
            setOtpStatus(row, data.message, '');
            startResendCountdown(sendBtn, data.resendInSec || 60);
          } else {
            sendBtn.disabled = false;
            setOtpStatus(row, data.message || 'Could not send the code.', 'err');
          }
        })
        .catch(function() {
          sendBtn.disabled = false;
          setOtpStatus(row, 'Network error. Please try again.', 'err');
        });
    });

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
            sendBtn.hidden = true;
            setOtpStatus(row, '✓ Verified', 'ok');
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
