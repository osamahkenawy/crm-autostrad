// The AI lab: try an email, measure the classifier on a labelled test set, and see where staff corrected it.
// Nothing here creates cases or sends mail. Mounted at /api/helpdesk/lab (admin and IT).
import fs from 'node:fs';
import { Router } from 'express';
import { db } from '../db.js';
import { audit } from './audit.js';
import { modelInfo, retrain } from './learner.js';
import { llmAvailable } from './llm.js';
import { previewAnalysis } from './pipeline.js';
import { nowUtc } from './routing.js';
import { SUBCATEGORIES, SUB_BY_KEY, subByName } from './taxonomy.js';
import { BUILT_IN_TESTS } from './testset.js';
import { detectLanguage, normalize } from './text.js';

const router = Router();
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message || 'Something went wrong' }); } };
const round = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const pct = (a, b) => (b ? round((a / b) * 100) : null);

/** Request type from a key, a name ("Invoice Request") or a loose spelling of it. */
export function resolveType(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (SUB_BY_KEY[v]) return SUB_BY_KEY[v].key;
  const hit = subByName(v) || SUBCATEGORIES.find((s) => normalize(s.name) === normalize(v) || s.key === v.toLowerCase().replace(/[\s-]+/g, '_'));
  return hit ? hit.key : null;
}

// 68 emails written separately from the keyword list (by another model that never saw it), kept untouched so they
// give an honest accuracy figure. The labels were assigned from the request-type descriptions: review them.
const INDEPENDENT = JSON.parse(fs.readFileSync(new URL('./testset.independent.json', import.meta.url), 'utf8'));
// 85 more written the same way, used to check the confidence scores and then added to the training samples (dialects, Arabizi, forwards).
const DEV = JSON.parse(fs.readFileSync(new URL('./testset.dev.json', import.meta.url), 'utf8'));

/** Seeds the sample emails (once, or again after a reset): the tuning samples and the independent set. */
export function seedTestSet({ reset = false } = {}) {
  if (reset) db.prepare("DELETE FROM hd_test_cases WHERE source IN ('built-in', 'independent')").run();
  else if (db.prepare('SELECT COUNT(*) n FROM hd_test_cases').get().n) return 0;
  const ins = db.prepare('INSERT INTO hd_test_cases (subject, body, expected_sub_key, expected_priority, language, source) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const [key, subject, body, priority] of BUILT_IN_TESTS) ins.run(subject, body, key, priority || null, detectLanguage(`${subject} ${body}`), 'built-in');
    for (const t of DEV) ins.run(t.subject || '', t.body, t.expected, null, detectLanguage(`${t.subject || ''} ${t.body}`), 'built-in');
    for (const t of INDEPENDENT) ins.run(t.subject || '', t.body, t.expected, null, detectLanguage(`${t.subject || ''} ${t.body}`), 'independent');
  })();
  return BUILT_IN_TESTS.length + DEV.length + INDEPENDENT.length;
}

/* ---------------------------------------------------------------- try one email */
router.post('/classify', wrap(async (req, res) => {
  const { subject = '', body = '', ai = false } = req.body || {};
  if (!String(subject).trim() && !String(body).trim()) throw new Error('Paste an email subject or body to test.');
  if (String(body).length > 20000) throw new Error('That email is too long to test (limit 20,000 characters).');
  const useAi = Boolean(ai) && llmAvailable();
  res.json({ ...(await previewAnalysis({ subject, body, ai: useAi, learn: !(req.body && req.body.learn === false) })), ai_requested: Boolean(ai), ai_available: llmAvailable() });
}));

/* ---------------------------------------------------------------- the labelled test set */
router.get('/tests', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM hd_test_cases ORDER BY expected_sub_key, id').all();
  const per = {};
  for (const r of rows) per[r.expected_sub_key] = (per[r.expected_sub_key] || 0) + 1;
  res.json({ data: rows, total: rows.length, per_type: per, ai_available: llmAvailable() });
}));

