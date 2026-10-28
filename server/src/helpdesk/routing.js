// Who owns a case and when it is due: department by request type (editable routing rules), the least
// loaded active person in that department (or the branch that serves the location), and the SLA due time.
import { db } from '../db.js';
import { ACTIVE_STATUSES, SUBCATEGORIES, SUB_BY_KEY } from './taxonomy.js';
import { emirateOfPlace } from './extract.js';
import { normalize } from './text.js';

/** First start: one editable routing rule per request type, from the standard departments. */
export function seedDefaultRouting() {
  if (db.prepare('SELECT COUNT(*) n FROM hd_routing_rules').get().n) return 0;
  const ins = db.prepare('INSERT INTO hd_routing_rules (sub_key, department, note) VALUES (?, ?, ?)');
  db.transaction(() => SUBCATEGORIES.forEach((x) => ins.run(x.key, x.department, 'Standard routing')))();
  return SUBCATEGORIES.length;
}

export function routeFor(subKey) {
  const rule = db.prepare('SELECT department, owner_id FROM hd_routing_rules WHERE sub_key = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(subKey);
  const sub = SUB_BY_KEY[subKey];
  return { department: (rule && rule.department) || (sub && sub.department) || 'Customer Happiness', ownerId: rule ? rule.owner_id : null };
}

/** The branch that should handle a location: by name or address match, else the first branch in that emirate. */
export function branchForLocation(location, fallbackBranchId = null) {
  const branches = db.prepare('SELECT id, name, emirate, address FROM branches WHERE status = ?').all('open');
  if (location) {
    const loc = normalize(location);
    const byText = branches.find((b) => normalize(`${b.name} ${b.address || ''}`).includes(loc) || loc.includes(normalize(b.name)));
    if (byText) return byText.id;
    const emirate = emirateOfPlace(location);
    const byEmirate = emirate && branches.find((b) => b.emirate === emirate);
    if (byEmirate) return byEmirate.id;
  }
  return fallbackBranchId;
}

/** Least loaded active person in the department; for Branch, prefer someone based at the branch. */
export function pickOwner(department, { branchId = null, ruleOwnerId = null } = {}) {
  if (ruleOwnerId) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").get(ruleOwnerId);
    if (u) return u.id;
  }
  let people = db.prepare("SELECT id, branch_id FROM users WHERE status = 'active' AND department = ?").all(department);
  if (!people.length) return null;
  if (department === 'Branch' && branchId) {
    const local = people.filter((p) => p.branch_id === branchId);
    if (local.length) people = local;
  }
  const load = db.prepare(`SELECT owner_id, COUNT(*) n FROM hd_cases WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) GROUP BY owner_id`).all(...ACTIVE_STATUSES);
  const count = Object.fromEntries(load.map((r) => [r.owner_id, r.n]));
  people.sort((a, b) => (count[a.id] || 0) - (count[b.id] || 0) || a.id - b.id);
  return people[0].id;
}

const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
export const addHours = (from, hours) => fmt(new Date(new Date(`${String(from).replace(' ', 'T')}Z`).getTime() + hours * 3600000));
export const nowUtc = () => fmt(new Date());


/** SLA due time for a priority, counted from `from` (UTC string). */
export const dueAtFor = (priority, from, settings) => addHours(from, (settings.sla_hours && settings.sla_hours[priority]) || 48);
