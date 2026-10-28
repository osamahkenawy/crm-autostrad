// Mock-server tests for the Microsoft Graph mailbox connector (src/helpdesk/mail/graph.js).
//
// A fake Microsoft 365 (a login endpoint and a Graph endpoint, two plain node:http servers on 127.0.0.1) records
// every request the connector makes and answers the way the real service does: client-credentials tokens, delta
// queries with paging and opaque delta links, messages with categories and flags, reply drafts and Sent Items.
// Nothing leaves the machine and every credential below is fake.
// Run: node --test test/helpdesk.graph.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const MAILBOX = 'helpdesk@autostrad.com';
const GUID = '00000000-aaaa-4bbb-8ccc-000000000001'; // how Graph names the user inside the links it hands back
const DAY = 86_400_000;

/* ------------------------------------------------------------------------------------------------ environment */
// Everything below must be in place before a src module is imported: db.js reads ARC_DB_PATH at import time.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-hd-graph-'));
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|GRAPH_|HELPDESK_)/.test(k)) delete process.env[k];
process.env.ARC_DB_PATH = path.join(dir, 'graph.test.db');
Object.assign(process.env, { GRAPH_TENANT_ID: 'test-tenant', GRAPH_CLIENT_ID: 'test-client', GRAPH_CLIENT_SECRET: 'test-secret' });

/* ------------------------------------------------------------------------------------------------ fake Microsoft 365 */
const world = {
  requests: [], // every request, in arrival order, with the response that was sent
  intercepts: [], // [{ match(rec), times, reply(rec, res) }] checked before normal routing
  unrouted: [], // requests no route understood (must stay empty)
  tokenTtl: 3600, tokenFailure: null, tokenCount: 0, issued: new Set(),
  inboxStats: { total: 128, unread: 7 },
  pageCap: 50, // the most items the fake will put on one delta page (a server may return fewer than asked)
  logPatches: true, // a PATCH shows up in the next delta round, exactly like the real thing
  seq: 0, n: 0,
  messages: new Map(), // id -> message
  logs: { inbox: [], sentitems: [] }, // change log per folder: { seq, id, kind: 'upsert' | 'removed' }
  snapshots: new Map(), snapshotCount: 0,
  masterCategories: [],
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
});

async function record(host, req) {
  const text = await readBody(req);
  const url = new URL(req.url, 'http://mock');
  const rec = {
    at: Date.now(), host, method: req.method, url: req.url, rawPath: url.pathname, path: decodeURIComponent(url.pathname),
    query: url.searchParams, search: url.search, headers: req.headers, text, json: null, status: null, responseJson: null,
  };
  if (text && /json/i.test(req.headers['content-type'] || '')) { try { rec.json = JSON.parse(text); } catch { /* left null */ } }
  world.requests.push(rec);
  return rec;
}
function reply(rec, res, status, body, headers = {}) {
  rec.status = status;
  rec.responseJson = body === undefined ? null : body;
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...(text ? { 'content-type': 'application/json' } : {}), ...headers });
  res.end(text);
}
const graphError = (code, message) => ({ error: { code, message } });

/** Fake login.microsoftonline.com: only the client-credentials token endpoint of the configured tenant. */
async function loginHandler(req, res) {
  const rec = await record('login', req);
  if (rec.method !== 'POST' || rec.rawPath !== '/test-tenant/oauth2/v2.0/token') return reply(rec, res, 404, { error: 'not_found' });
  if (world.tokenFailure) return reply(rec, res, world.tokenFailure.status, world.tokenFailure.body);
  const form = new URLSearchParams(rec.text);
  const right = form.get('grant_type') === 'client_credentials' && form.get('client_id') === 'test-client' && form.get('client_secret') === 'test-secret'
    && form.get('scope') === 'https://graph.microsoft.com/.default';
  if (!right) return reply(rec, res, 400, { error: 'invalid_request', error_description: 'AADSTS900144: The request body is not what the token endpoint expects.' });
  const token = `fake-token-${++world.tokenCount}`;
  world.issued.add(token);
  return reply(rec, res, 200, { token_type: 'Bearer', expires_in: world.tokenTtl, ext_expires_in: world.tokenTtl, access_token: token });
}