router.post('/tests', wrap((req, res) => {
  const b = req.body || {};
  const key = resolveType(b.expected_sub_key);
  if (!key) throw new Error('Choose the correct request type for this email.');
  if (!String(b.body || '').trim()) throw new Error('The email body is required.');
  if (b.expected_priority && !['Critical', 'High', 'Average', 'Low'].includes(b.expected_priority)) throw new Error('Unknown priority.');
  const info = db.prepare('INSERT INTO hd_test_cases (subject, body, expected_sub_key, expected_priority, language, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(b.subject || '').slice(0, 300), String(b.body).slice(0, 20000), key, b.expected_priority || null, detectLanguage(`${b.subject || ''} ${b.body}`), b.source === 'override' ? 'override' : 'added');
  audit({ actor: req.me, action: 'test_case_added', newValue: key, detail: String(b.subject || '').slice(0, 120) });
  res.status(201).json(db.prepare('SELECT * FROM hd_test_cases WHERE id = ?').get(info.lastInsertRowid));
}));

router.delete('/tests/:id', wrap((req, res) => {
  const r = db.prepare('DELETE FROM hd_test_cases WHERE id = ?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Test email not found' });
  res.json({ ok: true });
}));

router.post('/tests/reset', wrap((req, res) => {
  const n = seedTestSet({ reset: true });
  audit({ actor: req.me, action: 'test_set_reset', detail: `${n} built-in sample emails restored` });
  res.json({ restored: n });
}));

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * CSV columns: subject, body, expected (request type name or key), priority (optional).
 * mode: 'split' (half measure, half train: the default), 'measure' (all kept out of training) or 'train'.
 * Emails the model trains on cannot also measure it, so the split is what keeps the accuracy figure honest.
 */
router.post('/tests/import', wrap((req, res) => {
  const mode = ['measure', 'train'].includes(req.body && req.body.mode) ? req.body.mode : 'split';
  const rows = parseCsv(req.body && req.body.csv);
  if (rows.length < 2) throw new Error('The file needs a header row and at least one email.');
  const head = rows[0].map((h) => normalize(h).replace(/\s+/g, '_'));
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iSubject = col('subject', 'title');
  const iBody = col('body', 'email', 'text', 'message');
  const iType = col('expected', 'expected_type', 'request_type', 'type', 'sub_category', 'subcategory', 'category');
  const iPrio = col('priority', 'expected_priority');
  if (iBody < 0 || iType < 0) throw new Error('Columns needed: body (the email text) and expected (the correct request type). Optional: subject, priority.');
  const ins = db.prepare('INSERT INTO hd_test_cases (subject, body, expected_sub_key, expected_priority, language, source) VALUES (?, ?, ?, ?, ?, ?)');
  let added = 0;
  const errors = [];
  db.transaction(() => {
    for (const [n, r] of rows.slice(1, 1001).entries()) {
      const key = resolveType(r[iType]);
      const body = String(r[iBody] || '').trim();
      if (!body) { errors.push(`Row ${n + 2}: empty email body`); continue; }
      if (!key) { errors.push(`Row ${n + 2}: unknown request type "${String(r[iType] || '').slice(0, 40)}"`); continue; }
      const prio = iPrio >= 0 ? ['Critical', 'High', 'Average', 'Low'].find((p) => p.toLowerCase() === String(r[iPrio] || '').trim().toLowerCase()) || null : null;
      const subject = iSubject >= 0 ? String(r[iSubject] || '').slice(0, 300) : '';
      const source = mode === 'measure' ? 'imported' : mode === 'train' ? 'imported-train' : (added % 2 === 0 ? 'imported' : 'imported-train');
      ins.run(subject, body.slice(0, 20000), key, prio, detectLanguage(`${subject} ${body}`), source);
      added++;
    }
  })();
  if (added) audit({ actor: req.me, action: 'test_set_imported', detail: `${added} labelled emails imported (${{ split: 'half to measure, half to train', measure: 'all to measure', train: 'all to train' }[mode]})${errors.length ? `, ${errors.length} skipped` : ''}` });
  res.json({ added, skipped: errors.length, errors: errors.slice(0, 20), mode });
}));

