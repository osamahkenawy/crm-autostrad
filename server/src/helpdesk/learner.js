// The learned layer of the engine: a small text model trained on Autostrad's own wording. It learns from
//  - the keyword phrases (so it starts with everything the starter list knows),
//  - labelled sample emails (never the "independent" set or imported emails kept for measuring: those stay untouched for honest measurement),
//  - real cases: ones staff corrected or confirmed count double, ones closed by a person count a little less.
// Words, word pairs and short letter groups are weighted by how rare they are (TF-IDF). A new email is compared with
// every request type's average (centroid) and with the closest past emails (nearest neighbours); the two opinions are
// averaged into one probability per type. Letter groups make it forgiving of typos, Arabic prefixes and dialect spelling.
// It retrains by itself whenever the keywords, the samples or the staff corrections change. No outside service is used.
import { db } from '../db.js';
import { SUBCATEGORIES } from './taxonomy.js';
import { normalize } from './text.js';

const KEYS = SUBCATEGORIES.map((s) => s.key);
const KEY_SET = new Set(KEYS);
const STOP = new Set(('the a an and or to of in on for is are was were be been it this that i my me we you your our with at by from as have has had do did not no but so if can could would please ' +
  'hi hello dear thanks thank regards kind best team autostrad rent car cars اللي في من على الي إلى عن هذا هذه ذلك ان لا ما هل مع كل او و يا انا نحن لكم لكن قد تم كان كانت السلام عليكم ورحمه الله وبركاته ' +
  'مرحبا شكرا تحيه طيبه السادة الكرام المحترمين اوتوستراد شركه ابي ابغي ابغى للحين').split(' '));
const AR_PREFIX = /^(?:وال|بال|كال|فال|لل|ال)(?=.{3,})/;

const stem = (t) => (/^[؀-ۿ]+$/.test(t) ? t.replace(AR_PREFIX, '') : t);

