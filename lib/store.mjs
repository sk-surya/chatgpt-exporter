// SQLite-backed persistent store for conversation index, download tracking,
// and project mapping. Survives browser-cache wipes, reboots, cron runs.
//
// Uses Node's built-in node:sqlite (Node ≥22.5). No native compilation needed.
//
// The database is a single file: .export.db in the data directory.
// On first open, existing JSON files (conversation-index.json, project-mapping.json)
// are auto-migrated into SQLite.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, lstatSync, unlinkSync, symlinkSync, rmdirSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

// ── Singleton ─────────────────────────────────────────────────────────────

let _db = null;

// ── Schema ────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT 'Untitled',
  create_time     REAL,
  update_time     REAL,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  gizmo_id        TEXT,   -- project_id from conversation object
  _raw            TEXT,   -- full JSON blob of the list-entry object
  on_disk         INTEGER NOT NULL DEFAULT 0,  -- 1 if json/ file exists
  indexed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_update_time ON conversations(update_time);
CREATE INDEX IF NOT EXISTS idx_conv_gizmo_id ON conversations(gizmo_id);
CREATE INDEX IF NOT EXISTS idx_conv_on_disk ON conversations(on_disk);

CREATE TABLE IF NOT EXISTS files_downloaded (
  file_id         TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name            TEXT,
  type            TEXT,
  size            INTEGER,
  downloaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  instructions    TEXT,
  workspace_id    TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  num_interactions INTEGER DEFAULT 0,
  _raw            TEXT,
  refreshed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_conversations (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_pc_conv_id ON project_conversations(conversation_id);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// ── Open / close ──────────────────────────────────────────────────────────

export function openStore(dataDir) {
  if (_db) return _db;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, '.export.db');
  const isNew = !existsSync(dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(SCHEMA);

  if (isNew) {
    _migrateFromJson(dataDir, db);
  }

  _db = db;
  return db;
}

export function closeStore() {
  if (_db) {
    try {
      _db.exec('PRAGMA optimize');
      _db.close();
    } catch { /* ignore */ }
    _db = null;
  }
}

// ── Migration ─────────────────────────────────────────────────────────────

function _migrateFromJson(dataDir, db) {
  // Migrate conversation-index.json (from export-chatgpt tool or prior runs)
  const indexFile = join(dataDir, 'conversation-index.json');
  if (existsSync(indexFile)) {
    try {
      const entries = JSON.parse(readFileSync(indexFile, 'utf8'));
      if (Array.isArray(entries) && entries.length > 0) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO conversations (id, title, create_time, update_time, is_archived, gizmo_id, _raw)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        db.exec('BEGIN');
        for (const e of entries) {
          insert.run(
            e.id, e.title || 'Untitled', e.create_time || null,
            e.update_time || null, e._archived ? 1 : 0,
            e.gizmo_id || e.project_id || e._project_id || null,
            JSON.stringify(e)
          );
        }
        db.exec('COMMIT');
        console.log(`  Migrated ${entries.length} conversations from conversation-index.json`);
      }
    } catch (e) {
      console.log('  Warning: could not migrate conversation index:', e.message);
    }
  }

  // Migrate project-mapping.json
  const mapFile = join(dataDir, 'project-mapping.json');
  if (existsSync(mapFile)) {
    try {
      const mapping = JSON.parse(readFileSync(mapFile, 'utf8'));
      if (mapping?.projects) {
        importProjects(db, mapping);
        console.log(`  Migrated ${Object.keys(mapping.projects).length} projects from project-mapping.json`);
      }
    } catch (e) {
      console.log('  Warning: could not migrate project mapping:', e.message);
    }
  }
}

// ── Conversation operations ───────────────────────────────────────────────

export function upsertConversations(db, convs) {
  const stmt = db.prepare(
    `INSERT INTO conversations (id, title, create_time, update_time, is_archived, gizmo_id, _raw)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, create_time=excluded.create_time,
       update_time=excluded.update_time, is_archived=excluded.is_archived,
       gizmo_id=COALESCE(excluded.gizmo_id, conversations.gizmo_id),
       _raw=COALESCE(excluded._raw, conversations._raw)`
  );
  db.exec('BEGIN');
  for (const c of convs) {
    stmt.run(
      c.id, c.title || 'Untitled', c.create_time || null,
      c.update_time || null, c._archived ? 1 : 0,
      c.gizmo_id || c.project_id || c._project_id || null,
      c._raw ? JSON.stringify(c._raw) : (c.id ? JSON.stringify(c) : null)
    );
  }
  db.exec('COMMIT');
}

export function markOnDisk(db, conversationIds) {
  const stmt = db.prepare('UPDATE conversations SET on_disk = 1 WHERE id = ?');
  db.exec('BEGIN');
  for (const id of conversationIds) stmt.run(id);
  db.exec('COMMIT');
}

export function getConversationCount(db) {
  return db.prepare('SELECT COUNT(*) as c FROM conversations').get()?.c || 0;
}

export function getCountOnDisk(db) {
  return db.prepare('SELECT COUNT(*) as c FROM conversations WHERE on_disk = 1').get()?.c || 0;
}

export function getAllConversations(db) {
  return db.prepare('SELECT * FROM conversations ORDER BY update_time DESC').all();
}

// ── Index from disk (scan json/ directory) ────────────────────────────────

/**
 * Scan the json/ directory and index all conversations into the store.
 * Extracts id, title, create_time, update_time from each JSON file.
 * Returns { added, updated, total } counts.
 */
export function indexFromDisk(db, dataDir) {
  const jsonDir = join(dataDir, 'json');
  if (!existsSync(jsonDir)) {
    console.log(`  No json/ directory found at ${jsonDir}`);
    return { added: 0, updated: 0, total: 0 };
  }

  const files = readdirSync(jsonDir).filter(f => f.endsWith('.json'));
  console.log(`  Scanning ${files.length} JSON files in json/...`);

  const insert = db.prepare(
    `INSERT INTO conversations (id, title, create_time, update_time, gizmo_id, _raw, on_disk)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, create_time=excluded.create_time,
       update_time=excluded.update_time,
       gizmo_id=COALESCE(excluded.gizmo_id, conversations.gizmo_id),
       _raw=excluded._raw, on_disk=1`
  );

  let added = 0, updated = 0;

  db.exec('BEGIN');
  for (const file of files) {
    try {
      const raw = readFileSync(join(jsonDir, file), 'utf8');
      const conv = JSON.parse(raw);
      const id = conv.id || conv.conversation_id;
      if (!id) continue;

      const existing = db.prepare('SELECT id, update_time FROM conversations WHERE id = ?').get(id);
      const updateTime = conv.update_time || null;

      insert.run(
        id,
        conv.title || 'Untitled',
        conv.create_time || null,
        updateTime,
        conv.gizmo_id || null,
        raw
      );

      if (!existing) added++;
      else if (existing.update_time !== updateTime) updated++;
    } catch (e) {
      console.log(`    Warning: could not parse ${file}: ${e.message}`);
    }
  }
  db.exec('COMMIT');

  return { added, updated, total: added + updated };
}

// ── Project operations ────────────────────────────────────────────────────

export function importProjects(db, mapping) {
  const { projects = {}, conversations = {} } = mapping;

  const insProj = db.prepare(
    `INSERT INTO projects (id, name, description, instructions, workspace_id,
       created_at, updated_at, num_interactions, _raw, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description,
       instructions=excluded.instructions, workspace_id=excluded.workspace_id,
       updated_at=excluded.updated_at, num_interactions=excluded.num_interactions,
       _raw=excluded._raw, refreshed_at=datetime('now')`
  );

  const insLink = db.prepare(
    `INSERT OR IGNORE INTO project_conversations (project_id, conversation_id)
     VALUES (?, ?)`
  );

  db.exec('BEGIN');

  // Insert projects
  for (const [pid, proj] of Object.entries(projects)) {
    insProj.run(
      pid,
      proj.name || 'Untitled Project',
      proj.description || '',
      proj.instructions || '',
      proj.workspace_id || null,
      proj.created_at || null,
      proj.updated_at || null,
      proj.num_interactions || 0,
      JSON.stringify(proj)
    );
  }

  // Rebuild project-conversation links: clear and repopulate
  db.prepare('DELETE FROM project_conversations').run();
  for (const [cid, conv] of Object.entries(conversations)) {
    if (conv.project_id) {
      insLink.run(conv.project_id, cid);
    }
    // Also update the conversation's gizmo_id
    db.prepare('UPDATE conversations SET gizmo_id = ? WHERE id = ? AND gizmo_id IS NULL')
      .run(conv.project_id || null, cid);
  }

  db.exec('COMMIT');
}

export function getProjects(db) {
  const projects = {};
  const projRows = db.prepare('SELECT * FROM projects ORDER BY name').all();
  for (const p of projRows) {
    projects[p.id] = {
      id: p.id, name: p.name, description: p.description,
      instructions: p.instructions, workspace_id: p.workspace_id,
      created_at: p.created_at, updated_at: p.updated_at,
      num_interactions: p.num_interactions,
      conversation_ids: [],
    };
    if (p._raw) {
      try {
        const raw = JSON.parse(p._raw);
        projects[p.id].files = raw.files || [];
      } catch {}
    }
  }

  const linkRows = db.prepare(
    'SELECT project_id, conversation_id FROM project_conversations ORDER BY project_id'
  ).all();
  for (const row of linkRows) {
    if (projects[row.project_id]) {
      projects[row.project_id].conversation_ids.push(row.conversation_id);
    }
  }

  return projects;
}

export function getConversationProjectMap(db) {
  const rows = db.prepare(
    'SELECT pc.conversation_id, pc.project_id, p.name as project_name FROM project_conversations pc JOIN projects p ON p.id = pc.project_id'
  ).all();
  const map = {};
  for (const r of rows) {
    map[r.conversation_id] = { project_id: r.project_id, project_name: r.project_name };
  }
  return map;
}

// ── KV store for progress / misc ──────────────────────────────────────────

export function setKV(db, key, value) {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

export function getKV(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// ── Stats ─────────────────────────────────────────────────────────────────

export function getStats(db) {
  return {
    conversations: getConversationCount(db),
    onDisk: getCountOnDisk(db),
    projects: db.prepare('SELECT COUNT(*) as c FROM projects').get()?.c || 0,
    projectLinks: db.prepare('SELECT COUNT(*) as c FROM project_conversations').get()?.c || 0,
    filesDownloaded: db.prepare('SELECT COUNT(*) as c FROM files_downloaded').get()?.c || 0,
    dbSize: (() => {
      try {
        // reconstruct path — node:sqlite doesn't expose it directly
        return 0; // not easily available
      } catch { return 0; }
    })(),
  };
}
