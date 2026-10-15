const userSelect = document.getElementById('userSelect');
const emailTableBody = document.getElementById('emailTableBody');
const refreshBtn = document.getElementById('refreshBtn');

const modalOverlay = document.getElementById('modalOverlay');
const modalClose = document.getElementById('modalClose');
const modalSubject = document.getElementById('modalSubject');
const modalDate = document.getElementById('modalDate');
const modalFrom = document.getElementById('modalFrom');
const modalSubjectLine = document.getElementById('modalSubjectLine');
const modalBody = document.getElementById('modalBody');

let users = [];
let currentUser = null;
let currentEmails = [];


async function loadUsers() {
  try {
    const res = await fetch('/api/users');

    if (!res.ok) {
      throw new Error('Failed to load users');
    }

    users = await res.json();

    // Populate the dropdown with fetched users
    userSelect.innerHTML = '';

    if (users.length === 0) {
      userSelect.innerHTML = '<option value="">No accounts found</option>';
      emailTableBody.innerHTML = `
        <tr>
          <td colspan="3" class="empty-row">No accounts available</td>
        </tr>
      `;
      return;
    }

    // Add all users to the dropdown
    users.forEach((u) => {
      const option = document.createElement('option');
      option.value = u.id;
      option.textContent = u.email;
      userSelect.appendChild(option);
    });

    // Handle dropdown selection changes
    userSelect.onchange = () => {
      const selectedId = userSelect.value;
      const user = users.find((u) => String(u.id) === String(selectedId));
      if (user) {
        selectUser(user);
      }
    };

    // Automatically select the active user in dropdown and fetch their emails
    await selectUser(users[0]);
  } catch (err) {
    console.error('Failed to load users:', err);
    emailTableBody.innerHTML = `
      <tr>
        <td colspan="3" class="empty-row">Failed to load accounts: ${escapeHtml(err.message)}</td>
      </tr>
    `;
  }
}


async function selectUser(user) {
  currentUser = user;
  userSelect.value = user.id;
  await fetchEmails();
}

async function fetchEmails(forceRefresh = false, isSilent = false) {
  if (!currentUser) {
    return;
  }

  // Only show "Loading..." if the table is completely empty (initial load)
  if (!isSilent && currentEmails.length === 0) {
    emailTableBody.innerHTML = '<tr><td colspan="3" class="empty-row">Loading...</td></tr>';
  }

  try {
    const url = `/api/emails/${currentUser.id}${forceRefresh ? '?refresh=1' : ''}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      throw new Error(data.error);
    }

    currentEmails = data.emails;
    renderTable();
  } catch (err) {
    if (!isSilent) {
      emailTableBody.innerHTML = `<tr><td colspan="3" class="empty-row">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
    console.error(err);
  }
}

function renderTable() {
  emailTableBody.innerHTML = '';

  if (currentEmails.length === 0) {
    emailTableBody.innerHTML = '<tr><td colspan="3" class="empty-row">No emails found</td></tr>';
    return;
  }

  currentEmails.forEach((email, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>
        <div class="row-from">From: ${escapeHtml(email.from)}</div>
        <div class="row-subject">Subject: ${escapeHtml(email.subject)}</div>
      </td>
      <td>${formatTime(email.date)}</td>
    `;
    tr.onclick = () => openModal(idx);
    emailTableBody.appendChild(tr);
  });
}

async function openModal(idx) {
  const email = currentEmails[idx];

  modalSubject.textContent = email.subject;
  modalDate.textContent = formatFullDate(email.date);
  modalFrom.textContent = email.from;
  modalSubjectLine.textContent = email.subject;
  modalBody.innerHTML = '<div style="padding:20px;color:#8e8e93;">Loading...</div>';

  modalOverlay.classList.remove('hidden');

  try {
    const res = await fetch(`/api/email/${currentUser.id}/${email.seqno}`);
    const data = await res.json();

    if (data.error) throw new Error(data.error);

    if (data.html) {
      modalBody.innerHTML = `<iframe srcdoc="${escapeAttr(data.html)}"></iframe>`;
    } else {
      modalBody.innerHTML = `<pre>${escapeHtml(data.text || '(No content)')}</pre>`;
    }
  } catch (err) {
    modalBody.innerHTML = `<pre>Failed to load: ${escapeHtml(err.message)}</pre>`;
  }
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  modalBody.innerHTML = '';
}

function formatTime(d) {
  if (!d) return '';
  const date = new Date(d);
  const now = new Date();

  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday, ' + date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) +
    ', ' +
    date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatFullDate(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;');
}

refreshBtn.onclick = async () => {
  if (!currentUser) {
    return;
  }

  refreshBtn.classList.add('spinning');

  try {
    await fetchEmails(true);
  } finally {
    setTimeout(() => {
      refreshBtn.classList.remove('spinning');
    }, 600);
  }
};

modalClose.onclick = closeModal;

modalOverlay.onclick = (e) => {
  if (e.target === modalOverlay) {
    closeModal();
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    closeModal();
  }
});

loadUsers();

// Auto-sync every 15 seconds without reloading the page or flickering the screen
setInterval(() => {
  if (currentUser && modalOverlay.classList.contains('hidden')) {
    fetchEmails(true, true);
  }
}, 15000);