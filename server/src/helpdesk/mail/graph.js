// Microsoft 365 / Outlook shared mailbox through Microsoft Graph (application permissions, client
// credentials). Reads the Inbox and Sent Items with delta queries, writes categories and a due-date flag
// back onto messages, saves reply drafts to the mailbox and (only when the admin allows it) sends them.
//
// Environment: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET (kept on the server, never in the app).
// Graph application permissions needed: Mail.ReadWrite (read, tag, draft), Mail.Send (only for "send after
// approval"), MailboxSettings.ReadWrite (optional: creates the coloured category labels). Restrict the
// app to the helpdesk mailbox with an Exchange ApplicationAccessPolicy.
import { getSettings, getState, setState } from '../settings.js';
import { nowUtc } from '../routing.js';
import { CATEGORIES, DEPARTMENTS, PRIORITIES, STATUSES, SUBCATEGORIES } from '../taxonomy.js';

const base = () => (process.env.GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
const loginBase = () => (process.env.GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '');
export const graphConfigured = () => Boolean(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET);
export const missingGraphEnv = () => ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET'].filter((k) => !process.env[k]);

let tokenCache = { token: null, exp: 0 };

async function token() {
  if (tokenCache.token && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({ client_id: process.env.GRAPH_CLIENT_ID, client_secret: process.env.GRAPH_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const res = await fetch(`${loginBase()}/${encodeURIComponent(process.env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`, { method: 'POST', body, signal: AbortSignal.timeout(20_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Microsoft sign-in failed: ${j.error_description ? String(j.error_description).split('\r')[0] : res.status}`);
  tokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
  return tokenCache.token;
}

/** Call Graph. `url` is a path under /users/... or an absolute @odata link. Retries throttling (429/503). */
async function call(url, { method = 'GET', body, headers = {}, expect = [200] } = {}) {
  const target = /^https?:/i.test(url) ? url : `${base()}${url}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(target, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await new Promise((r) => setTimeout(r, Math.min(20, Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000));
      continue;
    }
    const text = await res.text();
    const j = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
    if (!expect.includes(res.status)) {
      const err = new Error((j.error && (j.error.message || j.error.code)) || `Graph returned ${res.status}`);
      err.status = res.status;
      err.code = j.error && j.error.code;
      throw err;
    }
    return j;
  }
  throw new Error('Graph is throttling requests. Try again shortly.');
}

const mb = () => `/users/${encodeURIComponent(getSettings().mailbox)}`;
const utc = (s) => (s ? String(s).replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '').slice(0, 19) : nowUtc());
const SELECT = 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,hasAttachments,isDraft,webLink';

function mapMessage(m, folder, mailbox) {
  const from = (m.from && m.from.emailAddress) || {};
  const fromEmail = String(from.address || '').toLowerCase();
  return {
    providerId: m.id,
    internetId: m.internetMessageId,
    conversationId: m.conversationId,
    direction: folder === 'sentitems' || fromEmail === mailbox.toLowerCase() ? 'out' : 'in',
    from: { name: from.name || '', email: fromEmail },
    to: (m.toRecipients || []).map((r) => r.emailAddress && r.emailAddress.address).filter(Boolean),
    cc: (m.ccRecipients || []).map((r) => r.emailAddress && r.emailAddress.address).filter(Boolean),
    subject: m.subject || '',
    body: (m.body && m.body.content) || m.bodyPreview || '',
    receivedAt: utc(m.receivedDateTime),
    attachments: m.hasAttachments ? [{ name: 'attachment', note: 'Open the message in Outlook to see attachments' }] : [],
    webLink: m.webLink || null,
  };
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text, language) => `<div${language === 'ar' ? ' dir="rtl" style="text-align:right"' : ''}>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;

let categoriesEnsured = false;
const OWN_PREFIX = /^(CH: |Priority: |Status: |Dept: |Owner: |CS-\d)/;
const labelSet = () => [
  ...CATEGORIES.map((c) => `CH: ${c}`), ...SUBCATEGORIES.map((s) => `CH: ${s.name}`),
  ...PRIORITIES.map((p) => `Priority: ${p}`), ...STATUSES.map((st) => `Status: ${st.replace('_', ' ')}`), ...DEPARTMENTS.map((d) => `Dept: ${d}`),
];
const CATEGORY_COLORS = { 'CH: ': 'preset7', 'Priority: Critical': 'preset0', 'Priority: High': 'preset1', 'Priority: Average': 'preset3', 'Priority: Low': 'preset5', 'Status: ': 'preset8', 'Dept: ': 'preset10', 'Owner: ': 'preset12', 'CS-': 'preset14' };
const colourFor = (name) => Object.entries(CATEGORY_COLORS).find(([k]) => name.startsWith(k))?.[1] || 'preset9';

async function ensureMasterCategories(names) {
  try {
    const existing = await call(`${mb()}/outlook/masterCategories`);
    const have = new Set((existing.value || []).map((c) => c.displayName));
    for (const name of names) {
      if (/^CS-\d/.test(name)) continue; // one label per case would flood the category list
      if (!have.has(name)) await call(`${mb()}/outlook/masterCategories`, { method: 'POST', body: { displayName: name, color: colourFor(name) }, expect: [201] }).catch(() => {});
    }
  } catch { /* MailboxSettings permission not granted: categories still apply, just without colours */ }
}

export const graphProvider = {
  name: 'graph',

  async status() {
    const mailbox = getSettings().mailbox;
    if (!graphConfigured()) return { connected: false, label: 'Microsoft 365', mailbox, detail: `Missing on the server: ${missingGraphEnv().join(', ')}. See the setup steps below.` };
    try {
      const f = await call(`${mb()}/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount`);
      return { connected: true, label: 'Microsoft 365', mailbox, inbox: { total: f.totalItemCount, unread: f.unreadItemCount }, detail: 'Connected to the shared mailbox.' };
    } catch (e) {
      const hint = e.status === 403 ? ' The app is not allowed to read this mailbox (admin consent or an Exchange application access policy is missing).' : e.status === 404 ? ' The mailbox was not found.' : '';
      return { connected: false, label: 'Microsoft 365', mailbox, detail: `${e.message}.${hint}` };
    }
  },

  /** New and changed messages since the last sync (delta queries on Inbox and Sent Items). */
  async fetchNew() {
    const settings = getSettings();
    const mailbox = settings.mailbox;
    const messages = [];
    const pendingLinks = {};
    for (const folder of ['inbox', 'sentitems']) {
      const key = `graph_delta_${folder}`;
      let url = getState(key);
      if (!url) {
        const since = new Date(Date.now() - 14 * 86400000).toISOString();
        url = `${mb()}/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
      }
      let pages = 0;
      let restarted = false;
      while (url && pages++ < 40) {
        let j;
        try {
          j = await call(url, { headers: { Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50' } });
        } catch (e) {
          // the saved delta link expired (410 / SyncStateNotFound): forget it and read the last 14 days again
          if (!restarted && (e.status === 410 || /syncstate/i.test(e.code || ''))) {
            restarted = true;
            setState(key, null);
            const since = new Date(Date.now() - 14 * 86400000).toISOString();
            url = `${mb()}/mailFolders/${folder}/messages/delta?$select=${SELECT}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
            continue;
          }
          throw e;
        }
        for (const m of j.value || []) if (!m['@removed'] && !m.isDraft) messages.push(mapMessage(m, folder, mailbox));
        if (j['@odata.nextLink']) url = j['@odata.nextLink'];
        else { pendingLinks[key] = j['@odata.deltaLink'] || null; url = null; }
      }
    }
    return { messages, commit: () => { for (const [k, v] of Object.entries(pendingLinks)) if (v) setState(k, v); } };
  },

  /** Categories and a flag whose due date is the case due date. */
  async applyTracking({ providerId, categories, dueAt, closed }) {
    if (!providerId || /^(demo|crm)-/.test(providerId)) return false;
    if (!categoriesEnsured) { categoriesEnsured = true; await ensureMasterCategories(labelSet()); }
    // keep any category a person added by hand; only replace the ones this module manages
    let kept = [];
    try {
      const cur = await call(`${mb()}/messages/${encodeURIComponent(providerId)}?$select=categories`);
      kept = (cur.categories || []).filter((c) => !OWN_PREFIX.test(c));
    } catch { /* the message may have been moved or deleted: tagging below will report it */ }
    const flag = closed || !dueAt
      ? { flagStatus: closed ? 'complete' : 'notFlagged' }
      : { flagStatus: 'flagged', startDateTime: { dateTime: nowUtc().replace(' ', 'T'), timeZone: 'UTC' }, dueDateTime: { dateTime: dueAt.replace(' ', 'T'), timeZone: 'UTC' } };
    await call(`${mb()}/messages/${encodeURIComponent(providerId)}`, { method: 'PATCH', body: { categories: [...kept, ...categories], flag } });
    return true;
  },

  /** A reply draft in the mailbox Drafts folder (threaded under the customer's message). */
  async createDraft({ draft, replyTo }) {
    const html = toHtml(draft.body, draft.language);
    if (replyTo && replyTo.provider_id && !/^(demo|crm)-/.test(replyTo.provider_id)) {
      const created = await call(`${mb()}/messages/${encodeURIComponent(replyTo.provider_id)}/createReply`, { method: 'POST', body: {}, expect: [201] });
      const full = await call(`${mb()}/messages/${encodeURIComponent(created.id)}?$select=body`);
      // createReply addresses the sender (or the Reply-To) of the message it answers: the recipient is set explicitly, to the address the reply was approved for
      await call(`${mb()}/messages/${encodeURIComponent(created.id)}`, {
        method: 'PATCH', body: { toRecipients: [{ emailAddress: { address: draft.to_email } }], ccRecipients: [], body: { contentType: 'html', content: `${html}<br>${(full.body && full.body.content) || ''}` } },
      });
      return { providerId: created.id, webLink: created.webLink || null };
    }
    const created = await call(`${mb()}/messages`, {
      method: 'POST', expect: [201],
      body: { subject: draft.subject, body: { contentType: 'html', content: html }, toRecipients: [{ emailAddress: { address: draft.to_email } }] },
    });
    return { providerId: created.id, webLink: created.webLink || null };
  },

  /** Only used when the admin chose "send after approval". */
  async sendReply({ case: c, draft, replyTo }) {
    const created = await this.createDraft({ draft, replyTo });
    await call(`${mb()}/messages/${encodeURIComponent(created.providerId)}/send`, { method: 'POST', expect: [202] });
    return { providerId: `crm-${draft.id}`, conversationId: c.conversation_id, sentAt: nowUtc(), webLink: created.webLink };
  },
};