/* ---------------------------------------------------------------- measure it */
const AI_RUN_LIMIT = 150; // keeps the cost of one AI run predictable

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

const ENGINE_NAME = { rules: 'Keyword rules', smart: 'Smart engine (rules and learned model)', ai: 'Smart engine and AI' };

router.post('/run', wrap(async (req, res) => {
  const engine = req.body && ['rules', 'smart', 'ai'].includes(req.body.engine) ? req.body.engine : 'smart';
  if (engine === 'ai' && !llmAvailable()) throw new Error('The AI layer is not switched on (needs ANTHROPIC_API_KEY and an AI mode other than off). Run the rules engine instead.');
  let tests = db.prepare('SELECT * FROM hd_test_cases ORDER BY id').all();
  if (!tests.length) throw new Error('The test set is empty. Add emails or restore the built-in samples first.');
  // an AI run asks the AI about every email, so it covers the independent and imported emails (the ones that measure), not the tuning samples
  if (engine === 'ai') tests = tests.filter((t) => t.source !== 'built-in');
  if (engine === 'ai' && !tests.length) throw new Error('There are no independent or imported emails to run the AI on.');
  if (engine === 'ai' && tests.length > AI_RUN_LIMIT) throw new Error(`An AI run is limited to ${AI_RUN_LIMIT} emails to keep the cost predictable. Remove some test emails or run the smart engine.`);

  const results = await inBatches(tests, engine === 'ai' ? 3 : 20, async (t) => {
    const out = await previewAnalysis({ subject: t.subject || '', body: t.body, ai: engine === 'ai', learn: engine !== 'rules' });
    return { id: t.id, subject: t.subject, language: t.language, source: t.source, expected: t.expected_sub_key, expected_priority: t.expected_priority, got: out.sub_key, priority: out.priority,
      confidence: out.confidence, engine: out.engine, needs_review: out.needs_review, ok: out.sub_key === t.expected_sub_key, priority_ok: t.expected_priority ? out.priority === t.expected_priority : null,
      terms: out.rules.matched.slice(0, 4).map((m) => m.term) };
  });

  const correct = results.filter((r) => r.ok).length;
  const types = SUBCATEGORIES.map((s) => {
    const expected = results.filter((r) => r.expected === s.key);
    const predicted = results.filter((r) => r.got === s.key);
    const tp = expected.filter((r) => r.ok).length;
    return { sub_key: s.key, name: s.name, tests: expected.length, correct: tp, predicted: predicted.length, recall: pct(tp, expected.length), precision: pct(tp, predicted.length) };
  }).filter((t) => t.tests || t.predicted);
  const byLang = {};
  for (const r of results) { const l = r.language || 'en'; (byLang[l] ||= { total: 0, correct: 0 }); byLang[l].total++; if (r.ok) byLang[l].correct++; }
  const bySource = {};
  for (const r of results) { const k = r.source || 'added'; (bySource[k] ||= { total: 0, correct: 0 }); bySource[k].total++; if (r.ok) bySource[k].correct++; }
  const confident = results.filter((r) => !r.needs_review); // what the system would not hand to a person for checking
  const prioChecked = results.filter((r) => r.priority_ok !== null);
  const avg = (list) => (list.length ? list.reduce((a, r) => a + (r.confidence || 0), 0) / list.length : null);
  const summary = {
    engine, total: results.length, correct, accuracy: pct(correct, results.length),
    priority_checked: prioChecked.length, priority_correct: prioChecked.filter((r) => r.priority_ok).length,
    flagged_for_triage: results.filter((r) => r.needs_review).length,
    avg_confidence_correct: round(avg(results.filter((r) => r.ok)), 2), avg_confidence_wrong: round(avg(results.filter((r) => !r.ok)), 2),
    by_language: Object.fromEntries(Object.entries(byLang).map(([l, v]) => [l, { ...v, accuracy: pct(v.correct, v.total) }])),
    by_source: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, { ...v, accuracy: pct(v.correct, v.total) }])),
    confident_total: confident.length, confident_correct: confident.filter((r) => r.ok).length, confident_accuracy: pct(confident.filter((r) => r.ok).length, confident.length),
    types, failures: results.filter((r) => !r.ok || r.priority_ok === false),
  };
  const info = db.prepare('INSERT INTO hd_test_runs (ran_at, engine, total, correct, result) VALUES (?, ?, ?, ?, ?)').run(nowUtc(), engine, results.length, correct, JSON.stringify(summary));
  audit({ actor: req.me, action: 'test_run', detail: `${ENGINE_NAME[engine]}: ${correct}/${results.length} correct (${summary.accuracy}%)` });
  res.status(201).json({ id: Number(info.lastInsertRowid), ran_at: nowUtc(), ...summary });
}));

