document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('adminLoginForm');
  const errorMsg = document.getElementById('loginError');

  // LOGIN HANDLER
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('adminUsername').value;
    const password = document.getElementById('adminPassword').value;

    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (res.ok) {
        // ✅ Redirect to dashboard
        window.location.href = 'dashboard.html';
      } else {
        errorMsg.textContent = 'Invalid credentials.';
        errorMsg.style.display = 'block';
      }
    } catch (err) {
      console.error(err);
      errorMsg.textContent = 'Something went wrong.';
      errorMsg.style.display = 'block';
    }
  });
});
