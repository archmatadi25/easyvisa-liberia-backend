document.addEventListener('DOMContentLoaded', () => {
  const tbody = document.getElementById('appTbody');
  const statusMsg = document.getElementById('statusMsg');
  const logoutBtn = document.getElementById('logoutBtn');

  const statTotal = document.getElementById('statTotal');
  const statPending = document.getElementById('statPending');
  const statApproved = document.getElementById('statApproved');
  const statRejected = document.getElementById('statRejected');

  const searchInput = document.getElementById('searchInput');
  const statusFilter = document.getElementById('statusFilter');
  const pageSizeSel = document.getElementById('pageSize');
  const pagi = document.getElementById('pagi');

  let allApps = [];
  let viewApps = [];
  let currentPage = 1;

  function showMsg(text, type = 'success') {
    statusMsg.textContent = text;
    statusMsg.className = `msg ${type}`;
    statusMsg.style.display = 'block';
    setTimeout(() => (statusMsg.style.display = 'none'), 1600);
  }

  function statusBadge(status) {
    const s = (status || '').toLowerCase();
    if (s.startsWith('approved')) return `<span class="badge b-approved">Approved</span>`;
    if (s.startsWith('reject')) return `<span class="badge b-rejected">Rejected</span>`;
    return `<span class="badge b-pending">Pending Review</span>`;
    }

  function copyBtn(text) {
    return `<button class="copy" data-copy="${text}">Copy</button>`;
  }

  function fileLink(name) {
    if (!name) return `<span style="color:#90a4ae">—</span>`;
    return `<a href="/uploads/${encodeURIComponent(name)}" target="_blank" rel="noopener">Download</a>`;
  }

  function renderStats(list) {
    const total = list.length;
    const pending = list.filter(a => (a.status || '').toLowerCase().startsWith('pending')).length;
    const approved = list.filter(a => (a.status || '').toLowerCase().startsWith('approved')).length;
    const rejected = list.filter(a => (a.status || '').toLowerCase().startsWith('reject')).length;

    statTotal.textContent = total;
    statPending.textContent = pending;
    statApproved.textContent = approved;
    statRejected.textContent = rejected;
  }

  function applyFilters() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const s = statusFilter.value;

    viewApps = allApps.filter(a => {
      const hit =
        (a.appNumber || '').toString().toLowerCase().includes(q) ||
        `${a.firstname || ''} ${a.lastname || ''}`.toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q) ||
        (a.passport || '').toLowerCase().includes(q);

      const statusOk = s ? (a.status === s) : true;
      return hit && statusOk;
    });

    renderStats(viewApps);
    currentPage = 1;
    renderTable();
  }

  function renderTable() {
    const size = parseInt(pageSizeSel.value || '10', 10);
    const totalPages = Math.max(1, Math.ceil(viewApps.length / size));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * size;
    const pageItems = viewApps.slice(start, start + size);

    if (pageItems.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty">No applications found.</td></tr>`;
      pagi.style.display = 'none';
      return;
    }

    tbody.innerHTML = pageItems.map(a => {
      const fullName = `${a.firstname || ''} ${a.lastname || ''}`.trim();
      return `
        <tr data-app="${a.appNumber}">
          <td class="mono">${a.appNumber || ''}<br/>${copyBtn(a.appNumber || '')}</td>
          <td>${fullName || '—'}</td>
          <td><a href="mailto:${a.email || ''}">${a.email || '—'}</a></td>
          <td>${a.nationality || '—'}</td>
          <td class="mono">${a.passport || '—'}</td>
          <td>${fileLink(a.passportFileName)}</td>
          <td>${statusBadge(a.status)}</td>
          <td>
            <select class="status-select">
              <option ${a.status === 'Pending Review' ? 'selected' : ''}>Pending Review</option>
              <option ${a.status === 'Approved' ? 'selected' : ''}>Approved</option>
              <option ${a.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
            </select>
          </td>
          <td><button class="action-btn">Save</button></td>
        </tr>
      `;
    }).join('');

    // Pagination
    if (totalPages > 1) {
      let html = '';
      for (let p = 1; p <= totalPages; p++) {
        html += `<button class="${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
      }
      pagi.innerHTML = html;
      pagi.style.display = 'flex';
    } else {
      pagi.style.display = 'none';
    }
  }

  // Copy to clipboard / Save click handlers
  tbody.addEventListener('click', async (e) => {
    const btn = e.target;
    // Copy application number
    if (btn.matches('.copy')) {
      const text = btn.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 800);
      } catch (_) {
        showMsg('Copy failed', 'error');
      }
      return;
    }

    // Save status
    if (btn.matches('.action-btn')) {
      const tr = btn.closest('tr');
      const appNumber = tr?.getAttribute('data-app');
      const select = tr?.querySelector('.status-select');
      if (!appNumber || !select) return;

      const newStatus = select.value;

      try {
        const res = await fetch('/admin/update-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ appNumber, status: newStatus })
        });

        if (res.ok) {
          // update local cache & rerender
          const idx = allApps.findIndex(a => a.appNumber === appNumber);
          if (idx >= 0) allApps[idx].status = newStatus;
          applyFilters();
          showMsg('Status updated');
        } else {
          const data = await res.json().catch(() => ({}));
          showMsg(data.message || 'Update failed', 'error');
        }
      } catch (err) {
        console.error('Update error:', err);
        showMsg('Network error', 'error');
      }
    }
  });

  // Pagination click
  document.getElementById('pagi').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b) return;
    currentPage = parseInt(b.getAttribute('data-page'), 10);
    renderTable();
  });

  // Debounced search
  let t;
  searchInput.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(applyFilters, 180);
  });
  statusFilter.addEventListener('change', applyFilters);
  pageSizeSel.addEventListener('change', () => { currentPage = 1; renderTable(); });

  // Logout
  logoutBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
      if (res.ok) {
        window.location.href = 'admin.html';
      } else {
        showMsg('Logout failed', 'error');
      }
    } catch (err) {
      showMsg('Logout error', 'error');
    }
  });

  // Initial load
  async function load() {
    try {
      const res = await fetch('/admin/applications', { credentials: 'same-origin' });
      if (res.status === 403 || res.status === 401) {
        window.location.href = 'admin.html';
        return;
      }
      const data = await res.json();
      allApps = Array.isArray(data) ? data : [];
      viewApps = allApps.slice();
      renderStats(allApps);
      renderTable();
    } catch (err) {
      console.error('Load error:', err);
      tbody.innerHTML = `<tr><td colspan="9" class="empty">Failed to load applications.</td></tr>`;
    }
  }

  load();
});