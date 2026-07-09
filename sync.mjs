#!/usr/bin/env node
/**
 * sync.mjs — Index and organize ChatGPT exports with project awareness.
 *
 * After running the chatgpt-exporter bookmarklet and extracting the ZIP,
 * point this tool at the extracted directory to:
 *   1. Index all conversations into a local SQLite database (.export.db)
 *   2. Optionally fetch project metadata from the ChatGPT API
 *   3. Rebuild a projects/ symlink tree
 *   4. Report what changed since last run
 *
 * Usage:
 *   node sync.mjs <data-dir>                          # index only
 *   node sync.mjs <data-dir> --bearer TOKEN           # index + fetch projects
 *   node sync.mjs <data-dir> --mapping FILE           # index + use downloaded mapping
 *   node sync.mjs <data-dir> --proxy                  # index + fetch via Safari proxy
 *   node sync.mjs <data-dir> --mapping-only           # rebuild symlinks only
 *   node sync.mjs <data-dir> --dry-run                # preview changes
 *
 * The data-dir should contain json/ and optionally markdown/ subdirectories
 * (extracted from the chatgpt-exporter ZIP).
 */

import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openStore, closeStore, indexFromDisk, importProjects, getStats } from './lib/store.mjs';
import {
  buildMappingFromAPI, diffMapping, loadMapping, saveMapping,
  rebuildSymlinks, formatReport, formatSymlinkReport,
} from './lib/mapper.mjs';

// ── Argument parsing ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dataDir: './chatgpt-data',
    bearer: process.env.CHATGPT_BEARER_TOKEN || null,
    mappingFile: null,
    proxy: false,
    mappingOnly: false,
    dryRun: false,
    jsonOnly: false,
    verbose: false,
    throttle: 15,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--bearer': opts.bearer = args[++i]; break;
      case '--proxy': opts.proxy = true; break;
      case '--mapping': opts.mappingFile = args[++i]; break;
      case '--mapping-only': opts.mappingOnly = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json-only': opts.jsonOnly = true; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--throttle': opts.throttle = parseFloat(args[++i]) || 15; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        opts.dataDir = arg;
    }
    i++;
  }

  return opts;
}

function showHelp() {
  console.log(`
  ChatGPT Export Sync — index and organize your exported conversations

  Usage:
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
    --help, -h         Show this help

  Examples:
    node sync.mjs ~/Documents/chatgpt-backups/
    node sync.mjs ~/Documents/chatgpt-backups/ --bearer "eyJ..."
    node sync.mjs ~/Documents/chatgpt-backups/ --mapping project-mapping.json
    node sync.mjs ~/Documents/chatgpt-backups/ --mapping-only --dry-run
`);
}

// ── Auth helpers ──────────────────────────────────────────────────────────

