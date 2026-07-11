// ChatGPT Project Mapper — bookmarklet
// Click on chatgpt.com to fetch project metadata and download project-mapping.json
(function() {
  // Flash the page background so user knows it activated
  var origBg = document.body.style.background;
  document.body.style.background = '#1e40af';
  setTimeout(function(){ document.body.style.background = origBg; }, 300);

  var API = '/backend-api';
  var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

  // ── Fatal error: try to show something on-page before throwing ──────
  function fail(msg) {
    var el = document.getElementById('pm-overlay');
    if (el) el.remove();
    // Try banner first, fall back to alert
    try {
      var banner = document.createElement('div');
      banner.id = 'pm-banner';
      banner.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:999999;background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:90vw;text-align:center';
      banner.textContent = 'Project Mapper: ' + msg;
      document.body.appendChild(banner);
      setTimeout(function(){ banner.remove(); }, 8000);
    } catch(e) {
      alert('Project Mapper: ' + msg);
    }
    throw new Error(msg);
  }

  // ── Auth ────────────────────────────────────────────────────────────
  async function getToken() {
    if (window.__mapperToken) return window.__mapperToken;
    var resp = await fetch('/api/auth/session');
    var data = await resp.json();
    window.__mapperToken = data.accessToken;
    return data.accessToken;
  }

  // ── API fetchers ────────────────────────────────────────────────────
  async function fetchProjects(token) {
    var projects = {};
    var cursor = null;
    var hasMore = true;

    while (hasMore) {
      var url = API + '/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0';
      if (cursor) url += '&cursor=' + encodeURIComponent(cursor);

      var resp = await fetch(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      });
      if (!resp.ok) throw new Error('Project list: HTTP ' + resp.status);

      var data = await resp.json();
      if (data.items && data.items.length > 0) {
        for (var i = 0; i < data.items.length; i++) {
          var item = data.items[i];
          var g = (item.gizmo && item.gizmo.gizmo) || item.gizmo;
          if (!g || !g.id) continue;

          projects[g.id] = {
            id: g.id,
            name: (g.display && g.display.name) || 'Untitled Project',
            description: (g.display && g.display.description) || '',
            instructions: g.instructions || '',
            workspace_id: g.workspace_id || null,
            created_at: g.created_at || null,
            updated_at: g.updated_at || null,
            num_interactions: g.num_interactions || 0,
            files: (item.gizmo && item.gizmo.files || []).map(function(f) {
              return { id: f.id, file_id: f.file_id, name: f.name, type: f.type, size: f.size };
            }),
            conversation_ids: []
          };
        }
      }

      cursor = data.cursor || null;
      if (!cursor) hasMore = false;
      await sleep(800);
    }
    return projects;
  }

  async function fetchProjectConvs(token, projectId) {
    var convs = [];
    var cursor = '';
    var hasMore = true;

    while (hasMore) {
      var url = API + '/gizmos/' + projectId + '/conversations?cursor=' + encodeURIComponent(cursor);
      var resp = await fetch(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      });
      if (!resp.ok) {
        console.error('  Warning: project ' + projectId + ': HTTP ' + resp.status);
        break;
      }

      var data = await resp.json();
      if (data.items && data.items.length > 0) {
        for (var i = 0; i < data.items.length; i++) {
          var c = data.items[i];
          convs.push({
            id: c.id,
            title: c.title || 'Untitled',
            create_time: c.create_time || null,
            update_time: c.update_time || null
          });
        }
      }
      cursor = data.cursor || null;
      if (!cursor) hasMore = false;
      await sleep(800);
    }
    return convs;
  }

  // ── Diff ────────────────────────────────────────────────────────────
  function diffMapping(old, fresh) {
    var oldConvs = (old && old.conversations) || {};
    var newConvs = fresh.conversations || {};
    var oldProjects = (old && old.projects) || {};
    var newProjects = fresh.projects || {};
    var c = {
      moved: [], addedToProject: [], removedFromProject: [],
      newConversations: [], disappeared: [],
      projectsRenamed: [], projectsNew: [], projectsRemoved: []
    };

    var pids, pid, proj, oldC, freshC;
    for (pid in newProjects) {
      proj = newProjects[pid];
      if (!oldProjects[pid]) c.projectsNew.push({ id: pid, name: proj.name });
      else if (oldProjects[pid].name !== proj.name) c.projectsRenamed.push({ id: pid, oldName: oldProjects[pid].name, newName: proj.name });
    }
    for (pid in oldProjects) {
      if (!newProjects[pid]) c.projectsRemoved.push({ id: pid, name: oldProjects[pid].name });
    }
    for (var cid in newConvs) {
      var conv = newConvs[cid];
      oldC = oldConvs[cid];
      if (!oldC) {
        c.newConversations.push({ id: cid, title: conv.title, project_name: (newProjects[conv.project_id] || {}).name || '?' });
      } else if (oldC.project_id !== conv.project_id) {
        c.moved.push({ id: cid, title: conv.title, fromName: (oldProjects[oldC.project_id] || {}).name || '?', toName: (newProjects[conv.project_id] || {}).name || '?' });
      }
    }
    for (cid in oldConvs) {
      conv = oldConvs[cid];
      freshC = newConvs[cid];
      if (!freshC) {
        c.disappeared.push({ id: cid, title: conv.title, wasProjectName: (oldProjects[conv.project_id] || {}).name || '?' });
      } else if (!freshC.project_id && conv.project_id) {
        c.removedFromProject.push({ id: cid, title: conv.title, fromName: (oldProjects[conv.project_id] || {}).name || '?' });
      } else if (freshC.project_id && !conv.project_id) {
        c.addedToProject.push({ id: cid, title: conv.title, toName: (newProjects[freshC.project_id] || {}).name || '?' });
      }
    }
    return c;
  }

  // ── UI ──────────────────────────────────────────────────────────────
  var overlay = document.createElement('div');
  overlay.id = 'pm-overlay';
  overlay.innerHTML =
    '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif">' +
      '<div style="background:#1e293b;border-radius:14px;padding:32px;max-width:600px;width:90%;color:#e2e8f0;box-shadow:0 20px 40px rgba(0,0,0,0.4)">' +
        '<h2 style="margin:0 0 4px;font-size:18px;color:#f8fafc">Project Mapper</h2>' +
        '<p id="pm-status" style="color:#94a3b8;font-size:13px;margin:0 0 16px">Connecting...</p>' +
        '<div id="pm-report" style="font-size:12px;max-height:340px;overflow-y:auto;background:#0f172a;border-radius:8px;padding:14px;margin-bottom:16px;font-family:monospace;color:#94a3b8;white-space:pre-wrap;line-height:1.5"></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
          '<button id="pm-save" style="display:none;padding:8px 20px;background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500">Download project-mapping.json</button>' +
          '<button id="pm-close" style="padding:8px 20px;background:#334155;color:#e2e8f0;border:none;border-radius:8px;cursor:pointer;font-size:13px">Close</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var statusEl = document.getElementById('pm-status');
  var reportEl = document.getElementById('pm-report');
  var saveBtn = document.getElementById('pm-save');
  var closeBtn = document.getElementById('pm-close');

  closeBtn.addEventListener('click', function() { overlay.remove(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') overlay.remove(); });

  function status(t) { statusEl.textContent = t; }
  function report(t) { reportEl.textContent += t + '\n'; }

  // ── Main ────────────────────────────────────────────────────────────
  (async function() {
    try {
      status('Getting auth token...');
      var token = await getToken();
      if (!token) fail('Could not get access token. Are you logged in?');

      status('Fetching projects...');
      var projects = await fetchProjects(token);
      var pids = Object.keys(projects);
      status('Found ' + pids.length + ' projects. Fetching conversations...');

      var conversations = {};
      for (var i = 0; i < pids.length; i++) {
        status('[' + (i + 1) + '/' + pids.length + '] "' + projects[pids[i]].name + '"...');
        var convs = await fetchProjectConvs(token, pids[i]);
        projects[pids[i]].conversation_ids = convs.map(function(c) { return c.id; });
        for (var j = 0; j < convs.length; j++) {
          conversations[convs[j].id] = { project_id: pids[i], title: convs[j].title };
        }
      }

      var freshMapping = {
        version: 1,
        updated_at: new Date().toISOString(),
        projects: projects,
        conversations: conversations
      };

      // Diff against localStorage
      var oldMapping = null;
      try {
        var stored = localStorage.getItem('chatgpt-project-mapping');
        if (stored) oldMapping = JSON.parse(stored);
      } catch(e) {}

      var changes = diffMapping(oldMapping, freshMapping);

      status('');
      report('Projects:              ' + pids.length);
      report('Project conversations: ' + Object.keys(conversations).length);

      if (!oldMapping) {
        report('\nFirst run - no previous mapping to compare.');
      } else {
        var c = changes;
        if (c.projectsNew.length) { report('\nNew projects (' + c.projectsNew.length + '):'); c.projectsNew.forEach(function(p) { report('   + "' + p.name + '"'); }); }
        if (c.projectsRemoved.length) { report('\nRemoved projects (' + c.projectsRemoved.length + '):'); c.projectsRemoved.forEach(function(p) { report('   - "' + p.name + '"'); }); }
        if (c.projectsRenamed.length) { report('\nRenamed (' + c.projectsRenamed.length + '):'); c.projectsRenamed.forEach(function(p) { report('   "' + p.oldName + '" -> "' + p.newName + '"'); }); }
        if (c.moved.length) { report('\nMoved between projects (' + c.moved.length + '):'); c.moved.forEach(function(x) { report('   "' + x.title + '"  ' + x.fromName + ' -> ' + x.toName); }); }
        if (c.addedToProject.length) { report('\nAdded to project (' + c.addedToProject.length + '):'); c.addedToProject.forEach(function(x) { report('   "' + x.title + '"  -> ' + x.toName); }); }
        if (c.removedFromProject.length) { report('\nRemoved from project (' + c.removedFromProject.length + '):'); c.removedFromProject.forEach(function(x) { report('   "' + x.title + '"  was in ' + x.fromName); }); }
        if (c.newConversations.length) { report('\nNew in projects (' + c.newConversations.length + '):'); c.newConversations.forEach(function(x) { report('   "' + x.title + '"  in ' + x.project_name); }); }
        if (c.disappeared.length) { report('\nDisappeared (' + c.disappeared.length + '):'); c.disappeared.forEach(function(x) { report('   "' + x.title + '"  was in ' + x.wasProjectName); }); }

        var total = c.moved.length + c.addedToProject.length + c.removedFromProject.length +
          c.newConversations.length + c.disappeared.length + c.projectsRenamed.length +
          c.projectsNew.length + c.projectsRemoved.length;
        if (total === 0) report('\nNo changes -- up to date.');
      }

      saveBtn.style.display = 'block';
      saveBtn.addEventListener('click', function() {
        localStorage.setItem('chatgpt-project-mapping', JSON.stringify(freshMapping));
        var blob = new Blob([JSON.stringify(freshMapping, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'project-mapping.json';
        a.click();
        URL.revokeObjectURL(url);
        saveBtn.textContent = 'Downloaded';
        saveBtn.style.background = '#16a34a';
      });

    } catch (err) {
      status('Error');
      report('\n' + err.message);
      console.error(err);
    }
  })();

})();
