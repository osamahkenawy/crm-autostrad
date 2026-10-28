// Dashboard numbers. Everything is computed from the case tables on request (a few thousand rows at
// most), so the dashboard can refresh every 15 minutes without a separate reporting database.
import { db } from '../db.js';
import { getSettings } from './settings.js';
import { ACTIVE_STATUSES, CATEGORIES, SUB_BY_KEY, WORKING_STATUSES } from './taxonomy.js';

const GULF = 4 * 3600000;
const ms = (s) => new Date(`${String(s).replace(' ', 'T')}Z`).getTime();
const gulfDay = (s) => new Date(ms(s) + GULF).toISOString().slice(0, 10);
export const gulfToday = () => new Date(Date.now() + GULF).toISOString().slice(0, 10);
const hoursBetween = (a, b) => (ms(b) - ms(a)) / 3600000;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);

/** Monday of the week containing a Gulf day (YYYY-MM-DD). */
export function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
const addDays = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

function loadCases(sinceDays) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const cases = db.prepare(`SELECT c.id, c.case_no, c.status, c.category, c.sub_key, c.sub_category, c.priority, c.department, c.owner_id, u.name AS owner_name, c.subject, c.customer_name,
      c.confidence, c.classified_by, c.first_received_at, c.closed_at, c.due_at, c.escalation_level, c.channel, c.needs_review, c.sensitive,
      (SELECT MIN(m.received_at) FROM hd_messages m WHERE m.case_id = c.id AND m.direction = 'out') AS first_reply_at
    FROM hd_cases c LEFT JOIN users u ON u.id = c.owner_id WHERE c.first_received_at >= ? OR c.status <> 'closed'`).all(since);
  return cases;
}

/** Cases per category, bucketed by day / week / month (new cases by arrival date). */
function trends(cases) {
  const today = gulfToday();
  const mk = (keys) => Object.fromEntries(keys.map((k) => [k, Object.fromEntries([['key', k], ...CATEGORIES.map((c) => [c, 0])])]));
  const days = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29));
  const weeks = Array.from({ length: 12 }, (_, i) => weekStart(addDays(today, (i - 11) * 7)));
  const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (5 - i), 1); return d.toISOString().slice(0, 7); });
  const D = mk(days); const W = mk(weeks); const M = mk(months);
  for (const c of cases) {
    const day = gulfDay(c.first_received_at);
    if (D[day]) D[day][c.category] = (D[day][c.category] || 0) + 1;
    const wk = weekStart(day);
    if (W[wk]) W[wk][c.category] = (W[wk][c.category] || 0) + 1;
    if (M[day.slice(0, 7)]) M[day.slice(0, 7)][c.category] = (M[day.slice(0, 7)][c.category] || 0) + 1;
  }
  const rows = (o, keys) => keys.map((k) => ({ ...o[k], total: CATEGORIES.reduce((a, c) => a + o[k][c], 0) }));
  return { daily: rows(D, days), weekly: rows(W, weeks), monthly: rows(M, months), categories: CATEGORIES };
}

export function aiPerformance(cases, threshold) {
  const ids = cases.map((c) => c.id);
  if (!ids.length) return { classified: 0, classification_rate: null, draft_acceptance_rate: null, override_rate: null, drafts_reviewed: 0, drafts_accepted: 0, overrides: 0, avg_confidence: null, engine_mix: {} };
  const inIds = `(${ids.join(',')})`;
  const classified = cases.filter((c) => c.classified_by && c.classified_by !== 'manual');
  const auto = classified.filter((c) => (c.confidence || 0) >= threshold);
  const drafts = db.prepare(`SELECT status, edited, discard_reason FROM hd_drafts WHERE case_id IN ${inIds} AND generated_by IN ('template', 'llm')`).all();
  const reviewed = drafts.filter((d) => ['approved', 'sent'].includes(d.status) || (d.status === 'discarded' && !['superseded', 'case_closed', 'replied in the mailbox'].includes(d.discard_reason || '')));
  const accepted = reviewed.filter((d) => ['approved', 'sent'].includes(d.status) && !d.edited);
  const overrides = db.prepare(`SELECT COUNT(DISTINCT case_id) n FROM hd_audit WHERE action = 'override' AND case_id IN ${inIds}`).get().n;
  const mix = {};
  for (const c of classified) mix[c.classified_by] = (mix[c.classified_by] || 0) + 1;
  return {
    classified: classified.length,
    classification_rate: pct(auto.length, classified.length),
    draft_acceptance_rate: pct(accepted.length, reviewed.length),
    override_rate: pct(overrides, classified.length),
    drafts_reviewed: reviewed.length, drafts_accepted: accepted.length, overrides,
    avg_confidence: avg(classified.map((c) => (c.confidence || 0) * 100)),
    engine_mix: mix,
  };
}

