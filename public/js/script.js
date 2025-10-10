document.addEventListener('DOMContentLoaded', () => {
  const paymentBtn = document.getElementById('proceedToPayment');

  // When "Proceed to Payment" is clicked
  if (paymentBtn) {
    paymentBtn.addEventListener('click', async () => {
      const file = document.getElementById('passportFile').files[0];
      if (file && file.size > 10 * 1024 * 1024) {
        alert("File is too large. Please upload a file under 10MB.");
        return;
      }

      // Generate unique 16-character application number
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let appNumber = '';
      for (let i = 0; i < 16; i++) {
        appNumber += chars.charAt(Math.floor(Math.random() * chars.length));
      }

      const data = {
        firstname: document.getElementById('firstname').value.trim(),
        middlename: document.getElementById('middlename').value.trim(),
        lastname: document.getElementById('lastname').value.trim().toUpperCase(),
        dob: document.getElementById('dob').value,
        email: document.getElementById('email').value.trim(),
        nationality: document.getElementById('nationality').value,
        passport: document.getElementById('passport').value.trim(),
        appNumber
      };

      // Store user data temporarily
      localStorage.setItem('pendingApplication', JSON.stringify(data));

      const reader = new FileReader();
      reader.onload = () => {
        localStorage.setItem('passportFileBase64', reader.result);
        localStorage.setItem('passportFileName', file.name);
      };
      if (file) {
        reader.readAsDataURL(file);
      }

      try {
        const response = await fetch('/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: data.email })
        });

        const result = await response.json();
        if (result.url) {
          window.location.href = result.url;
        } else {
          alert("Failed to initiate payment.");
        }
      } catch (err) {
        console.error("Payment setup error:", err);
        alert("An error occurred while starting payment.");
      }
    });
  }

  // Success page: submit application and file upload
  if (window.location.pathname.includes('success.html')) {
    const data = JSON.parse(localStorage.getItem('pendingApplication'));
    const base64 = localStorage.getItem('passportFileBase64');
    const filename = localStorage.getItem('passportFileName');

    if (data) {
      const formData = new FormData();
      for (const key in data) {
        formData.append(key, data[key]);
      }

      if (base64 && filename) {
        const blob = dataURLToBlob(base64);
        formData.append('passportFile', blob, filename);
      }

      fetch('/submit', {
        method: 'POST',
        body: formData
      })
        .then(response => {
          if (response.ok) {
            localStorage.setItem('latestApplication', JSON.stringify(data));
            localStorage.removeItem('pendingApplication');
            localStorage.removeItem('passportFileBase64');
            localStorage.removeItem('passportFileName');
            window.location.href = 'confirmation.html';
          } else {
            alert("Payment succeeded but submission failed. Please contact support.");
          }
        })
        .catch(err => {
          console.error("Error submitting application after payment:", err);
          alert("There was a problem submitting your application.");
        });
    } else {
      alert("No application found after payment.");
    }
  }

  // Confirmation page: show application number
  if (window.location.pathname.includes('confirmation.html')) {
    const data = JSON.parse(localStorage.getItem('latestApplication')) || {};
    const el = document.getElementById('appNumber');
    el.textContent = data?.appNumber || 'APPLICATION NUMBER NOT FOUND';
  }

  // Track application status (fixed and animated)
  if (window.location.pathname.includes('track.html')) {
    const trackForm = document.getElementById('trackForm');
    const resultEl = document.getElementById('result');
    const errorEl = document.getElementById('error');

    trackForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      // Reset UI states
      resultEl.innerHTML = '';
      errorEl.innerHTML = '';
      resultEl.classList.remove('show');
      errorEl.classList.remove('show');

      const appNumber = document.getElementById('trackNumber').value.trim().toUpperCase();
      const lastName = document.getElementById('trackLastName').value.trim();

      if (!appNumber || !lastName) {
        errorEl.textContent = 'Please enter both Application Number and Last Name.';
        errorEl.classList.add('show');
        return;
      }

      try {
        const res = await fetch('/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appNumber, lastName })
        });

        const data = await res.json();
        console.log('Track API Response:', res.status, data);

        if (res.ok) {
          resultEl.innerHTML = `
            <p><strong>Name:</strong> ${data.name}</p>
            <p><strong>Status:</strong> ${data.status}</p>
          `;
          resultEl.classList.add('show');
        } else {
          errorEl.textContent = data.message || 'Application not found.';
          errorEl.classList.add('show');
        }
      } catch (err) {
        console.error('Tracking error:', err);
        errorEl.textContent = 'An error occurred while tracking. Please try again.';
        errorEl.classList.add('show');
      }
    });
  }

  // Helper: convert base64 to Blob
  function dataURLToBlob(dataURL) {
    const parts = dataURL.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const binary = atob(parts[1]);
    let len = binary.length;
    const u8arr = new Uint8Array(len);
    while (len--) {
      u8arr[len] = binary.charCodeAt(len);
    }
    return new Blob([u8arr], { type: mime });
  }
});
