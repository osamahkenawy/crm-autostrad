import { Router } from 'express';
import { db } from './db.js';

const isSafe = (s) => /^[a-zA-Z0-9_.]+$/.test(s);
const RESERVED = ['q', 'limit', 'offset', 'sort', 'dir', 'field'];

/** Turn SQLite constraint errors into something a person can act on. */
function friendly(e) {
  const m = String(e && e.message ? e.message : e);
  let x;
  if ((x = m.match(/UNIQUE constraint failed: \w+\.(\w+)/))) return `Another record already uses this ${x[1].replace(/_/g, ' ')}.`;
  if ((x = m.match(/NOT NULL constraint failed: \w+\.(\w+)/))) return `${x[1].replace(/_/g, ' ')} is required.`;
  if (/FOREIGN KEY constraint failed/.test(m)) return 'This record is linked to other records (bookings, invoices, trips…) so it cannot be removed or pointed at a missing record.';
  return m;
}

/**
 * Generic REST resource.
 * opts: { table, columns[], searchable[], selectSql, orderBy,
 *         beforeWrite(body, op, rawBody, req) -> body,
 *         beforeDelete(prevRow, req) (throw to stop it), afterWrite(row, op, prevRow, req), afterDelete(prevRow, req) }
 */
export function crudRouter(opts) {
  const {
    table,
    columns,
    searchable = [],
    selectSql = `SELECT t.* FROM ${opts.table} t`,
    orderBy = 't.id DESC',
    beforeWrite,
    beforeDelete,
    afterWrite,
    afterDelete,
  } = opts;

  const r = Router();

  /** WHERE for ?q= and exact-match column filters. `skip` leaves a column out (used by /_counts). */
  function buildWhere(query, skip = []) {
    const where = [];
    const params = {};

    const q = String(query.q || '').trim();
    if (q && searchable.length) {
      where.push('(' + searchable.map((c, i) => `IFNULL(${c},'') LIKE @q${i}`).join(' OR ') + ')');
      searchable.forEach((_, i) => { params[`q${i}`] = `%${q}%`; });
    }

    for (const [key, val] of Object.entries(query)) {
      if (RESERVED.includes(key) || skip.includes(key)) continue;
      if (val === '' || val == null || typeof val !== 'string') continue;
      if (!columns.includes(key)) continue;
      where.push(`t.${key} = @f_${key}`);
      params[`f_${key}`] = val;
    }
    return { whereSql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
  }

  r.get('/', (req, res) => {
    const { whereSql, params } = buildWhere(req.query);

    let order = orderBy;
    if (req.query.sort && isSafe(req.query.sort) && columns.includes(req.query.sort)) {
      const dir = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      order = `t.${req.query.sort} ${dir}`;
    }

    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Number(req.query.offset) || 0;

    try {
      const rows = db.prepare(`${selectSql}${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(params);
      // Count through the same joined SELECT, so searches on joined columns (c.name, v.plate…) work.
      const { n } = db.prepare(`SELECT COUNT(*) n FROM (${selectSql}${whereSql})`).get(params);
      res.json({ data: rows, total: n });
    } catch (e) { res.status(400).json({ error: friendly(e) }); }
  });

  /** Counts per value of one column, honouring ?q= and the other filters (status tabs). */
  r.get('/_counts', (req, res) => {
    const field = String(req.query.field || '');
    if (!isSafe(field) || !columns.includes(field)) return res.status(400).json({ error: 'Unknown field' });
    const { whereSql, params } = buildWhere(req.query, [field]);
    try {
      const rows = db.prepare(`SELECT ${field} AS value, COUNT(*) AS n FROM (${selectSql}${whereSql}) GROUP BY ${field}`).all(params);
      const counts = {};
      let total = 0;
      for (const row of rows) { counts[row.value ?? ''] = row.n; total += row.n; }
      res.json({ field, counts, total });
    } catch (e) { res.status(400).json({ error: friendly(e) }); }
  });

  r.get('/:id', (req, res) => {
    const row = db.prepare(`${selectSql} WHERE t.id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  r.post('/', (req, res) => {
    try {
      let body = pick(req.body, columns);
      if (beforeWrite) body = beforeWrite(body, 'create', req.body || {}, req) || body;
      const keys = Object.keys(body);
      if (!keys.length) return res.status(400).json({ error: 'No fields supplied' });
      const info = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => '@' + k).join(',')})`).run(body);
      const row = db.prepare(`${selectSql} WHERE t.id = ?`).get(info.lastInsertRowid);
      if (afterWrite) afterWrite(row, 'create', null, req);
      res.status(201).json(db.prepare(`${selectSql} WHERE t.id = ?`).get(info.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: friendly(e) }); }
  });

  r.put('/:id', (req, res) => {
    try {
      const prev = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
      if (!prev) return res.status(404).json({ error: 'Not found' });
      let body = pick(req.body, columns);
      if (beforeWrite) body = beforeWrite(body, 'update', req.body || {}, req) || body;
      const keys = Object.keys(body);
      if (!keys.length) return res.status(400).json({ error: 'No fields supplied' });
      db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=@${k}`).join(',')} WHERE id=@__id`).run({ ...body, __id: req.params.id });
      const row = db.prepare(`${selectSql} WHERE t.id = ?`).get(req.params.id);
      if (afterWrite) afterWrite(row, 'update', prev, req);
      res.json(db.prepare(`${selectSql} WHERE t.id = ?`).get(req.params.id));
    } catch (e) { res.status(400).json({ error: friendly(e) }); }
  });

  r.delete('/:id', (req, res) => {
    try {
      const prev = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
      if (!prev) return res.status(404).json({ error: 'Not found' });
      if (beforeDelete) beforeDelete(prev, req);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
      if (afterDelete) afterDelete(prev, req);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: friendly(e) }); }
  });

  return r;
}

function pick(obj = {}, allowed) {
  const out = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) {
      out[k] = obj[k] === '' ? null : obj[k];
    }
  }
  return out;
}
