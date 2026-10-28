// The keyword dictionary, loaded from hd_keywords and cached until someone edits it.
import { db } from '../db.js';
import { buildDictionary, regexProblem } from './classify.js';
import { invalidateModel } from './learner.js';
import { SUB_BY_KEY } from './taxonomy.js';
import { normalize } from './text.js';

let cache = null;
export function loadDictionary() {
  if (!cache) cache = buildDictionary(db.prepare('SELECT sub_key, language, term, weight, kind, active FROM hd_keywords WHERE active = 1').all());
  return cache;
}
// editing a keyword changes both the matcher and what the learned model trains on
export const invalidateDictionary = () => { cache = null; invalidateModel(); };

const ARABIC = /[؀-ۿ]/;
const bad = (message) => { throw new Error(message); };

/**
 * What a keyword must satisfy before it is saved. `input` holds the fields being written, `prev` the stored row on an update (an update
 * may send only what it changes). Returns the fields to write, cleaned. A keyword with an unknown request type or a weight that is not a
 * number used to be accepted and made every confidence NaN, so every email was routed as "confident" to the wrong team.
 */
export function checkKeyword(input, prev = null) {
  const out = { ...input };
  const merged = { ...(prev || {}), ...input };
  if ('sub_key' in input || !prev) { if (!SUB_BY_KEY[merged.sub_key]) bad('Choose one of the request types.'); }
  if ('term' in input || !prev) {
    const term = String(merged.term ?? '').trim();
    if (normalize(term).length < 2) bad('The phrase needs at least two characters.');
    if (term.length > 200) bad('The phrase is too long (limit 200 characters).');
    out.term = term;
  }
  if ('weight' in input || !prev) {
    const w = input.weight === undefined || input.weight === null || input.weight === '' ? 3 : Number(input.weight);
    if (!Number.isInteger(w) || w < 1 || w > 5) bad('The weight is a whole number from 1 (weak hint) to 5 (almost always this type).');
    out.weight = w;
  }
  if ('kind' in input || !prev) {
    out.kind = input.kind === undefined || input.kind === null || input.kind === '' ? 'phrase' : input.kind;
    if (!['phrase', 'regex'].includes(out.kind)) bad('The kind is "phrase" or "regex".');
  }
  if ('language' in input || !prev) {
    out.language = input.language === undefined || input.language === null || input.language === '' ? (ARABIC.test(merged.term || '') ? 'ar' : 'en') : input.language;
    if (!['en', 'ar'].includes(out.language)) bad('The language is "en" or "ar".');
  }
  if ('active' in input || !prev) {
    const a = input.active === undefined || input.active === null ? 1 : input.active;
    out.active = a === 0 || a === '0' || a === false || a === 'false' ? 0 : 1;
  }
  if ((out.kind ?? merged.kind) === 'regex' && ('term' in input || 'kind' in input || !prev)) {
    const problem = regexProblem(out.term ?? merged.term);
    if (problem) bad(problem);
  }
  return out;
}
