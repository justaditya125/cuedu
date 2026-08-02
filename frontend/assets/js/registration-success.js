(function() {
  var raw = sessionStorage.getItem('registrationResult');
  var data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {
    data = null;
  }

  var errorNote = document.getElementById('errorNote');
  var submitted = document.getElementById('submittedDetails');
  var successMsg = document.getElementById('successMessage');
  var regIdCard = document.getElementById('regIdCard');
  var regIdValue = document.getElementById('regIdValue');

  if (!data) {
    if (errorNote) errorNote.classList.remove('hidden');
    return;
  }

  if (errorNote) errorNote.classList.add('hidden');
  if (submitted) submitted.classList.remove('hidden');

  var crm = data.crm || {};

  if (successMsg) {
    successMsg.textContent = crm.message || 'Your registration has been submitted to our admissions team.';
  }

  var leadId = crm.lead && crm.lead.id;
  if (leadId) {
    if (regIdCard) regIdCard.classList.remove('hidden');
    if (regIdValue) regIdValue.textContent = leadId;
  }

  var detailsList = document.getElementById('detailsList');
  if (detailsList && data.submitted) {
    var labels = {
      name: 'Full Name',
      email: 'Email Address',
      phone: 'Phone Number',
      qualification: 'Highest Qualification',
      course: 'Programme'
    };
    Object.keys(labels).forEach(function(key) {
      if (!data.submitted[key]) return;
      var row = document.createElement('div');
      row.className = 'detail-row';
      var label = document.createElement('span');
      label.className = 'label';
      label.textContent = labels[key];
      var value = document.createElement('span');
      value.className = 'value';
      value.textContent = data.submitted[key];
      row.appendChild(label);
      row.appendChild(value);
      detailsList.appendChild(row);
    });
  }
})();
