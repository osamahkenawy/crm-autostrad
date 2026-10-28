// The safeguards that matter when this runs for real: no default token secret, no accidental wipe, a way to create the first administrator.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostrad-prod-'));
const dbFile = path.join(dir, 'prod.db');
const base = { ...process.env, ARC_DB_PATH: dbFile, HELPDESK_SCHEDULER: 'off' };
for (const k of ['JWT_SECRET', 'ADMIN_PASSWORD', 'NODE_ENV', 'ANTHROPIC_API_KEY', 'HELPDESK_PROVIDER']) delete base[k];
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, env: { ...base, ...env }, encoding: 'utf8', timeout: 20000 });

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('in production the server will not start with the development token secret or a short one', () => {
  for (const secret of [undefined, 'too-short']) {
    const r = run(['src/index.js'], { NODE_ENV: 'production', API_PORT: String(4900 + Math.floor(Math.random() * 90)), ...(secret ? { JWT_SECRET: secret } : {}) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /JWT_SECRET/);
  }
});

test('the demo seed refuses to wipe a production database unless it is forced', () => {
  const r = run(['src/seed.js'], { NODE_ENV: 'production' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wipes every table/);
  assert.ok(!fs.existsSync(dbFile) || new Database(dbFile, { readonly: true }).prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get() === undefined, 'nothing was created or deleted');
});

test('create-admin makes a working sign-in on an empty database, and refuses weak input', () => {
  const secret = 'throwaway-test-value-1';
  assert.equal(run(['scripts/create-admin.mjs', 'not-an-email', 'X']).status, 1);
  assert.equal(run(['scripts/create-admin.mjs', 'ops@example.com', 'Ops Admin'], { ADMIN_PASSWORD: 'short' }).status, 1);
  assert.equal(run(['scripts/create-admin.mjs', 'ops@example.com', 'Ops Admin', 'superuser'], { ADMIN_PASSWORD: secret }).status, 1);
  const made = run(['scripts/create-admin.mjs', 'Ops@Example.com', 'Ops Admin', 'admin', 'Management'], { ADMIN_PASSWORD: secret });
  assert.equal(made.status, 0, made.stderr);
  const db = new Database(dbFile, { readonly: true });
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get('ops@example.com');
  db.close();
  assert.ok(u && u.role === 'admin' && u.department === 'Management' && u.status === 'active');
  assert.ok(bcrypt.compareSync(secret, u.password_hash), 'the stored value is a hash of the password');
  assert.notEqual(u.password_hash, secret);
  // running it again resets the password instead of creating a duplicate
  assert.equal(run(['scripts/create-admin.mjs', 'ops@example.com', 'Ops Admin'], { ADMIN_PASSWORD: 'a-second-test-value-2' }).status, 0);
  const again = new Database(dbFile, { readonly: true });
  assert.equal(again.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  again.close();
});
