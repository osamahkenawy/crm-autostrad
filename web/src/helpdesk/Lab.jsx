// AI lab: try an email, measure the classifier on labelled emails, and teach it from what staff corrected.
// Nothing here creates cases or sends mail. For admin and IT users.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BookPlus, FileUp, FlaskConical, Play, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../toast';
import { Button, Card, EmptyState, PageHeader, Pill, Tabs } from '../components/ui';
import { ConfirmDialog, Modal } from '../components/Modal';
import { fmtDateTime, relTime } from '../lib/format';
import { Confidence, ENGINE_LABEL, PRIORITIES, PriorityPill, sentence, useMeta } from './shared';

const isArabic = (s) => /[؀-ۿ]/.test(s || '');
const nameOf = (meta, key) => (meta && (meta.subcategories.find((s) => s.key === key) || {}).name) || sentence(key);
const ENGINE_NAME = { rules: 'keyword rules only', smart: 'smart engine', ai: 'smart engine and AI' };
const SOURCE = { 'built-in': 'Tuning sample', independent: 'Independent', imported: 'Imported, for measuring', 'imported-train': 'Imported, for training', added: 'Added', override: 'From a correction' };

/* ------------------------------------ add a keyword ------------------------------------ */
function KeywordModal({ open, onClose, meta, initial, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ sub_key: '', term: '', weight: 4 });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF({ sub_key: initial?.sub_key || '', term: initial?.term || '', weight: 4 }); }, [open, initial]);
  const save = async () => {
    if (!f.sub_key || f.term.trim().length < 2) { toast.error('Choose the request type and type the phrase.'); return; }
    setBusy(true);
    try {
      await api.post('/helpdesk/keywords', { sub_key: f.sub_key, term: f.term.trim(), weight: Number(f.weight), language: isArabic(f.term) ? 'ar' : 'en', kind: 'phrase', active: 1 });
      toast.success('Keyword added. New emails use it straight away.');
      onSaved?.();
      onClose();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Teach it a phrase" subtitle="When an email contains this phrase, it counts towards the chosen request type." size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Add keyword</Button></>}>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <div className="field"><label htmlFor="k-type">Request type</label>
          <select id="k-type" className="select" value={f.sub_key} onChange={(e) => setF({ ...f, sub_key: e.target.value })}><option value="">Choose...</option>{meta ? meta.subcategories.map((s) => <option key={s.key} value={s.key}>{s.name}</option>) : null}</select></div>
        <div className="field"><label htmlFor="k-term">Phrase</label><input id="k-term" className="input" dir="auto" value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} placeholder="how customers write it, for example: strange amount" />
          <span className="hint">A short, specific phrase works best. Single common words match too much.</span></div>
        <div className="field"><label htmlFor="k-w">How strong a signal is it?</label>
          <select id="k-w" className="select" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })}><option value={5}>5, almost always this type</option><option value={4}>4, strong</option><option value={3}>3, moderate</option><option value={2}>2, weak hint</option></select></div>
      </div>
    </Modal>
  );
}

