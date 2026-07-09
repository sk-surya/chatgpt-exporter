// Fetches project metadata from the ChatGPT API, diffs against stored state,
// and rebuilds a projects/ symlink tree over flat json/markdown exports.
//
// Works in TWO modes:
//   1. API mode — fetches fresh data from chatgpt.com (needs Bearer token)
//   2. File mode — reads project-mapping.json (from bookmarklet download)

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, lstatSync, unlinkSync, symlinkSync, rmdirSync, rmSync, readlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// ── API fetching (Node mode) ──────────────────────────────────────────────

const DEFAULT_API_BASE = 'https://chatgpt.com/backend-api';
const DELAY = 800; // ms between requests

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  };
}

/**
 * Fetch all projects for the account.
 * Returns { [projectId]: { id, name, description, instructions, ... } }
 */
export async function fetchProjects(token, apiBase = DEFAULT_API_BASE) {
  const projects = {};
  let cursor = null;
  let hasMore = true;

  while (hasMore) {
    let url = `${apiBase}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const resp = await fetch(url, { headers: makeHeaders(token) });
    if (!resp.ok) {
      throw new Error(`Project list fetch failed: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    if (data.items?.length > 0) {
      for (const item of data.items) {
        const g = item.gizmo?.gizmo || item.gizmo;
        if (!g?.id) continue;

        projects[g.id] = {
          id: g.id,
          name: g.display?.name || 'Untitled Project',
          description: g.display?.description || '',
          instructions: g.instructions || '',
          workspace_id: g.workspace_id || null,
          created_at: g.created_at || null,
          updated_at: g.updated_at || null,
          num_interactions: g.num_interactions || 0,
          files: (item.gizmo?.files || []).map(f => ({
            id: f.id, file_id: f.file_id, name: f.name,
            type: f.type, size: f.size,
          })),
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

/**
 * Fetch conversation IDs for a single project.
 */
export async function fetchProjectConvs(token, projectId, apiBase = DEFAULT_API_BASE) {
  const convs = [];
  let cursor = '';
  let hasMore = true;

  while (hasMore) {
    const url = `${apiBase}/gizmos/${projectId}/conversations?cursor=${encodeURIComponent(cursor)}`;

    const resp = await fetch(url, { headers: makeHeaders(token) });
    if (!resp.ok) {
      console.error(`  Warning: project ${projectId} conv fetch failed: ${resp.status}`);
      break;
    }

    const data = await resp.json();
    if (data.items?.length > 0) {
      for (const c of data.items) {
        convs.push({
          id: c.id,
          title: c.title || 'Untitled',
          create_time: c.create_time || null,
          update_time: c.update_time || null,
        });
      }
    }

    cursor = data.cursor || null;
    if (!cursor) hasMore = false;
    await sleep(DELAY);
  }

  return convs;
}

/**
 * Build a complete project-mapping by fetching all project metadata
 * and per-project conversation lists from the API.
 */
export async function buildMappingFromAPI(token, apiBase = DEFAULT_API_BASE) {
  const projects = await fetchProjects(token, apiBase);
  const conversations = {};

  const projectIds = Object.keys(projects);
  for (let i = 0; i < projectIds.length; i++) {
    const pid = projectIds[i];
    const proj = projects[pid];
    process.stderr.write(`\r  [${i + 1}/${projectIds.length}] "${proj.name}"...`);
    const convs = await fetchProjectConvs(token, pid, apiBase);
    proj.conversation_ids = convs.map(c => c.id);
    for (const c of convs) {
      conversations[c.id] = { project_id: pid, title: c.title };
    }
  }
  if (projectIds.length > 0) process.stderr.write('\n');

  return {
    version: 1,
    updated_at: new Date().toISOString(),
    projects,
    conversations,
  };
}

// ── Diff logic ────────────────────────────────────────────────────────────

export function diffMapping(oldMapping, newMapping) {
  const oldConvs = oldMapping?.conversations || {};
  const newConvs = newMapping.conversations || {};
  const oldProjects = oldMapping?.projects || {};
  const newProjects = newMapping.projects || {};

  const changes = {
    moved: [], addedToProject: [], removedFromProject: [],
    newConversations: [], disappeared: [],
    projectsRenamed: [], projectsNew: [], projectsRemoved: [],
  };

  for (const [pid, proj] of Object.entries(newProjects)) {
    if (!oldProjects[pid]) changes.projectsNew.push({ id: pid, name: proj.name });
    else if (oldProjects[pid].name !== proj.name) {
      changes.projectsRenamed.push({ id: pid, oldName: oldProjects[pid].name, newName: proj.name });
    }
  }
  for (const pid of Object.keys(oldProjects)) {
    if (!newProjects[pid]) changes.projectsRemoved.push({ id: pid, name: oldProjects[pid].name });
  }

  for (const [cid, conv] of Object.entries(newConvs)) {
    const oldC = oldConvs[cid];
    if (!oldC) {
      changes.newConversations.push({
        id: cid, title: conv.title,
        project_name: (newProjects[conv.project_id] || {}).name || 'unknown',
      });
    } else if (oldC.project_id !== conv.project_id) {
      changes.moved.push({
        id: cid, title: conv.title,
        fromName: (oldProjects[oldC.project_id] || {}).name || 'unknown',
        toName: (newProjects[conv.project_id] || {}).name || 'unknown',
      });
    }
  }

  for (const [cid, conv] of Object.entries(oldConvs)) {
    const fresh = newConvs[cid];
    if (!fresh) {
      changes.disappeared.push({
        id: cid, title: conv.title,
        wasProjectName: (oldProjects[conv.project_id] || {}).name || 'unknown',
      });
    } else if (!fresh.project_id && conv.project_id) {
      changes.removedFromProject.push({
        id: cid, title: conv.title,
        fromName: (oldProjects[conv.project_id] || {}).name || 'unknown',
      });
    } else if (fresh.project_id && !conv.project_id) {
      changes.addedToProject.push({
        id: cid, title: conv.title,
        toName: (newProjects[fresh.project_id] || {}).name || 'unknown',
      });
    }
  }

  const total = changes.moved.length + changes.addedToProject.length +
    changes.removedFromProject.length + changes.newConversations.length +
    changes.disappeared.length + changes.projectsRenamed.length +
    changes.projectsNew.length + changes.projectsRemoved.length;

  return { changes, hasChanges: total > 0 };
}

// ── Report formatting ─────────────────────────────────────────────────────

export function formatReport(changes) {
  const lines = [];
  if (!changes) return ['No previous mapping — first run.'];

  const { moved, addedToProject, removedFromProject, newConversations,
    disappeared, projectsRenamed, projectsNew, projectsRemoved } = changes;

  if (projectsNew.length) {
    lines.push(`\n🆕 New projects (${projectsNew.length}):`);
    for (const p of projectsNew) lines.push(`   + "${p.name}"`);
  }
  if (projectsRemoved.length) {
    lines.push(`\n🗑  Removed projects (${projectsRemoved.length}):`);
    for (const p of projectsRemoved) lines.push(`   - "${p.name}"`);
  }
  if (projectsRenamed.length) {
    lines.push(`\n✏️  Renamed (${projectsRenamed.length}):`);
    for (const p of projectsRenamed) lines.push(`   "${p.oldName}" → "${p.newName}"`);
  }
  if (moved.length) {
    lines.push(`\n📦 Moved between projects (${moved.length}):`);
    for (const c of moved) lines.push(`   "${c.title}"  ${c.fromName} → ${c.toName}`);
  }
  if (addedToProject.length) {
    lines.push(`\n➕ Added to project (${addedToProject.length}):`);
    for (const c of addedToProject) lines.push(`   "${c.title}"  → ${c.toName}`);
  }
  if (removedFromProject.length) {
    lines.push(`\n➖ Removed from project (${removedFromProject.length}):`);
    for (const c of removedFromProject) lines.push(`   "${c.title}"  was in ${c.fromName}`);
  }
  if (newConversations.length) {
    lines.push(`\n✨ New in projects (${newConversations.length}):`);
    for (const c of newConversations) lines.push(`   "${c.title}"  in ${c.project_name}`);
  }
  if (disappeared.length) {
    lines.push(`\n❓ Disappeared (${disappeared.length}):`);
    for (const c of disappeared) lines.push(`   "${c.title}"  was in ${c.wasProjectName}`);
  }

  if (lines.length === 0) lines.push('\n✅ No changes — project mapping is up to date.');
  return lines;
}

// ── Filesystem: find files by conversation ID ─────────────────────────────

/**
 * Find a file in a directory whose name includes the conversation ID.
 * Handles both naming conventions: Title_id8.json and date_Title_id13.json.
 */
function findFileByConvId(dir, conversationId) {
  if (!existsSync(dir)) return null;
  const prefixes = [conversationId, conversationId.substring(0, 13), conversationId.substring(0, 8)];
  for (const prefix of prefixes) {
    const matches = readdirSync(dir).filter(f => f.includes(prefix));
    if (matches.length > 0) return matches[0];
  }
  return null;
}

// ── Filesystem: sanitize names ────────────────────────────────────────────

function sanitizeProjectFolder(name) {
  if (!name) return 'untitled_project';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .substring(0, 50);
}

function ensureDir(dirPath) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

// ── Symlink rebuild ───────────────────────────────────────────────────────

/**
 * Rebuild the projects/ symlink tree from a project-mapping.
 *
 * The dataDir must contain json/ and optionally markdown/ directories
 * with flat conversation files. Symlinks are created under:
 *   projects/{folder}/json/  → ../../json/
 *   projects/{folder}/markdown/ → ../../markdown/
 *
 * Stale symlinks and empty project dirs are removed.
 */
export function rebuildSymlinks(dataDir, mapping, options = {}) {
  const { dryRun = false, verbose = false } = options;
  const projectsDir = join(dataDir, 'projects');
  const jsonDir = join(dataDir, 'json');
  const mdDir = join(dataDir, 'markdown');

  const results = { created: [], removed: [], skipped: [], dirsRemoved: [] };

  // Set of active project folder names
  const activeFolders = new Set();
  for (const [, proj] of Object.entries(mapping.projects || {})) {
    activeFolders.add(sanitizeProjectFolder(proj.name));
  }

  // Remove stale project directories
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir)) {
      const entryPath = join(projectsDir, entry);
      try {
        if (lstatSync(entryPath).isDirectory() && !activeFolders.has(entry)) {
          if (dryRun) {
            results.dirsRemoved.push(entry);
          } else {
            rmSync(entryPath, { recursive: true, force: true });
            results.dirsRemoved.push(entry);
            if (verbose) console.log(`  rm -rf projects/${entry}/`);
          }
        }
      } catch { /* gone */ }
    }
  }

  // Track all expected symlink paths
  const expected = new Set();

  // Build expected symlinks
  for (const [, proj] of Object.entries(mapping.projects || {})) {
    const folder = sanitizeProjectFolder(proj.name);
    const projJsonDir = join(projectsDir, folder, 'json');
    const projMdDir = join(projectsDir, folder, 'markdown');

    for (const convId of (proj.conversation_ids || [])) {
      const jsonFile = findFileByConvId(jsonDir, convId);
      const mdFile = findFileByConvId(mdDir, convId);

      if (jsonFile) {
        const linkPath = join(projJsonDir, jsonFile);
        expected.add(linkPath);
        if (!_symlinkExists(linkPath)) {
          if (!dryRun) {
            ensureDir(projJsonDir);
            symlinkSync(join('..', '..', 'json', jsonFile), linkPath);
          }
          results.created.push(`projects/${folder}/json/${jsonFile}`);
        } else {
          results.skipped.push(`projects/${folder}/json/${jsonFile}`);
        }
      }

      if (mdFile) {
        const linkPath = join(projMdDir, mdFile);
        expected.add(linkPath);
        if (!_symlinkExists(linkPath)) {
          if (!dryRun) {
            ensureDir(projMdDir);
            symlinkSync(join('..', '..', 'markdown', mdFile), linkPath);
          }
          results.created.push(`projects/${folder}/markdown/${mdFile}`);
        } else {
          results.skipped.push(`projects/${folder}/markdown/${mdFile}`);
        }
      }
    }
  }

  // Remove stale symlinks
  if (existsSync(projectsDir)) {
    _removeStaleSymlinks(projectsDir, expected, results, dryRun, verbose);
  }

  // Clean up empty project directories
  if (!dryRun) {
    _removeEmptyDirs(projectsDir, projectsDir);
  }

  return results;
}

// existsSync follows symlinks (so a broken symlink → false).
// Use lstatSync to detect the link itself regardless of target validity.
function _symlinkExists(linkPath) {
  try { lstatSync(linkPath); return true; } catch { return false; }
}

function _removeStaleSymlinks(dir, expected, results, dryRun, verbose) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        _removeStaleSymlinks(full, expected, results, dryRun, verbose);
      } else if (stat.isSymbolicLink() && !expected.has(full)) {
        const rel = relative(resolve(dir, '..'), full).replace(/\\/g, '/');
        if (dryRun) {
          results.removed.push(rel);
        } else {
          unlinkSync(full);
          results.removed.push(rel);
          if (verbose) console.log(`  - ${rel}`);
        }
      }
    } catch { /* gone */ }
  }
}

