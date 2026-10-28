// Loads server/.env before anything else reads the environment (this file is the first import of index.js).
// Real environment variables always win over the file. Secrets (ANTHROPIC_API_KEY, GRAPH_*) live only here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(file); } catch (e) { console.warn(`Could not read ${file}: ${e.message}`); }
}
