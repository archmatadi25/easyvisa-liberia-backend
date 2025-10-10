document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('appTableContainer');
  const statusMsg = document.getElementById('statusMsg');
  const logoutBtn = document.getElementById('logoutBtn');
  const searchInput = document.getElementById('searchInput');

  try {
    const res = await fetch('/admin/applications');
    const apps = await res.json();

    if (!apps.length) {
      container.innerHTML = '<p>No applications found.</p>';
      return;
    }

    let table = `<table class="app-table">
      <thead>
        <tr>
          <th>Application #</th>
          <th>Name</th>
          <th>Email</th>
          <th>Nationality</th>
          <th>Passport No.</th>
          <th>Passport File</th>
          <th>Status</th>
          <th>Update</th>
        </tr>
      </thead>
      <tbody>`;

    apps.forEach(app => {
      const passportLink = app.passportFileName
        ? `<a href="/uploads/${app.passportFileName}" download target="_blank">Download</a>`
        : 'N/A';

      table += `<tr>
        <td>${app.appNumber}</td>
        <td>${app.firstname} ${app.lastname}</td>
        <td>${app.email}</td>
        <td>${app.nationality}</td>
        <td>${app.passport}</td>
        <td>${passportLink}</td>
        <td>
          <select data-id="${app.appNumber}" class="status-select">
            <option ${app.status === 'Pending Review' ? 'selected' : ''}>Pending Review</option>
            <option ${app.status === 'Approved' ? 'selected' : ''}>Approved</option>
            <option ${app.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
          </select>
        </td>
        <td><button data-id="${app.appNumber}" class="btn update-btn">Save</button></td>
      </tr>`;
    });

    table += `</tbody></table>`;
    container.innerHTML = table;

    // 🔄 Status update functionality
    document.querySelectorAll('.update-btn').forEach(button => {
      button.addEventListener('click', async (e) => {
        const appNumber = e.target.getAttribute('data-id');
        const select = document.querySelector(`select[data-id="${appNumber}"]`);
        const newStatus = select.value;

        try {
          const updateRes = await fetch(`/admin/update-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appNumber, status: newStatus })
          });

          if (updateRes.ok) {
            statusMsg.textContent = `✅ Status updated for ${appNumber}`;
            statusMsg.className = 'success-msg';
          } else {
            statusMsg.textContent = `❌ Failed to update status for ${appNumber}`;
            statusMsg.className = 'error-msg';
          }

          statusMsg.style.display = 'block';
          setTimeout(() => statusMsg.style.display = 'none', 4000);
        } catch (err) {
          console.error(err);
          statusMsg.textContent = 'Server error updating status.';
          statusMsg.className = 'error-msg';
          statusMsg.style.display = 'block';
        }
      });
    });

    // 🔍 Live search/filter
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        const query = this.value.toLowerCase();
        const rows = document.querySelectorAll('.app-table tbody tr');

        rows.forEach(row => {
          const rowText = row.textContent.toLowerCase();
          row.style.display = rowText.includes(query) ? '' : 'none';
        });
      });
    }

  } catch (err) {
    console.error('Failed to load applications:', err);
    container.innerHTML = '<p>Error loading applications.</p>';
  }

  // ✅ Secure Logout
  logoutBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/admin/logout', { method: 'POST' });
      if (res.ok) {
        window.location.href = 'admin.html';
      } else {
        alert('Logout failed.');
      }
    } catch (err) {
      console.error('Logout error:', err);
      alert('Logout error.');
    }
  });
});
