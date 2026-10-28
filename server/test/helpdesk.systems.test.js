// Tests for the customer-systems connector (src/helpdesk/systems/): the mapping language, the configuration checks, the HTTP client's
// safety behaviour, the resolver that turns an email into an account, and the pipeline end to end with the account on the case.
//
// Nothing leaves the machine: the "customer systems" are plain node:http servers on 127.0.0.1 (the stand-in API from
// scripts/mock-customer-api.mjs, and small hand-made servers for the odd behaviours), and every key below is fake.
// Run: node --test test/helpdesk.systems.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-hd-systems-'));
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|GRAPH_|HELPDESK_|ORION_|CNR_|CUSTOMER_)/.test(k)) delete process.env[k];
process.env.ARC_DB_PATH = path.join(dir, 'systems.test.db');
process.env.HELPDESK_SCHEDULER = 'off';
process.env.HELPDESK_ACCOUNT_SOURCE = 'api';
process.env.CUSTOMER_SYSTEMS_CONFIG = path.join(root, 'config', 'customer-systems.example.json');
process.env.ORION_API_KEY = 'orion-test-key';
process.env.CNR_API_KEY = 'cnr-test-key';

const { db, migrate } = await import('../src/db.js');
migrate();
const { seedDefaultKeywords, seedDefaultTemplates } = await import('../src/helpdesk/templates.js');
seedDefaultKeywords();
seedDefaultTemplates();

const mapping = await import('../src/helpdesk/systems/mapping.js');
const cfgMod = await import('../src/helpdesk/systems/config.js');
const client = await import('../src/helpdesk/systems/client.js');
const { resolveDetailed, identityOf, pickRecent, sameContractNo } = await import('../src/helpdesk/systems/resolver.js');
const account = await import('../src/helpdesk/systems/account.js');
const actions = await import('../src/helpdesk/systems/actions.js');
const { createMockApi } = await import('../scripts/mock-customer-api.mjs');
const { ingestMessage } = await import('../src/helpdesk/pipeline.js');
const { getCaseDetail, updateCase } = await import('../src/helpdesk/cases.js');
const { approveDraft, createDraft } = await import('../src/helpdesk/drafts.js');
const { nowUtc } = await import('../src/helpdesk/routing.js');

