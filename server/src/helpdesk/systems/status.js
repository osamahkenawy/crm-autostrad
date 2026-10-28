// What the "Customer data" setup page shows: is the connection on, is the configuration sound, which secrets are still missing on the
// server, how each system has been answering, and a test box that runs a real lookup and shows every step.
import path from 'node:path';
import { db } from '../../db.js';
import { crmAccount } from '../contracts.js';
import { sourceHealth } from './client.js';
import { accountMode, configPath, loadConfig, LOOKUPS, sourceRuntime } from './config.js';
import { resolveDetailed } from './resolver.js';

/** An address for display: no password or key can ride along in it. */
function showUrl(u) {
  try { const x = new URL(u); return `${x.origin}${x.pathname.replace(/\/+$/, '')}`; } catch { return u ? 'invalid address' : ''; }
}

export function systemsStatus() {
  const cfg = loadConfig();
  const mode = accountMode();
  const c = cfg.config;
  const sources = Object.keys(c.sources).map((name) => {
    const rt = sourceRuntime(name, c);
    return { name, label: rt.label, base_url: showUrl(rt.baseUrl), auth: rt.auth.type, missing: rt.missing, timeout_ms: rt.timeout_ms, cache_seconds: rt.cache_seconds, health: sourceHealth(name) };
  });
  const lookups = Object.entries(LOOKUPS).map(([name, def]) => {
    const lk = c.lookups[name];
    return { name, about: def.about, configured: Boolean(lk), source: lk ? lk.source : null, method: lk ? lk.method || 'GET' : null, path: lk ? lk.path : null, query: lk ? Object.keys(lk.query || {}) : [], fields: lk ? Object.keys(lk.map) : [] };
  });
  const row = (sql) => db.prepare(sql).get().n;
  return {
    mode, forced_by_env: Boolean(process.env.HELPDESK_ACCOUNT_SOURCE), enabled: Boolean(c.enabled), fallback_to_crm: Boolean(c.fallback_to_crm), freshness_minutes: c.freshness_minutes,
    config: { file: path.relative(process.cwd(), configPath()) || configPath(), exists: cfg.exists, ok: cfg.ok, problems: cfg.problems, using_last_good: Boolean(cfg.usingLastGood) },
    sources, lookups,
    cases: {
      from_systems: row("SELECT COUNT(*) n FROM hd_case_accounts WHERE source = 'api'"),
      waiting: row('SELECT COUNT(*) n FROM hd_case_accounts WHERE next_try_at IS NOT NULL'),
      mismatched: row("SELECT COUNT(*) n FROM hd_case_accounts a JOIN hd_cases c ON c.id = a.case_id WHERE a.identity = 'contract_only' AND c.status <> 'closed'"),
    },
  };
}

/**
 * Run a real lookup for an email and/or contract number and report each step. -> { mode, snapshot, steps }.
 * `withRaw` adds each system's untouched answer to its step, to see what the field names are; only IT is shown that.
 */
export async function testLookup({ email = null, contractNo = null, withRaw = false } = {}) {
  const mode = accountMode();
  if (!email && !contractNo) throw new Error('Enter an email address, a contract number, or both.');
  if (mode === 'crm') return { mode, snapshot: crmAccount({ email, contractNo }), steps: [] };
  const cfg = loadConfig();
  if (!cfg.exists || (!cfg.ok && !cfg.usingLastGood)) throw new Error(cfg.exists ? `The configuration has problems: ${cfg.problems[0]}` : 'The configuration file is missing.');
  const { snapshot, steps } = await resolveDetailed({ email, contractNo, bypassCache: true, keepRaw: withRaw });
  return { mode, snapshot, steps: steps.map((s) => (withRaw && s.raw !== undefined ? { ...s, raw: clipRaw(s.raw) } : s)) };
}

/** Cut a long answer down so the page stays readable: a list keeps its first three items. */
function clipRaw(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => clipRaw(x, depth + 1)).concat(v.length > 3 ? [`... ${v.length - 3} more`] : []);
  if (v && typeof v === 'object') return depth > 5 ? '...' : Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, clipRaw(x, depth + 1)]));
  return typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...` : v;
}
