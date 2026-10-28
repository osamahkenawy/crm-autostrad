// Append-only activity log: what the AI did, what people changed, drafts, overrides, closures.
import { db } from '../db.js';

const clip = (v, n = 800) => (v === null || v === undefined ? null : String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, n));

/**
 * actor: 'ai' | 'system' | a user row ({ id, name }).
 * Never put card numbers or other personal data in old/new/detail: callers pass redacted text only.
 */
export function audit({ caseId = null, actor = 'system', action, field = null, oldValue = null, newValue = null, detail = null, at = null }) {
  const user = actor && typeof actor === 'object' ? actor : null;
  db.prepare(`INSERT INTO hd_audit (case_id, at, actor_type, actor_id, actor_name, action, field, old_value, new_value, detail)
              VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    caseId, at, user ? 'user' : actor, user ? user.id : null, user ? user.name : (actor === 'ai' ? 'AI agent' : 'System'),
    action, field, clip(oldValue), clip(newValue), clip(detail, 2000),
  );
}