function tokens(text) {
  const out = [];
  for (const m of normalize(text).matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (t.length < 2 || /^\d+$/.test(t) || STOP.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

/** Occurrence counts of words, word pairs and letter groups (the lighter weight of the letter groups is applied in vec, after the logarithm). */
function features(text) {
  const f = new Map();
  const add = (k) => f.set(k, (f.get(k) || 0) + 1);
  const toks = tokens(text);
  toks.forEach((t, i) => {
    add(`w:${t}`);
    if (i > 0) add(`b:${toks[i - 1]}_${t}`);
    const padded = `<${t}>`;
    for (const n of [3, 4]) for (let j = 0; j + n <= padded.length; j++) add(`c:${padded.slice(j, j + n)}`);
  });
  return f;
}

const l2 = (v) => { let s = 0; for (const x of v.values()) s += x * x; s = Math.sqrt(s) || 1; for (const [k, x] of v) v.set(k, x / s); return v; };

/** Everything the model learns from, with how much each source counts. A row with an unknown request type or a weight that is not a number is left out. */
function collect() {
  const docs = [];
  const info = { keywords: 0, samples: 0, corrected: 0, closed: 0 };
  // emails kept for measuring: an exact copy of one must not teach the model the answer it is then measured on
  const held = new Set(db.prepare("SELECT subject, body FROM hd_test_cases WHERE source IN ('independent', 'imported')").all().map((t) => normalize(`${t.subject || ''}\n${t.body}`)));
  for (const k of db.prepare("SELECT sub_key, term, weight FROM hd_keywords WHERE active = 1 AND kind = 'phrase'").all()) {
    if (!KEY_SET.has(k.sub_key) || !k.term) continue;
    docs.push({ label: k.sub_key, text: k.term, w: Math.max(0.5, (Number(k.weight) || 3) / 3), kind: 'keyword' });
    info.keywords++;
  }
  for (const t of db.prepare("SELECT subject, body, expected_sub_key AS label FROM hd_test_cases WHERE source NOT IN ('independent', 'imported')").all()) {
    const text = `${t.subject || ''}\n${t.body}`;
    if (!KEY_SET.has(t.label) || held.has(normalize(text))) continue;
    docs.push({ label: t.label, text, w: 1.5, kind: 'sample' });
    info.samples++;
  }
  const rows = db.prepare(`SELECT c.id, c.sub_key, c.subject, c.status, c.closure_reason,
      (SELECT m.body FROM hd_messages m WHERE m.case_id = c.id AND m.direction = 'in' ORDER BY m.received_at, m.id LIMIT 1) AS body,
      EXISTS (SELECT 1 FROM hd_audit a WHERE a.case_id = c.id AND (a.action = 'classification_confirmed' OR (a.action = 'override' AND a.field = 'sub_key'))) AS corrected
    FROM hd_cases c WHERE c.sub_key IS NOT NULL`).all();
  for (const r of rows) {
    if (!r.body || !KEY_SET.has(r.sub_key)) continue;
    const text = `${r.subject || ''}\n${r.body}`;
    if (held.has(normalize(text))) continue;
    if (r.corrected) { docs.push({ label: r.sub_key, text, w: 2, kind: 'case', caseId: r.id }); info.corrected++; }
    else if (r.status === 'closed' && ['resolved', 'action_completed', 'customer_confirmed', 'not_applicable'].includes(r.closure_reason)) {
      docs.push({ label: r.sub_key, text, w: 0.8, kind: 'case', caseId: r.id });
      info.closed++;
    }
  }
  return { docs, info };
}

function build() {
  const { docs, info } = collect();
  const df = new Map();
  const tfs = docs.map((d) => features(d.text));
  for (const tf of tfs) for (const k of tf.keys()) df.set(k, (df.get(k) || 0) + 1);
  const N = docs.length;
  const idf = new Map();
  for (const [k, n] of df) idf.set(k, Math.log((N + 1) / (n + 1)) + 1);

  // letter groups count for a third as much as whole words. The 0.35 is applied here, to (1 + log count): it used to be added to the count
  // itself, so a group seen once weighed 1 + log(0.35) = -0.05, and typo-robustness, the point of the letter groups, was close to nothing
  const CHAR_WEIGHT = 0.35;
  const vec = (tf) => { const v = new Map(); for (const [k, c] of tf) { const i = idf.get(k); if (i) v.set(k, (1 + Math.log(c)) * i * (k[0] === 'c' ? CHAR_WEIGHT : 1)); } return l2(v); };
  const postings = new Map();
  const centroids = new Map(KEYS.map((k) => [k, new Map()]));
  const vectors = docs.map((d, i) => {
    const v = vec(tfs[i]);
    for (const [k, x] of v) { (postings.get(k) || postings.set(k, []).get(k)).push([i, x]); const c = centroids.get(d.label); if (c) c.set(k, (c.get(k) || 0) + x * d.w); }
    return v;
  });
  for (const c of centroids.values()) l2(c);

  const dot = (a, b) => { let s = 0; for (const [k, x] of a) { const y = b.get(k); if (y) s += x * y; } return s; };

  /** -> per-type probabilities, how strong the evidence is, and the nearest past emails. */
  function predict(text, { excludeCaseId = null } = {}) {
    const q = vec(features(text));
    if (!q.size) return null;
    const sims = {};
    let maxSim = 0;
    for (const k of KEYS) { sims[k] = dot(q, centroids.get(k)); if (sims[k] > maxSim) maxSim = sims[k]; }
    const score = new Float64Array(docs.length);
    for (const [k, qw] of q) for (const [i, w] of postings.get(k) || []) score[i] += qw * w;
    const order = [];
    for (let i = 0; i < docs.length; i++) if (score[i] > 0.05 && !(excludeCaseId && docs[i].caseId === excludeCaseId)) order.push(i);
    order.sort((a, b) => score[b] - score[a]);
    const near = order.slice(0, 7);
    const vote = Object.fromEntries(KEYS.map((k) => [k, 0.02]));
    for (const i of near) vote[docs[i].label] += score[i] ** 2 * docs[i].w;
    const vSum = Object.values(vote).reduce((a, b) => a + b, 0);
    const ex = KEYS.map((k) => Math.exp(12 * sims[k]));
    const eSum = ex.reduce((a, b) => a + b, 0);
    const p = {};
    KEYS.forEach((k, i) => { p[k] = 0.5 * (ex[i] / eSum) + 0.5 * (vote[k] / vSum); });
    const top = KEYS.map((k) => ({ sub_key: k, p: p[k], sim: sims[k] })).sort((a, b) => b.p - a.p);
    return { p, top, max_sim: maxSim, nearest: near.map((i) => ({ doc: docs[i], sim: score[i] })) };
  }

  /** Past cases whose wording is closest to this text (only cases the model has learned from). */
  function similar(text, { excludeCaseId = null, limit = 3, minSim = 0.3 } = {}) {
    const q = vec(features(text));
    if (!q.size) return [];
    const score = new Map();
    for (const [k, qw] of q) for (const [i, w] of postings.get(k) || []) if (docs[i].caseId && docs[i].caseId !== excludeCaseId) score.set(i, (score.get(i) || 0) + qw * w);
    return [...score.entries()].filter(([, s]) => s >= minSim).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i, s]) => ({ case_id: docs[i].caseId, sim: Math.round(s * 100) / 100, label: docs[i].label }));
  }

  return { predict, similar, info: { ...info, docs: N, features: idf.size, trained_at: new Date().toISOString() } };
}

let model = null;
let signature = null;
const sig = () => {
  const r = db.prepare(`SELECT
      (SELECT COUNT(*) || ':' || COALESCE(SUM(weight), 0) || ':' || COALESCE(MAX(id), 0) || ':' || COALESCE(SUM(id * 31 + length(term) * 7 + length(sub_key) * 13 + unicode(sub_key) + (CASE kind WHEN 'phrase' THEN 1 ELSE 0 END)), 0) FROM hd_keywords WHERE active = 1) k,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM hd_test_cases WHERE source NOT IN ('independent', 'imported')) t,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(id), 0) FROM hd_test_cases WHERE source IN ('independent', 'imported')) h,
      (SELECT COUNT(*) FROM hd_cases WHERE status = 'closed') c,
      (SELECT COALESCE(MAX(id), 0) FROM hd_audit WHERE action IN ('override', 'classification_confirmed')) a`).get();
  return `${r.k}|${r.t}|${r.h}|${r.c}|${r.a}`;
};

/** The current model, retrained first if what it learns from has changed. */
export function getModel() {
  const s = sig();
  if (!model || s !== signature) { model = build(); signature = s; }
  return model;
}
export const invalidateModel = () => { model = null; signature = null; };
export const retrain = () => { model = null; return getModel(); };
export const modelInfo = () => getModel().info;

/** -> { p, top, max_sim, nearest } | null */
export function predictLearned(text, opts) {
  const m = getModel();
  return m.info.docs ? m.predict(text, opts) : null;
}
export const similarCases = (text, opts) => getModel().similar(text, opts);
