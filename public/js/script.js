document.addEventListener('DOMContentLoaded', () => {
  const paymentBtn = document.getElementById('proceedToPayment');

  // When "Proceed to Payment" is clicked
  if (paymentBtn) {
    paymentBtn.addEventListener('click', async () => {
      try {
        paymentBtn.disabled = true;

        const fileInput = document.getElementById('passportFile');
        const file = fileInput?.files?.[0];

        // Client-side size check (match server: 5MB)
        if (file && file.size > 5 * 1024 * 1024) {
          alert('File is too large. Please upload a file under 5MB.');
          paymentBtn.disabled = false;
          return;
        }

        // Build application data
        const data = {
          firstname: (document.getElementById('firstname')?.value || '').trim(),
          middlename: (document.getElementById('middlename')?.value || '').trim(),
          lastname: (document.getElementById('lastname')?.value || '').trim().toUpperCase(),
          dob: (document.getElementById('dob')?.value || '').trim(),
          email: (document.getElementById('email')?.value || '').trim(),
          nationality: (document.getElementById('nationality')?.value || '').trim(),
          passport: (document.getElementById('passport')?.value || '').trim(),
          appNumber: generateAppNumber(16),
        };

        // Basic required fields (email + appNumber are essential for checkout)
        if (!data.email) {
          alert('Please enter your email before proceeding to payment.');
          paymentBtn.disabled = false;
          return;
        }

        // Save form data locally so we can submit after Stripe redirects back
        localStorage.setItem('pendingApplication', JSON.stringify(data));

        // If a file was chosen, pre-store it as base64 so we can recreate it later
        if (file) {
          const base64 = await fileToDataURL(file);
          localStorage.setItem('passportFileBase64', base64);
          localStorage.setItem('passportFileName', file.name);
        } else {
          localStorage.removeItem('passportFileBase64');
          localStorage.removeItem('passportFileName');
        }

        // IMPORTANT: send BOTH email and appNumber to backend
        const response = await fetch('/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: data.email, appNumber: data.appNumber }),
        });

        const result = await response.json();
        if (response.ok && result.url) {
          window.location.href = result.url; // Redirect to Stripe Checkout
        } else {
          alert(result.error || 'Failed to initiate payment.');
          paymentBtn.disabled = false;
        }
      } catch (err) {
        console.error('Payment setup error:', err);
        alert('An error occurred while starting payment.');
        paymentBtn.disabled = false;
      }
    });
  }

  // Success page: submit application and file upload
  if (window.location.pathname.includes('success.html')) {
    (async () => {
      try {
        const dataRaw = localStorage.getItem('pendingApplication');
        const data = dataRaw ? JSON.parse(dataRaw) : null;
        const base64 = localStorage.getItem('passportFileBase64');
        const filename = localStorage.getItem('passportFileName');

        if (!data) {
          alert('No application found after payment.');
          return;
        }

        const formData = new FormData();
        Object.keys(data).forEach((k) => formData.append(k, data[k]));

        if (base64 && filename) {
          const blob = dataURLToBlob(base64);
          formData.append('passportFile', blob, filename);
        }

        const res = await fetch('/submit', { method: 'POST', body: formData });

        if (res.ok) {
          localStorage.setItem('latestApplication', JSON.stringify(data));
          localStorage.removeItem('pendingApplication');
          localStorage.removeItem('passportFileBase64');
          localStorage.removeItem('passportFileName');
          window.location.href = 'confirmation.html';
        } else {
          const r = await res.json().catch(() => ({}));
          alert(r.message || 'Payment succeeded but submission failed. Please contact support.');
        }
      } catch (err) {
        console.error('Error submitting application after payment:', err);
        alert('There was a problem submitting your application.');
      }
    })();
  }

  // Confirmation page: show application number
  if (window.location.pathname.includes('confirmation.html')) {
    const data = JSON.parse(localStorage.getItem('latestApplication') || '{}');
    const el = document.getElementById('appNumber');
    if (el) el.textContent = data.appNumber || 'APPLICATION NUMBER NOT FOUND';
  }

  // Track application status
  if (window.location.pathname.includes('track.html')) {
    const trackForm = document.getElementById('trackForm');
    const resultEl = document.getElementById('result');
    const errorEl = document.getElementById('error');

    if (trackForm) {
      trackForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        resultEl.innerHTML = '';
        errorEl.innerHTML = '';
        resultEl.classList.remove('show');
        errorEl.classList.remove('show');

        const appNumber = (document.getElementById('trackNumber')?.value || '').trim().toUpperCase();
        const lastName = (document.getElementById('trackLastName')?.value || '').trim();

        if (!appNumber || !lastName) {
          errorEl.textContent = 'Please enter both Application Number and Last Name.';
          errorEl.classList.add('show');
          return;
        }

        try {
          const res = await fetch('/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appNumber, lastName }),
          });

          const payload = await res.json().catch(() => ({}));
          if (res.ok) {
            resultEl.innerHTML = `
              <p><strong>Name:</strong> ${payload.name}</p>
              <p><strong>Status:</strong> ${payload.status}</p>
            `;
            resultEl.classList.add('show');
          } else {
            errorEl.textContent = payload.message || 'Application not found.';
            errorEl.classList.add('show');
          }
        } catch (err) {
          console.error('Tracking error:', err);
          errorEl.textContent = 'An error occurred while tracking. Please try again.';
          errorEl.classList.add('show');
        }
      });
    }
  }

  // Helpers
  function generateAppNumber(len = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < len; i++) {
      out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  function dataURLToBlob(dataURL) {
    const [head, body] = dataURL.split(',');
    const mime = head.match(/:(.*?);/)[1];
    const binary = atob(body);
    const u8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }
});