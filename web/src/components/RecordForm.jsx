import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { RELATIONS, useOptions } from '../lib/options';
import { isRequired } from '../lib/formValues';

/* ---------------------- searchable picker ---------------------- */
function Combobox({ id, value, onChange, items, placeholder, clearable, invalid }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const wrap = useRef(null);
  const selected = items.find((i) => String(i.value) === String(value));

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? items.filter((i) => `${i.label} ${i.hint || ''}`.toLowerCase().includes(s)) : items;
    return list.slice(0, 80);
  }, [items, q]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (v) => { onChange(v); setOpen(false); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) choose(filtered[hi].value); }
    else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  };

  return (
    <div className="combo" ref={wrap}>
      <button type="button" id={id} className={`select${invalid ? ' invalid' : ''}`} style={{ textAlign: 'left' }} onClick={() => { setOpen((o) => !o); setQ(''); setHi(0); }}>
        {selected ? selected.label : <span className="faint">{placeholder || 'Select…'}</span>}
      </button>
      {open ? (
        <div className="pop">
          <div style={{ padding: '4px 4px 8px' }}>
            <input autoFocus className="input input-sm" placeholder="Type to search…" value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} />
          </div>
          {clearable && value ? (
            <button type="button" className="item" onClick={() => choose('')}><X size={14} /> <span className="muted">Clear selection</span></button>
          ) : null}
          {filtered.map((it, i) => (
            <button type="button" key={it.value} className={`item${i === hi ? ' active' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => choose(it.value)}>
              <span className="grow ellipsis">{it.label}</span>
              {it.hint ? <span className="faint small">{it.hint}</span> : null}
            </button>
          ))}
          {!filtered.length ? <div className="empty" style={{ padding: 16 }}>No match</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------- the form ---------------------- */
function Field({ f, value, onChange, error, mode, relItems, warning }) {
  const id = `f-${f.key}`;
  const required = isRequired(f, mode);
  const invalid = Boolean(error);
  const set = (v) => onChange(f.key, v);
  let opts = (f.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
  if (f.type === 'select' && value && !opts.some((o) => String(o.value) === String(value))) opts = [...opts, { value, label: String(value) }];
  let control;

  switch (f.type) {
    case 'select':
      control = (
        <select id={id} className={`select${invalid ? ' invalid' : ''}`} value={value ?? ''} onChange={(e) => set(e.target.value)}>
          {!required ? <option value="">—</option> : null}
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'relation':
      control = <Combobox id={id} value={value} onChange={set} items={relItems[f.relation] || []} placeholder={f.placeholder} clearable={!required} invalid={invalid} />;
      break;
    case 'textarea':
      control = <textarea id={id} className={`textarea${invalid ? ' invalid' : ''}`} value={value ?? ''} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} rows={f.rows || 3} />;
      break;
    case 'number':
      control = (
        <div className="input-wrap">
          <input id={id} type="number" className={`input${f.suffix ? ' has-suffix' : ''}${invalid ? ' invalid' : ''}`} value={value ?? ''} min={f.min} max={f.max} step={f.step || 'any'} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />
          {f.suffix ? <span className="suffix">{f.suffix}</span> : null}
        </div>
      );
      break;
    case 'date':
      control = <input id={id} type="date" className={`input${invalid ? ' invalid' : ''}`} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    case 'datetime':
      control = <input id={id} type="datetime-local" className={`input${invalid ? ' invalid' : ''}`} value={value ?? ''} onChange={(e) => set(e.target.value)} />;
      break;
    case 'password':
      control = <input id={id} type="password" autoComplete="new-password" className={`input${invalid ? ' invalid' : ''}`} value={value ?? ''} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />;
      break;
    default:
      control = <input id={id} type={f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text'} className={`input${invalid ? ' invalid' : ''}`} dir="auto" value={value ?? ''} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} readOnly={f.readOnly} />;
  }

  return (
    <div className={`field${f.span === 2 ? ' span2' : ''}`}>
      <label htmlFor={id}>{f.label}{required ? <span className="req">*</span> : null}</label>
      {control}
      {error ? <span className="err">{error}</span> : f.hint ? <span className="hint">{typeof f.hint === 'function' ? f.hint(mode) : f.hint}</span> : null}
      {!error && warning ? <span className="warn-line">{warning}</span> : null}
    </div>
  );
}

export default function RecordForm({ fields, values, onChange, errors = {}, mode = 'create' }) {
  const options = useOptions();
  const relItems = useMemo(() => {
    const m = {};
    if (!options) return m;
    for (const [name, fn] of Object.entries(RELATIONS)) m[name] = (options[name] || []).map(fn);
    return m;
  }, [options]);

  return (
    <div className="form-grid">
      {fields.map((f, i) => {
        if (f.hidden && f.hidden(mode, values)) return null;
        if (f.type === 'section') return <div key={`s${i}`} className="form-section">{f.label}</div>;
        return <Field key={f.key} f={f} value={values[f.key]} onChange={onChange} error={errors[f.key]} mode={mode} relItems={relItems} warning={f.warn ? f.warn(values, options, mode) : null} />;
      })}
    </div>
  );
}
