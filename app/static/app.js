// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let allVideos = [];
let activeJobId = null;
let activeEventSource = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function qs(sel) { return document.querySelector(sel); }

function appendLog(text, cls) {
  const box = qs('#log-box');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog() { qs('#log-box').innerHTML = ''; }

function setBadge(status) {
  const badge = qs('#job-status-badge');
  badge.textContent = status;
  badge.className = 'badge';
  if (status === 'running') badge.classList.add('badge-running');
  else if (status === 'done') badge.classList.add('badge-done');
  else if (status === 'error') badge.classList.add('badge-error');
  else badge.textContent = '';
}

function logClass(line) {
  if (line.includes('>> opened window')) return 'log-open';
  if (line.includes('>> closed window')) return 'log-close';
  if (line.includes('ERROR')) return 'log-error';
  if (line.includes('% video scanned')) return 'log-progress';
  return null;
}

function setButtonsDisabled(disabled) {
  qs('#start-scan-btn').disabled = disabled;
  qs('#start-clips-btn').disabled = disabled;
}

// ---------------------------------------------------------------------------
// Competitor lists
// ---------------------------------------------------------------------------
async function loadLists() {
  const data = await fetch('/api/lists').then(r => r.json());
  renderLists(data);
  populateScanListSelect(data);
}

function renderLists(data) {
  const ul = qs('#lists-ul');
  const empty = qs('#lists-empty');
  ul.innerHTML = '';
  const names = Object.keys(data);
  empty.style.display = names.length ? 'none' : 'block';
  names.forEach(name => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="list-name">${name} <small style="color:#555">(${data[name].length} names)</small></span>
      <span class="list-actions">
        <button class="btn-danger" data-edit="${name}" title="Edit">edit</button>
        <button class="btn-danger" data-delete="${name}" title="Delete">✕</button>
      </span>`;
    ul.appendChild(li);
  });
}

function populateScanListSelect(data) {
  const sel = qs('#scan-list-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- select a list --</option>';
  Object.keys(data).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

qs('#save-list-btn').addEventListener('click', async () => {
  const name = qs('#list-name-input').value.trim();
  const raw = qs('#competitors-textarea').value;
  if (!name) { alert('Enter a list name.'); return; }
  const competitors = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!competitors.length) { alert('Enter at least one competitor.'); return; }
  await fetch('/api/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, competitors }),
  });
  loadLists();
});

qs('#clear-form-btn').addEventListener('click', () => {
  qs('#list-name-input').value = '';
  qs('#competitors-textarea').value = '';
});

qs('#lists-ul').addEventListener('click', async (e) => {
  const editName = e.target.dataset.edit;
  const deleteName = e.target.dataset.delete;
  if (editName) {
    const data = await fetch('/api/lists').then(r => r.json());
    qs('#list-name-input').value = editName;
    qs('#competitors-textarea').value = (data[editName] || []).join('\n');
  }
  if (deleteName) {
    if (!confirm(`Delete list "${deleteName}"?`)) return;
    await fetch(`/api/lists/${encodeURIComponent(deleteName)}`, { method: 'DELETE' });
    loadLists();
  }
});

// ---------------------------------------------------------------------------
// Video browser
// ---------------------------------------------------------------------------
async function loadVideos() {
  allVideos = await fetch('/api/videos').then(r => r.json());
  renderVideos(allVideos);
}

function renderVideos(videos) {
  const container = qs('#video-list');
  const empty = qs('#video-empty');
  container.innerHTML = '';
  empty.style.display = videos.length ? 'none' : 'block';
  container.style.display = videos.length ? 'flex' : 'none';
  videos.forEach(v => {
    const item = document.createElement('label');
    item.className = 'file-item';
    item.innerHTML = `
      <input type="checkbox" value="${v.path}">
      <span>
        <div class="file-name">${v.name}</div>
        <div class="file-path">${v.relative}</div>
      </span>`;
    item.querySelector('input').addEventListener('change', e => {
      item.classList.toggle('checked', e.target.checked);
    });
    container.appendChild(item);
  });
}

qs('#video-filter').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  renderVideos(allVideos.filter(v => v.relative.toLowerCase().includes(q)));
});

function getSelectedVideos() {
  return [...qs('#video-list').querySelectorAll('input:checked')].map(i => i.value);
}

// ---------------------------------------------------------------------------
// Results file list (for clips + viewer) — defined later after viewer funcs
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Job streaming
// ---------------------------------------------------------------------------
function startJobStream(jobId, skipLines = 0) {
  if (activeEventSource) activeEventSource.close();
  activeJobId = jobId;
  setBadge('running');
  setButtonsDisabled(true);

  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  activeEventSource = es;
  let received = 0;

  es.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (typeof data === 'string') {
      if (received >= skipLines) appendLog(data, logClass(data));
      received++;
    } else if (data.status) {
      setBadge(data.status);
      setButtonsDisabled(false);
      es.close();
      if (data.status === 'done') loadResults();
    }
  };

  es.onerror = () => {
    setBadge('error');
    setButtonsDisabled(false);
    es.close();
  };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
qs('#start-scan-btn').addEventListener('click', async () => {
  const listName = qs('#scan-list-select').value;
  const videos = getSelectedVideos();
  const resultsFile = qs('#results-file-input').value.trim() || 'results.csv';
  const intervalSeconds = parseFloat(qs('#interval-input').value);
  const gapTolerance = parseInt(qs('#gap-input').value);

  if (!listName) { alert('Select a competitor list.'); return; }
  if (!videos.length) { alert('Select at least one video file.'); return; }

  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos, list_name: listName, interval_seconds: intervalSeconds, gap_tolerance: gapTolerance, results_file: resultsFile }),
  });

  if (!res.ok) { alert(`Error: ${(await res.json()).detail}`); return; }
  const { job_id } = await res.json();
  clearLog();
  startJobStream(job_id);
});

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------
qs('#start-clips-btn').addEventListener('click', async () => {
  const resultsFile = qs('#clips-results-select').value;
  const clipPadding = parseFloat(qs('#padding-input').value);
  const clipsDir = qs('#clips-dir-input').value.trim() || 'clips';

  if (!resultsFile) { alert('Select a results file.'); return; }

  const res = await fetch('/api/clips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results_file: resultsFile, clip_padding: clipPadding, clips_dir: clipsDir }),
  });

  if (!res.ok) { alert(`Error: ${(await res.json()).detail}`); return; }
  const { job_id } = await res.json();
  clearLog();
  startJobStream(job_id);
});

// ---------------------------------------------------------------------------
// Results viewer
// ---------------------------------------------------------------------------
async function populateViewResultsSelect(files) {
  const sel = qs('#view-results-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- select results --</option>';
  files.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    if (f === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function viewResults(filename) {
  const rows = await fetch(`/api/results/${encodeURIComponent(filename)}`).then(r => r.json());
  const tbody = qs('#results-tbody');
  const wrap = qs('#results-table-wrap');
  const empty = qs('#results-viewer-empty');
  const count = qs('#results-viewer-count');

  tbody.innerHTML = '';

  if (!rows.length) {
    wrap.style.display = 'none';
    empty.style.display = 'block';
    count.textContent = '';
    return;
  }

  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name-cell">${row.name}</td>
      <td class="time-cell">${row.start}</td>
      <td class="time-cell">${row.end}</td>
      <td class="file-cell">${row.video_file}</td>`;
    tbody.appendChild(tr);
  });

  wrap.style.display = 'block';
  empty.style.display = 'none';
  count.textContent = `(${rows.length} match${rows.length !== 1 ? 'es' : ''})`;
}

qs('#view-results-btn').addEventListener('click', () => {
  const filename = qs('#view-results-select').value;
  if (!filename) { alert('Select a results file.'); return; }
  viewResults(filename);
});

async function loadResults() {
  const files = await fetch('/api/results').then(r => r.json());
  const sel = qs('#clips-results-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- select results --</option>';
  files.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    if (f === prev) opt.selected = true;
    sel.appendChild(opt);
  });
  populateViewResultsSelect(files);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function checkActiveJob() {
  const job = await fetch('/api/active-job').then(r => r.json());
  if (job.job_id && job.status === 'running') {
    clearLog();
    setBadge('running');
    setButtonsDisabled(true);
    // replay existing log lines then stream the rest without duplicating them
    job.log.forEach(line => appendLog(line, logClass(line)));
    startJobStream(job.job_id, job.log.length);
  }
}

loadLists();
loadVideos();
loadResults();
checkActiveJob();
