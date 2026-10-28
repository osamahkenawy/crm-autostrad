// "Test the connection": walks through what the Outlook link needs, one step at a time, and says which step fails and how to fix
// it. Read-only: it signs in and reads, it never writes to the mailbox.
import { getSettings } from '../settings.js';
import { graphConfigured, missingGraphEnv } from './graph.js';

const base = () => (process.env.GRAPH_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
const loginBase = () => (process.env.GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/+$/, '');

async function signIn() {
  const body = new URLSearchParams({ client_id: process.env.GRAPH_CLIENT_ID, client_secret: process.env.GRAPH_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' });
  const res = await fetch(`${loginBase()}/${encodeURIComponent(process.env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`, { method: 'POST', body, signal: AbortSignal.timeout(20_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(j.error_description ? String(j.error_description).split('\r')[0] : `Microsoft answered ${res.status}`);
  return j.access_token;
}

async function read(path, token) {
  try {
    const res = await fetch(`${base()}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, message: (json.error && (json.error.message || json.error.code)) || `Graph answered ${res.status}` };
  } catch (e) {
    return { status: 0, json: {}, message: `Could not reach Microsoft Graph: ${e.message}` };
  }
}

/** -> [{ key, ok, optional?, title, detail, fix? }] stopping at the first step that blocks everything after it. */
export async function diagnoseGraph() {
  const mailbox = getSettings().mailbox;
  const steps = [];
  const add = (key, ok, title, detail, fix, optional = false) => steps.push({ key, ok, title, detail, ...(fix ? { fix } : {}), ...(optional ? { optional: true } : {}) });

  if (!graphConfigured()) {
    add('env', false, 'Credentials on the server', `Missing: ${missingGraphEnv().join(', ')}.`, 'Add them to server/.env (see the lines further down this page) and restart the server.');
    return steps;
  }
  add('env', true, 'Credentials on the server', 'Tenant, client ID and secret are set.');

  let token;
  try {
    token = await signIn();
    add('token', true, 'Signing in to Microsoft', 'The app registration accepted the secret.');
  } catch (e) {
    add('token', false, 'Signing in to Microsoft', e.message, 'Check the tenant ID and client ID, and that the secret VALUE (not the secret ID) was copied and has not expired.');
    return steps;
  }

  const mb = `/users/${encodeURIComponent(mailbox)}`;
  const inbox = await read(`${mb}/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount`, token);
  if (inbox.status === 200) add('inbox', true, `Reading the Inbox of ${mailbox}`, `${inbox.json.totalItemCount} messages, ${inbox.json.unreadItemCount} unread.`);
  else {
    add('inbox', false, `Reading the Inbox of ${mailbox}`, inbox.message,
      inbox.status === 403 ? 'The app may not read this mailbox: grant admin consent for Mail.ReadWrite, and check that the Exchange application access policy (or RBAC scope) includes this mailbox.'
        : inbox.status === 404 ? 'The mailbox was not found: check HELPDESK_MAILBOX and that it is a real mailbox or shared mailbox.' : 'See the message above.');
    return steps;
  }

  const sent = await read(`${mb}/mailFolders/sentitems?$select=totalItemCount`, token);
  add('sent', sent.status === 200, 'Reading Sent Items', sent.status === 200 ? `${sent.json.totalItemCount} messages. Replies sent from Outlook are matched to their case.` : sent.message, sent.status === 200 ? undefined : 'Without Sent Items, replies written in Outlook will not show up in the case.');

  const probe = await read(`${mb}/mailFolders/inbox/messages?$top=1&$select=subject,receivedDateTime`, token);
  add('messages', probe.status === 200, 'Reading a message', probe.status === 200 ? (probe.json.value && probe.json.value.length ? `Latest message received ${String(probe.json.value[0].receivedDateTime).slice(0, 16).replace('T', ' ')}.` : 'The Inbox is empty.') : probe.message, probe.status === 200 ? undefined : 'Mail.ReadWrite is needed to read messages.');

  const cats = await read(`${mb}/outlook/masterCategories`, token);
  add('categories', cats.status === 200, 'Colour labels (optional)', cats.status === 200 ? 'The coloured category labels can be created.' : 'Not allowed. Cases are still tagged in Outlook, just without colours.', cats.status === 200 ? undefined : 'Add the MailboxSettings.ReadWrite permission if you want the coloured labels.', true);
  return steps;
}