/* ---- messages */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlToText = (h) => String(h).replace(/<(?:br|\/div|\/p)\s*\/?>/gi, '\r\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const person = (p) => (typeof p === 'string' ? { name: '', address: p } : p);
/** Graph writes receivedDateTime in UTC; the fraction varies by property and API version, so the fake varies it too. */
const stamp = (d, style) => {
  const s = new Date(d).toISOString();
  return style === 'millis' ? s : style === 'ticks' ? s.replace(/\.\d{3}Z$/, '.1234567Z') : s.replace(/\.\d{3}Z$/, 'Z');
};
const utcText = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

function addMessage(folder, spec) {
  const n = ++world.n;
  const id = spec.id || `AAMkAD${String(n).padStart(3, '0')}${folder}-x_y=`;
  const m = {
    id, folder, conversationId: spec.conversationId || `AAQkAD-conversation-${n}=`, internetMessageId: spec.internetMessageId || `<msg-${n}@mail.example.com>`,
    subject: spec.subject, from: person(spec.from), to: (spec.to || [MAILBOX]).map(person), cc: (spec.cc || []).map(person),
    receivedAt: new Date(spec.receivedAt || Date.now()), timeStyle: spec.timeStyle || 'plain',
    text: spec.text ?? null, html: spec.html ?? null, hasAttachments: Boolean(spec.hasAttachments), isDraft: Boolean(spec.isDraft),
    categories: [...(spec.categories || [])], flag: { flagStatus: 'notFlagged' },
    webLink: spec.webLink || `https://outlook.office.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
  };
  world.messages.set(id, m);
  if (world.logs[folder]) world.logs[folder].push({ seq: ++world.seq, id, kind: 'upsert' });
  return id;
}
function removeMessage(id) {
  const m = world.messages.get(id);
  world.messages.delete(id);
  world.logs[m.folder].push({ seq: ++world.seq, id, kind: 'removed' });
}
/** What happens when a person (or the CRM) sends a saved draft: it leaves Drafts and appears in Sent Items. */
function sendDraft(id) {
  const m = world.messages.get(id);
  Object.assign(m, { isDraft: false, folder: 'sentitems', receivedAt: new Date(), timeStyle: 'plain' });
  world.logs.sentitems.push({ seq: ++world.seq, id, kind: 'upsert' });
}
const textOf = (m) => m.text ?? htmlToText(m.html);
const htmlOf = (m) => m.html ?? `<html><body><div>${esc(m.text).replace(/\r?\n/g, '<br>')}</div></body></html>`;
function view(m, prefer) {
  const wantText = /outlook\.body-content-type="text"/i.test(prefer || '');
  const address = (p) => ({ emailAddress: { name: p.name, address: p.address } });
  return {
    id: m.id, conversationId: m.conversationId, internetMessageId: m.internetMessageId, subject: m.subject,
    from: address(m.from), toRecipients: m.to.map(address), ccRecipients: m.cc.map(address),
    receivedDateTime: stamp(m.receivedAt, m.timeStyle), sentDateTime: stamp(m.receivedAt, m.timeStyle),
    body: wantText ? { contentType: 'text', content: textOf(m) } : { contentType: 'html', content: htmlOf(m) },
    bodyPreview: textOf(m).replace(/\s+/g, ' ').slice(0, 255), hasAttachments: m.hasAttachments, isDraft: m.isDraft,
    webLink: m.webLink, categories: m.categories, flag: m.flag, parentFolderId: m.folder,
  };
}
/** $select as Graph applies it: only what was asked for, plus the id. A field the connector forgets to select never arrives. */
const project = (v, select) => {
  if (!select) return v;
  const keep = new Set(['id', ...select.split(',').map((s) => s.trim())]);
  return Object.fromEntries(Object.entries(v).filter(([k]) => keep.has(k)));
};

/* ---- delta */
function delta(rec, res, folder, origin) {
  const q = rec.query;
  const prefer = rec.headers.prefer || '';
  const cap = Math.min(Number(/odata\.maxpagesize=(\d+)/i.exec(prefer)?.[1]) || 10, world.pageCap);
  let sid; let snap; let offset = 0;
  if (q.has('$skiptoken')) {
    const [id, off] = q.get('$skiptoken').split(':');
    sid = id; offset = Number(off); snap = world.snapshots.get(id);
    if (!snap) return reply(rec, res, 410, graphError('SyncStateNotFound', 'The skip token is not known.'));
  } else {
    const endSeq = world.seq;
    let items;
    if (q.has('$deltatoken')) {
      const since = Number.parseInt(String(q.get('$deltatoken')).replace(/^tok/, ''), 10);
      const latest = new Map();
      for (const e of world.logs[folder]) if (e.seq > since) latest.set(e.id, e);
      items = [...latest.values()].sort((a, b) => a.seq - b.seq).map((e) => ({ id: e.id, removed: e.kind === 'removed' || !world.messages.has(e.id) }));
    } else {
      const f = /receivedDateTime ge (\S+)/.exec(q.get('$filter') || '');
      const floor = f ? Date.parse(f[1]) : -Infinity;
      items = [...world.messages.values()].filter((m) => m.folder === folder && m.receivedAt.getTime() >= floor).map((m) => ({ id: m.id, removed: false }));
    }
    sid = `S${++world.snapshotCount}`;
    snap = { folder, select: q.get('$select'), endSeq, items };
    world.snapshots.set(sid, snap);
  }
  const value = snap.items.slice(offset, offset + cap).map((it) => (it.removed
    ? { id: it.id, '@removed': { reason: 'deleted' } }
    : project(view(world.messages.get(it.id), prefer), snap.select)));
  const body = { '@odata.context': `${origin}/v1.0/$metadata#Collection(message)`, value };
  const link = `${origin}/v1.0/users('${GUID}')/mailFolders('${folder}')/messages/delta`;
  if (offset + cap < snap.items.length) body['@odata.nextLink'] = `${link}?$skiptoken=${sid}:${offset + cap}`;
  else body['@odata.deltaLink'] = `${link}?$deltatoken=tok${snap.endSeq}-${sid}`; // unique per round, like the real opaque token
  return reply(rec, res, 200, body);
}

/** Fake graph.microsoft.com (v1.0): just the routes the connector is meant to use. */
function makeGraphHandler(getOrigin) {
  return async (req, res) => {
    const rec = await record('graph', req);
    const origin = getOrigin();
    const auth = rec.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !world.issued.has(auth.slice(7))) return reply(rec, res, 401, graphError('InvalidAuthenticationToken', 'Access token is empty or invalid.'));
    const hit = world.intercepts.findIndex((x) => x.match(rec));
    if (hit >= 0) {
      const x = world.intercepts[hit];
      if (--x.times <= 0) world.intercepts.splice(hit, 1);
      return x.reply(rec, res);
    }
    // /v1.0/users/{mailbox}/... where the links Graph hands back write users('{guid}') and mailFolders('{name}')
    let s = rec.rawPath.split('/').filter(Boolean).map((x) => decodeURIComponent(x)).slice(1);
    if (/^users\('/.test(s[0] || '')) s = ['users', s[0].slice(7, -2), ...s.slice(1)];
    const [kind, user, ...rest0] = s;
    const rest = rest0.flatMap((x) => { const mm = /^(\w+)\('([^']*)'\)$/.exec(x); return mm ? [mm[1], mm[2]] : [x]; });
    if (kind !== 'users' || ![MAILBOX, GUID].includes(user)) { world.unrouted.push(`${rec.method} ${rec.path}`); return reply(rec, res, 404, graphError('ErrorInvalidUser', 'The requested user is invalid.')); }
    const get = rec.method === 'GET';

    if (get && rest.length === 2 && rest[0] === 'mailFolders') {
      return reply(rec, res, 200, project({ id: rest[1], displayName: 'Inbox', totalItemCount: world.inboxStats.total, unreadItemCount: world.inboxStats.unread }, rec.query.get('$select')));
    }
    if (get && rest.length === 4 && rest[0] === 'mailFolders' && rest[2] === 'messages' && rest[3] === 'delta') return delta(rec, res, rest[1], origin);
    if (rest[0] === 'messages' && rest.length === 2) {
      const m = world.messages.get(rest[1]);
      if (!m) return reply(rec, res, 404, graphError('ErrorItemNotFound', 'The specified object was not found in the store.'));
      if (get) return reply(rec, res, 200, project(view(m, rec.headers.prefer), rec.query.get('$select')));
      if (rec.method === 'PATCH') {
        const b = rec.json || {};
        if (b.categories) m.categories = b.categories;
        if (b.flag) m.flag = b.flag;
        if (b.body) { m.html = b.body.content; m.text = null; }
        if (world.logPatches && world.logs[m.folder]) world.logs[m.folder].push({ seq: ++world.seq, id: m.id, kind: 'upsert' });
        return reply(rec, res, 200, view(m));
      }
    }
    if (rest[0] === 'messages' && rest.length === 3 && rec.method === 'POST') {
      const src = world.messages.get(rest[1]);
      if (!src) return reply(rec, res, 404, graphError('ErrorItemNotFound', 'The specified object was not found in the store.'));
      if (rest[2] === 'createReply') {
        const quoted = `<html><body><div><br></div><hr><div id="divRplyFwdMsg"><b>From:</b> ${esc(src.from.name)} &lt;${esc(src.from.address)}&gt;<br><b>Sent:</b> Tuesday, October 27, 2026 8:15 AM<br><b>To:</b> ${esc(MAILBOX)}<br><b>Subject:</b> ${esc(src.subject)}</div><div>${esc(textOf(src)).replace(/\r?\n/g, '<br>')}</div></body></html>`;
        const id = addMessage('drafts', { subject: `RE: ${src.subject}`, from: { name: 'Helpdesk', address: MAILBOX }, to: [src.from], html: quoted, isDraft: true, conversationId: src.conversationId });
        return reply(rec, res, 201, { id, subject: `RE: ${src.subject}`, conversationId: src.conversationId, isDraft: true, webLink: world.messages.get(id).webLink });
      }
      if (rest[2] === 'send') {
        if (!src.isDraft) return reply(rec, res, 400, graphError('ErrorInvalidRequest', 'Only a draft can be sent.'));
        sendDraft(src.id);
        return reply(rec, res, 202);
      }
    }
    if (rest.length === 1 && rest[0] === 'messages' && rec.method === 'POST') {
      const b = rec.json || {};
      const to = (b.toRecipients || []).map((r) => r.emailAddress);
      const id = addMessage('drafts', { subject: b.subject, from: { name: 'Helpdesk', address: MAILBOX }, to, html: b.body && b.body.content, isDraft: true });
      return reply(rec, res, 201, { id, subject: b.subject, isDraft: true, webLink: world.messages.get(id).webLink });
    }
    if (rest.length === 2 && rest[0] === 'outlook' && rest[1] === 'masterCategories') {
      if (get) return reply(rec, res, 200, { value: world.masterCategories });
      if (rec.method === 'POST') {
        const b = rec.json || {};
        if (!b.displayName || !/^preset\d{1,2}$/.test(b.color || '')) return reply(rec, res, 400, graphError('ErrorInvalidRequest', 'displayName and a preset colour are required.'));
        const created = { id: `cat-${world.masterCategories.length + 1}`, displayName: b.displayName, color: b.color };
        world.masterCategories.push(created);
        return reply(rec, res, 201, created);
      }
    }
    world.unrouted.push(`${rec.method} ${rec.path}`);
    return reply(rec, res, 404, graphError('ErrorInvalidRequest', `No route for ${rec.method} ${rec.path}`));
  };
}

const login = await listen(loginHandler);
let graphOrigin = null;
const graph = await listen(makeGraphHandler(() => graphOrigin));
graphOrigin = graph.origin;
process.env.GRAPH_LOGIN_BASE = login.origin;
process.env.GRAPH_BASE = `${graph.origin}/v1.0`;

/* ------------------------------------------------------------------------------------------------ the code under test */
const { db, migrate } = await import('../src/db.js');
migrate();
const { seedDefaultKeywords, seedDefaultTemplates } = await import('../src/helpdesk/templates.js');
seedDefaultKeywords();
seedDefaultTemplates();
const { setSettings } = await import('../src/helpdesk/settings.js');
const { graphProvider, graphConfigured, missingGraphEnv } = await import('../src/helpdesk/mail/graph.js');
const { getProvider, syncMailbox } = await import('../src/helpdesk/mail/index.js');
const { approveDraft, getDraft } = await import('../src/helpdesk/drafts.js');
const { CATEGORIES, DEPARTMENTS, PRIORITIES, STATUSES, SUBCATEGORIES } = await import('../src/helpdesk/taxonomy.js');

setSettings({ provider: 'graph', mailbox: MAILBOX, send_mode: 'draft_only', llm_mode: 'off' });
const approverId = Number(db.prepare("INSERT INTO users (name, email, password_hash, role, department) VALUES ('Layla Hassan', 'layla@autostrad.com', 'x', 'admin', 'Customer Happiness')").run().lastInsertRowid);
const approver = { id: approverId, name: 'Layla Hassan', role: 'admin' };

after(async () => {
  for (const s of [login.server, graph.server]) {
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------------------------------------ helpers */
const mark = () => world.requests.length;
const graphSince = (m) => world.requests.slice(m).filter((r) => r.host === 'graph');
const loginSince = (m) => world.requests.slice(m).filter((r) => r.host === 'login');
const DELTA_PATH = /\/mailFolders(?:\/|\(')(inbox|sentitems)(?:'\))?\/messages\/delta$/;
const isDelta = (r, folder) => r.host === 'graph' && r.method === 'GET' && (DELTA_PATH.exec(r.path) || [])[1] === folder;
const deltaSince = (m, folder) => graphSince(m).filter((r) => isDelta(r, folder));
const urlOf = (link) => { const u = new URL(link); return u.pathname + u.search; };
const storedLinks = () => db.prepare("SELECT value FROM hd_state WHERE value LIKE '%/messages/delta?%'").all().map((r) => r.value);
const storedLink = (folder) => storedLinks().find((v) => v.includes(`mailFolders('${folder}')`)) || null;
const caseOf = (providerId) => db.prepare('SELECT c.* FROM hd_cases c JOIN hd_messages m ON m.case_id = c.id WHERE m.provider_id = ?').get(providerId);
const pendingDraft = (caseId) => db.prepare("SELECT * FROM hd_drafts WHERE case_id = ? AND status = 'pending' ORDER BY id DESC").get(caseId);
const outbound = (caseId) => db.prepare("SELECT * FROM hd_messages WHERE case_id = ? AND direction = 'out' ORDER BY id").all(caseId);
const patchesFor = (id) => world.requests.filter((r) => r.host === 'graph' && r.method === 'PATCH' && r.path === `/v1.0/users/${MAILBOX}/messages/${id}` && r.json && r.json.categories);
const quiet = (t) => { t.mock.method(console, 'error', () => {}); t.mock.method(console, 'warn', () => {}); };
const expectedLabels = [
  ...CATEGORIES.map((c) => `CH: ${c}`), ...SUBCATEGORIES.map((s) => `CH: ${s.name}`), ...PRIORITIES.map((p) => `Priority: ${p}`),
  ...STATUSES.map((s) => `Status: ${s.replace('_', ' ')}`), ...DEPARTMENTS.map((d) => `Dept: ${d}`),
];

/* ================================================================================================ sign-in and status */
describe('sign-in and connection status', () => {
  it('asks for a token with the client-credentials grant and renews one that is about to expire', async () => {
    assert.equal(graphConfigured(), true);
    assert.deepEqual(missingGraphEnv(), []);
    world.tokenTtl = 30; // shorter than the one-minute safety margin, so the connector must treat it as already stale
    const m = mark();
    const st = await graphProvider.status();
    assert.equal(st.connected, true);
    assert.equal(st.label, 'Microsoft 365');
    assert.equal(st.mailbox, MAILBOX);
    assert.deepEqual(st.inbox, { total: 128, unread: 7 });

    const [tokenReq] = loginSince(m);
    assert.equal(tokenReq.method, 'POST');
    assert.equal(tokenReq.rawPath, '/test-tenant/oauth2/v2.0/token');
    assert.equal(tokenReq.search, '', 'no secret in the URL');
    assert.match(tokenReq.headers['content-type'], /^application\/x-www-form-urlencoded/);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenReq.text)), {
      grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default', client_id: 'test-client', client_secret: 'test-secret',
    });

    const [folderReq] = graphSince(m);
    assert.equal(folderReq.method, 'GET');
    assert.equal(folderReq.rawPath, `/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/inbox`);
    assert.equal(folderReq.query.get('$select'), 'displayName,totalItemCount,unreadItemCount');
    assert.equal(folderReq.headers.authorization, 'Bearer fake-token-1');

    await graphProvider.status(); // the 30 second token is already past its renewal point
    assert.equal(loginSince(m).length, 2, 'a second token was requested');
    assert.equal(graphSince(m)[1].headers.authorization, 'Bearer fake-token-2');
  });

  it('reports a rejected client secret as a readable sign-in failure', async () => {
    world.tokenFailure = {
      status: 401,
      body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: 0b1c0000\r\nCorrelation ID: 7d3e0000\r\nTimestamp: 2026-10-27 08:00:00Z' },
    };
    const m = mark();
    const st = await graphProvider.status();
    world.tokenFailure = null;
    assert.equal(st.connected, false);
    assert.match(st.detail, /^Microsoft sign-in failed: AADSTS7000215: Invalid client secret provided\./);
    assert.doesNotMatch(st.detail, /Trace ID|Correlation ID/, 'only the first line of the Microsoft message is shown');
    assert.equal(graphSince(m).length, 0, 'no Graph call is made without a token');
  });

  it('keeps a healthy token and reuses it', async () => {
    world.tokenTtl = 3600;
    const m = mark();
    assert.equal((await graphProvider.status()).connected, true);
    assert.equal(loginSince(m).length, 1);
    const m2 = mark();
    for (let i = 0; i < 3; i++) assert.equal((await graphProvider.status()).connected, true);
    assert.equal(loginSince(m2).length, 0, 'no new token while the current one is good');
    const used = new Set(graphSince(m2).map((r) => r.headers.authorization));
    assert.equal(used.size, 1);
  });

  it('says what is missing, without calling anywhere, when a credential is not configured', async () => {
    const secret = process.env.GRAPH_CLIENT_SECRET;
    delete process.env.GRAPH_CLIENT_SECRET;
    try {
      const m = mark();
      assert.equal(graphConfigured(), false);
      assert.deepEqual(missingGraphEnv(), ['GRAPH_CLIENT_SECRET']);
      const st = await graphProvider.status();
      assert.equal(st.connected, false);
      assert.match(st.detail, /Missing on the server: GRAPH_CLIENT_SECRET/);
      assert.equal(world.requests.length, m);
    } finally { process.env.GRAPH_CLIENT_SECRET = secret; }
  });

  it('turns a 403 into a hint about admin consent and the application access policy', async () => {
    world.intercepts.push({ match: (r) => r.method === 'GET' && r.path.endsWith('/mailFolders/inbox'), times: 1, reply: (rec, res) => reply(rec, res, 403, graphError('ErrorAccessDenied', 'Access is denied. Check credentials and try again.')) });
    const st = await graphProvider.status();
    assert.equal(st.connected, false);
    assert.match(st.detail, /Access is denied/);
    assert.match(st.detail, /not allowed to read this mailbox/);
    assert.match(st.detail, /admin consent/);
    assert.match(st.detail, /application access policy/);
  });

  it('says when the mailbox does not exist (404)', async () => {
    world.intercepts.push({ match: (r) => r.method === 'GET' && r.path.endsWith('/mailFolders/inbox'), times: 1, reply: (rec, res) => reply(rec, res, 404, graphError('ErrorInvalidUser', 'The requested user is invalid.')) });
    const st = await graphProvider.status();
    assert.equal(st.connected, false);
    assert.match(st.detail, /The requested user is invalid/);
    assert.match(st.detail, /The mailbox was not found/);
  });
});

/* ================================================================================================ first sync */
describe('first sync of the Inbox and Sent Items', () => {
  const now = Date.now();
  const ids = {};
  const when = {};
  let result; let reqs; let firstMark;

  before(async () => {
    world.pageCap = 2; // forces the connector to follow @odata.nextLink
    world.masterCategories = [{ id: 'cat-a', displayName: 'Priority: Low', color: 'preset5' }, { id: 'cat-b', displayName: 'CH: Refund', color: 'preset7' }];
    // one category name is already taken in a way the list did not show: that POST fails and the rest must carry on
    world.intercepts.push({
      match: (r) => r.method === 'POST' && r.path.endsWith('/outlook/masterCategories') && r.json && r.json.displayName === 'CH: Dispute', times: 1,
      reply: (rec, res) => reply(rec, res, 409, graphError('ErrorNameAlreadyExists', 'The specified category name already exists.')),
    });
    when.pre = now - 5 * DAY; when.deposit = now - DAY; when.invoice = now - 2 * 3_600_000;
    ids.pre = addMessage('inbox', {
      from: { name: 'Layla Noor', address: 'layla.noor@example.com' }, subject: 'Pre-auth not released', receivedAt: when.pre, timeStyle: 'ticks', hasAttachments: true,
      text: 'The pre-authorization of AED 2,000 is still on my card three weeks after I returned the car. Contract AST-100555.\n\nKind regards,\nLayla Noor',
    });
    ids.deposit = addMessage('inbox', {
      from: { name: 'Omar Khalid', address: 'omar.k@example.com' }, subject: 'Security deposit refund', receivedAt: when.deposit, timeStyle: 'plain',
      text: 'I returned the car on 1 October and my security deposit of AED 1,000 has still not been refunded. Contract AST-100231.',
    });
    ids.invoice = addMessage('inbox', {
      from: { name: 'Sara Ahmed', address: 'Sara.Ahmed@Example.com' }, to: [MAILBOX, { name: 'Accounts', address: 'accounts@autostrad.com' }], cc: ['manager@example.com'],
      subject: 'Tax invoice for contract AST-100777', receivedAt: when.invoice, timeStyle: 'millis',
      categories: ['VIP customer', 'Follow up with Hassan', 'Status: closed', 'Owner: Old Person'],
      text: 'Good morning,\n\nKindly send me the tax invoice for my rental contract AST-100777. We need it for our accounts department.\n\nKind regards,\nSara Ahmed',
    });
    ids.draft = addMessage('inbox', { from: { name: 'Helpdesk', address: MAILBOX }, subject: 'Half-written draft that must not become a case', receivedAt: now - 3_600_000, isDraft: true, text: 'Dear customer, we' });
    ids.old = addMessage('inbox', { from: 'old.customer@example.com', subject: 'Old invoice request', receivedAt: now - 30 * DAY, text: 'Please send the invoice for contract AST-100001.' });
    ids.sentOther = addMessage('sentitems', { from: { name: 'Helpdesk', address: MAILBOX }, to: ['partner@example.org'], subject: 'Re: Meeting on Thursday', receivedAt: now - 3 * 3_600_000, text: 'Thursday works for us.' });
    firstMark = mark();
    result = await syncMailbox();
    reqs = world.requests.slice(firstMark);
  });
  after(() => { world.pageCap = 50; });

  it('reads the last 14 days of Inbox and Sent Items with a delta query, $select, $filter and the Prefer header', () => {
    const inbox = deltaSince(firstMark, 'inbox');
    const sent = deltaSince(firstMark, 'sentitems');
    assert.equal(inbox.length, 2, 'two Inbox pages');
    assert.equal(sent.length, 1);
    for (const first of [inbox[0], sent[0]]) {
      const folder = first === inbox[0] ? 'inbox' : 'sentitems';
      assert.equal(first.rawPath, `/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/${folder}/messages/delta`);
      const select = first.query.get('$select').split(',');
      for (const f of ['id', 'conversationId', 'internetMessageId', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'body', 'hasAttachments', 'isDraft', 'webLink']) {
        assert.ok(select.includes(f), `$select asks for ${f}`);
      }
      const filter = /^receivedDateTime ge (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(first.query.get('$filter'));
      assert.ok(filter, `unexpected $filter ${first.query.get('$filter')}`);
      assert.ok(Math.abs(Date.now() - Date.parse(filter[1]) - 14 * DAY) < 120_000, 'the filter starts 14 days back');
    }
    for (const r of [...inbox, ...sent]) {
      const prefer = r.headers.prefer.split(',').map((x) => x.trim());
      assert.ok(prefer.includes('outlook.body-content-type="text"'), 'plain text bodies are requested on every page');
      assert.ok(prefer.includes('odata.maxpagesize=50'));
      assert.match(r.headers.authorization, /^Bearer fake-token-\d+$/);
    }
  });

  it('pages through @odata.nextLink exactly as given and does not filter the continuation again', () => {
    const [p1, p2] = deltaSince(firstMark, 'inbox');
    assert.ok(p1.responseJson['@odata.nextLink'], 'page 1 points at page 2');
    assert.equal(p1.responseJson['@odata.deltaLink'], undefined);
    assert.equal(p2.url, urlOf(p1.responseJson['@odata.nextLink']), 'the next page is requested with the link as received');
    assert.equal(p2.query.has('$filter'), false);
    assert.ok(p2.responseJson['@odata.deltaLink'], 'the last page carries the delta link');
    assert.equal(p2.responseJson['@odata.nextLink'], undefined);
    assert.equal(p1.responseJson.value.length + p2.responseJson.value.length, 4, 'three customer emails and the draft, nothing older than 14 days');
  });

  it('counts what it imported: customer emails become cases, drafts and old mail do not', () => {
    assert.deepEqual(result.errors, []);
    assert.equal(result.provider, 'graph');
    assert.equal(result.fetched, 4, 'three customer emails and one Sent Items message (the draft is not counted)');
    assert.equal(result.created, 3);
    assert.equal(result.ignored, 1, 'outgoing mail that belongs to no case');
    assert.equal(result.outbound, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM hd_cases').get().n, 3);
    for (const gone of [ids.draft, ids.old, ids.sentOther]) assert.equal(db.prepare('SELECT 1 FROM hd_messages WHERE provider_id = ?').get(gone), undefined);
  });

  it('turns a customer email into a case with its customer, contract, owner, due time and a pending draft', () => {
    const c = caseOf(ids.invoice);
    assert.ok(c, 'a case exists for the email');
    assert.match(c.case_no, /^CS-\d{4}-\d{6}$/);
    assert.equal(c.status, 'open');
    assert.equal(c.customer_email, 'sara.ahmed@example.com');
    assert.equal(c.subject, 'Tax invoice for contract AST-100777');
    assert.equal(c.contract_no, 'AST-100777');
    assert.equal(c.conversation_id, world.messages.get(ids.invoice).conversationId);
    assert.ok(c.category && c.sub_category && c.priority && c.department && c.due_at);
    assert.equal(c.owner_id, approverId, 'routed to the one active person in the department');
    const drafts = db.prepare('SELECT * FROM hd_drafts WHERE case_id = ?').all(c.id);
    assert.ok(drafts.length >= 1 && drafts.every((d) => d.status === 'pending'), 'a reply draft waits for review');
    assert.equal(outbound(c.id).length, 0, 'nothing was sent');
  });

  it('maps the Graph message: addresses, plain text body, UTC time, attachments, ids and link', () => {
    const row = db.prepare('SELECT * FROM hd_messages WHERE provider_id = ?').get(ids.invoice);
    const m = world.messages.get(ids.invoice);
    assert.equal(row.direction, 'in');
    assert.equal(row.from_email, 'sara.ahmed@example.com', 'sender is lower-cased');
    assert.equal(row.from_name, 'Sara Ahmed');
    assert.equal(row.to_email, `${MAILBOX}, accounts@autostrad.com`);
    assert.equal(row.cc, 'manager@example.com');
    assert.equal(row.subject, 'Tax invoice for contract AST-100777');
    assert.equal(row.internet_id, m.internetMessageId);
    assert.equal(row.conversation_id, m.conversationId);
    assert.equal(row.web_link, m.webLink);
    assert.ok(row.body.includes('Kindly send me the tax invoice for my rental contract AST-100777.'));
    assert.doesNotMatch(row.body, /<\/?(?:html|body|div|br)\b/i, 'the body is plain text, not HTML');
    assert.equal(row.attachments, null);
    // receivedDateTime comes in three shapes (whole seconds, milliseconds, 7-digit fraction) and all end up as YYYY-MM-DD HH:MM:SS in UTC
    assert.equal(row.received_at, utcText(when.invoice));
    assert.match(row.received_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(db.prepare('SELECT received_at FROM hd_messages WHERE provider_id = ?').get(ids.deposit).received_at, utcText(when.deposit));
    const pre = db.prepare('SELECT received_at, attachments FROM hd_messages WHERE provider_id = ?').get(ids.pre);
    assert.equal(pre.received_at, utcText(when.pre));
    assert.deepEqual(JSON.parse(pre.attachments).map((a) => a.name), ['attachment'], 'a message with attachments says so');
  });

  it('writes the case back to the Outlook message: categories, a due-date flag, and keeps what a person added', () => {
    const c = caseOf(ids.invoice);
    const [patch, ...more] = patchesFor(ids.invoice);
    assert.equal(more.length, 0, 'one tagging call per message');
    assert.equal(patch.rawPath, `/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${encodeURIComponent(ids.invoice)}`, 'the message id is URL-encoded');
    assert.equal(patch.headers['content-type'], 'application/json');
    const cats = patch.json.categories;
    assert.deepEqual(cats.slice(0, 2), ['VIP customer', 'Follow up with Hassan'], 'categories added by hand are kept, first');
    assert.ok(!cats.includes('Status: closed') && !cats.includes('Owner: Old Person'), 'stale labels of this module are replaced');
    for (const label of [`CH: ${c.category}`, `CH: ${c.sub_category}`, `Priority: ${c.priority}`, 'Status: open', `Dept: ${c.department}`, 'Owner: Layla Hassan', c.case_no]) {
      assert.ok(cats.includes(label), `category ${label}`);
    }
    assert.equal(new Set(cats).size, cats.length, 'no duplicates');
    assert.equal(patch.json.flag.flagStatus, 'flagged');
    assert.equal(patch.json.flag.dueDateTime.timeZone, 'UTC');
    assert.equal(patch.json.flag.dueDateTime.dateTime, c.due_at.replace(' ', 'T'), 'the flag is due when the case is due');
    assert.match(patch.json.flag.startDateTime.dateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.equal(patch.json.flag.startDateTime.timeZone, 'UTC');
    // what Outlook now holds
    assert.deepEqual(world.messages.get(ids.invoice).categories, cats);
    for (const id of [ids.pre, ids.deposit]) assert.equal(patchesFor(id).length, 1, 'every new case is tagged');
  });

  it('creates the coloured master categories once, skips existing ones and carries on after a failed one', () => {
    const lists = reqs.filter((r) => r.method === 'GET' && r.path.endsWith('/outlook/masterCategories'));
    const posts = reqs.filter((r) => r.method === 'POST' && r.path.endsWith('/outlook/masterCategories'));
    assert.equal(lists.length, 1, 'the existing list is read once');
    const asked = posts.map((r) => r.json.displayName);
    const wanted = expectedLabels.filter((l) => !['Priority: Low', 'CH: Refund'].includes(l));
    assert.deepEqual([...asked].sort(), [...wanted].sort(), 'every label except the two that already exist, nothing else');
    assert.ok(asked.every((n) => !/^CS-\d/.test(n)), 'no label per case number');
    const color = (n) => posts.find((r) => r.json.displayName === n).json.color;
    assert.equal(color('CH: Complaint'), 'preset7');
    assert.equal(color('Priority: Critical'), 'preset0');
    assert.equal(color('Priority: High'), 'preset1');
    assert.equal(color('Priority: Average'), 'preset3');
    assert.equal(color('Status: open'), 'preset8');
    assert.equal(color('Dept: Accounts'), 'preset10');
    assert.ok(posts.every((r) => r.rawPath === `/v1.0/users/${encodeURIComponent(MAILBOX)}/outlook/masterCategories`));
    const failed = posts.find((r) => r.json.displayName === 'CH: Dispute');
    assert.equal(failed.status, 409);
    assert.ok(posts.indexOf(failed) < posts.length - 1, 'later categories were still created');
    // the labels exist before the first message is tagged
    const firstPatch = reqs.findIndex((r) => r.method === 'PATCH');
    assert.ok(reqs.lastIndexOf(posts[posts.length - 1]) < firstPatch);
  });

  it('stores the delta links only once the sync is complete', () => {
    const inbox = deltaSince(firstMark, 'inbox');
    const sent = deltaSince(firstMark, 'sentitems');
    assert.equal(storedLink('inbox'), inbox[1].responseJson['@odata.deltaLink']);
    assert.equal(storedLink('sentitems'), sent[0].responseJson['@odata.deltaLink']);
  });

  it('never sends anything and never calls a route the connector should not use', () => {
    assert.equal(reqs.filter((r) => /\/send$/.test(r.path)).length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM hd_messages WHERE direction = 'out'").get().n, 0);
    assert.deepEqual(world.unrouted, []);
    Object.assign(globalThis, { __graphFirst: ids }); // lets later suites find the messages
  });
});

/* ================================================================================================ delta links */
describe('delta links between syncs', () => {
  const ids = () => globalThis.__graphFirst;

  it('uses the stored delta link on the next sync (no $filter) and moves on to the new one', async () => {
    const inboxLink = storedLink('inbox');
    const sentLink = storedLink('sentitems');
    assert.ok(inboxLink && sentLink);
    const fresh = addMessage('inbox', {
      from: { name: 'Hamad Salem', address: 'hamad.salem@example.com' }, subject: 'Collect the car from Business Bay', receivedAt: Date.now() - 600_000,
      text: 'Please arrange collection of the vehicle from my office in Business Bay tomorrow at 5pm. Contract AST-100889.',
    });
    removeMessage(ids().deposit); // somebody deleted this one in Outlook
    const m = mark();
    const result = await syncMailbox();
    const inbox = deltaSince(m, 'inbox');
    const sent = deltaSince(m, 'sentitems');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].url, urlOf(inboxLink), 'the Inbox request is the stored link, untouched');
    assert.equal(inbox[0].query.has('$filter'), false);
    assert.ok(inbox[0].query.get('$deltatoken'));
    assert.equal(sent[0].url, urlOf(sentLink));
    assert.equal(sent[0].query.has('$filter'), false);
    assert.match(inbox[0].headers.prefer, /outlook\.body-content-type="text"/, 'the body format is requested again, a delta link does not remember it');

    assert.deepEqual(result.errors, []);
    assert.equal(result.created, 1, 'only the new email');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM hd_cases').get().n, 4);
    assert.ok(caseOf(fresh));
    assert.equal(result.duplicates, 2, 'the two tagged messages that Outlook reports as changed are recognised, not imported again');
    assert.equal(result.fetched, 3, 'the deleted message (@removed) is skipped');
    assert.ok(caseOf(ids().deposit), 'deleting the email does not delete the case');
    assert.equal(storedLink('inbox'), inbox[0].responseJson['@odata.deltaLink']);
    assert.notEqual(storedLink('inbox'), inboxLink);
    ids().fresh = fresh;
  });

  it('keeps the old delta link when a message failed to import, and tries again from it', async (t) => {
    quiet(t);
    const before = storedLink('inbox');
    const poison = addMessage('inbox', {
      from: { name: 'Mona Fares', address: 'mona.fares@example.com' }, subject: 'POISON PILL invoice request', receivedAt: Date.now() - 300_000,
      text: 'Please send the tax invoice for contract AST-100901.',
    });
    // the database refuses this one case, as it would on a full disk
    db.exec("CREATE TRIGGER poison_pill BEFORE INSERT ON hd_cases WHEN NEW.subject LIKE '%POISON PILL%' BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END;");
    let failed;
    try {
      const m = mark();
      failed = await syncMailbox();
      assert.equal(deltaSince(m, 'inbox')[0].url, urlOf(before));
    } finally { db.exec('DROP TRIGGER poison_pill'); }
    assert.equal(failed.errors.length, 1);
    assert.match(failed.errors[0], /POISON PILL.*disk full/);
    assert.equal(failed.created, 0);
    assert.equal(storedLink('inbox'), before, 'not committed, so nothing is lost');
    assert.equal(db.prepare('SELECT 1 FROM hd_messages WHERE provider_id = ?').get(poison), undefined);

    const m = mark();
    const ok = await syncMailbox();
    assert.equal(deltaSince(m, 'inbox')[0].url, urlOf(before), 'the same position is read again');
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.created, 1, 'the message that failed is imported now');
    assert.ok(caseOf(poison));
    assert.notEqual(storedLink('inbox'), before, 'committed after a clean sync');
  });

  for (const [label, status, body] of [
    ['410 Gone with SyncStateNotFound', 410, graphError('SyncStateNotFound', 'The sync state generation is not found.')],
    ['410 Gone with a different code', 410, graphError('resyncRequired', 'The delta token is no longer valid.')],
    ['an error whose code names the sync state', 400, graphError('ErrorInvalidSyncStateData', 'Invalid sync state data.')],
  ]) {
    it(`restarts from the last 14 days instead of failing forever when the delta link has expired (${label})`, async () => {
      const expired = storedLink('inbox');
      const sentLink = storedLink('sentitems');
      world.intercepts.push({ match: (r) => isDelta(r, 'inbox') && r.query.has('$deltatoken'), times: 1, reply: (rec, res) => reply(rec, res, status, body) });
      const m = mark();
      const result = await syncMailbox();
      const inbox = deltaSince(m, 'inbox');
      assert.equal(inbox.length, 2);
      assert.equal(inbox[0].url, urlOf(expired));
      assert.equal(inbox[0].status, status);
      assert.equal(inbox[1].query.has('$deltatoken'), false);
      assert.ok(/^receivedDateTime ge /.test(inbox[1].query.get('$filter')), 'the restart is a fresh last-14-days read');
      assert.ok(Math.abs(Date.now() - Date.parse(inbox[1].query.get('$filter').split(' ')[2]) - 14 * DAY) < 120_000);
      assert.deepEqual(result.errors, []);
      assert.equal(result.created, 0);
      assert.ok(result.duplicates >= 3, 'what was already imported is recognised');
      assert.equal(deltaSince(m, 'sentitems')[0].url, urlOf(sentLink), 'Sent Items keeps its own, still valid, link');
      const renewed = storedLink('inbox');
      assert.equal(renewed, inbox[1].responseJson['@odata.deltaLink']);
      assert.notEqual(renewed, expired);
    });
  }

  it('fails a sync whose delta link keeps coming back expired, instead of looping', async (t) => {
    quiet(t);
    const m = mark();
    world.intercepts.push({ match: (r) => isDelta(r, 'inbox'), times: 2, reply: (rec, res) => reply(rec, res, 410, graphError('SyncStateNotFound', 'The sync state generation is not found.')) });
    const result = await syncMailbox();
    assert.equal(deltaSince(m, 'inbox').length, 2, 'one restart, then give up');
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /sync state generation/);
    assert.equal(storedLink('inbox'), null, 'the expired link was forgotten');
    const again = await syncMailbox(); // and the following sync recovers by itself
    assert.deepEqual(again.errors, []);
    assert.ok(storedLink('inbox'));
  });
});

/* ================================================================================================ throttling */
describe('throttling', () => {
  it('waits for Retry-After on a 429 and repeats the same request', async () => {
    world.intercepts.push({
      match: (r) => isDelta(r, 'inbox'), times: 1,
      reply: (rec, res) => reply(rec, res, 429, graphError('TooManyRequests', 'Application is over its MailboxConcurrency limit.'), { 'Retry-After': '2' }),
    });
    const m = mark();
    const result = await syncMailbox();
    const tries = deltaSince(m, 'inbox');
    assert.equal(tries.length, 2);
    assert.equal(tries[0].status, 429);
    assert.equal(tries[1].status, 200);
    assert.equal(tries[1].url, tries[0].url, 'the identical request is repeated');
    assert.equal(tries[1].headers.authorization, tries[0].headers.authorization);
    const waited = tries[1].at - tries[0].at;
    assert.ok(waited >= 1900 && waited < 6000, `waited ${waited} ms for a Retry-After of 2 seconds (the default back-off would be 1 second)`);
    assert.deepEqual(result.errors, []);
  });

  it('gives up with the Graph error after a few attempts when the service stays unavailable (503)', async (t) => {
    quiet(t);
    // a fractional Retry-After keeps this test fast; the connector reads it as a number of seconds
    world.intercepts.push({
      match: (r) => isDelta(r, 'inbox'), times: 10,
      reply: (rec, res) => reply(rec, res, 503, graphError('ServiceNotAvailable', 'The service is temporarily unavailable.'), { 'Retry-After': '0.05' }),
    });
    const before = storedLink('inbox');
    const m = mark();
    const result = await syncMailbox();
    world.intercepts.length = 0;
    const attempts = deltaSince(m, 'inbox').length;
    assert.ok(attempts >= 3 && attempts <= 6, `${attempts} attempts`);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /temporarily unavailable/);
    assert.equal(deltaSince(m, 'sentitems').length, 0, 'the sync stops at the first failing folder');
    assert.equal(storedLink('inbox'), before, 'nothing is committed');
  });
});

/* ================================================================================================ tagging, directly */
describe('tagging an Outlook message', () => {
  const call = (over = {}) => graphProvider.applyTracking({
    providerId: globalThis.__graphFirst.invoice, categories: ['CH: Refund', 'CH: Security Deposit Refund', 'Priority: High', 'Status: pending customer', 'Dept: Accounts', 'CS-2026-000777'],
    dueAt: '2026-11-03 09:30:00', closed: false, ...over,
  });

  it('replaces its own labels on every update but keeps one a person added in Outlook in the meantime', async () => {
    const id = globalThis.__graphFirst.invoice;
    world.messages.get(id).categories.push('Escalated by Hassan'); // added by hand after the first tagging
    const m = mark();
    assert.equal(await call(), true);
    const calls = graphSince(m);
    assert.deepEqual(calls.map((r) => r.method), ['GET', 'PATCH'], 'read the current categories, then write');
    assert.equal(calls[0].query.get('$select'), 'categories');
    const cats = calls[1].json.categories;
    assert.deepEqual(cats, ['VIP customer', 'Follow up with Hassan', 'Escalated by Hassan', 'CH: Refund', 'CH: Security Deposit Refund', 'Priority: High', 'Status: pending customer', 'Dept: Accounts', 'CS-2026-000777']);
    assert.equal(world.requests.slice(m).filter((r) => r.path.endsWith('/outlook/masterCategories')).length, 0, 'master categories are only checked once');
  });

  it('flags the message with the case due date, completes the flag when the case is closed, clears it without a due date', async () => {
    const id = globalThis.__graphFirst.invoice;
    let m = mark();
    await call();
    assert.deepEqual(graphSince(m)[1].json.flag.dueDateTime, { dateTime: '2026-11-03T09:30:00', timeZone: 'UTC' });
    assert.equal(graphSince(m)[1].json.flag.flagStatus, 'flagged');
    m = mark();
    await call({ closed: true, categories: ['Status: closed'] });
    assert.deepEqual(graphSince(m)[1].json.flag, { flagStatus: 'complete' });
    assert.deepEqual(world.messages.get(id).flag, { flagStatus: 'complete' });
    m = mark();
    await call({ dueAt: null, closed: false });
    assert.deepEqual(graphSince(m)[1].json.flag, { flagStatus: 'notFlagged' });
  });

  it('leaves demo and CRM-local messages alone without calling Graph', async () => {
    const m = mark();
    assert.equal(await call({ providerId: 'demo-abc' }), false);
    assert.equal(await call({ providerId: 'crm-12' }), false);
    assert.equal(await call({ providerId: '' }), false);
    assert.equal(world.requests.length, m);
  });

  it('reports a message that has been moved or deleted instead of hiding it', async () => {
    await assert.rejects(call({ providerId: 'AAMkAD-gone=' }), (e) => e.status === 404 && /not found/i.test(e.message));
  });
});

/* ================================================================================================ approving replies */
describe('approving a reply draft', () => {
  it('draft_only saves the reply into the mailbox Drafts folder: createReply, read the quoted body, PATCH html, and no send', async () => {
    setSettings({ send_mode: 'draft_only' });
    const ids = globalThis.__graphFirst;
    const c = caseOf(ids.invoice);
    const draft = pendingDraft(c.id);
    assert.ok(draft, 'the case has a pending draft');
    const m = mark();
    const out = await approveDraft(draft.id, approver, getProvider(), { body: `${draft.body}\n\nPS: Tom & Jerry <b>bold</b>` });
    assert.equal(out.mode, 'draft_only');

    const calls = graphSince(m);
    const base = `/v1.0/users/${encodeURIComponent(MAILBOX)}/messages`;
    assert.deepEqual(calls.map((r) => r.method), ['POST', 'GET', 'PATCH'], 'createReply, then the body, then the edit');
    const [create, read, patch] = calls;
    assert.equal(create.rawPath, `${base}/${encodeURIComponent(ids.invoice)}/createReply`, 'the reply is created under the customer message');
    assert.deepEqual(create.json, {});
    assert.equal(create.status, 201);
    const replyId = create.responseJson.id;
    assert.equal(read.rawPath, `${base}/${encodeURIComponent(replyId)}`);
    assert.equal(read.query.get('$select'), 'body');
    assert.equal(patch.rawPath, `${base}/${encodeURIComponent(replyId)}`);
    assert.equal(patch.json.body.contentType, 'html');
    const html = patch.json.body.content;
    const mine = html.slice(0, html.indexOf('</div>') + 6);
    assert.ok(mine.startsWith('<div>') && mine.includes('Dear '), 'our text comes first');
    assert.ok(mine.includes('Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt;'), 'text is escaped');
    assert.ok(!mine.includes('<b>') && !mine.includes('\n'), 'line breaks become <br>');
    assert.ok(mine.includes('<br>'));
    assert.ok(html.indexOf('Kindly send me the tax invoice') > mine.length, 'the quoted original that Outlook created is kept after our text');
    assert.equal(calls.filter((r) => /\/send$/.test(r.path)).length, 0, 'nothing is sent');

    const stored = getDraft(draft.id);
    assert.equal(stored.status, 'approved');
    assert.equal(stored.provider_draft_id, replyId);
    assert.equal(outbound(c.id).length, 0, 'not recorded as sent');
    assert.equal(world.messages.get(replyId).isDraft, true);
    assert.equal(world.messages.get(replyId).folder, 'drafts');
    assert.equal(db.prepare('SELECT status FROM hd_cases WHERE id = ?').get(c.id).status, 'open');
    globalThis.__graphFirst.invoiceReply = replyId;
  });

  it('send_after_approval creates the same draft and then sends it (POST /send on the reply)', async () => {
    setSettings({ send_mode: 'send_after_approval' });
    const ids = globalThis.__graphFirst;
    const c = caseOf(ids.pre);
    const draft = pendingDraft(c.id);
    assert.ok(draft);
    const m = mark();
    const out = await approveDraft(draft.id, approver, getProvider());
    assert.equal(out.mode, 'send_after_approval');
    const calls = graphSince(m);
    assert.deepEqual(calls.map((r) => r.method), ['POST', 'GET', 'PATCH', 'POST']);
    const replyId = calls[0].responseJson.id;
    const send = calls[3];
    assert.equal(send.rawPath, `/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${encodeURIComponent(replyId)}/send`, 'the reply is sent, not the customer message');
    assert.equal(send.text, '');
    assert.equal(send.status, 202);
    assert.equal(world.messages.get(replyId).folder, 'sentitems');

    const stored = getDraft(draft.id);
    assert.equal(stored.status, 'sent');
    assert.equal(stored.provider_draft_id, `crm-${draft.id}`);
    const sentRows = outbound(c.id);
    assert.equal(sentRows.length, 1, 'recorded once as an outgoing message');
    assert.equal(sentRows[0].provider_id, `crm-${draft.id}`);
    assert.equal(db.prepare('SELECT status FROM hd_cases WHERE id = ?').get(c.id).status, 'pending_customer');
    globalThis.__graphFirst.preReply = replyId;
  });

  it('does not record the Sent Items copy of a reply the CRM just sent a second time', async () => {
    const ids = globalThis.__graphFirst;
    const c = caseOf(ids.pre);
    const m = mark();
    const result = await syncMailbox();
    const sentPage = deltaSince(m, 'sentitems')[0].responseJson.value;
    assert.ok(sentPage.some((x) => x.id === ids.preReply), 'the copy in Sent Items was delivered by the delta query');
    assert.equal(result.outbound, 0, 'not treated as a new outgoing message');
    assert.ok(result.duplicates >= 1);
    assert.deepEqual(result.errors, []);
    assert.equal(outbound(c.id).length, 1, 'still one outgoing message on the case');
    assert.equal(db.prepare('SELECT 1 FROM hd_messages WHERE provider_id = ?').get(ids.preReply), undefined);
    const again = await syncMailbox();
    assert.equal(outbound(c.id).length, 1);
    assert.equal(again.outbound, 0);
  });

  it('records a reply that a person sent from Outlook (the saved draft) once, and marks the approved draft as sent', async () => {
    const ids = globalThis.__graphFirst;
    const c = caseOf(ids.invoice);
    assert.equal(getDraft(db.prepare("SELECT id FROM hd_drafts WHERE case_id = ? AND status = 'approved'").get(c.id).id).status, 'approved');
    sendDraft(ids.invoiceReply); // the person presses Send in Outlook
    const result = await syncMailbox();
    assert.equal(result.outbound, 1);
    assert.equal(result.created, 0);
    const rows = outbound(c.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider_id, ids.invoiceReply);
    assert.equal(rows[0].from_email, MAILBOX);
    assert.equal(rows[0].to_email.toLowerCase(), 'sara.ahmed@example.com');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM hd_drafts WHERE case_id = ? AND status = 'sent'").get(c.id).n, 1);
    assert.equal(db.prepare('SELECT status FROM hd_cases WHERE id = ?').get(c.id).status, 'pending_customer');
    assert.equal((await syncMailbox()).outbound, 0, 'and a later sync does not record it again');
    assert.equal(outbound(c.id).length, 1);
  });

  it('creates a plain draft message when there is no customer message to reply to, right-to-left for Arabic', async () => {
    const m = mark();
    const created = await graphProvider.createDraft({
      draft: { subject: 'Re: استفسار', body: 'السلام عليكم\nشكراً لتواصلكم & <أهلاً>', to_email: 'customer@example.com', language: 'ar' }, replyTo: null,
    });
    const [post] = graphSince(m);
    assert.equal(graphSince(m).length, 1);
    assert.equal(post.method, 'POST');
    assert.equal(post.rawPath, `/v1.0/users/${encodeURIComponent(MAILBOX)}/messages`);
    assert.equal(post.json.subject, 'Re: استفسار');
    assert.deepEqual(post.json.toRecipients, [{ emailAddress: { address: 'customer@example.com' } }]);
    assert.equal(post.json.body.contentType, 'html');
    assert.equal(post.json.body.content, '<div dir="rtl" style="text-align:right">السلام عليكم<br>شكراً لتواصلكم &amp; &lt;أهلاً&gt;</div>');
    assert.equal(created.providerId, post.responseJson.id);
  });

  it('only ever called routes it is meant to', () => {
    assert.deepEqual(world.unrouted, []);
  });
});
