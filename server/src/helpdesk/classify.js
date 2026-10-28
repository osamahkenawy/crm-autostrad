// Rules classifier: scores an email against the keyword dictionary (English and Arabic) and explains
// why. Pure and fast; the AI layer (llm.js) can confirm or correct it.
import { SUB_BY_KEY, SUBCATEGORIES } from './taxonomy.js';
import { detectLanguage, normalize } from './text.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ARABIC = /[؀-ۿ]/;

/** hd_keywords rows -> { sub_key: [{ term, weight, re }] } ready for matching. */
export function buildDictionary(rows) {
  const dict = {};
  for (const r of rows) {
    if (r.active === 0 || !r.term) continue;
    const term = normalize(r.term);
    if (term.length < 2) continue;
    let re;
    try {
      if (r.kind === 'regex') re = new RegExp(r.term, 'giu');
      else if (ARABIC.test(term)) re = new RegExp(escapeRe(term), 'g');
      else re = new RegExp(`(?<![a-z0-9])${escapeRe(term)}(?:s|es)?(?![a-z0-9])`, 'g');
    } catch { continue; }
    (dict[r.sub_key] ||= []).push({ term: r.term, weight: Number(r.weight) || 3, re });
  }
  return dict;
}

/** Non-overlapping term matches for one type: longer, heavier phrases win over the words inside them. */
function matchesFor(entries, norm) {
  const hits = [];
  for (const e of entries) {
    e.re.lastIndex = 0;
    let m;
    while ((m = e.re.exec(norm))) {
      hits.push({ term: e.term, weight: e.weight, start: m.index, end: m.index + m[0].length });
      if (m.index === e.re.lastIndex) e.re.lastIndex++;
    }
  }
  hits.sort((a, b) => b.weight - a.weight || (b.end - b.start) - (a.end - a.start));
  const taken = [];
  const kept = [];
  for (const h of hits) {
    if (taken.some((t) => h.start < t.end && h.end > t.start)) continue;
    taken.push(h);
    kept.push(h);
  }
  return kept;
}

const SUBJECT_BOOST = 1.5;

export function classify({ subject = '', body = '' } = {}, dict) {
  const subj = normalize(subject);
  const text = normalize(body);
  const language = detectLanguage(`${subject} ${body}`);
  const scores = [];

  for (const sub of SUBCATEGORIES) {
    const entries = dict[sub.key];
    if (!entries || !entries.length) continue;
    const inSubject = matchesFor(entries, subj).map((h) => ({ ...h, where: 'subject', points: h.weight * SUBJECT_BOOST }));
    const inBody = matchesFor(entries, text).map((h) => ({ ...h, where: 'body', points: h.weight }));
    // a phrase seen in both subject and body counts once, at the higher value
    const seen = new Set(inSubject.map((h) => h.term));
    const matched = [...inSubject, ...inBody.filter((h) => !seen.has(h.term))];
    const score = matched.reduce((a, h) => a + h.points, 0);
    if (score > 0) scores.push({ sub_key: sub.key, score, matched: matched.map(({ term, weight, where, points }) => ({ term, weight, where, points })) });
  }

  // ties go to the more specific first-wave types
  scores.sort((a, b) => b.score - a.score || Number(Boolean(SUB_BY_KEY[b.sub_key].top5)) - Number(Boolean(SUB_BY_KEY[a.sub_key].top5)));
  const best = scores[0];
  if (!best || best.score < 3) {
    const g = SUB_BY_KEY.general_inquiry;
    return { sub_key: g.key, sub_category: g.name, category: g.category, impact: g.impact, department: g.department, sensitive: false, confidence: best ? 0.3 : 0.15, language, scores: scores.slice(0, 3), matched: best ? best.matched : [] };
  }
  const second = scores[1] ? scores[1].score : 0;
  const top = best.score;
  const margin = (top - second) / top;
  const confidence = Math.max(0.05, Math.min(0.97, (top / (top + 3)) * (0.55 + 0.45 * margin)));
  const sub = SUB_BY_KEY[best.sub_key];
  return {
    sub_key: sub.key, sub_category: sub.name, category: sub.category, impact: sub.impact, department: sub.department, sensitive: sub.sensitive,
    confidence: Math.round(confidence * 100) / 100, language,
    scores: scores.slice(0, 3).map((s) => ({ sub_key: s.sub_key, score: Math.round(s.score * 10) / 10 })),
    matched: best.matched,
  };
}
