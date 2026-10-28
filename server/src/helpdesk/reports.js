// Daily and weekly summaries: volume, status, aging, who is overdue, top issues, how the AI did.
// Generated on a schedule (and on demand), stored, and shown in the app; the text version can be pasted
// into an email. Nothing is sent automatically.
import { db } from '../db.js';
import { audit } from './audit.js';
import { aiPerformance, gulfToday, responseStats, weekStart } from './metrics.js';
import { getSettings } from './settings.js';
import { ACTIVE_STATUSES, CATEGORIES, SUB_BY_KEY, WORKING_STATUSES } from './taxonomy.js';

const GULF = 4 * 3600000;
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
/** Gulf day boundaries as UTC strings. */
const startUtc = (day) => new Date(new Date(`${day}T00:00:00Z`).getTime() - GULF).toISOString().slice(0, 19).replace('T', ' ');
const longDay = (day) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));

function snapshot(fromDay, toDayExclusive, settings) {
  const from = startUtc(fromDay);
  const to = startUtc(toDayExclusive);
  const created = db.prepare(`SELECT c.*, u.name AS owner_name,
      (SELECT MIN(m.received_at) FROM hd_messages m WHERE m.case_id = c.id AND m.direction = 'out') AS first_reply_at
    FROM hd_cases c LEFT JOIN users u ON u.id = c.owner_id WHERE c.first_received_at >= ? AND c.first_received_at < ?`).all(from, to);
  const closed = db.prepare('SELECT COUNT(*) n FROM hd_cases WHERE closed_at >= ? AND closed_at < ?').get(from, to).n;
  const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const open = db.prepare(`SELECT c.*, u.name AS owner_name FROM hd_cases c LEFT JOIN users u ON u.id = c.owner_id WHERE c.status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(',')})`).all();
  const overdue = open.filter((c) => WORKING_STATUSES.includes(c.status) && c.due_at && c.due_at < nowStr);

  const count = (arr, key) => Object.entries(arr.reduce((m, c) => ({ ...m, [c[key] || 'Unassigned']: (m[c[key] || 'Unassigned'] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  const byCategory = CATEGORIES.map((c) => ({ category: c, count: created.filter((x) => x.category === c).length }));
  const topIssues = count(created, 'sub_key').slice(0, 5).map(([k, n]) => ({ sub_key: k, name: (SUB_BY_KEY[k] || {}).name || k, count: n }));
  const aging = [['0 to 2 days', 0, 2], ['3 to 7 days', 2, 7], ['8+ days', 7, 9999]].map(([bucket, lo, hi]) => ({
    bucket, count: open.filter((c) => { const d = (Date.now() - new Date(`${c.first_received_at.replace(' ', 'T')}Z`)) / 86400000; return d > lo && d <= hi || (lo === 0 && d <= hi); }).length,
  }));
  return {
    new_cases: created.length, closed_cases: closed, open_cases: open.length, overdue_cases: overdue.length,
    by_category: byCategory, top_issues: topIssues, aging,
    overdue_by_owner: count(overdue, 'owner_name').map(([owner, n]) => ({ owner, count: n })),
    overdue_by_department: count(overdue, 'department').map(([department, n]) => ({ department, count: n })),
    by_priority: ['Critical', 'High', 'Average', 'Low'].map((p) => ({ priority: p, open: open.filter((c) => c.priority === p).length })),
    critical_open: open.filter((c) => c.priority === 'Critical').slice(0, 8).map((c) => ({ case_no: c.case_no, subject: c.subject, owner: c.owner_name, due_at: c.due_at })),
    ai: aiPerformance(created, settings.confidence_threshold),
    response: responseStats(created, settings),
  };
}

const delta = (a, b) => (b === 0 ? '' : ` (${a - b >= 0 ? '+' : ''}${a - b} vs ${'the period before'})`);

function summaryText(kind, label, cur, prev) {
  const lines = [];
  lines.push(`${kind === 'daily' ? 'Daily' : 'Weekly'} customer service summary: ${label}`);
  lines.push('');
  lines.push(`Volume: ${cur.new_cases} new cases${prev ? ` (${cur.new_cases - prev.new_cases >= 0 ? '+' : ''}${cur.new_cases - prev.new_cases} vs the ${kind === 'daily' ? 'day' : 'week'} before)` : ''}, ${cur.closed_cases} closed.`);
  lines.push(`Backlog: ${cur.open_cases} open cases, ${cur.overdue_cases} overdue${cur.overdue_by_department.length ? ` (${cur.overdue_by_department.map((d) => `${d.count} ${d.department}`).join(', ')})` : ''}.`);
  lines.push(`Aging of open cases: ${cur.aging.map((a) => `${a.count} at ${a.bucket}`).join(', ')}.`);
  if (cur.top_issues.length) lines.push(`Top requests: ${cur.top_issues.map((t) => `${t.name} (${t.count})`).join(', ')}.`);
  if (cur.response.avg_first_response_hours !== null) lines.push(`Average first response: ${cur.response.avg_first_response_hours} hours; SLA compliance ${cur.response.sla_compliance ?? 'n/a'}%.`);
  if (cur.ai.classified) lines.push(`AI: ${cur.ai.classification_rate ?? 'n/a'}% classified with confidence, ${cur.ai.draft_acceptance_rate ?? 'n/a'}% of reviewed drafts accepted without edits, ${cur.ai.override_rate ?? 'n/a'}% of classifications overridden by staff.`);
  if (cur.critical_open.length) { lines.push(''); lines.push('Critical cases still open:'); for (const c of cur.critical_open) lines.push(`- ${c.case_no} ${c.subject}${c.owner ? ` (${c.owner})` : ' (unassigned)'}`); }
  if (cur.overdue_by_owner.length) { lines.push(''); lines.push(`Overdue by owner: ${cur.overdue_by_owner.map((o) => `${o.owner} ${o.count}`).join(', ')}.`); }
  return lines.join('\n');
}

/** Build (and store) a report. kind: 'daily' for one Gulf day, 'weekly' for the Monday to Sunday week containing `day`. */
export function generateReport(kind, { day = null, store = true } = {}) {
  const settings = getSettings();
  let start; let end; let prevStart; let label; let title;
  if (kind === 'weekly') {
    start = weekStart(day || addDays(gulfToday(), -1));
    end = addDays(start, 7);
    prevStart = addDays(start, -7);
    label = `${longDay(start).replace(/^\w+, /, '')} to ${longDay(addDays(start, 6)).replace(/^\w+, /, '')}`;
    title = `Weekly summary, week of ${start}`;
  } else {
    start = day || addDays(gulfToday(), -1);
    end = addDays(start, 1);
    prevStart = addDays(start, -1);
    label = longDay(start);
    title = `Daily summary, ${start}`;
  }
  const cur = snapshot(start, end, settings);
  const prev = snapshot(prevStart, start, settings);
  const data = { kind, period_start: start, period_end: addDays(end, -1), label, ...cur, previous: { new_cases: prev.new_cases, closed_cases: prev.closed_cases } };
  const summary = summaryText(kind, label, cur, prev);
  if (store) {
    db.prepare(`INSERT INTO hd_reports (kind, period_start, period_end, title, summary, data) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind, period_start) DO UPDATE SET generated_at = datetime('now'), period_end = excluded.period_end, title = excluded.title, summary = excluded.summary, data = excluded.data`)
      .run(kind, start, addDays(end, -1), title, summary, JSON.stringify(data));
    audit({ actor: 'system', action: 'report_generated', detail: title });
  }
  return { kind, period_start: start, title, summary, data };
}

export const listReports = (kind = null) => db.prepare(`SELECT id, kind, period_start, period_end, generated_at, title FROM hd_reports ${kind ? 'WHERE kind = ?' : ''} ORDER BY period_start DESC LIMIT 60`).all(...(kind ? [kind] : []));
export const getReport = (id) => { const r = db.prepare('SELECT * FROM hd_reports WHERE id = ?').get(id); return r ? { ...r, data: JSON.parse(r.data || '{}') } : null; };