async function getTokenFromProxy() {
  try {
    const http = await import('node:http');
    return new Promise((resolve) => {
      http.get('http://localhost:9876/api/auth/session', (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.accessToken || null);
          } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  if (opts.help) { showHelp(); process.exit(0); }

  const dataDir = resolve(opts.dataDir);

  console.log(`\n📋 ChatGPT Export Sync\n`);
  console.log(`   Data directory: ${dataDir}`);

  const jsonDir = `${dataDir}/json`;
  if (!existsSync(jsonDir) && !opts.mappingOnly) {
    console.error(`\nError: No json/ directory found at ${dataDir}`);
    console.error('       Extract the chatgpt-exporter ZIP first, then point here.');
    process.exit(1);
  }

  // ── Step 1: Index conversations on disk into SQLite ─────────────────

  if (!opts.mappingOnly) {
    console.log('\n── Indexing conversations ──');
    const db = openStore(dataDir);
    const { added, updated, total } = indexFromDisk(db, dataDir);
    const stats = getStats(db);

    if (total > 0) {
      console.log(`  New: ${added}, Updated: ${updated}, Total indexed: ${stats.conversations}`);
    } else {
      console.log(`  All ${stats.conversations} conversations already indexed.`);
    }
    console.log(`  On disk: ${stats.onDisk}`);
  }

  // ── Step 2: Fresh project mapping ──────────────────────────────────

  let freshMapping = null;
  const needMapping = !opts.mappingOnly;

  if (needMapping) {
    let token = opts.bearer;

    if (!token && opts.proxy) {
      console.log('\n── Getting token from Safari proxy ──');
      token = await getTokenFromProxy();
      if (!token) {
        console.error('  Could not get token from proxy. Is Safari open on chatgpt.com?');
        console.error('  Is safari-proxy.js running? (node safari-proxy.js in export-chatgpt repo)');
        process.exit(1);
      }
      console.log('  Token obtained.');
    }

    if (opts.mappingFile) {
      console.log('\n── Loading project mapping from file ──');
      try {
        freshMapping = JSON.parse(readFileSync(resolve(opts.mappingFile), 'utf8'));
        console.log(`  ${Object.keys(freshMapping.projects || {}).length} projects, ${Object.keys(freshMapping.conversations || {}).length} conversations`);
      } catch (e) {
        console.error(`  Error reading mapping file: ${e.message}`);
        process.exit(1);
      }
    } else if (token) {
      console.log('\n── Fetching project metadata from API ──');
      const apiBase = process.env.CHATGPT_API_BASE || 'https://chatgpt.com/backend-api';
      try {
        freshMapping = await buildMappingFromAPI(token, apiBase);
        console.log(`  ${Object.keys(freshMapping.projects).length} projects`);
        console.log(`  ${Object.keys(freshMapping.conversations).length} project conversations`);
      } catch (e) {
        if (e.message.includes('401') || e.message.includes('403')) {
          console.error(`\n  Auth failed. Your bearer token may be expired.`);
        } else {
          console.error(`\n  API error: ${e.message}`);
        }
        process.exit(1);
      }
    } else {
      // No mapping source — skip project steps
      console.log('\n── Skipping project mapping (no --bearer, --proxy, or --mapping) ──');
      console.log('   Run with one of these options to enable project organization.');
    }

    if (freshMapping) {
      // Save to SQLite
      const db = openStore(dataDir);
      importProjects(db, freshMapping);

      // Diff against stored mapping
      const oldMapping = loadMapping(dataDir);
      const { changes, hasChanges } = diffMapping(oldMapping, freshMapping);

      console.log('\n── Changes since last run ──');
      for (const line of formatReport(changes)) console.log(line);

      // Save mapping to disk
      if (!opts.dryRun) {
        saveMapping(dataDir, freshMapping);
        console.log(`\nSaved project-mapping.json`);
      }
    }
  }

  // ── Step 3: Rebuild symlinks ───────────────────────────────────────

  if (!opts.jsonOnly) {
    const mapping = freshMapping || loadMapping(dataDir);

    if (mapping) {
      console.log(`\n── Rebuilding project symlinks${opts.dryRun ? ' (dry-run)' : ''} ──`);
      const results = rebuildSymlinks(dataDir, mapping, {
        dryRun: opts.dryRun,
        verbose: opts.verbose,
      });
      for (const line of formatSymlinkReport(results)) console.log(line);
    } else {
      console.log('\n── Skipping symlink rebuild (no project mapping available) ──');
    }
  }

  // ── Summary ────────────────────────────────────────────────────────

  const db = openStore(dataDir);
  const finalStats = getStats(db);
  closeStore();

  console.log('\n' + '═'.repeat(50));
  console.log(`  Conversations: ${finalStats.conversations} indexed (${finalStats.onDisk} on disk)`);
  if (finalStats.projects > 0) {
    console.log(`  Projects:      ${finalStats.projects}`);
    const projectsDir = `${dataDir}/projects`;
    if (existsSync(projectsDir)) {
      const dirCount = readdirSync(projectsDir)
        .filter(f => lstatSync(join(projectsDir, f)).isDirectory()).length;
      console.log(`  Project dirs:  ${dirCount}`);
    }
  }
  console.log(`  Database:      ${dataDir}/.export.db`);
  console.log('═'.repeat(50) + '\n');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
