// Consistent snapshot of the database while the app is running (SQLite's online backup, so no -wal/-shm files to chase), checked for
// corruption, with old snapshots removed. Safe to run from cron every night and before every update (deploy/deploy.sh does it).
//
//   npm --prefix server run backup
//
// Settings (environment or server/.env):  ARC_DB_PATH   the database (default server/data/autostrad.db)
//                                         BACKUP_DIR    where snapshots go (default: a "backups" folder beside the database)
//                                         BACKUP_KEEP_DAYS   how long to keep them (default 30; 0 keeps everything)
// Restore: stop the app, copy a snapshot over the database file, delete the -wal and -shm files beside it, start the app.
import '../src/env.js'; // the same server/.env as the app, so it finds the same database
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.ARC_DB_PATH || path.join(here, '..', 'data', 'autostrad.db');
const dir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
const keepDays = process.env.BACKUP_KEEP_DAYS === undefined ? 30 : Number(process.env.BACKUP_KEEP_DAYS);

if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath}. Nothing to back up.`); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const dest = path.join(dir, `autostrad-${stamp}.db`);
if (fs.existsSync(dest)) { console.error(`A snapshot named ${path.basename(dest)} already exists (one per minute).`); process.exit(1); }

const src = new Database(dbPath, { readonly: true, fileMustExist: true });
try { await src.backup(dest); } finally { src.close(); }

// the snapshot must open and pass SQLite's own check, otherwise it is worth nothing. It is also made a single self-contained file
// (no -wal or -shm beside it), so copying or restoring it is just copying one file.
const copy = new Database(dest, { fileMustExist: true });
copy.pragma('journal_mode = DELETE');
const check = copy.pragma('integrity_check', { simple: true });
copy.close();
if (check !== 'ok') { fs.rmSync(dest, { force: true }); console.error(`The snapshot failed the integrity check (${check}) and was removed.`); process.exit(1); }
console.log(`Backed up ${dbPath}\n  to ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB, integrity ok)`);

if (keepDays > 0) {
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^autostrad-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(f)) continue; // only our own snapshots
    const file = path.join(dir, f);
    if (fs.statSync(file).mtimeMs < cutoff) { fs.rmSync(file); removed++; }
  }
  if (removed) console.log(`  removed ${removed} snapshot${removed > 1 ? 's' : ''} older than ${keepDays} days`);
}