function _removeEmptyDirs(dir, stopAt) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (lstatSync(full).isDirectory()) _removeEmptyDirs(full, stopAt);
    } catch { /* gone */ }
  }
  if (resolve(dir) !== resolve(stopAt)) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch { /* not empty */ }
  }
}

// ── File I/O for project-mapping.json ─────────────────────────────────────

export function loadMapping(dataDir) {
  const filePath = join(dataDir, 'project-mapping.json');
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (data?.version && data.projects && data.conversations) return data;
  } catch { /* corrupted */ }
  return null;
}

export function saveMapping(dataDir, mapping) {
  writeFileSync(join(dataDir, 'project-mapping.json'), JSON.stringify(mapping, null, 2));
}

// ── Format symlink report ─────────────────────────────────────────────────

export function formatSymlinkReport(results) {
  const lines = [];
  if (results.created.length > 0) lines.push(`  Links created: ${results.created.length}`);
  if (results.removed.length > 0) lines.push(`  Links removed: ${results.removed.length}`);
  if (results.dirsRemoved.length > 0) lines.push(`  Project dirs removed: ${results.dirsRemoved.length}`);
  if (results.created.length === 0 && results.removed.length === 0 && results.dirsRemoved.length === 0) {
    lines.push('  Symlinks already up to date.');
  }
  return lines;
}