export function responseStats(cases, settings) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const firsts = []; let within = 0; let breached = 0;
  for (const c of cases) {
    const sla = (settings.sla_hours && settings.sla_hours[c.priority]) || 48;
    if (c.first_reply_at) {
      const h = hoursBetween(c.first_received_at, c.first_reply_at);
      firsts.push(h);
      if (h <= sla) within++; else breached++;
    } else if (c.status !== 'closed' && c.due_at && c.due_at < now) breached++;
  }
  const resolved = cases.filter((c) => c.closed_at).map((c) => hoursBetween(c.first_received_at, c.closed_at));
  return { avg_first_response_hours: avg(firsts), avg_resolution_hours: avg(resolved), sla_compliance: pct(within, within + breached), responded: firsts.length };
}

export function dashboard({ days = 30 } = {}) {
  const settings = getSettings();
  const all = loadCases(Math.max(days, 190));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const period = all.filter((c) => c.first_received_at >= since);
  const open = all.filter((c) => ACTIVE_STATUSES.includes(c.status));
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const overdue = open.filter((c) => WORKING_STATUSES.includes(c.status) && c.due_at && c.due_at < now);

  const bucket = (c) => { const d = hoursBetween(c.first_received_at, now) / 24; return d <= 2 ? '0 to 2 days' : d <= 7 ? '3 to 7 days' : '8+ days'; };
  const aging = [['0 to 2 days', '0-2'], ['3 to 7 days', '3-7'], ['8+ days', '8+']].map(([b, key]) => ({ bucket: b, key, count: open.filter((c) => bucket(c) === b).length }));

  const byOwner = {};
  for (const c of overdue) { const k = c.owner_id || 0; byOwner[k] ||= { owner_id: c.owner_id, owner: c.owner_name || 'Unassigned', count: 0 }; byOwner[k].count++; }

  const priority = Object.fromEntries(['Critical', 'High', 'Average', 'Low'].map((p) => [p, open.filter((c) => c.priority === p).length]));

  const topMap = {};
  for (const c of period) topMap[c.sub_key] = (topMap[c.sub_key] || 0) + 1;
  const top_issues = Object.entries(topMap).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([key, count]) => ({ sub_key: key, name: (SUB_BY_KEY[key] || {}).name || key, category: (SUB_BY_KEY[key] || {}).category, count, share: pct(count, period.length) }));

  const channelRows = db.prepare('SELECT channel, SUM(count) n FROM hd_channel_stats WHERE day >= ? GROUP BY channel').all(since.slice(0, 10));
  const chan = Object.fromEntries(channelRows.map((r) => [String(r.channel).toLowerCase(), r.n]));
  // Email is read from the mailbox. WhatsApp and phone calls have no feed into this module yet: the counts are typed in by staff.
  const channels = [
    { channel: 'Email', key: 'email', count: period.filter((c) => c.channel === 'email').length, connected: true, manual: false },
    { channel: 'WhatsApp', key: 'whatsapp', count: chan.whatsapp || 0, connected: false, manual: 'whatsapp' in chan },
    { channel: 'Calls', key: 'calls', count: chan.calls || 0, connected: false, manual: 'calls' in chan },
  ];

  const attention = [...open].filter((c) => overdue.includes(c) || c.priority === 'Critical')
    .sort((a, b) => (overdue.includes(b) ? 1 : 0) - (overdue.includes(a) ? 1 : 0) || ['Critical', 'High', 'Average', 'Low'].indexOf(a.priority) - ['Critical', 'High', 'Average', 'Low'].indexOf(b.priority) || String(a.due_at).localeCompare(String(b.due_at)))
    .slice(0, 8).map((c) => ({ id: c.id, case_no: c.case_no, subject: c.subject, sub_category: c.sub_category, priority: c.priority, owner: c.owner_name, due_at: c.due_at, is_overdue: overdue.includes(c), status: c.status }));

  const pendingDrafts = db.prepare("SELECT COUNT(*) n FROM hd_drafts d JOIN hd_cases c ON c.id = d.case_id WHERE d.status = 'pending' AND c.status <> 'closed'").get().n;
  return {
    generated_at: new Date().toISOString(), range_days: days, refresh_minutes: 15,
    totals: {
      open: open.length, working: open.filter((c) => WORKING_STATUSES.includes(c.status)).length,
      pending_customer: open.filter((c) => c.status === 'pending_customer').length, pending_internal: open.filter((c) => c.status === 'pending_internal').length,
      new_in_period: period.length, closed_in_period: all.filter((c) => c.closed_at && c.closed_at >= since).length,
      overdue: overdue.length, needs_triage: open.filter((c) => c.needs_review).length, drafts_pending: pendingDrafts,
      escalated: open.filter((c) => c.escalation_level > 0).length,
    },
    aging, overdue_by_owner: Object.values(byOwner).sort((a, b) => b.count - a.count), priority, trends: trends(all), top_issues, channels,
    ai: aiPerformance(period, settings.confidence_threshold),
    response: responseStats(period, settings),
    attention,
  };
}