client.tuning.retryPauseMs = 5;
client.tuning.breakerOpenMs = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const iso = (days) => new Date(Date.now() + days * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
const dmy = (days) => { const d = new Date(Date.now() + days * DAY); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };

after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/* ------------------------------------------------------------------------------------------------ small servers */
async function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const rec = { method: req.method, url: req.url, headers: req.headers, at: Date.now() };
    hits.push(rec);
    Promise.resolve(handler(req, res, rec)).catch((e) => { res.writeHead(500); res.end(e.message); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const send = (res, status, body, headers = {}) => { const t = typeof body === 'string' ? body : JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(t); };

let cfgCount = 0;
/** Use this configuration (an object, or a path) from now on. */
function useConfig(config) {
  let file = config;
  if (typeof config === 'object') { file = path.join(dir, `cfg-${++cfgCount}.json`); fs.writeFileSync(file, JSON.stringify(config)); }
  process.env.CUSTOMER_SYSTEMS_CONFIG = file;
  cfgMod.resetConfigCache();
  client.resetClient();
}
const oneSource = (url, over = {}, lookup = {}) => ({
  enabled: true,
  sources: { s: { label: 'Test system', base_url: url, allow_http: true, timeout_ms: 800, ...over } },
  lookups: { contract: { source: 's', path: '/contracts/{contract_no}', result: 'data', map: { contract_no: 'no' }, ...lookup } },
});

/* ================================================================================================ mapping */
describe('mapping language', () => {
  const { getPath, pick, mapRow, toNumber, toDateText, cleanText, rowsAt } = mapping;

  it('reads paths, list items, negative positions and wildcards, and refuses prototype keys', () => {
    const row = { a: { b: [{ c: 1 }, { c: 2 }, { c: 3 }] }, 'x': null };
    assert.equal(getPath(row, 'a.b[1].c'), 2);
    assert.equal(getPath(row, 'a.b.-1.c'), 3);
    assert.deepEqual(getPath(row, 'a.b[*].c'), [1, 2, 3]);
    assert.equal(getPath(row, '$.a.b.0.c'), 1);
    assert.equal(getPath(row, 'a.nope.deeper'), undefined);
    assert.equal(getPath(row, '__proto__.polluted'), undefined);
    assert.equal(getPath(row, 'constructor.name'), undefined);
    assert.equal(getPath(null, 'a'), undefined);
  });

  it('turns an answer into rows: a list stays, one record becomes a list of one, nothing becomes none', () => {
    assert.equal(rowsAt({ data: [{ a: 1 }, 'x', { a: 2 }] }, 'data').length, 2);
    assert.deepEqual(rowsAt({ data: { a: 1 } }, 'data'), [{ a: 1 }]);
    assert.deepEqual(rowsAt({ data: null }, 'data'), []);
    assert.deepEqual(rowsAt({ a: 1 }, ''), [{ a: 1 }]);
  });

  it('reads numbers the way people and systems write them', () => {
    assert.equal(toNumber('1,234.50'), 1234.5);
    assert.equal(toNumber('1.234,50'), 1234.5);
    assert.equal(toNumber('12,50'), 12.5);
    assert.equal(toNumber('1,234'), 1234);
    assert.equal(toNumber('AED 1 250'), 1250);
    assert.equal(toNumber('(12.00)'), -12);
    assert.equal(toNumber('-5'), -5);
    assert.equal(toNumber('abc'), undefined);
    assert.equal(toNumber(Number.NaN), undefined);
    assert.equal(toNumber({}), undefined);
  });

  it('reads dates and instants: zones, local Gulf time, day-month order, epoch, .NET, and impossible days', () => {
    assert.equal(toDateText('2026-10-06T22:00:00Z', 'datetime'), '2026-10-06 22:00:00');
    assert.equal(toDateText('2026-10-07T02:00:00+04:00', 'datetime'), '2026-10-06 22:00:00');
    assert.equal(toDateText('2026-10-06 10:00:00', 'datetime'), '2026-10-06 06:00:00', 'no zone = Gulf local time');
    assert.equal(toDateText('2026-10-06 10:00:00', 'datetime', { offset: 0 }), '2026-10-06 10:00:00');
    assert.equal(toDateText('2026-10-06T22:00:00Z', 'date'), '2026-10-07', 'the calendar day in the Gulf, not in UTC');
    assert.equal(toDateText('2026-10-06', 'date'), '2026-10-06', 'a plain date is not shifted');
    assert.equal(toDateText('01/10/2026', 'date'), '2026-10-01', 'day first');
    assert.equal(toDateText('01/10/2026', 'date', { order: 'mdy' }), '2026-01-10');
    assert.equal(toDateText('01/10/2026 14:30', 'datetime'), '2026-10-01 10:30:00');
    assert.equal(toDateText(1790000000, 'datetime'), '2026-09-21 14:13:20');
    assert.equal(toDateText(1790000000000, 'datetime'), '2026-09-21 14:13:20');
    assert.equal(toDateText('/Date(1790000000000)/', 'datetime'), '2026-09-21 14:13:20');
    assert.equal(toDateText('31/02/2026', 'date'), undefined);
    assert.equal(toDateText('not a date', 'date'), undefined);
  });

  it('picks with fallbacks, templates, value maps, scale, defaults, lists and booleans', () => {
    const row = { data: { first: 'Sara', last: 'Khan', emails: ['a@x.test', 'b@x.test'], minor: 12550, st: 'ON RENT', yes: 'Y', none: '' } };
    assert.equal(pick(row, ['data.nope', 'data.first']), 'Sara');
    assert.equal(pick(row, ['data.none', 'data.last']), 'Khan', 'an empty text counts as missing');
    assert.equal(pick(row, { template: '{data.first} {data.last}' }), 'Sara Khan');
    assert.equal(pick(row, { template: '{data.nope}' }), undefined);
    assert.equal(pick(row, { path: 'data.minor', type: 'money', scale: 0.01 }), 125.5);
    assert.equal(pick(row, { path: 'data.st', map: { 'on rent': 'active' } }), 'active');
    assert.equal(pick(row, { path: 'data.st', map: { other: 'x' }, unmapped: 'null' }), undefined);
    assert.equal(pick(row, { path: 'data.nope', default: 'x' }), 'x');
    assert.deepEqual(pick(row, { path: 'data.emails', type: 'list' }), ['a@x.test', 'b@x.test']);
    assert.equal(pick(row, { path: 'data.yes', type: 'bool' }), true);
    assert.equal(pick(row, { path: 'data.first', type: 'upper' }), 'SARA');
    assert.equal(pick(row, { value: 'AED' }), 'AED');
    assert.equal(pick(row, 'data'), undefined, 'an object is not text: nothing, not "[object Object]"');
  });

  it('strips control characters, direction tricks and runaway length from text', () => {
    assert.equal(cleanText('a\u0000b‮c  d\n'), 'a b c d');
    assert.equal(cleanText('x'.repeat(5000)).length, 2000);
    assert.equal(cleanText({}), undefined);
  });

  it('collects what it could not read, instead of failing', () => {
    const warnings = [];
    const out = mapRow({ d: '31/02/2026', n: 'abc', ok: '12' }, { date: { path: 'd', type: 'date' }, num: { path: 'n', type: 'money' }, good: { path: 'ok', type: 'int' } }, { warn: (m) => warnings.push(m) });
    assert.deepEqual(out, { good: 12 });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /date: Not a date/);
  });
});

/* ================================================================================================ configuration */
describe('configuration checks', () => {
  const problemsOf = (config) => { useConfig(config); return cfgMod.loadConfig(); };
  const base = () => oneSource('http://127.0.0.1:9');

  it('the shipped example is valid, and the shipped default is switched off', () => {
    useConfig(path.join(root, 'config', 'customer-systems.example.json'));
    const ex = cfgMod.loadConfig();
    assert.equal(ex.ok, true, ex.problems.join('; '));
    assert.equal(Object.keys(ex.config.lookups).length, 7);
    useConfig(path.join(root, 'config', 'customer-systems.json'));
    const def = cfgMod.loadConfig();
    assert.equal(def.ok, true);
    assert.equal(def.config.enabled, false);
  });

  it('says in plain words what is wrong', () => {
    let c = base(); c.lookups.contract.source = 'nope';
    assert.match(problemsOf(c).problems.join(' '), /"nope" is not in "sources"/);

    c = base(); c.lookups.contract.path = '/contracts/{contractno}';
    assert.match(problemsOf(c).problems.join(' '), /\{contractno\} is unknown/);

    c = base(); c.lookups.contract.path = '/contracts';
    assert.match(problemsOf(c).problems.join(' '), /at least one required placeholder.*everybody/);

    c = base(); c.lookups.contract.map = { colour: 'c' };
    const p = problemsOf(c).problems.join(' ');
    assert.match(p, /"colour" is not a field the helpdesk uses/);
    assert.match(p, /must say where to read "contract_no"/);

    c = base(); c.lookups.contract.body = { a: 1 };
    assert.match(problemsOf(c).problems.join(' '), /"body" is only used with "method": "POST"/);

    c = base(); c.lookups.contract.method = 'POST';
    assert.match(problemsOf(c).problems.join(' '), /needs a "body"/);

    c = base(); c.sources.s.base_url = 'ftp://x';
    assert.match(problemsOf(c).problems.join(' '), /must start with https/);

    c = base(); c.surprise = true;
    assert.equal(problemsOf(c).ok, false);

    c = { enabled: true, sources: {}, lookups: {} };
    assert.match(problemsOf(c).problems.join(' '), /No lookups are configured/);

    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    useConfig(path.join(dir, 'broken.json'));
    assert.match(cfgMod.loadConfig().problems[0], /not valid JSON/);
  });

  it('refuses plain http outside localhost, and everywhere in production unless allowed', () => {
    let c = oneSource('http://orion.internal.test/api', { allow_http: false });
    assert.match(problemsOf(c).problems.join(' '), /uses plain http/);
    c = oneSource('http://orion.internal.test/api', { allow_http: true });
    assert.equal(problemsOf(c).ok, true);
    c = oneSource('http://127.0.0.1:9', { allow_http: false });
    assert.equal(problemsOf(c).ok, true, 'localhost is fine while developing');
    process.env.NODE_ENV = 'production';
    try { assert.match(problemsOf(oneSource('http://127.0.0.1:9', { allow_http: false })).problems.join(' '), /uses plain http/); } finally { delete process.env.NODE_ENV; }
  });

  it('percent-encodes everything it puts into an address and never lets a path climb', () => {
    const { fillPlaceholders, placeholdersIn } = cfgMod;
    assert.equal(fillPlaceholders('/c/{email}', { email: 'a+b@x.test/../../etc?x=1#y' }).text, '/c/a%2Bb%40x.test%2F..%2F..%2Fetc%3Fx%3D1%23y');
    assert.equal(fillPlaceholders('/c/{contract_no|digits}', { contract_no: 'AST-100123' }).text, '/c/100123');
    assert.deepEqual(fillPlaceholders('/c/{contract_no}', { contract_no: '..' }), { text: '/c/', missing: ['contract_no'] });
    assert.deepEqual(fillPlaceholders('/c/{contract_no}', {}).missing, ['contract_no']);
    assert.deepEqual(fillPlaceholders('?a={email?}', {}), { text: '?a=', missing: [] });
    assert.deepEqual(placeholdersIn('{a?}{b|lower}').map((p) => [p.name, p.optional, p.filter]), [['a', true, null], ['b', false, 'lower']]);
  });

  it('chooses the data source: the CRM unless the connector is on, and an environment line overrides the file', () => {
    useConfig(path.join(root, 'config', 'customer-systems.example.json'));
    assert.equal(cfgMod.accountMode(), 'api', 'HELPDESK_ACCOUNT_SOURCE=api is set for this suite');
    process.env.HELPDESK_ACCOUNT_SOURCE = 'crm';
    assert.equal(cfgMod.accountMode(), 'crm');
    delete process.env.HELPDESK_ACCOUNT_SOURCE;
    assert.equal(cfgMod.accountMode(), 'api', 'the file says enabled');
    useConfig(path.join(root, 'config', 'customer-systems.json'));
    assert.equal(cfgMod.accountMode(), 'crm', 'the shipped default is off');
    process.env.HELPDESK_ACCOUNT_SOURCE = 'api';
  });

  it('reports which secrets are still missing on the server, by name and never by value', () => {
    useConfig(oneSource('http://127.0.0.1:9', { auth: { type: 'bearer', token_env: 'ORION_NOT_SET_TOKEN' } }));
    const rt = cfgMod.sourceRuntime('s');
    assert.deepEqual(rt.missing, ['ORION_NOT_SET_TOKEN']);
    const rt2 = cfgMod.sourceRuntime('s', { sources: { s: { label: 'x', base_url_env: 'ORION_NOT_SET_URL', auth: { type: 'basic', user_env: 'U_NOT_SET', password_env: 'P_NOT_SET' } } } });
    assert.deepEqual(rt2.missing.sort(), ['ORION_NOT_SET_URL', 'P_NOT_SET', 'U_NOT_SET']);
  });
});

/* ================================================================================================ client */
describe('the HTTP client', () => {
  let srv;
  afterEach(async () => { if (srv) { await srv.close(); srv = null; } }); // also when a test fails half way

  it('signs in with an api key in a header, and keeps the key out of what it reports', async () => {
    srv = await serve((req, res) => send(res, 200, { data: { no: 'AST-1' } }));
    process.env.TEST_KEY = 'super-secret-key';
    useConfig(oneSource(srv.url, { auth: { type: 'api_key', key_env: 'TEST_KEY', header: 'X-Key', prefix: 'K ' } }));
    const r = await client.runLookup('contract', { contract_no: 'AST-1' });
    assert.equal(r.ok, true);
    assert.equal(r.rows[0].no, 'AST-1');
    assert.equal(srv.hits[0].headers['x-key'], 'K super-secret-key');
    assert.ok(!JSON.stringify(r).includes('super-secret-key'));
    assert.equal(srv.hits[0].headers['user-agent'], 'Autostrad-Helpdesk/1');
    await srv.close();
  });

  it('can put the key in the query string, and masks it in the address it reports', async () => {
    srv = await serve((req, res) => send(res, 200, { data: { no: 'AST-1' } }));
    process.env.TEST_KEY = 'query-secret';
    useConfig(oneSource(srv.url, { auth: { type: 'api_key', key_env: 'TEST_KEY', query: 'api_key' } }));
    const r = await client.runLookup('contract', { contract_no: 'AST-1' });
    assert.match(srv.hits[0].url, /api_key=query-secret/);
    assert.ok(r.url.includes('api_key=***') && !r.url.includes('query-secret'));
    await srv.close();
  });

  it('supports bearer tokens and basic sign-in', async () => {
    srv = await serve((req, res) => send(res, 200, { data: { no: 'X' } }));
    process.env.TEST_TOKEN = 'tok-123'; process.env.TEST_USER = 'svc'; process.env.TEST_PASS = 'pw';
    useConfig(oneSource(srv.url, { auth: { type: 'bearer', token_env: 'TEST_TOKEN' } }));
    await client.runLookup('contract', { contract_no: 'A1' });
    assert.equal(srv.hits[0].headers.authorization, 'Bearer tok-123');
    useConfig(oneSource(srv.url, { auth: { type: 'basic', user_env: 'TEST_USER', password_env: 'TEST_PASS' } }));
    await client.runLookup('contract', { contract_no: 'A2' });
    assert.equal(srv.hits[1].headers.authorization, `Basic ${Buffer.from('svc:pw').toString('base64')}`);
    await srv.close();
  });

  it('gets an OAuth token once, reuses it, renews it when refused, and explains a refused sign-in', async () => {
    let tokens = 0;
    let issued = 'tok-1';
    srv = await serve(async (req, res) => {
      if (req.url === '/oauth/token') {
        tokens++;
        const form = new URLSearchParams(await new Promise((r) => { let t = ''; req.on('data', (c) => { t += c; }); req.on('end', () => r(t)); }));
        if (form.get('client_secret') !== 'shh' || form.get('grant_type') !== 'client_credentials') return send(res, 400, { error: 'invalid_client', error_description: 'bad secret' });
        issued = `tok-${tokens}`;
        return send(res, 200, { access_token: issued, expires_in: 3600 });
      }
      return req.headers.authorization === `Bearer ${issued}` ? send(res, 200, { data: { no: 'OK' } }) : send(res, 401, { error: 'expired' });
    });
    process.env.OA_ID = 'cid'; process.env.OA_SECRET = 'shh';
    const auth = { type: 'oauth2_client_credentials', token_url: `${srv.url}/oauth/token`, client_id_env: 'OA_ID', client_secret_env: 'OA_SECRET', scope: 'read' };
    useConfig(oneSource(srv.url, { auth }));
    assert.equal((await client.runLookup('contract', { contract_no: 'A1' })).ok, true);
    assert.equal((await client.runLookup('contract', { contract_no: 'A2' })).ok, true);
    assert.equal(tokens, 1, 'one token served both calls');
    issued = 'revoked-elsewhere'; // the system forgets our token
    const again = await client.runLookup('contract', { contract_no: 'A3' });
    assert.equal(again.ok, true, again.error && again.error.message);
    assert.equal(tokens, 2, 'a 401 made it fetch a fresh token once');
    process.env.OA_SECRET = 'wrong';
    useConfig(oneSource(srv.url, { auth }));
    const refused = await client.runLookup('contract', { contract_no: 'A4' });
    assert.equal(refused.error.code, 'auth');
    assert.match(refused.error.message, /sign-in was refused/);
    assert.ok(!refused.error.message.includes('wrong'));
    await srv.close();
  });

  it('answers "not found" as an answer, and a refused key as an error', async () => {
    srv = await serve((req, res) => (req.url.includes('missing') ? send(res, 404, { error: 'none' }) : send(res, 401, { error: 'no' })));
    useConfig(oneSource(srv.url));
    const nf = await client.runLookup('contract', { contract_no: 'missing' });
    assert.deepEqual([nf.ok, nf.notFound, nf.rows.length], [true, true, 0]);
    const denied = await client.runLookup('contract', { contract_no: 'secret' });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'auth');
    assert.match(denied.error.message, /refused our credentials \(401\)/);
    await srv.close();
  });

  it('retries throttling once and then succeeds; a persistent 503 is an error', async () => {
    let n = 0;
    srv = await serve((req, res) => {
      if (req.url.includes('throttled')) return n++ === 0 ? send(res, 429, { error: 'slow down' }, { 'retry-after': '0' }) : send(res, 200, { data: { no: 'T' } });
      return send(res, 503, { error: 'down' });
    });
    useConfig(oneSource(srv.url));
    assert.equal((await client.runLookup('contract', { contract_no: 'throttled' })).ok, true);
    assert.equal(srv.hits.length, 2);
    const down = await client.runLookup('contract', { contract_no: 'broken' });
    assert.equal(down.ok, false);
    assert.equal(down.error.code, 'http');
    assert.equal(srv.hits.length, 4, 'one retry, then it gave up');
    await srv.close();
  });

  it('gives up on a slow system after its timeout, and never follows a redirect', async () => {
    srv = await serve(async (req, res) => {
      if (req.url.includes('slow')) { await sleep(1500); return send(res, 200, { data: {} }); }
      return send(res, 302, '', { location: 'http://127.0.0.1:1/elsewhere' });
    });
    useConfig(oneSource(srv.url, { timeout_ms: 500 }));
    const t0 = Date.now();
    const slow = await client.runLookup('contract', { contract_no: 'slow' });
    assert.equal(slow.error.code, 'timeout');
    assert.ok(Date.now() - t0 < 1300, 'it did not wait for the slow answer');
    const moved = await client.runLookup('contract', { contract_no: 'moved' });
    assert.equal(moved.error.code, 'redirect');
    assert.equal(srv.hits.filter((h) => h.url.includes('moved')).length, 1);
    await srv.close();
  });

  it('refuses an answer that is too big or is not JSON', async () => {
    srv = await serve((req, res) => (req.url.includes('big') ? send(res, 200, `{"data":"${'x'.repeat(60_000)}"}`) : send(res, 200, '<html>login</html>', { 'content-type': 'text/html' })));
    useConfig(oneSource(srv.url, { max_response_kb: 16 }));
    assert.equal((await client.runLookup('contract', { contract_no: 'big' })).error.code, 'too_large');
    const html = await client.runLookup('contract', { contract_no: 'page' });
    assert.equal(html.error.code, 'parse');
    assert.match(html.error.message, /did not answer with JSON \(it sent text\/html\)/);
    await srv.close();
  });

  it('caches answers (and "not found" for a shorter time), unless asked for fresh ones', async () => {
    srv = await serve((req, res) => (req.url.includes('gone') ? send(res, 404, {}) : send(res, 200, { data: { no: 'C' } })));
    useConfig(oneSource(srv.url));
    await client.runLookup('contract', { contract_no: 'AST-1' });
    const second = await client.runLookup('contract', { contract_no: 'ast-1' });
    assert.equal(second.cached, true);
    assert.equal(srv.hits.length, 1, 'same contract in another case: one call');
    await client.runLookup('contract', { contract_no: 'AST-1' }, { bypassCache: true });
    assert.equal(srv.hits.length, 2, 'Refresh always asks again');
    await client.runLookup('contract', { contract_no: 'gone' });
    await client.runLookup('contract', { contract_no: 'gone' });
    assert.equal(srv.hits.filter((h) => h.url.includes('gone')).length, 1);
    await srv.close();
  });

  it('pauses a system that keeps failing, then lets one request through to see whether it is back', async () => {
    let up = false;
    srv = await serve((req, res) => (up ? send(res, 200, { data: { no: 'B' } }) : send(res, 500, { error: 'boom' })));
    useConfig(oneSource(srv.url));
    const keep = client.tuning.breakerThreshold;
    client.tuning.breakerThreshold = 3;
    try {
      for (let i = 0; i < 3; i++) assert.equal((await client.runLookup('contract', { contract_no: `F${i}` })).error.code, 'http');
      const before = srv.hits.length;
      const paused = await client.runLookup('contract', { contract_no: 'F9' });
      assert.equal(paused.error.code, 'breaker');
      assert.match(paused.error.message, /not answering/);
      assert.equal(srv.hits.length, before, 'a paused system is not called at all');
      assert.ok(client.sourceHealth('s').paused_until);
      await sleep(300);
      up = true;
      assert.equal((await client.runLookup('contract', { contract_no: 'F10' })).ok, true, 'the probe got through and succeeded');
      assert.equal(client.sourceHealth('s').paused_until, null);
      assert.equal((await client.runLookup('contract', { contract_no: 'F11' })).ok, true);
    } finally { client.tuning.breakerThreshold = keep; }
    await srv.close();
  });

  it('keeps hostile values out of the address, and asks nothing when it has nothing to ask with', async () => {
    srv = await serve((req, res) => send(res, 200, { data: { no: 'H' } }));
    useConfig(oneSource(srv.url, {}, { query: { who: '{email?}' } }));
    await client.runLookup('contract', { contract_no: 'A/../../admin?x=1#y', email: 'a&admin=1@x.test' });
    assert.equal(srv.hits[0].url, '/contracts/A%2F..%2F..%2Fadmin%3Fx%3D1%23y?who=a%26admin%3D1%40x.test');
    const before = srv.hits.length;
    const dots = await client.runLookup('contract', { contract_no: '..' });
    assert.deepEqual([dots.skipped, dots.reason], [true, 'needs contract_no']);
    const none = await client.runLookup('contract', {});
    assert.equal(none.skipped, true);
    assert.equal(srv.hits.length, before);
    await srv.close();
  });

  it('never has more requests open than the system allows', async () => {
    let open = 0; let peak = 0;
    srv = await serve(async (req, res) => { open++; peak = Math.max(peak, open); await sleep(80); open--; send(res, 200, { data: { no: 'P' } }); });
    useConfig(oneSource(srv.url, { max_concurrent: 1 }));
    const all = await Promise.all(['1', '2', '3'].map((n) => client.runLookup('contract', { contract_no: `AST-${n}` })));
    assert.ok(all.every((r) => r.ok));
    assert.equal(peak, 1);
    await srv.close();
  });

  it('says what to add when the server lacks a key, and makes no request', async () => {
    srv = await serve((req, res) => send(res, 200, {}));
    useConfig(oneSource(srv.url, { auth: { type: 'bearer', token_env: 'NOT_THERE_TOKEN' } }));
    const r = await client.runLookup('contract', { contract_no: 'AST-1' });
    assert.equal(r.error.code, 'config');
    assert.match(r.error.message, /add NOT_THERE_TOKEN to server\/\.env/);
    assert.equal(srv.hits.length, 0);
    await srv.close();
  });
});

/* ================================================================================================ the resolver */
describe('from an email to an account', () => {
  let api;
  const data = {
    customers: [
      { id: 'C-1', fullName: 'Sara Khan', email: 'sara@example.test', altEmails: ['sara.k@work.test'], mobile: '+971500000001', loyalty: 'GOLD', accountType: 'INDIVIDUAL' },
      { id: 'C-2', fullName: 'Omar Ali', email: 'omar@example.test', altEmails: [], mobile: '+971500000002', loyalty: 'STANDARD', accountType: 'INDIVIDUAL' },
      { id: 'C-3', companyName: 'Acme Rentals LLC', email: 'fleet@acme.test', altEmails: [], mobile: '+97144000000', loyalty: 'PLATINUM', accountType: 'CORPORATE' },
      { id: 'C-4', fullName: 'Old Customer', email: 'old@example.test', altEmails: [], mobile: '', loyalty: 'STANDARD', accountType: 'INDIVIDUAL' },
    ],
    contracts: [
      { contractNumber: 'AST-100001', state: 'RETURNED', product: 'Daily', grandTotal: 1250, paymentState: 'PAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-20), endDate: iso(-10), pickupBranch: { name: 'Dubai Airport T3', emirate: 'Dubai' }, vehicle: { make: 'Nissan', model: 'Sunny', plate: 'A 12345' }, portalUrl: 'https://portal.test/c/100001' },
      { contractNumber: 'AST-100002', state: 'ON_RENT', product: 'Monthly', grandTotal: 3000, paymentState: 'UNPAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-3), endDate: iso(27), pickupBranch: { name: 'Business Bay', emirate: 'Dubai' }, vehicle: { make: 'Kia', model: 'Seltos', plate: 'B 777' } },
      { contractNumber: 'AST-100003', state: 'RETURNED', product: 'Daily', grandTotal: 500, paymentState: 'PAID', customerId: 'C-2', customerEmail: 'omar@example.test', startDate: iso(-9), endDate: iso(-5), pickupBranch: null, vehicle: null },
      { contractNumber: 'AST-100004', state: 'ON_RENT', product: 'Fleet', grandTotal: 9000, paymentState: 'PAID', customerId: 'C-3', customerEmail: 'fleet@acme.test', startDate: iso(-30), endDate: iso(30), pickupBranch: { name: 'Al Quoz Head Office', emirate: 'Dubai' }, vehicle: null },
      { contractNumber: 'AST-100005', state: 'RETURNED', product: 'Daily', grandTotal: 400, paymentState: 'PAID', customerId: 'C-4', customerEmail: 'old@example.test', startDate: iso(-130), endDate: iso(-120), pickupBranch: null, vehicle: null },
      { contractNumber: 'AST-100006', state: 'CANCELLED', product: 'Daily', grandTotal: 400, paymentState: 'REFUNDED', customerId: 'C-2', customerEmail: 'omar@example.test', startDate: iso(-2), endDate: iso(1), pickupBranch: null, vehicle: null },
    ],
    invoices: [
      { invoiceNo: 'INV-1', contractNumber: 'AST-100001', customerId: 'C-1', gross: 1250, vat: 59.52, state: 'PAID', issuedOn: dmy(-10), dueOn: dmy(4), outstanding: '0.00' },
      { invoiceNo: 'INV-2', contractNumber: 'AST-100001', customerId: 'C-1', gross: 400, vat: 19.05, state: 'SENT', issuedOn: dmy(-9), dueOn: dmy(-2), outstanding: '400.00' },
      { invoiceNo: 'INV-3', contractNumber: 'AST-100001', customerId: 'C-1', gross: 90, vat: 4.29, state: 'DRAFT', issuedOn: dmy(-1), dueOn: dmy(14), outstanding: '90.00' },
      { invoiceNo: 'INV-9', contractNumber: 'AST-100003', customerId: 'C-2', gross: 500, vat: 23.81, state: 'SENT', issuedOn: dmy(-5), dueOn: dmy(9), outstanding: '500.00' },
    ],
    fines: [
      { ref: 'DXB-77', contractNumber: 'AST-100001', category: 'SALIK', amount: 4, adminFee: 0, state: 'UNRECOVERED', issuedAt: iso(-15) },
      { ref: 'DXB-78', contractNumber: 'AST-100001', category: 'TRAFFIC', amount: 400, adminFee: 25, state: 'RECOVERED', issuedAt: iso(-14) },
    ],
    deposits: {
      'AST-100001': { deposit: { amount: 1000, state: 'HELD', refundDue: null }, cardHold: { amount: 1500, state: 'ACTIVE', releasedOn: null, last4: '4242' } },
    },
  };

  before(async () => {
    api = createMockApi({ data, apiKey: 'orion-test-key' });
    const url = await api.listen(0);
    process.env.ORION_BASE_URL = url;
    process.env.CNR_BASE_URL = url;
    process.env.CNR_API_KEY = 'orion-test-key';
    process.env.ORION_API_KEY = 'orion-test-key';
    useConfig(path.join(root, 'config', 'customer-systems.example.json'));
  });
  after(async () => { await api.close(); });
  const fresh = () => { api.reset(); client.resetClient(); };
  const ask = (o) => resolveDetailed({ bypassCache: true, ...o }).then((r) => r.snapshot);

  it('finds the customer, the contract, the invoices, fines, deposit and card hold from the sender and the contract number', async () => {
    fresh();
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.equal(s.status, 'ok');
    assert.equal(s.source, 'api');
    assert.deepEqual(s.systems.sort(), ['CNR Portal', 'Orion Fleet']);
    assert.equal(s.identity, 'email');
    assert.equal(s.inferred, false);
    assert.deepEqual([s.customer.name, s.customer.tier, s.customer.segment, s.customer.id], ['Sara Khan', 'Gold', 'Individual', 'C-1']);
    const k = s.contract;
    assert.deepEqual([k.contract_no, k.status, k.payment_status, k.total_amount, k.product_line], ['AST-100001', 'completed', 'paid', 1250, 'Daily']);
    assert.deepEqual(k.vehicle, { name: 'Nissan Sunny', plate: 'A 12345' });
    assert.deepEqual(k.pickup_branch, { id: null, name: 'Dubai Airport T3', emirate: 'Dubai' });
    assert.equal(k.url, 'https://portal.test/c/100001');
    assert.equal(k.customer.name, 'Sara Khan');
    assert.match(k.start_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(k.customer_ref, undefined, 'the stored contract does not carry the matching helper');

    assert.deepEqual(k.invoices.map((i) => i.number), ['INV-3', 'INV-2', 'INV-1'], 'newest first');
    const inv = Object.fromEntries(k.invoices.map((i) => [i.number, i]));
    assert.deepEqual([inv['INV-1'].status, inv['INV-1'].balance], ['paid', 0]);
    assert.deepEqual([inv['INV-2'].status, inv['INV-2'].balance], ['overdue', 400], 'sent and past its due date');
    assert.equal(inv['INV-3'].status, 'draft');
    assert.match(inv['INV-1'].issue_date, /^\d{4}-\d{2}-\d{2}$/, 'dd/mm/yyyy became a date');
    assert.deepEqual(k.invoice_summary, { count: 3, unpaid_count: 1, outstanding: 400, overdue_count: 1 }, 'a draft is not owed');

    assert.deepEqual(k.fines.map((f) => [f.reference, f.type, f.status]).sort(), [['DXB-77', 'Salik Toll', 'unrecovered'], ['DXB-78', 'Traffic Fine', 'recovered']]);
    assert.deepEqual([k.financials.deposit_amount, k.financials.deposit_status, k.financials.preauth_amount, k.financials.preauth_status, k.financials.card_last4], [1000, 'held', 1500, 'active', '4242']);
    assert.deepEqual(s.other_contracts.map((o) => o.contract_no), ['AST-100002']);
    assert.deepEqual(s.errors, []);
  });

  it('asks for the sender and the contract at the same time, and sends the key each system expects', async () => {
    fresh();
    await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    const paths = api.requests.map((r) => r.path);
    assert.ok(paths.includes('/v1/contracts/AST-100001') && paths.includes('/v1/customers'));
    assert.ok(api.requests.every((r) => r.headers['x-api-key'] === 'orion-test-key'));
    assert.equal(api.requests.find((r) => r.path === '/v1/customers').query.email, 'sara@example.test');
  });

  it('with no contract number it takes the sender\'s current rental, and says it guessed', async () => {
    fresh();
    const s = await ask({ email: 'sara@example.test' });
    assert.equal(s.inferred, true);
    assert.equal(s.contract.contract_no, 'AST-100002', 'the rental that is running now');
    assert.equal(s.identity, 'email');
    assert.deepEqual(s.other_contracts.map((o) => o.contract_no), ['AST-100001']);
  });

  it('does not guess a rental that ended long ago, or one that was cancelled', async () => {
    fresh();
    const old = await ask({ email: 'old@example.test' });
    assert.equal(old.contract, null);
    assert.equal(old.customer.name, 'Old Customer');
    assert.equal(old.status, 'ok');
    const omar = await ask({ email: 'omar@example.test' });
    assert.equal(omar.contract.contract_no, 'AST-100003', 'the cancelled one is skipped');
  });

  it('never guesses when the email named a contract that does not exist, and lists the sender\'s own instead', async () => {
    fresh();
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-999999' });
    assert.equal(s.contract, null);
    assert.equal(s.inferred, false);
    assert.equal(s.customer.name, 'Sara Khan');
    assert.match(s.notes.join(' '), /Contract AST-999999 was not found in Orion Fleet\. The sender has 2 other contracts/);
    assert.deepEqual(s.other_contracts.map((o) => o.contract_no).sort(), ['AST-100001', 'AST-100002']);
  });

  it('matches a bare number to the prefixed one, and a known second address to the same customer', async () => {
    fresh();
    assert.equal(sameContractNo('100001', 'AST-100001'), true);
    assert.equal(sameContractNo('AST-100001', 'ast100001'), true);
    assert.equal(sameContractNo('AST-100001', 'AST-100002'), false);
    assert.equal(sameContractNo('1234', 'AST-1234'), false, 'short numbers must match exactly');
    const s = await ask({ email: 'SARA.K@work.test', contractNo: 'AST-100001' });
    assert.equal(s.customer.id, 'C-1');
    assert.equal(s.identity, 'email', 'her second address is on file');
  });

  it('says the sender is NOT the customer when somebody else\'s contract number is typed', async () => {
    fresh();
    const known = await ask({ email: 'omar@example.test', contractNo: 'AST-100001' });
    assert.equal(known.identity, 'contract_only');
    assert.equal(known.customer.name, 'Omar Ali', 'the case is about the person who wrote');
    assert.equal(known.contract.customer.name, 'Sara Khan', 'while the contract shows who it belongs to');
    const stranger = await ask({ email: 'someone@elsewhere.test', contractNo: 'AST-100001' });
    assert.equal(stranger.identity, 'contract_only');
    assert.equal(stranger.customer.name, 'Sara Khan', 'an unknown sender: the case falls back to the contract\'s customer');
    assert.equal(stranger.contract.customer.email, 'sara@example.test');
    const nobody = await ask({ email: 'someone@elsewhere.test' });
    assert.deepEqual([nobody.status, nobody.identity, nobody.customer, nobody.contract], ['not_found', 'none', null, null]);
  });

  it('decides identity by the rules, case by case', () => {
    const sara = { id: 'C-1', emails: ['sara@example.test'] };
    const k = (ref) => ({ contract_no: 'AST-1', customer_ref: ref });
    assert.equal(identityOf({ email: '' }), 'none');
    assert.equal(identityOf({ email: 'a@x.test', customerFromEmail: sara }), 'email', 'no contract: the sender is a known customer');
    assert.equal(identityOf({ email: 'a@x.test' }), 'none');
    assert.equal(identityOf({ email: 'a@x.test', customerFromEmail: sara, contract: k({ id: 'C-1' }) }), 'email');
    assert.equal(identityOf({ email: 'a@x.test', customerFromEmail: sara, contract: k({ id: 'C-2' }) }), 'contract_only');
    assert.equal(identityOf({ email: 'a@x.test', contract: k({ email: 'a@x.test' }) }), 'email', 'the contract itself names the sender');
    assert.equal(identityOf({ email: 'a@x.test', contract: k({ id: 'C-2' }), owner: { id: 'C-2', emails: ['a@x.test'] } }), 'email', 'the contract\'s customer lists the address');
    assert.equal(identityOf({ email: 'a@x.test', contract: k({}) }), 'contract_only', 'a contract that does not say whose it is proves nothing');
    assert.equal(identityOf({ email: 'a@x.test', customerFromEmail: { id: null, emails: ['a@x.test'] }, contract: k({}) }), 'contract_only', 'neither side has an id to compare');
    assert.equal(identityOf({ email: 'a@x.test', contract: k({}), inferred: true }), 'email', 'chosen from the sender\'s own contracts');
  });

  it('chooses the sender\'s recent rental: running, or ended within 60 days; never upcoming or cancelled', () => {
    const rows = [
      { contract_no: 'A', status: 'completed', end_at: '2020-01-01 00:00:00' },
      { contract_no: 'B', status: 'cancelled', end_at: iso(1) },
      { contract_no: 'C', status: 'upcoming', end_at: iso(9) },
      { contract_no: 'D', status: 'completed', end_at: iso(-30) },
      { contract_no: 'E', status: 'completed', end_at: iso(-10) },
    ];
    assert.equal(pickRecent(rows).contract_no, 'E');
    assert.equal(pickRecent([rows[0], rows[1], rows[2]]), null);
    assert.equal(pickRecent([{ contract_no: 'R', status: 'active', end_at: iso(20) }, rows[4]]).contract_no, 'R');
  });

  it('shows what it has when part of the answer is missing', async () => {
    fresh();
    api.intercept({ match: (r) => r.path === '/v1/invoices', reply: (_r, res, json) => json(res, 500, { error: { code: 'BOOM' } }) });
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.equal(s.status, 'partial');
    assert.equal(s.contract.contract_no, 'AST-100001');
    assert.equal(s.contract.invoices.length, 0);
    assert.equal(s.customer.name, 'Sara Khan');
    assert.equal(s.errors[0].lookup, 'invoices');
    assert.match(s.errors[0].message, /CNR Portal had an internal error \(500\)/);
  });

  it('reports unavailable, not "not found", when the systems do not answer', async () => {
    fresh();
    api.state.down = true;
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.equal(s.status, 'unavailable');
    assert.ok(s.errors.length >= 1);
    assert.equal(s.customer, null);
    assert.equal(s.identity, 'none');
    fresh();
  });

  it('does not attach records from an API that ignores the filter it was given', async () => {
    fresh();
    // the customer lookup answers with everybody instead of the one asked for
    api.intercept({ match: (r) => r.path === '/v1/customers', reply: (_r, res, json) => json(res, 200, { data: data.customers.map((c) => ({ id: c.id, fullName: c.fullName || c.companyName, emailAddress: c.email, otherEmails: [], mobile: '', loyalty: c.loyalty, accountType: c.accountType })) }) });
    const stranger = await ask({ email: 'nobody@elsewhere.test' });
    assert.equal(stranger.customer, null);
    assert.match(stranger.warnings.join(' '), /none with the address nobody@elsewhere\.test/);
    // the contract lookup answers with a different contract than the one asked for
    api.reset();
    api.intercept({ match: (r) => r.path === '/v1/contracts/AST-100003', reply: (_r, res, json) => json(res, 200, { data: { contractNumber: 'AST-100002', state: 'ON_RENT' } }) });
    const wrong = await ask({ email: 'omar@example.test', contractNo: 'AST-100003' });
    assert.equal(wrong.contract, null);
    assert.match(wrong.warnings.join(' '), /answered, but not with contract AST-100003/);
  });

  it('turns odd statuses and tiers into the words the screens use, and keeps unknown ones as they are', async () => {
    fresh();
    api.intercept({ match: (r) => r.path === '/v1/invoices', reply: (_r, res, json) => json(res, 200, { data: [
      { invoiceNo: 'X1', contractNumber: 'AST-100001', amount: { gross: '1,000.50', vat: '47.64' }, state: 'Partially Paid', issuedOn: '2026-10-01', dueOn: '2020-01-01', outstanding: '300' },
      { invoiceNo: 'X2', contractNumber: 'AST-100001', amount: { gross: 10 }, state: 'WEIRD STATE', issuedOn: dmy(-1) },
      { invoiceNo: 'X3', contractNumber: 'AST-100001', amount: { gross: 10 }, issuedOn: dmy(-2), outstanding: '0' },
    ] }) });
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    const by = Object.fromEntries(s.contract.invoices.map((i) => [i.number, i]));
    assert.equal(by.X1.status, 'overdue', 'partly paid and long past due');
    assert.equal(by.X1.total, 1000.5);
    assert.equal(by.X2.status, 'weird_state');
    assert.equal(by.X3.status, 'paid', 'no status but nothing outstanding');
  });

  it('only turns web addresses into links', async () => {
    fresh();
    api.intercept({ match: (r) => r.path === '/v1/contracts/AST-100001', reply: (_r, res, json) => json(res, 200, { data: { contractNumber: 'AST-100001', state: 'RETURNED', links: { portal: 'javascript:alert(1)' } } }) });
    const s = await ask({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.equal(s.contract.url, null);
  });

  it('keeps the sender and the contract number out of what it logs and stores as errors', async () => {
    fresh();
    api.state.down = true;
    const s = await ask({ email: 'private.person@example.test', contractNo: 'AST-100001' });
    assert.ok(!JSON.stringify(s.errors).includes('private.person'));
    fresh();
  });
});

/* ================================================================================================ the account on a case */
describe('the account on a case', () => {
  let api;
  let user;
  const mk = (n) => ({ ...n });
  let counter = 0;
  const email = (o) => ({
    providerId: `sys-${++counter}`, conversationId: `sys-conv-${counter}`, direction: 'in', from: { name: 'Sara Khan', email: 'sara@example.test' }, to: ['helpdesk@autostrad.com'],
    subject: 'Security deposit refund', body: 'Hello, when will I get my security deposit back for contract AST-100001? Thank you', receivedAt: nowUtc(), ...o,
  });
  const base = () => ({
    customers: [
      { id: 'C-1', fullName: 'Sara Khan', email: 'sara@example.test', altEmails: [], mobile: '+971500000001', loyalty: 'GOLD', accountType: 'INDIVIDUAL' },
      { id: 'C-2', fullName: 'Omar Ali', email: 'omar@example.test', altEmails: [], mobile: '+971500000002', loyalty: 'STANDARD', accountType: 'INDIVIDUAL' },
    ],
    contracts: [
      { contractNumber: 'AST-100001', state: 'RETURNED', product: 'Daily', grandTotal: 1250, paymentState: 'PAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-20), endDate: iso(-10), pickupBranch: { name: 'Dubai Airport T3', emirate: 'Dubai' }, vehicle: { make: 'Nissan', model: 'Sunny', plate: 'A 12345' } },
      { contractNumber: 'AST-100002', state: 'ON_RENT', product: 'Monthly', grandTotal: 3000, paymentState: 'UNPAID', customerId: 'C-1', customerEmail: 'sara@example.test', startDate: iso(-3), endDate: iso(27), pickupBranch: null, vehicle: null },
      { contractNumber: 'AST-100003', state: 'RETURNED', product: 'Daily', grandTotal: 500, paymentState: 'PAID', customerId: 'C-2', customerEmail: 'omar@example.test', startDate: iso(-9), endDate: iso(-5), pickupBranch: null, vehicle: null },
    ],
    invoices: [{ invoiceNo: 'INV-1', contractNumber: 'AST-100001', customerId: 'C-1', gross: 1250, vat: 59.52, state: 'PAID', issuedOn: dmy(-10), dueOn: dmy(4), outstanding: '0.00' }],
    fines: [],
    deposits: { 'AST-100001': { deposit: { amount: 1000, state: 'HELD', refundDue: null }, cardHold: null } },
  });

  before(async () => {
    api = createMockApi({ data: base(), apiKey: 'orion-test-key' });
    const url = await api.listen(0);
    process.env.ORION_BASE_URL = url;
    process.env.CNR_BASE_URL = url;
    useConfig(path.join(root, 'config', 'customer-systems.example.json'));
    user = db.prepare("INSERT INTO users (name, email, password_hash, role, status) VALUES ('Test Admin', 'ta@test.test', 'x', 'admin', 'active')").run().lastInsertRowid;
    user = { id: Number(user), name: 'Test Admin', role: 'admin' };
  });
  after(async () => { await api.close(); });
  // each test starts with the systems calm and no open cases: a new email about a contract that already has an open case of the same type
  // correctly joins that case as a chaser, which is not what these tests are about
  const calm = () => {
    api.reset(); client.resetClient();
    db.prepare("UPDATE hd_cases SET status = 'closed', closed_at = datetime('now') WHERE status <> 'closed'").run();
  };

  it('opens a case with the customer, contract and invoices from the systems, and keeps them with the case', async () => {
    calm();
    const r = await ingestMessage(email({}));
    assert.equal(r.action, 'created');
    const c = getCaseDetail(r.caseId, user);
    assert.equal(c.sub_key, 'deposit_refund');
    assert.equal(c.customer_name, 'Sara Khan');
    assert.equal(c.contract_no, 'AST-100001');
    assert.equal(c.customer_id, null, 'ids that point into the CRM tables stay empty');
    assert.equal(c.booking_id, null);
    assert.equal(c.account.source, 'api');
    assert.deepEqual(c.account.systems.sort(), ['CNR Portal', 'Orion Fleet']);
    assert.equal(c.account.status, 'ok');
    assert.equal(c.account.identity, 'email');
    assert.equal(c.contract.invoices[0].number, 'INV-1');
    assert.equal(c.contract.financials.deposit_amount, 1000);
    assert.ok(c.priority_reasons.some((x) => /Gold customer/.test(x)), 'the tier from the system raised the priority');
    assert.ok(c.audit.some((a) => a.action === 'customer_matched' && /Orion Fleet and CNR Portal: Sara Khan, contract AST-100001/.test(a.detail)));
    const draft = c.drafts.find((d) => d.status === 'pending');
    assert.match(draft.body, /AED 1,000\.00/, 'the draft quotes the deposit from the system');
    assert.match(draft.body, /being held/);
  });

  it('answers from the stored copy: reading a case again asks the systems nothing', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'sys-store' }));
    const before = api.requests.length;
    getCaseDetail(r.caseId, user);
    getCaseDetail(r.caseId, user);
    assert.equal(api.requests.length, before);
  });

  it('does not look up spam or automatic replies at all', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'sys-spam', subject: 'Boost your website ranking now', body: 'Dear owner, we can put your website on the first page of Google in 7 days. Unsubscribe if you are not interested.', from: { name: 'SEO', email: 'seo@spam.test' } }));
    assert.equal(api.requests.length, 0);
    const c = getCaseDetail(r.caseId, user);
    assert.equal(c.account.status, 'not_checked');
  });

  it('leaves figures out of the reply when the sender is not the customer on the contract, until staff confirm', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'sys-imposter', from: { name: 'Omar Ali', email: 'omar@example.test' }, body: 'Hello, when will I get my security deposit back for contract AST-100001? Thank you' }));
    let c = getCaseDetail(r.caseId, user);
    assert.equal(c.account.identity, 'contract_only');
    assert.equal(c.customer_name, 'Omar Ali', 'greeted by the name of the person who wrote');
    assert.equal(c.contract.customer.name, 'Sara Khan');
    assert.equal(c.contract.financials.deposit_amount, 1000, 'staff can still see it');
    assert.ok(c.insights.some((i) => i.tone === 'danger' && /sender is not the customer/.test(i.title)));
    let draft = c.drafts.find((d) => d.status === 'pending');
    assert.ok(!/1,000\.00/.test(draft.body) && !/being held/.test(draft.body), draft.body);
    assert.match(draft.notes, /not the customer on contract AST-100001/);

    await actions.verifySender(r.caseId, user);
    c = getCaseDetail(r.caseId, user);
    assert.equal(c.account.identity, 'staff');
    assert.equal(c.account.verified_by, 'Test Admin');
    draft = c.drafts.find((d) => d.status === 'pending');
    assert.match(draft.body, /AED 1,000\.00/, 'the untouched draft was written again with the figures');
    assert.ok(c.audit.some((a) => a.action === 'sender_verified'));
    // the confirmation is for this sender and this contract only
    updateCase(r.caseId, { contract_no: 'AST-100002' }, user);
    await account.refreshAccount(r.caseId, { user });
    assert.equal(getCaseDetail(r.caseId, user).account.identity, 'contract_only');
    updateCase(r.caseId, { contract_no: 'AST-100001' }, user);
    await account.refreshAccount(r.caseId, { user });
    assert.equal(getCaseDetail(r.caseId, user).account.identity, 'contract_only', 'changing the contract cancels the confirmation: it has to be given again');
  });

  it('does not let a draft that was written for an unconfirmed sender be approved with gaps left in it', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'sys-gap', subject: 'Invoice please', from: { name: 'Omar Ali', email: 'omar@example.test' }, body: 'Please send me the invoice for contract AST-100001.' }));
    const c = getCaseDetail(r.caseId, user);
    const d = c.drafts.find((x) => x.status === 'pending');
    assert.ok(d, 'a draft exists');
    assert.equal(c.account.identity, 'contract_only');
    if (/\[\[/.test(d.body)) await assert.rejects(() => approveDraft(d.id, user, {}), /placeholders/);
    assert.ok(!/INV-1/.test(d.body), 'the invoice number of somebody else\'s contract is not in the reply');
  });

  it('opens the case anyway when a system is down, then fills it in by itself when the system is back', async () => {
    calm();
    api.state.down = true;
    const r = await ingestMessage(email({ providerId: 'sys-down', body: 'Hello, where is my deposit refund? Contract AST-100001.' }));
    assert.equal(r.action, 'created');
    let c = getCaseDetail(r.caseId, user);
    assert.equal(c.account.status, 'unavailable');
    assert.equal(c.account.will_retry, true);
    assert.equal(c.contract, null);
    assert.ok(c.insights.some((i) => /Customer details are not available yet/.test(i.title)));
    assert.ok(!c.insights.some((i) => /No contract found/.test(i.title)), 'it must not claim the contract does not exist');
    assert.ok(c.audit.some((a) => a.action === 'account_lookup_failed'));
    const downDraft = c.drafts.find((d) => d.status === 'pending');
    assert.ok(downDraft && !/1,000\.00/.test(downDraft.body));

    api.state.down = false;
    client.resetClient();
    db.prepare("UPDATE hd_case_accounts SET next_try_at = datetime('now', '-1 minute') WHERE case_id = ?").run(r.caseId);
    const out = await actions.retryPendingAccounts();
    assert.deepEqual([out.tried, out.fixed], [1, 1]);
    c = getCaseDetail(r.caseId, user);
    assert.equal(c.account.status, 'ok');
    assert.equal(c.account.will_retry, false);
    assert.equal(c.contract.contract_no, 'AST-100001');
    assert.ok(c.audit.some((a) => a.action === 'account_refreshed' && /retry/.test(a.detail)));
    assert.match(c.drafts.find((d) => d.status === 'pending').body, /AED 1,000\.00/, 'the untouched draft was rewritten with the facts that arrived');
    assert.equal((await actions.retryPendingAccounts()).tried, 0, 'nothing is left to retry');
  });

  it('raises the priority of a Gold customer once their details arrive after an outage, and never undoes a person\'s choice', async () => {
    const urgent = { subject: 'URGENT: a charge I do not recognise', body: 'This is urgent: there is a charge on my card that I do not recognise. Contract AST-100001.' };
    calm();
    api.state.down = true;
    const r = await ingestMessage(email({ providerId: 'sys-vip-1', ...urgent }));
    assert.equal(getCaseDetail(r.caseId, user).priority, 'Average', 'without the tier the case is Average');
    api.state.down = false;
    client.resetClient();
    db.prepare("UPDATE hd_case_accounts SET next_try_at = datetime('now', '-1 minute') WHERE case_id = ?").run(r.caseId);
    await actions.retryPendingAccounts();
    const c = getCaseDetail(r.caseId, user);
    assert.equal(c.priority, 'High');
    assert.ok(c.priority_reasons.some((x) => /Gold customer/.test(x)), JSON.stringify(c.priority_reasons));
    assert.ok(c.audit.some((a) => a.action === 'priority_set' && a.actor_type === 'system' && /customer details arrived/i.test(a.detail)));
    assert.notEqual(c.due_at, null);

    // a person who set the priority is not overruled
    calm();
    api.state.down = true;
    const p = await ingestMessage(email({ providerId: 'sys-vip-2', ...urgent }));
    updateCase(p.caseId, { priority: 'Low' }, user);
    api.state.down = false;
    client.resetClient();
    db.prepare("UPDATE hd_case_accounts SET next_try_at = datetime('now', '-1 minute') WHERE case_id = ?").run(p.caseId);
    await actions.retryPendingAccounts();
    assert.equal(getCaseDetail(p.caseId, user).priority, 'Low');
  });

  it('spaces its retries out and stops after twelve tries', async () => {
    calm();
    api.state.down = true;
    const r = await ingestMessage(email({ providerId: 'sys-giveup', body: 'Deposit refund please, contract AST-100001' }));
    const row = () => db.prepare('SELECT attempts, next_try_at FROM hd_case_accounts WHERE case_id = ?').get(r.caseId);
    assert.equal(row().attempts, 1);
    assert.ok(row().next_try_at);
    for (let i = 0; i < 11; i++) {
      client.resetClient();
      db.prepare("UPDATE hd_case_accounts SET next_try_at = datetime('now', '-1 minute') WHERE case_id = ?").run(r.caseId);
      await actions.retryPendingAccounts();
    }
    assert.equal(row().attempts, 12);
    assert.equal(row().next_try_at, null, 'the twelfth failure ends the automatic tries; Refresh still works');
    api.state.down = false;
    client.resetClient();
    const view = await account.refreshAccount(r.caseId, { user });
    assert.equal(view.status, 'ok');
    assert.equal(view.attempts, 0);
  });

  it('keeps the last good details when a refresh fails, and says so', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'sys-stale', body: 'Deposit refund, contract AST-100001' }));
    api.state.down = true;
    client.resetClient();
    const view = await account.refreshAccount(r.caseId, { user });
    assert.equal(view.status, 'ok', 'the stored details stay');
    assert.equal(view.stale, true);
    assert.equal(view.snapshot.contract.contract_no, 'AST-100001');
    const c = getCaseDetail(r.caseId, user);
    assert.ok(c.insights.some((i) => /Showing details from/.test(i.title)));
    api.state.down = false;
    client.resetClient();
    const ok = await account.refreshAccount(r.caseId, { user });
    assert.equal(ok.stale, false);
  });

  it('takes a contract number a person typed as final, and asks the systems about it', async () => {
    calm();
    const r = await ingestMessage(email({ providerId: 'sys-typed', body: 'Deposit refund please', subject: 'Deposit refund' }));
    let c = getCaseDetail(r.caseId, user);
    assert.equal(c.contract_inferred, 1, 'no number in the email: the sender\'s current rental was used');
    assert.equal(c.contract_no, 'AST-100002');
    updateCase(r.caseId, { contract_no: 'AST-100001' }, user);
    await account.refreshAccount(r.caseId, { user });
    c = getCaseDetail(r.caseId, user);
    assert.equal(c.contract_inferred, 0, 'no longer a guess');
    assert.equal(c.contract.contract_no, 'AST-100001');
    assert.equal(c.account.inferred, false);
  });

  it('learns the contract from a later reply on the same thread', async () => {
    calm();
    const first = await ingestMessage(email({ providerId: 'sys-thread-1', conversationId: 'zed-thread', from: { name: 'Zed', email: 'zed@nowhere.test' }, subject: 'Deposit refund', body: 'Where is my deposit refund?' }));
    assert.equal(first.action, 'created');
    assert.equal(getCaseDetail(first.caseId, user).contract, null);
    const second = await ingestMessage(email({ providerId: 'sys-thread-2', conversationId: 'zed-thread', from: { name: 'Zed', email: 'zed@nowhere.test' }, subject: 'Re: Deposit refund', body: 'Sorry, the contract is AST-100003.' }));
    assert.equal(second.action, 'attached');
    const c = getCaseDetail(first.caseId, user);
    assert.equal(c.contract_no, 'AST-100003');
    assert.equal(c.contract.contract_no, 'AST-100003');
    assert.equal(c.account.identity, 'contract_only', 'an unknown sender quoting somebody\'s contract number');
    const d = c.drafts.find((x) => x.status === 'pending');
    assert.match(d.notes, /not the customer on contract AST-100003/, 'the untouched draft was written again about the contract that is now on the case');
  });

  it('keeps old cases working: the CRM shows its own records when the connector is off', async () => {
    const keep = process.env.HELPDESK_ACCOUNT_SOURCE;
    process.env.HELPDESK_ACCOUNT_SOURCE = 'crm';
    try {
      const r = await ingestMessage(email({ providerId: 'sys-crm', subject: 'Deposit refund', body: 'Deposit refund for contract AST-100001', from: { name: 'Sara Khan', email: 'sara@example.test' } }));
      const c = getCaseDetail(r.caseId, user);
      assert.equal(c.account.source, 'crm');
      assert.equal(c.account.status, 'not_found', 'the CRM tables of this test database are empty');
    } finally { process.env.HELPDESK_ACCOUNT_SOURCE = keep; }
  });

  it('reports its own health for the setup page', async () => {
    const { systemsStatus, testLookup } = await import('../src/helpdesk/systems/status.js');
    calm();
    const st = systemsStatus();
    assert.equal(st.mode, 'api');
    assert.equal(st.config.ok, true);
    assert.deepEqual(st.sources.map((s) => [s.name, s.missing.length]), [['orion', 0], ['cnr', 0]]);
    assert.equal(st.lookups.filter((l) => l.configured).length, 7);
    assert.ok(st.cases.from_systems >= 1);
    assert.ok(!JSON.stringify(st).includes('orion-test-key'), 'no secret in the status');

    const t = await testLookup({ email: 'sara@example.test', contractNo: 'AST-100001', withRaw: true });
    assert.equal(t.snapshot.contract.contract_no, 'AST-100001');
    const contractStep = t.steps.find((s) => s.name === 'contract');
    assert.equal(contractStep.raw.data.contractNumber, 'AST-100001', 'IT can see the untouched answer');
    assert.match(contractStep.url, /\/contracts\/AST-100001$/);
    const plain = await testLookup({ email: 'sara@example.test', contractNo: 'AST-100001' });
    assert.ok(plain.steps.every((s) => s.raw === undefined));
    await assert.rejects(() => testLookup({}), /Enter an email address/);
  });
});
