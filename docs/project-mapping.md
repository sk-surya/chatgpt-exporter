# Project Mapping & Local Sync

Companion tools that add project awareness and a durable local index to the
[chatgpt-exporter](https://github.com/thiscantbeserious/chatgpt-exporter) bookmarklet.

## Motivation

The bookmarklet downloads all conversations as a flat ZIP — it has no concept of ChatGPT
"Projects" (the UI organization feature). These tools:

- **Preserve project ↔ conversation associations** via the ChatGPT backend API
- **Replace IndexedDB** with a durable SQLite database that survives browser-cache
  wipes, Safari's 7-day rule, disk-pressure eviction, and cron runs
- **Organize exports** into per-project directories via symlinks
- **Detect changes** between runs — moved conversations, renamed projects, new/removed
  project membership

## Architecture

```
chatgpt-exporter bookmarklet  →  downloads ZIP (json/, markdown/, files/)
                                       ↓
                                  extract to data directory
                                       ↓
sync.mjs  ─┬─ 1. Scans json/ → indexes into .export.db (SQLite)
           ├─ 2. Fetches project metadata from ChatGPT API (or uses downloaded JSON)
           ├─ 3. Diffs against previous run → reports changes
           └─ 4. Rebuilds projects/ symlink tree
```

### Data directory layout after sync

```
~/Documents/chatgpt-data/
├── json/                     # Flat conversation files (bookmarklet output)
│   ├── 2024-07-03_Work_Chat_abc123def.json
│   └── ...
├── markdown/                 # Flat markdown files
├── files/                    # Downloaded attachments
├── .export.db                # SQLite: conversation index, project links, progress
├── project-mapping.json      # Cached project metadata (authoritative source)
└── projects/                 # Symlink tree — rebuilt fresh each sync
    ├── Work_Chats/
    │   ├── json/             → ../../json/
    │   └── markdown/         → ../../markdown/
    └── Side_Project/
        ├── json/
        └── markdown/
```

The `projects/` directory is **fully rebuilt** each run from the mapping. Stale symlinks
and empty project directories are cleaned up automatically. The flat `json/` and
`markdown/` directories are never touched — they remain the source of truth for content.

## Files

| File | Purpose |
|------|---------|
| `lib/store.mjs` | SQLite-backed store — conversation index, project links, KV progress |
| `lib/mapper.mjs` | Project API fetching, diff logic, symlink rebuild |
| `sync.mjs` | Main CLI entry point |
| `bookmarklet-map.js` | Browser bookmarklet — fetches project metadata and downloads `project-mapping.json` |

**Zero npm dependencies.** Uses Node 26's built-in `node:sqlite`. No `npm install` needed.

## Commands

### Full sync (index + fetch projects + rebuild symlinks)

```bash
node sync.mjs ~/Documents/chatgpt-data/ --bearer "eyJ..."
```

Requires a ChatGPT Bearer token (extract from DevTools → Network → any
`backend-api` request → Authorization header).

### Index only (no project API calls)

```bash
node sync.mjs ~/Documents/chatgpt-data/
```

Scans `json/` and indexes all conversations into SQLite. Skips project fetching
and symlink rebuild.

### Use a downloaded project-mapping.json

```bash
node sync.mjs ~/Documents/chatgpt-data/ --mapping ~/Downloads/project-mapping.json
```

Use when you fetched project metadata via the bookmarklet instead of the CLI.

### Rebuild symlinks only (no API calls, no re-indexing)

```bash
node sync.mjs ~/Documents/chatgpt-data/ --mapping-only
```

Reads the existing `project-mapping.json` and rebuilds the `projects/` symlink
tree. Completes in under a second.

### Preview changes (dry run)

```bash
node sync.mjs ~/Documents/chatgpt-data/ --bearer "eyJ..." --dry-run
```

Shows what would change without writing anything.

### Save project mapping only (skip symlinks)

```bash
node sync.mjs ~/Documents/chatgpt-data/ --bearer "eyJ..." --json-only
```

Fetches projects and saves `project-mapping.json` but doesn't rebuild symlinks.

### Tokenless auth via Safari proxy

```bash
# In one terminal (requires chatgpt.com open in Safari):
node ~/repos/export-chatgpt/safari-proxy.js

# In another:
node sync.mjs ~/Documents/chatgpt-data/ --proxy
```

### All options

```
node sync.mjs <data-dir> [options]

Options:
  --bearer TOKEN     Fetch project metadata from ChatGPT API (needs Bearer token)
  --proxy            Fetch project metadata via local Safari proxy (port 9876)
  --mapping FILE     Use a downloaded project-mapping.json (from the bookmarklet)
  --mapping-only     Only rebuild symlinks from existing project-mapping.json
  --dry-run          Preview changes without writing anything
  --json-only        Fetch projects but don't rebuild symlinks
  --throttle SEC     Seconds between API requests (default: 15)
  --verbose, -v      Show detailed per-file operations
```

## Bookmarklet workflow

The `bookmarklet-map.js` runs in the browser console on chatgpt.com. It:

1. Fetches the project list + per-project conversation IDs via the ChatGPT backend API
2. Shows a diff report against the previously-saved mapping (stored in `localStorage`)
3. Downloads the updated `project-mapping.json`

### Usage

1. Run the main chatgpt-exporter bookmarklet → downloads `chatgpt-export.zip`
2. Run `bookmarklet-map.js` in the browser console on chatgpt.com
3. Review the diff report, click "Download project-mapping.json"
4. Extract the ZIP into your data directory
5. Copy `project-mapping.json` into the data directory
6. Run `node sync.mjs <data-dir> --mapping-only`

### Compiling to a bookmarklet

```bash
cd ~/repos/chatgpt-exporter
node -e "
import { minify } from 'terser';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
const src = readFileSync('bookmarklet-map.js', 'utf8');
const result = await minify(src, { compress: true, mangle: false });
const bm = 'javascript:' + encodeURIComponent(result.code);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/bookmarklet-map.txt', bm);
console.log('dist/bookmarklet-map.txt:', bm.length, 'chars');
"
```

Paste the contents of `dist/bookmarklet-map.txt` into a bookmark's URL field.

## SQLite database (.export.db)

### Why SQLite instead of IndexedDB

| Threat | IndexedDB (bookmarklet) | SQLite .export.db |
|--------|------------------------|-------------------|
| Browser "Clear site data" | Wiped | Untouched |
| Safari iOS 7-day inactivity | Wiped | Untouched |
| Disk pressure eviction | Wiped | Untouched |
| Private/Incognito mode | Wiped on close | N/A |
| Cron job access | Not accessible | Fully accessible |
| Accidental deletion | One click in DevTools | Must delete the file |

### Schema

The database lives at `<data-dir>/.export.db` and contains:

- **conversations** — id, title, create_time, update_time, gizmo_id (project), on_disk flag, raw JSON
- **projects** — id, name, description, instructions, workspace_id, timestamps
- **project_conversations** — join table linking projects ↔ conversations
- **files_downloaded** — tracking for downloaded attachments
- **kv** — key-value store for progress state

### Migration

On first open, if `conversation-index.json` or `project-mapping.json` exist in the
data directory, they are automatically migrated into SQLite. The JSON files are
left in place as a backup.

## Cron usage

```bash
# crontab example: sync every 6 hours
0 */6 * * * cd ~/repos/chatgpt-exporter && node sync.mjs ~/Documents/chatgpt-data/ --bearer "$CHATGPT_TOKEN" >> ~/Documents/chatgpt-data/sync.log 2>&1
```

Store your Bearer token in an environment variable or a secured file. Tokens expire
after some hours — for long-running cron, use the Safari proxy approach or refresh
the token periodically.

Note: `sync.mjs` only indexes and organizes — it does **not** download conversations.
Run the bookmarklet periodically (or the `export-chatgpt` Node CLI) to download new
content, then `sync.mjs` to organize it.

## Change detection

Each run diffs the fresh project mapping against the stored `project-mapping.json`
and reports:

| Change | Meaning |
|--------|---------|
| 🆕 New project | Project created in ChatGPT UI |
| 🗑 Removed project | Project deleted |
| ✏️ Renamed | Project name changed → folder renamed |
| 📦 Moved | Conversation moved between projects |
| ➕ Added to project | Conversation added to a project |
| ➖ Removed from project | Conversation removed from a project |
| ✨ New in projects | New conversation found in a project |
| ❓ Disappeared | Conversation no longer in any project (possibly deleted) |

These changes are purely organizational — the underlying conversation files in
`json/` are never modified.
