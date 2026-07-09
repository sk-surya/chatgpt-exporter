// ── ChatGPT Project Mapper (bookmarklet) ──────────────────────────────
// Paste into browser console on chatgpt.com, or build into a bookmarklet.
//
// Fetches project metadata (project list + per-project conversation IDs)
// from the ChatGPT backend API. Shows a diff against any previously-saved
// mapping, then downloads the updated project-mapping.json.
//
// Pair with sync.mjs: copy the downloaded project-mapping.json into your
// data directory and run:
//   node sync.mjs <data-dir> --mapping-only
// to rebuild the projects/ symlink tree.
// ───────────────────────────────────────────────────────────────────────

(async () => {
  const API = '/backend-api';
  const DELAY = 800;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── Auth ──────────────────────────────────────────────────────────

  async function getToken() {
    if (window.__mapperToken) return window.__mapperToken;
    const resp = await fetch('/api/auth/session');
    const data = await resp.json();
    window.__mapperToken = data.accessToken;
    return data.accessToken;
  }

  // ── API fetchers ──────────────────────────────────────────────────

  async function fetchProjects(token) {
    const projects = {};
    let cursor = null, hasMore = true;

    while (hasMore) {
      let url = `${API}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`Project list: HTTP ${resp.status}`);

      const data = await resp.json();
      if (data.items?.length > 0) {
        for (const item of data.items) {
          const g = item.gizmo?.gizmo || item.gizmo;
          if (!g?.id) continue;
          projects[g.id] = {
            id: g.id, name: g.display?.name || 'Untitled Project',
            description: g.display?.description || '',
            instructions: g.instructions || '',
            workspace_id: g.workspace_id || null,
            created_at: g.created_at || null, updated_at: g.updated_at || null,
            num_interactions: g.num_interactions || 0,
            files: (item.gizmo?.files || []).map(f => ({ id: f.id, file_id: f.file_id, name: f.name, type: f.type, size: f.size })),
            conversation_ids: [],
          };
        }
      }
      cursor = data.cursor || null;
      if (!cursor) hasMore = false;
      await sleep(DELAY);
    }
    return projects;
  }

  async function fetchProjectConvs(token, projectId) {
    const convs = [];
    let cursor = '', hasMore = true;

    while (hasMore) {
      const url = `${API}/gizmos/${projectId}/conversations?cursor=${encodeURIComponent(cursor)}`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!resp.ok) { console.error(`  Warning: project ${projectId}: HTTP ${resp.status}`); break; }

      const data = await resp.json();
      if (data.items?.length > 0) {
        for (const c of data.items) {
          convs.push({ id: c.id, title: c.title || 'Untitled', create_time: c.create_time || null, update_time: c.update_time || null });
        }
      }
      cursor = data.cursor || null;
      if (!cursor) hasMore = false;
      await sleep(DELAY);
    }
    return convs;
  }

  // ── Diff ──────────────────────────────────────────────────────────

  function diffMapping(old, fresh) {
    const oldConvs = old?.conversations || {}, newConvs = fresh.conversations || {};
    const oldProjects = old?.projects || {}, newProjects = fresh.projects || {};
    const c = { moved: [], addedToProject: [], removedFromProject: [], newConversations: [], disappeared: [], projectsRenamed: [], projectsNew: [], projectsRemoved: [] };

    for (const [pid, proj] of Object.entries(newProjects)) {
      if (!oldProjects[pid]) c.projectsNew.push({ id: pid, name: proj.name });
      else if (oldProjects[pid].name !== proj.name) c.projectsRenamed.push({ id: pid, oldName: oldProjects[pid].name, newName: proj.name });
    }
    for (const pid of Object.keys(oldProjects)) {
      if (!newProjects[pid]) c.projectsRemoved.push({ id: pid, name: oldProjects[pid].name });
    }
    for (const [cid, conv] of Object.entries(newConvs)) {
      const oldC = oldConvs[cid];
      if (!oldC) c.newConversations.push({ id: cid, title: conv.title, project_name: (newProjects[conv.project_id] || {}).name || '?' });
      else if (oldC.project_id !== conv.project_id) c.moved.push({ id: cid, title: conv.title, fromName: (oldProjects[oldC.project_id] || {}).name || '?', toName: (newProjects[conv.project_id] || {}).name || '?' });
    }
    for (const [cid, conv] of Object.entries(oldConvs)) {
      const freshC = newConvs[cid];
      if (!freshC) c.disappeared.push({ id: cid, title: conv.title, wasProjectName: (oldProjects[conv.project_id] || {}).name || '?' });
      else if (!freshC.project_id && conv.project_id) c.removedFromProject.push({ id: cid, title: conv.title, fromName: (oldProjects[conv.project_id] || {}).name || '?' });
      else if (freshC.project_id && !conv.project_id) c.addedToProject.push({ id: cid, title: conv.title, toName: (newProjects[freshC.project_id] || {}).name || '?' });
    }
    return c;
  }

  // ── UI ────────────────────────────────────────────────────────────

  function showError(msg) {
    document.getElementById('pm-overlay')?.remove();
    alert('Project Mapper: ' + msg);
    throw new Error(msg);
  }

  const overlay = document.createElement('div');
  overlay.id = 'pm-overlay';
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif">
      <div style="background:#1e293b;border-radius:14px;padding:32px;max-width:600px;width:90%;color:#e2e8f0;box-shadow:0 20px 40px rgba(0,0,0,0.4)">
        <h2 style="margin:0 0 4px;font-size:18px;color:#f8fafc">Project Mapper</h2>
        <p id="pm-status" style="color:#94a3b8;font-size:13px;margin:0 0 16px">Connecting...</p>
        <div id="pm-report" style="font-size:12px;max-height:340px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:14px;margin-bottom:16px;font-family:monospace;color:#94a3b8;white-space:pre-wrap;line-height:1.5"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="pm-save" style="display:none;padding:8px 20px;background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500">Download project-mapping.json</button>
          <button id="pm-close" style="padding:8px 20px;background:#334155;color:#e2e8f0;border:none;border-radius:8px;cursor:pointer;font-size:13px">Close</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const statusEl = document.getElementById('pm-status');
  const reportEl = document.getElementById('pm-report');
  const saveBtn = document.getElementById('pm-save');
  document.getElementById('pm-close').addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });

  function status(t) { statusEl.textContent = t; }
  function report(t) { reportEl.textContent += t + '\n'; }

  // ── Main ──────────────────────────────────────────────────────────

  try {
    status('Getting auth token...');
    const token = await getToken();
    if (!token) showError('Could not get access token. Are you logged in?');

    status('Fetching projects...');
    const projects = await fetchProjects(token);

    const pids = Object.keys(projects);
    status(`Found ${pids.length} projects. Fetching conversations...`);

    const conversations = {};
    for (let i = 0; i < pids.length; i++) {
      status(`[${i + 1}/${pids.length}] "${projects[pids[i]].name}"...`);
      const convs = await fetchProjectConvs(token, pids[i]);
      projects[pids[i]].conversation_ids = convs.map(c => c.id);
      for (const c of convs) conversations[c.id] = { project_id: pids[i], title: c.title };
    }

    const freshMapping = { version: 1, updated_at: new Date().toISOString(), projects, conversations };

    // Diff against localStorage
    let oldMapping = null;
    try {
      const stored = localStorage.getItem('chatgpt-project-mapping');
      if (stored) oldMapping = JSON.parse(stored);
    } catch {}

    const changes = diffMapping(oldMapping, freshMapping);

    status('');
    report(`Projects:              ${pids.length}`);
    report(`Project conversations: ${Object.keys(conversations).length}`);

    if (!oldMapping) {
      report('\nFirst run — no previous mapping to compare.');
    } else {
      const c = changes;
      if (c.projectsNew.length) { report(`\nNew projects (${c.projectsNew.length}):`); c.projectsNew.forEach(p => report(`   + "${p.name}"`)); }
      if (c.projectsRemoved.length) { report(`\nRemoved projects (${c.projectsRemoved.length}):`); c.projectsRemoved.forEach(p => report(`   - "${p.name}"`)); }
      if (c.projectsRenamed.length) { report(`\nRenamed (${c.projectsRenamed.length}):`); c.projectsRenamed.forEach(p => report(`   "${p.oldName}" -> "${p.newName}"`)); }
      if (c.moved.length) { report(`\nMoved between projects (${c.moved.length}):`); c.moved.forEach(x => report(`   "${x.title}"  ${x.fromName} -> ${x.toName}`)); }
      if (c.addedToProject.length) { report(`\nAdded to project (${c.addedToProject.length}):`); c.addedToProject.forEach(x => report(`   "${x.title}"  -> ${x.toName}`)); }
      if (c.removedFromProject.length) { report(`\nRemoved from project (${c.removedFromProject.length}):`); c.removedFromProject.forEach(x => report(`   "${x.title}"  was in ${x.fromName}`)); }
      if (c.newConversations.length) { report(`\nNew in projects (${c.newConversations.length}):`); c.newConversations.forEach(x => report(`   "${x.title}"  in ${x.project_name}`)); }
      if (c.disappeared.length) { report(`\nDisappeared (${c.disappeared.length}):`); c.disappeared.forEach(x => report(`   "${x.title}"  was in ${x.wasProjectName}`)); }

      const total = c.moved.length + c.addedToProject.length + c.removedFromProject.length + c.newConversations.length + c.disappeared.length + c.projectsRenamed.length + c.projectsNew.length + c.projectsRemoved.length;
      if (total === 0) report('\nNo changes -- up to date.');
    }

    saveBtn.style.display = 'block';
    saveBtn.addEventListener('click', () => {
      localStorage.setItem('chatgpt-project-mapping', JSON.stringify(freshMapping));
      const blob = new Blob([JSON.stringify(freshMapping, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'project-mapping.json'; a.click();
      URL.revokeObjectURL(url);
      saveBtn.textContent = 'Downloaded';
      saveBtn.style.background = '#16a34a';
    });

  } catch (err) {
    status('Error');
    report(`\n${err.message}`);
    console.error(err);
  }
})();
