// "Getting started": what is still to do before the helpdesk is working on real mail. Shown in setup and, while
// something is missing, on the dashboard for admin and IT users.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight } from 'lucide-react';
import { api } from '../api';
import { Button, Card, ProgressBar } from '../components/ui';

export default function Readiness({ compact = false }) {
  const [r, setR] = useState(null);
  const [open, setOpen] = useState(!compact);
  useEffect(() => { api.get('/helpdesk/readiness').then(setR).catch(() => {}); }, []);
  if (!r) return null;
  const todo = r.items.filter((i) => i.state === 'todo');
  if (compact && !todo.length) return null;
  const rows = compact ? r.items.filter((i) => i.state !== 'done') : r.items;
  return (
    <Card title="Getting started" sub={todo.length ? `${r.done} of ${r.total} steps done. A few things before it works on real mail.` : 'Everything needed is in place.'} className="hd-mb"
      action={compact ? <Button size="sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide steps' : 'Show steps'}</Button> : null}>
      <ProgressBar value={(r.done / r.total) * 100} tone={todo.length ? '' : 'ok'} label="Setup progress" />
      <div style={{ marginTop: 8, display: open ? 'block' : 'none' }}>
        {rows.map((i, n) => (
          <div className="hd-step" key={i.key}>
            <span className={`mark ${i.state}`}>{i.state === 'done' ? <Check size={15} strokeWidth={3} /> : i.state === 'optional' ? '-' : n + 1}</span>
            <div className="grow"><b>{i.title}{i.state === 'optional' ? ' (optional)' : ''}</b><div className="hd-note">{i.detail}</div></div>
            {i.state !== 'done' ? <Link to={i.link} className="btn btn-xs btn-soft">Open<ChevronRight size={13} /></Link> : null}
          </div>
        ))}
      </div>
    </Card>
  );
}
