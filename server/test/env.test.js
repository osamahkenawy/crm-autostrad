// server/.env belongs to the real app. Every test that starts the server sets ARC_SKIP_ENV_FILE=1, so a developer's own mailbox settings
// (or a JWT_SECRET) can never change what a test sees. This pins that switch, and the loader's normal behaviour next to it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostrad-env-'));
// the loader finds its file as ../.env, so a copy of it inside a throw-away folder reads that folder's .env and never the real one
fs.mkdirSync(path.join(dir, 'src'));
fs.copyFileSync(path.join(here, '..', 'src', 'env.js'), path.join(dir, 'src', 'env.js'));
fs.writeFileSync(path.join(dir, '.env'), 'ARC_ENV_PROBE=from-the-file\n');

const base = { ...process.env };
for (const k of ['ARC_ENV_PROBE', 'ARC_SKIP_ENV_FILE']) delete base[k];
const probe = (env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/env.js'); console.log(process.env.ARC_ENV_PROBE ?? 'unset');"], { cwd: dir, env: { ...base, ...env }, encoding: 'utf8', timeout: 20000 });

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the settings file is read when the server starts', () => {
  const r = probe();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'from-the-file');
});

test('a real environment variable wins over the file', () => {
  assert.equal(probe({ ARC_ENV_PROBE: 'from-the-shell' }).stdout.trim(), 'from-the-shell');
});

test('ARC_SKIP_ENV_FILE=1 reads no file at all', () => {
  const r = probe({ ARC_SKIP_ENV_FILE: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'unset');
});
