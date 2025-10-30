async function fetchSetups() {
  const res = await fetch('/api/setups');
  return res.json();
}

function renderSetups(setups) {
  const container = document.getElementById('setupsList');
  container.innerHTML = '';
  const arr = Object.values(setups).sort((a,b) => a.id.localeCompare(b.id));
  if (arr.length === 0) container.innerText = 'No setups yet.';
  for (const s of arr) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <h4>${s.name || s.id}</h4>
      <p>${s.description || ''}</p>
      <p><strong>Collect:</strong> ${s.collectDuration || s.collect || 30}s · <strong>Base entries:</strong> ${s.baseEntries || 1}</p>
      <pre style="white-space:pre-wrap">${JSON.stringify(s.roleEntries || [], null, 2)}</pre>
      <p>To start this setup from Discord type: <code>$start ${s.name || s.id}</code></p>
      <button data-id="${s.id}" class="del">Delete</button>
    `;
    container.appendChild(el);
  }

  container.querySelectorAll('.del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Delete setup?')) return;
      await fetch(`/api/setups/${id}`, { method: 'DELETE' });
      load();
    });
  });
}

async function load() {
  const setups = await fetchSetups();
  renderSetups(setups);
}

document.getElementById('create').addEventListener('click', async () => {
  const name = document.getElementById('name').value.trim();
  const description = document.getElementById('desc').value.trim();
  const collectDuration = parseInt(document.getElementById('collect').value || '30', 10);
  const baseEntries = parseInt(document.getElementById('baseEntries').value || '1', 10);
  let roleEntries = [];
  try {
    roleEntries = JSON.parse(document.getElementById('roleEntries').value || '[]');
  } catch (e) { alert('roleEntries must be valid JSON'); return; }
  if (!name) { alert('Name required'); return; }
  const body = { name, description, collectDuration, baseEntries, roleEntries };
  await fetch('/api/setups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('name').value = '';
  document.getElementById('desc').value = '';
  document.getElementById('roleEntries').value = '[]';
  load();
});

load();
