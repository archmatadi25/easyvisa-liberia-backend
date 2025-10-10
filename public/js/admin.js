document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('adminLoginForm');
  const errorMsg = document.getElementById('loginError');
  const submitBtn = loginForm.querySelector('button[type="submit"]');

  function showError(msg) {
    if (!errorMsg) return;
    errorMsg.textContent = msg || 'Something went wrong.';
    errorMsg.style.display = 'block';
  }

  function clearError() {
    if (!errorMsg) return;
    errorMsg.textContent = '';
    errorMsg.style.display = 'none';
  }

  // Clear error when user types
  ['adminUsername', 'adminPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', clearError);
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const username = document.getElementById('adminUsername').value.trim();
    const password = document.getElementById('adminPassword').value;

    if (!username || !password) {
      showError('Please enter both username and password.');
      return;
    }

    // Button UX
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in…';

    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Ensure session cookie is included
        credentials: 'same-origin',
        body: JSON.stringify({ username, password })
      });

      if (res.ok) {
        // ✅ Redirect to dashboard
        window.location.href = 'dashboard.html';
        return;
      }

      // Handle common error cases
      if (res.status === 429) {
        showError('Too many login attempts. Please try again later.');
        return;
      }

      let data = {};
      try { data = await res.json(); } catch (_) {}
      showError(data.message || 'Invalid credentials.');
    } catch (err) {
      console.error('Login error:', err);
      showError('Network error. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
});