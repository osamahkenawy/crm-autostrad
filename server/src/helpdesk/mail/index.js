// Picks the mailbox connector from settings and runs a sync: fetch new mail, turn it into cases.
import { audit } from '../audit.js';
import { ingestMessage } from '../pipeline.js';
import { getSettings, getState, setState } from '../settings.js';
import { demoProvider } from './demo.js';
import { graphProvider } from './graph.js';

export const getProvider = () => (getSettings().provider === 'graph' ? graphProvider : demoProvider);

let running = null;

/** One sync pass. Safe to call from the scheduler and the "Sync now" button at the same time. */
export function syncMailbox() {
  if (running) return running;
  running = (async () => {
    const provider = getProvider();
    const result = { provider: provider.name, fetched: 0, created: 0, attached: 0, split: 0, outbound: 0, ignored: 0, duplicates: 0, errors: [], items: [] };
    try {
      const { messages, commit } = await provider.fetchNew();
      result.fetched = messages.length;
      messages.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
      for (const msg of messages) {
        try {
          const r = await ingestMessage(msg, { provider });
          const key = { created: 'created', attached: 'attached', split: 'split', outbound: 'outbound', duplicate: 'duplicates' }[r.action] || 'ignored';
          result[key]++;
          if (r.caseId) result.items.push({ providerId: msg.providerId, action: r.action, caseId: r.caseId, caseNo: r.caseNo });
        } catch (e) {
          result.errors.push(`${msg.subject || msg.providerId}: ${e.message}`);
          console.error('[helpdesk] ingest failed:', e);
        }
      }
      if (!result.errors.length) commit();
      setState('last_sync_at', new Date().toISOString());
      if (!result.errors.length) setState('last_sync_ok_at', new Date().toISOString());
      setState('last_sync_result', JSON.stringify({ ...result, items: undefined }));
      if (result.created || result.attached || result.outbound) audit({ actor: 'system', action: 'mailbox_synced', detail: `${provider.name}: ${result.created} new, ${result.attached} follow-up, ${result.outbound} sent` });
    } catch (e) {
      result.errors.push(e.message);
      setState('last_sync_at', new Date().toISOString());
      setState('last_sync_result', JSON.stringify(result));
      console.error('[helpdesk] mailbox sync failed:', e.message);
    }
    return result;
  })().finally(() => { running = null; });
  return running;
}

export const lastSync = () => ({ at: getState('last_sync_at'), ok_at: getState('last_sync_ok_at'), result: (() => { try { return JSON.parse(getState('last_sync_result') || 'null'); } catch { return null; } })() });
