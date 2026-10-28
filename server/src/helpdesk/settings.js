// Helpdesk settings: sensible defaults, overridden by rows in hd_settings (edited in the UI) and,
// for connection and safety switches, by environment variables.
import { db } from '../db.js';

export const DEFAULTS = {
  mailbox: 'helpdesk@autostrad.com',
  provider: 'demo', // demo | graph
  sla_hours: { Critical: 4, High: 24, Average: 48, Low: 72 },
  followup_hours: [48, 96], // customer reminders after we replied and heard nothing
  autoclose_days: 7, // pending customer with no reply after both reminders
  escalation_hours: [0, 12, 24], // hours past the due time for escalation level 1, 2, 3
  confidence_threshold: 0.6, // below this a case is flagged "needs triage"
  llm_mode: 'always', // off | fallback | always (only used when ANTHROPIC_API_KEY is set)
  llm_fallback_threshold: 0.75,
  draft_llm_personalize: false,
  send_mode: null, // draft_only | send_after_approval (default: demo sends after approval, a real mailbox saves drafts only)
  outlook_writeback: true,
  company_name: 'Autostrad Rent a Car',
  support_phone: '800 288 444',
  release_days_en: '7 to 21 days',
  release_days_ar: 'من 7 إلى 21 يوماً',
  sync_minutes: 2, // how often the mailbox is read (new emails appear without anyone pressing a button)
  report_hour_gulf: 7,
  // Regular expressions (as strings) that capture a contract number in group 1. Add Autostrad's real format here.
  contract_patterns: [
    '\\b(AST[-\\s]?\\d{5,8})\\b',
    // separators are a short bounded run: runs of \\s* around optional words are cubic on a long run of spaces
    '\\b(?:contract|agreement|rental\\s+agreement|booking|reservation|RA)\\b[\\s:#.\\-]{0,6}(?:(?:no|number|num|ref(?:erence)?|id)[\\s:#.\\-]{0,6})?([A-Z]{0,4}[-/]?\\d{4,10}(?:[-/]\\d{1,6})?)',
    '(?:رقم\\s{0,3}(?:ال)?(?:عقد|ايجار|إيجار|الحجز)|عقد\\s{0,3}رقم|العقد\\s{0,3}رقم)[\\s:#\\-]{0,6}([A-Z]{0,4}[-/]?\\d{4,10})',
  ],
};

const ENV_OVERRIDES = {
  provider: 'HELPDESK_PROVIDER',
  mailbox: 'HELPDESK_MAILBOX',
  send_mode: 'HELPDESK_SEND_MODE',
  llm_mode: 'HELPDESK_LLM_MODE',
};

/** Settings that environment variables pin (shown read-only in the UI). */
export const lockedSettings = () => Object.keys(ENV_OVERRIDES).filter((k) => process.env[ENV_OVERRIDES[k]]);

export function getSettings() {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM hd_settings').all()) {
    if (!(row.key in DEFAULTS)) continue;
    try { out[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
  }
  for (const [key, env] of Object.entries(ENV_OVERRIDES)) if (process.env[env]) out[key] = process.env[env];
  if (!out.send_mode) out.send_mode = out.provider === 'demo' ? 'send_after_approval' : 'draft_only';
  return out;
}

export function setSettings(patch) {
  const stmt = db.prepare('INSERT INTO hd_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const changed = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    stmt.run(key, JSON.stringify(value));
    changed.push(key);
  }
  return changed;
}

export const getState = (key) => { const r = db.prepare('SELECT value FROM hd_state WHERE key = ?').get(key); return r ? r.value : null; };
export const setState = (key, value) => db.prepare(
  "INSERT INTO hd_state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
).run(key, value === null || value === undefined ? null : String(value));