/* the learned model: what it was trained on, and a button to retrain it now (it also retrains by itself) */
router.get('/model', wrap((_req, res) => res.json(modelInfo())));
router.post('/model/retrain', wrap((req, res) => {
  const info = retrain().info;
  audit({ actor: req.me, action: 'model_retrained', detail: `${info.docs} training texts: ${info.keywords} keyword phrases, ${info.samples} sample emails, ${info.corrected} staff-corrected cases, ${info.closed} closed cases` });
  res.json(info);
}));

router.get('/runs', wrap((_req, res) => res.json({ data: db.prepare('SELECT id, ran_at, engine, total, correct FROM hd_test_runs ORDER BY id DESC LIMIT 30').all() })));
router.get('/runs/:id', wrap((req, res) => {
  const r = db.prepare('SELECT * FROM hd_test_runs WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Run not found' });
  res.json({ id: r.id, ran_at: r.ran_at, ...JSON.parse(r.result || '{}') });
}));

/* ---------------------------------------------------------------- what staff corrected */
const cleanPhrase = (subject) => normalize(subject)
  .replace(/^(?:re|fw|fwd)\s*:\s*/g, '').replace(/\[?cs-\d{4}-\d{6}\]?/g, '').replace(/\bast[-\s]?\d{4,8}\b/g, '').replace(/[^a-z0-9؀-ۿ\s]/g, ' ').replace(/\s+/g, ' ').trim();

router.get('/feedback', wrap((req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = `-${days} days`;
  const classified = db.prepare("SELECT COUNT(*) n FROM hd_audit WHERE action = 'classified' AND at >= datetime('now', ?)").get(since).n;
  const confirmed = db.prepare("SELECT COUNT(*) n FROM hd_audit WHERE action = 'classification_confirmed' AND at >= datetime('now', ?)").get(since).n;
  const overrides = db.prepare(`SELECT a.id, a.at, a.field, a.old_value, a.new_value, a.detail, a.actor_name, c.id AS case_id, c.case_no, c.subject, c.classified_by, c.confidence, c.matched_terms
                                  FROM hd_audit a JOIN hd_cases c ON c.id = a.case_id WHERE a.action = 'override' AND a.at >= datetime('now', ?) ORDER BY a.at DESC, a.id DESC LIMIT 200`).all(since);
  const byField = {};
  const pairs = {};
  const rows = overrides.map((o) => {
    byField[o.field] = (byField[o.field] || 0) + 1;
    let suggestion = null;
    if (o.field === 'sub_key') {
      pairs[`${o.old_value}>${o.new_value}`] = (pairs[`${o.old_value}>${o.new_value}`] || 0) + 1;
      const phrase = cleanPhrase(o.subject || '');
      if (phrase.split(' ').length >= 2 && phrase.length <= 60) suggestion = { sub_key: o.new_value, term: phrase };
    }
    return { ...o, matched_terms: (() => { try { return JSON.parse(o.matched_terms || '[]'); } catch { return []; } })(), suggestion };
  });
  res.json({
    days, classified, confirmed, overrides: overrides.length, by_field: byField,
    override_rate: pct(overrides.filter((o) => o.field === 'sub_key' || o.field === 'priority').length, classified),
    confused_pairs: Object.entries(pairs).map(([k, n]) => { const [from, to] = k.split('>'); return { from, to, count: n }; }).sort((a, b) => b.count - a.count).slice(0, 8),
    data: rows,
  });
}));

export default router;
