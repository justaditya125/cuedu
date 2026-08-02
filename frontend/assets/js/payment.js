(function() {
  var PAYMENT_URL = 'https://pages.razorpay.com/pl_TDMcoOPMLuKJ9W/view';
  var AMOUNT = '1000';
  var STUDENT_KEY = 'cuedu_payment_student';

  var form = document.getElementById('lookupForm');
  var emailInput = document.getElementById('email');
  var mobileInput = document.getElementById('mobile');
  var retrieveBtn = document.getElementById('retrieveBtn');
  var msg = document.getElementById('lookupMsg');
  var resultArea = document.getElementById('resultArea');
  var detailsList = document.getElementById('detailsList');
  var payBtn = document.getElementById('payBtn');
  var amountValue = document.getElementById('amountValue');

  if (!form) return;

  function formatAmount(value) {
    var n = Number(value);
    if (!isFinite(n) || n <= 0) return '';
    return '\u20B9 ' + n.toLocaleString('en-IN');
  }

  function formattedAmount() {
    return formatAmount(AMOUNT);
  }

  // Remember who was looked up, so the payment gateway return trip can still
  // identify the student when it does not echo the email/mobile back to us.
  function rememberStudent(student) {
    try {
      sessionStorage.setItem(STUDENT_KEY, JSON.stringify({
        email: student.email || '',
        phone: student.phone || ''
      }));
    } catch (e) { /* storage unavailable - fall back to URL params only */ }
  }

  function recallStudent() {
    try {
      return JSON.parse(sessionStorage.getItem(STUDENT_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function showMsg(text, type, isHtml) {
    msg.classList.remove('hidden');
    if (isHtml) {
      msg.innerHTML = text;
    } else {
      msg.textContent = text;
    }
    msg.className = 'lookup-msg' + (type ? ' ' + type : '');
  }

  function hideMsg() {
    msg.classList.add('hidden');
    msg.textContent = '';
  }

  function extractStudent(crmData) {
    var lead = crmData.lead || crmData.data || crmData.inquiry || crmData.enquiry || crmData.result || crmData;
    if (Array.isArray(lead)) lead = lead[0];
    if (!lead) return null;

    var n = lead.name || lead.student_name || lead.fullname || lead.customer_name || '';
    var e = lead.email || lead.email_id || lead.mail || '';
    var p = lead.mobile || lead.phone || lead.mobile_number || lead.contact || '';
    var c = lead.course || lead.programme || lead.program || lead.course_name || lead.course_id || '';
    var reg = lead.leadId || lead.lead_id || lead.admission_number || lead.regNo || lead.id || '';

    if (!n && !e && !p) return null;
    return { name: n, email: e, phone: String(p), course: c, regNo: String(reg), raw: lead };
  }

  function buildPaymentUrl(student) {
    var params = new URLSearchParams();
    if (student.regNo) {
      params.set('admission_no', student.regNo);
      params.set('admission_number', student.regNo);
      params.set('admissionno', student.regNo);
    }
    var full = student.name || '';
    if (student.course) full = (full ? full + ' - ' : '') + student.course;
    if (full) {
      params.set('full_name_and_course', full);
      params.set('full_name', full);
      params.set('fullname', full);
      params.set('name', student.name || full);
    }
    if (student.email) {
      params.set('email', student.email);
      params.set('email_id', student.email);
    }
    if (student.phone) {
      params.set('phone', student.phone);
      params.set('mobile', student.phone);
      params.set('contact', student.phone);
    }
    params.set('admission_fee', AMOUNT);
    params.set('admission_fees', AMOUNT);
    params.set('fee', AMOUNT);
    params.set('amount', AMOUNT);
    return PAYMENT_URL + '?' + params.toString();
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var email = (emailInput.value || '').trim();
    var mobile = (mobileInput.value || '').replace(/\D/g, '');

    if (!email && !mobile) {
      showMsg('Please enter your registered email address or mobile number.', 'error');
      return;
    }
    if (mobile && mobile.length !== 10) {
      showMsg('Please enter a valid 10-digit mobile number.', 'error');
      return;
    }

    hideMsg();
    resultArea.classList.add('hidden');
    retrieveBtn.disabled = true;
    retrieveBtn.textContent = 'Retrieving...';
    showMsg('Retrieving your details...', 'loading');

    var params = new URLSearchParams();
    if (email) {
      params.set('email', email);
    } else if (mobile) {
      params.set('mobile', mobile);
    }
    var url = '/api/payment/lookup?' + params.toString();
    fetch(url, { method: 'GET' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        retrieveBtn.disabled = false;
        retrieveBtn.textContent = 'Retrieve';

        if (!data.success) {
          var detail = '';
          if (data.crm && data.crm.error) detail = ' (' + data.crm.error + ')';
          showMsg((data.message || 'Unable to retrieve details. Please try again.') + detail, 'error');
          return;
        }

        var student = extractStudent(data.crm);
        if (!student) {
          showMsg('No registered details found. Please check your email/mobile or contact support.', 'error');
          return;
        }

        hideMsg();
        rememberStudent(student);
        renderDetails(student);
        if (amountValue) amountValue.textContent = formattedAmount();
        if (payBtn) payBtn.textContent = 'Proceed to Pay ' + formattedAmount();
        resultArea.classList.remove('hidden');

        payBtn.onclick = function() {
          window.open(buildPaymentUrl(student), '_blank', 'noopener');
        };
      })
      .catch(function() {
        retrieveBtn.disabled = false;
        retrieveBtn.textContent = 'Retrieve';
        showMsg('Unable to connect to the server. Please try again.', 'error');
      });
  });

  function renderDetails(student) {
    detailsList.innerHTML = '';
    var rows = [
      ['Admission Number', student.regNo],
      ['Full Name', student.name],
      ['Email Address', student.email],
      ['Mobile Number', student.phone],
      ['Programme', student.course],
      ['Amount', formattedAmount()]
    ];
    rows.forEach(function(row) {
      if (!row[1]) return;
      var div = document.createElement('div');
      div.className = 'detail-row';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = row[0];
      var value = document.createElement('span');
      value.className = 'value';
      value.textContent = row[1];
      div.appendChild(label);
      div.appendChild(value);
      detailsList.appendChild(div);
    });
  }

  // Renders the CRM payment receipt. Built with DOM nodes rather than innerHTML
  // because every value here originates from the URL or an external API.
  function showPaymentSuccess(data, fallback) {
    var receipt = data.payment || {};

    msg.classList.remove('hidden');
    msg.className = 'lookup-msg success';
    msg.textContent = '';

    var title = document.createElement('div');
    title.textContent = '✔ ' + (data.message || 'Payment confirmation successful!');
    msg.appendChild(title);

    var box = document.createElement('div');
    box.className = 'confirm-details';
    [
      ['Payment ID', receipt.txnId || data.payment_id || fallback.paymentId],
      ['Application No', receipt.appNo],
      ['Name', receipt.name],
      ['Amount', formatAmount(receipt.amount || data.amount || fallback.amount)],
      ['Payment Status', receipt.status || data.status || fallback.status],
      ['Date', receipt.date],
      ['Overall Payment Status', data.overallPayStatus]
    ].forEach(function(row) {
      if (!row[1]) return;
      var line = document.createElement('div');
      line.className = 'detail-row';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = row[0];
      var value = document.createElement('span');
      value.className = 'value';
      value.textContent = row[1];
      line.appendChild(label);
      line.appendChild(value);
      box.appendChild(line);
    });
    msg.appendChild(box);

    var note = document.createElement('div');
    note.className = 'confirm-note';
    note.textContent = 'Your payment status has been recorded and updated in the university CRM system.';
    msg.appendChild(note);
  }

  // Auto-detect payment return URL parameters (e.g. ?payment_id=pay_TKp4ZR4DgvTeK0&phone=8974563210&status=paid)
  (function checkUrlForPayment() {
    var urlParams = new URLSearchParams(window.location.search);
    var paymentId = urlParams.get('payment_id') || urlParams.get('razorpay_payment_id') || urlParams.get('pay_id') || urlParams.get('transaction_id') || urlParams.get('txn_id');
    var status = urlParams.get('status') || urlParams.get('payment_status') || 'Paid';
    var amount = urlParams.get('amount') || urlParams.get('paid_amount') || AMOUNT;

    if (!paymentId) return;

    // The gateway may return either identifier (or neither, if it drops them),
    // so fall back to whatever the lookup step stored for this session.
    var remembered = recallStudent();
    var phone = (urlParams.get('phone') || urlParams.get('mobile') || urlParams.get('contact') || remembered.phone || '').replace(/\D/g, '');
    var email = (urlParams.get('email') || urlParams.get('email_id') || remembered.email || '').trim();

    if (!phone && !email) {
      showMsg('Payment ID ' + paymentId + ' was received, but we could not identify your registration. ' +
        'Please retrieve your details above or contact admission.online@cutm.ac.in with this Payment ID.', 'error');
      return;
    }

    showMsg('Processing payment confirmation for Payment ID: ' + paymentId + '...', 'loading');
    fetch('/api/confirm-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_id: paymentId,
        phone: phone,
        email: email,
        status: status,
        amount: amount
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success) {
        showPaymentSuccess(data, { paymentId: paymentId, amount: amount, status: status });
      } else {
        var errDetail = (data.crm && data.crm.error) ? data.crm.error : data.message;
        showMsg('Payment ID: ' + paymentId + ' recorded, but the CRM update returned: ' + errDetail, 'error');
      }
    })
    .catch(function(err) {
      console.error('Failed to confirm payment:', err);
      showMsg('Payment ID: ' + paymentId + ' extracted. Unable to connect to server.', 'error');
    });
  })();

  // Auto-fill and fetch CRM details if email or mobile query parameter is present in URL
  (function checkUrlForLookup() {
    var urlParams = new URLSearchParams(window.location.search);
    var email = (urlParams.get('email') || '').trim();
    var mobile = (urlParams.get('mobile') || urlParams.get('phone') || '').replace(/\D/g, '');
    var paymentId = urlParams.get('payment_id') || urlParams.get('razorpay_payment_id') || urlParams.get('pay_id') || urlParams.get('transaction_id') || urlParams.get('txn_id');

    if (!paymentId) {
      if (email && emailInput) {
        emailInput.value = email;
        form.dispatchEvent(new Event('submit'));
      } else if (mobile && mobileInput) {
        mobileInput.value = mobile;
        form.dispatchEvent(new Event('submit'));
      }
    }
  })();
})();