/* ------------------------------------ try one email ------------------------------------ */
function TryIt({ meta, aiAvailable }) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [tests, setTests] = useState([]);
  const [teach, setTeach] = useState(null);
  useEffect(() => { api.get('/helpdesk/lab/tests').then((r) => setTests(r.data)).catch(() => {}); }, []);

  const run = async () => {
    setBusy(true);
    try { setRes(await api.post('/helpdesk/lab/classify', { subject, body, ai })); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const e = res && res.entities;
  return (
    <div className="hd-grid c2" style={{ alignItems: 'start' }}>
      <Card title="Paste an email" sub="It is analysed here and not stored. No case is created.">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div className="field">
            <label htmlFor="t-pick">Or start from a test email</label>
            <select id="t-pick" className="select" value="" onChange={(ev) => { const t = tests.find((x) => String(x.id) === ev.target.value); if (t) { setSubject(t.subject || ''); setBody(t.body); setRes(null); } }}>
              <option value="">Pick one...</option>
              {tests.map((t) => <option key={t.id} value={t.id}>{(t.subject || t.body).slice(0, 60)}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="t-sub">Subject</label><input id="t-sub" className="input" dir="auto" value={subject} onChange={(ev) => setSubject(ev.target.value)} /></div>
          <div className="field"><label htmlFor="t-body">Message</label><textarea id="t-body" className="textarea" rows={9} dir="auto" value={body} onChange={(ev) => setBody(ev.target.value)} /></div>
          <label className="row" style={{ gap: 8, fontWeight: 600, opacity: aiAvailable ? 1 : 0.55 }} title={aiAvailable ? '' : 'The AI layer is off. Add ANTHROPIC_API_KEY on the server to switch it on.'}>
            <input type="checkbox" checked={ai && aiAvailable} disabled={!aiAvailable} onChange={(ev) => setAi(ev.target.checked)} /> Also ask the AI (uses your Anthropic account, a few cents)
          </label>
        </div>
        <div className="hd-actions" style={{ marginTop: 14 }}><Button variant="primary" icon={Play} loading={busy} disabled={!subject.trim() && !body.trim()} onClick={run}>Analyse</Button></div>
      </Card>

      <Card title="What the system makes of it">
        {!res ? <EmptyState icon={FlaskConical} title="Nothing analysed yet" text="Paste an email on the left, or pick a test email, then press Analyse." /> : (
          <div className="hd-result">
            <div>
              <div className="row between wrap" style={{ gap: 10 }}>
                <div><div className="hd-big" style={{ fontSize: 24 }}>{res.sub_category}</div><div className="muted small">{res.category} · {res.department}{res.sensitive ? ' · sensitive financial request' : ''}</div></div>
                <PriorityPill value={res.priority} />
              </div>
              <div style={{ marginTop: 10 }}><Confidence value={res.confidence} engine={res.engine} /></div>
              <div className="hd-note" style={{ marginTop: 6 }}>
                {ENGINE_LABEL[res.engine] || res.engine}. {res.needs_review ? 'Below the confidence threshold: a real case would go to the "To check" queue for a person.' : 'Confident enough to be routed without a check.'}
                {res.ai_requested && !res.ai.used ? ' The AI was asked but did not answer (the keyword result is shown).' : ''}
              </div>
            </div>
            {res.ai.summary ? <div className="hd-banner info"><Sparkles size={18} /><div className="grow" dir="auto">{res.ai.summary}</div></div> : null}
            <div>
              <div className="section-title"><span>Closest request types (keyword score)</span></div>
              <table className="hd-table"><tbody>{res.rules.scores.length ? res.rules.scores.map((s) => <tr key={s.sub_key}><td>{nameOf(meta, s.sub_key)}</td><td className="num">{s.score}</td></tr>) : <tr><td className="hd-note">No keyword matched.</td></tr>}</tbody></table>
            </div>
            {res.learned ? (
              <div>
                <div className="section-title"><span>What the learned model thinks</span></div>
                <table className="hd-table"><tbody>{res.learned.top.map((t) => <tr key={t.sub_key}><td>{nameOf(meta, t.sub_key)}</td><td className="num">{Math.round(t.p * 100)}%</td></tr>)}</tbody></table>
                <p className="hd-note">It compares the wording with every email it has learned from. The final answer blends this with the keyword rules.</p>
              </div>
            ) : null}
            {res.rules.matched.length ? <div><div className="section-title"><span>Phrases it matched</span></div><div className="hd-chips">{res.rules.matched.map((m, i) => <span key={i} className="tag" dir="auto">{m.term}{m.where === 'subject' ? ' (subject)' : ''}</span>)}</div></div> : null}
            <div>
              <div className="section-title"><span>Details it found</span></div>
              <dl className="hd-kv">
                <div><dt>Contract</dt><dd>{e.contract_no || '-'}</dd></div><div><dt>Amount</dt><dd>{e.amount ? `AED ${e.amount}` : '-'}</dd></div>
                <div><dt>Card digits</dt><dd>{e.card_last4 || '-'}</dd></div><div><dt>Fine reference</dt><dd>{e.fine_ref || '-'}</dd></div>
                <div><dt>Location</dt><dd>{e.location || '-'}</dd></div><div><dt>Name</dt><dd>{e.customer_name || '-'}</dd></div>
              </dl>
            </div>
            <div><div className="section-title"><span>Why this priority</span></div><ul className="hd-reasons">{res.priority_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
            <div className="hd-actions"><Button icon={BookPlus} onClick={() => setTeach({ sub_key: res.sub_key, term: '' })}>It should be a different type: teach it</Button></div>
          </div>
        )}
      </Card>
      <KeywordModal open={Boolean(teach)} onClose={() => setTeach(null)} meta={meta} initial={teach} />
    </div>
  );
}

/* ------------------------------------ the test set ------------------------------------ */
function AddTest({ open, onClose, meta, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ subject: '', body: '', expected_sub_key: '', expected_priority: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF({ subject: '', body: '', expected_sub_key: '', expected_priority: '' }); }, [open]);
  const save = async () => {
    setBusy(true);
    try { await api.post('/helpdesk/lab/tests', { ...f, expected_priority: f.expected_priority || undefined }); toast.success('Test email added'); onSaved(); onClose(); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add a labelled email" subtitle="An email and the request type a person says it is." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Add</Button></>}>
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <div className="field"><label htmlFor="a-sub">Subject</label><input id="a-sub" className="input" dir="auto" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></div>
        <div className="field"><label htmlFor="a-body">Message <span className="req">*</span></label><textarea id="a-body" className="textarea" rows={7} dir="auto" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
        <div className="form-grid">
          <div className="field"><label htmlFor="a-type">Correct request type <span className="req">*</span></label><select id="a-type" className="select" value={f.expected_sub_key} onChange={(e) => setF({ ...f, expected_sub_key: e.target.value })}><option value="">Choose...</option>{meta ? meta.subcategories.map((s) => <option key={s.key} value={s.key}>{s.name}</option>) : null}</select></div>
          <div className="field"><label htmlFor="a-pri">Correct priority (optional)</label><select id="a-pri" className="select" value={f.expected_priority} onChange={(e) => setF({ ...f, expected_priority: e.target.value })}><option value="">Do not check</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></div>
        </div>
      </div>
    </Modal>
  );
}

function ImportCsv({ open, onClose, onSaved }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [mode, setMode] = useState('split');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const file = useRef(null);
  useEffect(() => { if (open) { setCsv(''); setOut(null); setMode('split'); } }, [open]); // always start from the recommended split, never from the last import's choice
  const readFile = (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) f.text().then(setCsv); };
  const go = async () => {
    setBusy(true);
    try { const r = await api.post('/helpdesk/lab/tests/import', { csv, mode }); setOut(r); if (r.added) { toast.success(`${r.added} labelled emails imported`); onSaved(); } } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Import labelled emails" subtitle="Real emails that people have already classified are the best way to measure accuracy."
      footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" loading={busy} disabled={!csv.trim()} onClick={go}>Import</Button></>}>
      <div className="hd-stack" style={{ gap: 12 }}>
        <p className="hd-note">A CSV with a header row and these columns: <span className="hd-code">subject</span>, <span className="hd-code">body</span> (the email text), <span className="hd-code">expected</span> (the correct request type name, for example Invoice Request), and optionally <span className="hd-code">priority</span>. Remove customer details you do not need before importing.</p>
        <div className="field"><label htmlFor="imp-mode">What are they for?</label>
          <select id="imp-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="split">Half to measure accuracy, half to teach the model (recommended)</option>
            <option value="measure">All to measure accuracy: the model never learns from them</option>
            <option value="train">All to teach the model</option>
          </select>
          <span className="hint">Emails the model learns from cannot also measure it fairly, so keep some aside.</span></div>
        <div className="hd-actions"><Button icon={FileUp} onClick={() => file.current && file.current.click()}>Choose a CSV file</Button><input ref={file} type="file" accept=".csv,text/csv" hidden onChange={readFile} /></div>
        <textarea className="textarea" rows={8} placeholder="...or paste the CSV here" value={csv} onChange={(e) => setCsv(e.target.value)} dir="auto" />
        {out ? <div className={`hd-banner ${out.skipped || (out.warnings && out.warnings.length) ? 'warn' : 'ok'}`}><div className="grow">{out.added} added, {out.skipped} skipped.{out.errors.length ? <ul className="hd-reasons">{out.errors.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}{out.warnings && out.warnings.length ? <ul className="hd-reasons">{out.warnings.map((x, i) => <li key={`w${i}`}>{x}</li>)}</ul> : null}</div></div> : null}
      </div>
    </Modal>
  );
}

function TestSet({ meta, aiAvailable }) {
  const toast = useToast();
  const [tests, setTests] = useState(null);
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [teach, setTeach] = useState(null);

  const loadTests = useCallback(() => api.get('/helpdesk/lab/tests').then((r) => setTests(r.data)).catch((e) => toast.error(e.message)), [toast]);
  const loadRuns = useCallback(() => api.get('/helpdesk/lab/runs').then((r) => { setRuns(r.data); return r.data; }).catch(() => []), []);
  useEffect(() => { loadTests(); loadRuns().then((r) => { if (r[0]) api.get(`/helpdesk/lab/runs/${r[0].id}`).then(setRun).catch(() => {}); }); }, [loadTests, loadRuns]);

  const [model, setModel] = useState(null);
  useEffect(() => { api.get('/helpdesk/lab/model').then(setModel).catch(() => {}); }, []);
  const retrain = async () => {
    setBusy('retrain');
    try { setModel(await api.post('/helpdesk/lab/model/retrain', {})); toast.success('Retrained from the latest keywords, samples and staff corrections'); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const doRun = async (engine) => {
    setBusy(engine);
    try { const r = await api.post('/helpdesk/lab/run', { engine }); setRun(r); loadRuns(); } catch (e) { toast.error(e.message); } finally { setBusy(''); }
  };
  const sources = useMemo(() => { const m = {}; (tests || []).forEach((t) => { m[t.source] = (m[t.source] || 0) + 1; }); return m; }, [tests]);

  return (
    <>
      <Card title="Labelled test emails" sub={tests ? `${tests.length} emails: ${Object.entries(sources).map(([k, n]) => `${n} ${SOURCE[k] || k}`).join(', ')}` : ''}
        action={<div className="row wrap" style={{ gap: 8 }}><Button size="sm" icon={Plus} onClick={() => setAdding(true)}>Add one</Button><Button size="sm" icon={FileUp} onClick={() => setImporting(true)}>Import CSV</Button><Button size="sm" icon={RotateCcw} onClick={() => setRestoring(true)}>Restore samples</Button></div>}>
        <div className="hd-banner info" style={{ marginBottom: 14 }}><AlertTriangle size={18} /><div className="grow">
          The <b>tuning samples</b> were used to write the keyword list and to train the learned model, so a high score on them proves little. The <b>independent</b> emails were written separately and are never trained on: watch that number. Both are made-up examples, not Autostrad's mail. Import real emails that staff have classified to measure properly.
        </div></div>
        <div className="hd-actions" style={{ marginBottom: 6 }}>
          <Button variant="primary" icon={Play} loading={busy === 'smart'} disabled={!tests || !tests.length} onClick={() => doRun('smart')}>Run: smart engine</Button>
          <Button icon={Play} loading={busy === 'rules'} disabled={!tests || !tests.length} title="Only the keyword list, without the learned model" onClick={() => doRun('rules')}>Keyword rules only</Button>
          <Button icon={Sparkles} loading={busy === 'ai'} disabled={!aiAvailable || !tests || !tests.length} title={aiAvailable ? 'Also asks the AI about each independent and imported email (one call each, a few dollars at most)' : 'The AI layer is off. Add ANTHROPIC_API_KEY on the server.'} onClick={() => doRun('ai')}>Smart engine and AI</Button>
          {!aiAvailable ? <span className="hd-note">The AI layer is not switched on, so it cannot be measured here.</span> : null}
        </div>
      </Card>

      <Card title="How the smart engine learns" className="hd-mt"
        action={<Button size="sm" icon={RotateCcw} loading={busy === 'retrain'} onClick={retrain}>Retrain now</Button>}>
        {model ? (
          <>
            <div className="hd-score">
              <div className="box"><div className="n">{model.keywords}</div><div className="l">keyword phrases</div></div>
              <div className="box"><div className="n">{model.samples}</div><div className="l">labelled sample emails</div></div>
              <div className="box"><div className="n">{model.corrected}</div><div className="l">cases staff corrected or confirmed</div></div>
              <div className="box"><div className="n">{model.closed}</div><div className="l">cases closed by people</div></div>
            </div>
            <p className="hd-note" style={{ marginTop: 10 }}>It reads the wording of every one of these and compares each new email with them, so it recognises phrasing the keyword list never listed, in English and Arabic, typos included. It retrains by itself whenever staff correct a case, change a keyword or add test emails. The independent test emails are never part of it.</p>
          </>
        ) : <span className="skel" style={{ width: '100%', height: 60 }} />}
      </Card>

      {run ? (
        <Card title={`Result: ${ENGINE_NAME[run.engine] || run.engine}`} sub={`Run ${fmtDateTime(run.ran_at)}`} className="hd-mt"
          action={runs.length > 1 ? <select className="select" style={{ width: 'auto', maxWidth: '100%' }} value={run.id} onChange={(e) => api.get(`/helpdesk/lab/runs/${e.target.value}`).then(setRun).catch((er) => toast.error(er.message))} aria-label="Earlier runs">{runs.map((r) => <option key={r.id} value={r.id}>{fmtDateTime(r.ran_at)}, {ENGINE_NAME[r.engine] || r.engine}, {r.correct}/{r.total}</option>)}</select> : null}>
          <div className="hd-score">
            <div className="box"><div className="n">{run.accuracy}%</div><div className="l">Right ({run.correct} of {run.total})</div></div>
            <div className="box"><div className="n">{run.confident_accuracy === null ? 'n/a' : `${run.confident_accuracy}%`}</div><div className="l">Right among the {run.confident_total} it did not flag for a check</div></div>
            <div className="box"><div className="n">{run.flagged_for_triage}</div><div className="l">Sent to "To check"</div></div>
            <div className="box"><div className="n">{run.priority_checked ? `${run.priority_correct}/${run.priority_checked}` : 'n/a'}</div><div className="l">Priority right (where a priority was set)</div></div>
          </div>
          <div className="hd-grid c2" style={{ marginTop: 16 }}>
            <div>
              <div className="section-title"><span>By set</span></div>
              <table className="hd-table"><tbody>{Object.entries(run.by_source || {}).map(([k, v]) => <tr key={k}><td>{SOURCE[k] || k}</td><td className="num">{v.correct}/{v.total}</td><td className="num"><b>{v.accuracy}%</b></td></tr>)}</tbody></table>
              <div className="section-title" style={{ marginTop: 14 }}><span>By language</span></div>
              <table className="hd-table"><tbody>{Object.entries(run.by_language || {}).map(([k, v]) => <tr key={k}><td>{{ en: 'English', ar: 'Arabic', mixed: 'Mixed' }[k] || k}</td><td className="num">{v.correct}/{v.total}</td><td className="num"><b>{v.accuracy}%</b></td></tr>)}</tbody></table>
            </div>
            <div>
              <div className="section-title"><span>By request type</span></div>
              <table className="hd-table"><thead><tr><th>Type</th><th className="num">Emails</th><th className="num">Found</th><th className="num">Precision</th></tr></thead>
                <tbody>{run.types.map((t) => <tr key={t.sub_key}><td>{t.name}</td><td className="num">{t.tests}</td><td className="num">{t.recall === null ? '-' : `${t.recall}%`}</td><td className="num">{t.precision === null ? '-' : `${t.precision}%`}</td></tr>)}</tbody></table>
              <p className="hd-note" style={{ marginTop: 8 }}>Found = of the emails of this type, how many it recognised. Precision = of the emails it called this type, how many really were.</p>
            </div>
          </div>
          <div className="section-title" style={{ marginTop: 18 }}><span>Where it was wrong ({run.failures.length})</span></div>
          {run.failures.length === 0 ? <div className="hd-note">Nothing wrong in this run.</div> : (
            <div className="table-wrap">
            <table className="hd-table" style={{ minWidth: 640 }}>
              <thead><tr><th>Email</th><th>Should be</th><th>It said</th><th className="num">Confidence</th><th /></tr></thead>
              <tbody>{run.failures.map((f) => (
                <tr key={f.id}>
                  <td dir="auto" style={{ maxWidth: 260 }}><div className="ellipsis">{f.subject || '(no subject)'}</div><div className="faint small">{SOURCE[f.source] || f.source}{f.terms.length ? ` · matched: ${f.terms.join(', ')}` : ''}</div></td>
                  <td>{nameOf(meta, f.expected)}</td>
                  <td>{f.ok === false ? nameOf(meta, f.got) : `priority ${f.priority}, expected ${f.expected_priority}`}</td>
                  <td className="num">{Math.round(f.confidence * 100)}%{f.needs_review ? ' (flagged)' : ''}</td>
                  <td className="num"><Button size="xs" icon={BookPlus} onClick={() => setTeach({ sub_key: f.expected, term: '' })}>Teach</Button></td>
                </tr>
              ))}</tbody>
            </table>
            </div>
          )}
        </Card>
      ) : null}

      <Card title="The test emails" className="hd-mt" pad={false}>
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="hd-table" style={{ minWidth: 640 }}>
            <thead><tr><th>Email</th><th>Correct type</th><th>Set</th><th /></tr></thead>
            <tbody>{(tests || []).map((t) => (
              <tr key={t.id}>
                <td dir="auto" style={{ maxWidth: 380 }}><div className="strong ellipsis">{t.subject || '(no subject)'}</div><div className="muted small ellipsis">{t.body.replace(/\s+/g, ' ').slice(0, 110)}</div></td>
                <td>{nameOf(meta, t.expected_sub_key)}{t.expected_priority ? <span className="faint small"> · {t.expected_priority}</span> : null}</td>
                <td><Pill tone={t.source === 'independent' ? 'info' : 'neutral'} dot={false}>{SOURCE[t.source] || t.source}</Pill></td>
                <td className="num"><button type="button" className="icon-btn sm" aria-label="Remove this test email" onClick={() => api.del(`/helpdesk/lab/tests/${t.id}`).then(loadTests).catch((e) => toast.error(e.message))}><Trash2 size={15} /></button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>

      <AddTest open={adding} onClose={() => setAdding(false)} meta={meta} onSaved={loadTests} />
      <ImportCsv open={importing} onClose={() => setImporting(false)} onSaved={loadTests} />
      <KeywordModal open={Boolean(teach)} onClose={() => setTeach(null)} meta={meta} initial={teach} />
      <ConfirmDialog open={restoring} title="Restore the sample emails?" tone="primary" confirmLabel="Restore" message="The built-in tuning samples and the independent emails are put back as they were. Emails you added or imported are kept."
        onCancel={() => setRestoring(false)} onConfirm={async () => { try { await api.post('/helpdesk/lab/tests/reset', {}); toast.success('Sample emails restored'); loadTests(); } catch (e) { toast.error(e.message); } setRestoring(false); }} />
    </>
  );
}

/* ------------------------------------ what staff corrected ------------------------------------ */
function Corrections({ meta }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [d, setD] = useState(null);
  const [teach, setTeach] = useState(null);
  const load = useCallback(() => api.get('/helpdesk/lab/feedback', { days }).then(setD).catch((e) => toast.error(e.message)), [days, toast]);
  useEffect(() => { load(); }, [load]);

  const addAsTest = async (row) => {
    try {
      const c = await api.get(`/helpdesk/cases/${row.case_id}`);
      const first = c.messages.find((m) => m.direction === 'in');
      await api.post('/helpdesk/lab/tests', { subject: c.subject, body: first ? first.body : c.subject, expected_sub_key: row.new_value, source: 'override' });
      toast.success('Added to the test set with the corrected type');
    } catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <div className="row between wrap" style={{ marginBottom: 14, gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>Every time staff change the request type, priority, team or owner the AI chose, it is recorded here. This is the raw material for making the system better.</p>
        <select className="select" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period"><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select>
      </div>
      {d ? (
        <>
          <div className="hd-score" style={{ marginBottom: 16 }}>
            <div className="box"><div className="n">{d.classified}</div><div className="l">Classified by the AI</div></div>
            <div className="box"><div className="n">{d.confirmed}</div><div className="l">Confirmed by a person</div></div>
            <div className="box"><div className="n">{d.overrides}</div><div className="l">Corrections</div></div>
            <div className="box"><div className="n">{d.override_rate === null ? 'n/a' : `${d.override_rate}%`}</div><div className="l">Type or priority changed</div></div>
          </div>
          {d.confused_pairs.length ? (
            <Card title="Most common mix-ups" sub="Where the system said one thing and staff said another" className="hd-mb">
              <table className="hd-table"><tbody>{d.confused_pairs.map((p) => <tr key={`${p.from}>${p.to}`}><td>{nameOf(meta, p.from)}</td><td>to</td><td>{nameOf(meta, p.to)}</td><td className="num"><b>{p.count}</b></td></tr>)}</tbody></table>
            </Card>
          ) : null}
          <Card title="Corrections" pad={false} className="hd-mt">
            {d.data.length === 0 ? <EmptyState icon={FlaskConical} title="No corrections in this period" text="When staff change how a case was classified, it appears here with a suggested keyword." /> : (
              <div className="table-wrap">
                <table className="hd-table" style={{ minWidth: 760 }}>
                  <thead><tr><th>When</th><th>Case</th><th>Change</th><th>By</th><th /></tr></thead>
                  <tbody>{d.data.map((o) => (
                    <tr key={o.id}>
                      <td className="nowrap muted" title={fmtDateTime(o.at)}>{relTime(o.at)}</td>
                      <td dir="auto" style={{ maxWidth: 260 }}><Link to={`/helpdesk/cases?tab=all&open=${o.case_id}`} style={{ color: 'var(--blue-deep)', fontWeight: 700 }}>{o.case_no}</Link><div className="ellipsis muted small">{o.subject}</div></td>
                      <td>{o.field === 'sub_key' ? <>Type: {nameOf(meta, o.old_value)} to <b>{nameOf(meta, o.new_value)}</b></> : <>{sentence(o.field === 'owner_id' ? 'owner' : o.field)}: {o.old_value || '-'} to <b>{o.new_value || '-'}</b></>}{o.detail ? <div className="faint small" dir="auto">"{o.detail}"</div> : null}</td>
                      <td>{o.actor_name}</td>
                      <td className="num">
                        {o.field === 'sub_key' ? <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          {o.suggestion ? <Button size="xs" icon={BookPlus} onClick={() => setTeach(o.suggestion)}>Teach a phrase</Button> : <Button size="xs" icon={BookPlus} onClick={() => setTeach({ sub_key: o.new_value, term: '' })}>Teach a phrase</Button>}
                          <Button size="xs" icon={Plus} onClick={() => addAsTest(o)}>Add as test</Button>
                        </div> : null}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : <span className="skel" style={{ width: '100%', height: 120 }} />}
      <KeywordModal open={Boolean(teach)} onClose={() => setTeach(null)} meta={meta} initial={teach} onSaved={load} />
    </>
  );
}

export default function Lab() {
  const meta = useMeta();
  const [tab, setTab] = useState('try');
  const [ai, setAi] = useState(null);
  useEffect(() => { api.get('/helpdesk/mailbox').then((m) => setAi(m.ai)).catch(() => {}); }, []);
  const aiAvailable = Boolean(ai && ai.configured && ai.mode !== 'off');
  return (
    <>
      <PageHeader title="AI lab" subtitle="Try emails, measure how well they are recognised, and teach the system from what staff correct.">
        <Pill tone={aiAvailable ? 'ok' : 'neutral'}>{aiAvailable ? `AI on (${ai.model})` : 'AI off: rules and learned model'}</Pill>
      </PageHeader>
      <div className="toolbar"><Tabs value={tab} onChange={setTab} items={[{ value: 'try', label: 'Try an email' }, { value: 'tests', label: 'Test set' }, { value: 'fix', label: 'Corrections' }]} /></div>
      {tab === 'try' ? <TryIt meta={meta} aiAvailable={aiAvailable} /> : null}
      {tab === 'tests' ? <TestSet meta={meta} aiAvailable={aiAvailable} /> : null}
      {tab === 'fix' ? <Corrections meta={meta} /> : null}
    </>
  );
}
