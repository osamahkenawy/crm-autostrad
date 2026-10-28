// Table configs for the helpdesk setup screens (reply wording, keywords, routing, hand-entered channel counts).
// Built from the lookup lists because the request-type names come from the server.
import { Ban, Check } from 'lucide-react';
import { Pill } from '../components/ui';
import { fmtDate } from '../lib/format';
import { PriorityPill, sentence } from './shared';

const LANGUAGE = [{ value: 'en', label: 'English' }, { value: 'ar', label: 'Arabic' }];
const KIND = [{ value: 'initial', label: 'First reply' }, { value: 'followup', label: 'Reminder' }];
const ACTIVE = [{ value: 1, label: 'On' }, { value: 0, label: 'Off' }];

export function buildConfigs(meta) {
  const types = meta.subcategories.map((s) => ({ value: s.key, label: s.name }));
  const typeName = (k) => (k === '*' ? 'Any other request' : (types.find((t) => t.value === k) || {}).label || k);
  const typeCol = { key: 'sub_key', label: 'Request type', sortable: true, render: (r) => typeName(r.sub_key), export: (r) => typeName(r.sub_key) };

  const templates = {
    resource: 'helpdesk/templates',
    editCap: 'helpdesk.rules',
    title: 'Reply wording',
    subtitle: 'The approved wording the AI fills in for each request type. Only approved templates are ever used in a reply. Change the words, then approve them again.',
    singular: 'reply template',
    plural: 'reply templates',
    searchPlaceholder: 'Search the name or the wording...',
    defaultSort: { key: 'sub_key', dir: 'asc' },
    tabs: { field: 'approved', all: 'All', options: [{ value: '0', label: 'Waiting for approval' }, { value: '1', label: 'Approved' }] },
    filters: [
      { key: 'sub_key', label: 'Request', options: [...types, { value: '*', label: 'Any other request' }] },
      { key: 'language', label: 'Language', options: LANGUAGE },
      { key: 'kind', label: 'Kind', options: KIND },
    ],
    columns: [
      { key: 'name', label: 'Template', sortable: true, render: (r) => (<div style={{ maxWidth: 340 }}><div className="cell-main ellipsis" dir="auto">{r.name}</div><div className="cell-sub ellipsis">{r.note || ''}</div></div>), export: (r) => r.name },
      typeCol,
      { key: 'kind', label: 'Kind', render: (r) => (r.kind === 'followup' ? 'Reminder' : 'First reply'), export: (r) => r.kind },
      { key: 'language', label: 'Language', render: (r) => (r.language === 'ar' ? 'Arabic' : 'English'), export: (r) => r.language },
      { key: 'approved', label: 'Status', sortable: true, render: (r) => (!r.active ? <Pill tone="neutral">Off</Pill> : r.approved ? <Pill tone="ok">Approved</Pill> : <Pill tone="warn">Waiting for approval</Pill>), export: (r) => (r.approved ? 'approved' : 'not approved') },
      { key: 'updated_at', label: 'Changed', sortable: true, render: (r) => fmtDate(r.updated_at), export: (r) => r.updated_at },
    ],
    recordTitle: (r) => r.name,
    recordSubtitle: (r) => `${typeName(r.sub_key)}, ${r.kind === 'followup' ? 'reminder' : 'first reply'}, ${r.language === 'ar' ? 'Arabic' : 'English'}`,
    badges: (r) => (<>{r.approved ? <Pill tone="ok">Approved</Pill> : <Pill tone="warn">Waiting for approval</Pill>}{!r.active ? <Pill tone="neutral">Off</Pill> : null}</>),
    highlights: (r) => (
      <>
        {!r.approved ? <div className="hd-banner warn"><div className="grow">This wording is not used in replies until an admin or IT user approves it.</div></div> : null}
        <div className="hd-panel"><header><h4>The wording</h4></header><div className="body"><div className="hd-body" dir="auto">{r.subject ? <b>{r.subject}{'\n\n'}</b> : null}{r.body}</div></div></div>
      </>
    ),
    actions: () => [
      { key: 'approve', label: 'Approve this wording', short: 'Approve', icon: Check, tone: 'primary', when: (x) => !x.approved, patch: () => ({ approved: 1 }), confirm: 'From now on replies for this request type use exactly this wording.', success: 'Approved' },
      { key: 'withdraw', label: 'Withdraw approval', short: 'Withdraw', icon: Ban, tone: 'soft', when: (x) => x.approved === 1, patch: () => ({ approved: 0 }), confirm: 'Replies will stop using this wording until it is approved again.', success: 'Approval withdrawn' },
    ],
    form: {
      defaults: () => ({ kind: 'initial', language: 'en', active: 1 }),
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true, span: 2 },
        { key: 'sub_key', label: 'Request type', type: 'select', required: true, options: [...types, { value: '*', label: 'Any other request (fallback)' }] },
        { key: 'kind', label: 'Kind', type: 'select', required: true, options: KIND },
        { key: 'language', label: 'Language', type: 'select', required: true, options: LANGUAGE },
        { key: 'active', label: 'Use it', type: 'select', required: true, options: ACTIVE },
        { key: 'subject', label: 'Subject (optional)', type: 'text', span: 2, hint: 'Leave empty to reply on the customer\'s own subject line.' },
        {
          key: 'body', label: 'Wording', type: 'textarea', rows: 14, required: true, span: 2, hideInView: true,
          hint: `Placeholders: ${meta.template_variables.map((v) => `{{${v}}}`).join(' ')}. Show a line only when a detail is known: {{#contract_no}}...{{/contract_no}}.`,
        },
        { key: 'note', label: 'Internal note', type: 'text', span: 2, hint: 'Not sent to anyone. Saving new wording takes the approval away until it is approved again.' },
      ],
    },
  };

  const keywords = {
    resource: 'helpdesk/keywords',
    editCap: 'helpdesk.rules',
    title: 'Keywords',
    subtitle: 'Phrases that point an email at a request type, in English and Arabic. The AI lab can add phrases from staff corrections.',
    singular: 'keyword',
    plural: 'keywords',
    searchPlaceholder: 'Search phrases...',
    defaultSort: { key: 'sub_key', dir: 'asc' },
    filters: [
      { key: 'sub_key', label: 'Request', options: types },
      { key: 'language', label: 'Language', options: LANGUAGE },
      { key: 'source', label: 'Added by', options: [{ value: 'default', label: 'Starter list' }] },
    ],
    columns: [
      { key: 'term', label: 'Phrase', sortable: true, render: (r) => <span className="strong" dir="auto">{r.term}</span> },
      typeCol,
      { key: 'language', label: 'Language', render: (r) => (r.language === 'ar' ? 'Arabic' : 'English') },
      { key: 'weight', label: 'Strength', sortable: true, render: (r) => `${r.weight} of 5` },
      { key: 'kind', label: 'Kind', render: (r) => (r.kind === 'regex' ? 'Pattern' : 'Phrase') },
      { key: 'source', label: 'Added by', render: (r) => (r.source === 'default' ? 'Starter list' : r.source) },
      { key: 'active', label: 'On', render: (r) => (r.active ? <Pill tone="ok" dot={false}>On</Pill> : <Pill tone="neutral" dot={false}>Off</Pill>) },
    ],
    recordTitle: (r) => r.term,
    recordSubtitle: (r) => typeName(r.sub_key),
    form: {
      defaults: () => ({ language: 'en', weight: 4, kind: 'phrase', active: 1 }),
      fields: [
        { key: 'term', label: 'Phrase', type: 'text', required: true, span: 2, hint: 'How customers write it. Short and specific works best. A pattern is a regular expression.' },
        { key: 'sub_key', label: 'Request type', type: 'select', required: true, options: types, span: 2 },
        { key: 'language', label: 'Language', type: 'select', required: true, options: LANGUAGE },
        { key: 'weight', label: 'Strength', type: 'number', required: true, min: 1, max: 5, step: 1, hint: '5 means almost always this type, 1 is a weak hint.' },
        { key: 'kind', label: 'Kind', type: 'select', required: true, options: [{ value: 'phrase', label: 'Phrase' }, { value: 'regex', label: 'Pattern (regular expression)' }] },
        { key: 'active', label: 'Use it', type: 'select', required: true, options: ACTIVE },
      ],
    },
  };

  const routing = {
    resource: 'helpdesk/routing',
    editCap: 'helpdesk.rules',
    title: 'Routing',
    subtitle: 'Which team handles each request type. A case goes to the least busy person in that team, or to the named person if you pick one.',
    singular: 'routing rule',
    plural: 'routing rules',
    searchPlaceholder: 'Search...',
    defaultSort: { key: 'sub_key', dir: 'asc' },
    filters: [{ key: 'department', label: 'Team', options: meta.departments }],
    columns: [
      typeCol,
      { key: 'department', label: 'Team', sortable: true },
      { key: 'owner_name', label: 'Always to', render: (r) => r.owner_name || <span className="faint">Least busy in the team</span> },
      { key: 'active', label: 'On', render: (r) => (r.active ? <Pill tone="ok" dot={false}>On</Pill> : <Pill tone="neutral" dot={false}>Off</Pill>) },
      { key: 'note', label: 'Note' },
    ],
    recordTitle: (r) => typeName(r.sub_key),
    recordSubtitle: (r) => r.department,
    form: {
      defaults: () => ({ active: 1 }),
      fields: [
        { key: 'sub_key', label: 'Request type', type: 'select', required: true, options: types, span: 2 },
        { key: 'department', label: 'Team', type: 'select', required: true, options: meta.departments },
        { key: 'owner_id', label: 'Always to this person (optional)', type: 'select', options: meta.people.map((p) => ({ value: p.id, label: p.name })) },
        { key: 'active', label: 'Use it', type: 'select', required: true, options: ACTIVE },
        { key: 'note', label: 'Note', type: 'text', span: 2 },
      ],
    },
  };

  const channels = {
    resource: 'helpdesk/channels',
    editCap: 'helpdesk.rules',
    title: 'Other channels',
    subtitle: 'WhatsApp and phone calls are not connected to the helpdesk. Type in the daily count here so the dashboard split stays honest.',
    singular: 'daily count',
    plural: 'daily counts',
    searchPlaceholder: 'Search...',
    defaultSort: { key: 'day', dir: 'desc' },
    filters: [{ key: 'channel', label: 'Channel', options: [{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'calls', label: 'Calls' }] }],
    columns: [
      { key: 'day', label: 'Day', sortable: true, render: (r) => fmtDate(r.day), export: (r) => r.day },
      { key: 'channel', label: 'Channel', render: (r) => (r.channel === 'whatsapp' ? 'WhatsApp' : r.channel === 'calls' ? 'Calls' : sentence(r.channel)) },
      { key: 'count', label: 'Requests', sortable: true },
      { key: 'note', label: 'Note' },
    ],
    recordTitle: (r) => `${r.channel === 'whatsapp' ? 'WhatsApp' : 'Calls'}, ${fmtDate(r.day)}`,
    recordSubtitle: (r) => `${r.count} requests`,
    addLabel: 'Add a count',
    form: {
      defaults: () => ({ channel: 'whatsapp', count: 0 }),
      fields: [
        { key: 'day', label: 'Day', type: 'date', required: true },
        { key: 'channel', label: 'Channel', type: 'select', required: true, options: [{ value: 'whatsapp', label: 'WhatsApp' }, { value: 'calls', label: 'Calls' }] },
        { key: 'count', label: 'Customer requests that day', type: 'number', required: true, min: 0, step: 1 },
        { key: 'note', label: 'Note', type: 'text' },
      ],
    },
  };

  return { templates, keywords, routing, channels };
}
