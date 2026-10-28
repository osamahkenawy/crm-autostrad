// Creates (or resets) a real person's sign-in, for example the first IT (super admin) account on a fresh production database.
// The password is asked for at the prompt (hidden), or taken from ADMIN_PASSWORD when there is no terminal. It is never stored in plain text.
//
//   node scripts/create-admin.mjs <email> "<Full name>" [it|admin|operations|customer_service|finance] ["Customer Happiness"|Accounts|Branch|Operations|Management]
import '../src/env.js'; // same server/.env as the server, so it writes to the same database
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { db, migrate } from '../src/db.js';

const ROLES = ['it', 'admin', 'operations', 'customer_service', 'finance'];
const TEAMS = ['Customer Happiness', 'Accounts', 'Branch', 'Operations', 'Management'];
const [email, name, role = 'it', department = null] = process.argv.slice(2);
const usage = () => { console.error('Usage: node scripts/create-admin.mjs <email> "<Full name>" [it|admin|operations|customer_service|finance] [support team]'); process.exit(1); };
if (!email || !/^\S+@\S+\.\S+$/.test(email) || !name) usage();
if (!ROLES.includes(role)) { console.error(`Role must be one of: ${ROLES.join(', ')}`); process.exit(1); }
if (department && !TEAMS.includes(department)) { console.error(`Support team must be one of: ${TEAMS.join(', ')}`); process.exit(1); }

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); }; // do not echo the password
  rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
});

let password = process.env.ADMIN_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) { console.error('No terminal to ask on: set ADMIN_PASSWORD for this one command.'); process.exit(1); }
  password = await ask('Password (at least 8 characters): ');
  if (password !== await ask('Repeat it: ')) { console.error('The two passwords differ.'); process.exit(1); }
}
if (String(password).length < 8) { console.error('The password must be at least 8 characters.'); process.exit(1); }

migrate();
const hash = bcrypt.hashSync(String(password), 10);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  db.prepare("UPDATE users SET name = ?, password_hash = ?, role = ?, department = COALESCE(?, department), status = 'active' WHERE id = ?").run(name, hash, role, department, existing.id);
  console.log(`Updated ${email} (${role}) and set the new password.`);
} else {
  db.prepare("INSERT INTO users (name, email, password_hash, role, department, status) VALUES (?, ?, ?, ?, ?, 'active')").run(name, email.toLowerCase(), hash, role, department);
  console.log(`Created ${email} (${role}). They can sign in now.`);
}
