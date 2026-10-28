// The keyword dictionary, loaded from hd_keywords and cached until someone edits it.
import { db } from '../db.js';
import { buildDictionary } from './classify.js';

let cache = null;
export function loadDictionary() {
  if (!cache) cache = buildDictionary(db.prepare('SELECT sub_key, language, term, weight, kind, active FROM hd_keywords WHERE active = 1').all());
  return cache;
}
export const invalidateDictionary = () => { cache = null; };
