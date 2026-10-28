// "Who can do what": the five roles and what each may see and change, read from the server so it is always the real rules.
import { useState } from 'react';
import { Check, Eye, Minus, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Button } from './ui';
import { Modal } from './Modal';

const CELL = {
  edit: [Check, 'Can change', 'var(--ok-fg)'],
  yes: [Check, 'Can do', 'var(--ok-fg)'],
  view: [Eye, 'Can look, not change', 'var(--info-fg)'],
  none: [Minus, 'No access', 'var(--faint)'],
};

export default function RolesGuide() {
  const [open, setOpen] = useState(false);
  const [g, setG] = useState(null);
  const show = () => { setOpen(true); if (!g) api.get('/auth/roles').then(setG).catch(() => {}); };
  return (
    <>
      <Button icon={ShieldCheck} onClick={show}>Who can do what?</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Who can do what" subtitle="The five roles. The server enforces this on every request, not just the screens." size="lg">
        {!g ? <span className="skel" style={{ width: '100%', height: 120 }} /> : (
          <>
            <div className="hd-stack" style={{ gap: 8, marginBottom: 14 }}>
              {g.roles.map((r) => <div key={r.key}><b>{r.label}.</b> <span className="muted">{r.blurb}</span></div>)}
            </div>
            <div className="table-wrap">
              <table className="hd-table" style={{ minWidth: 640 }}>
                <thead><tr><th>Area</th>{g.roles.map((r) => <th key={r.key} className="num" style={{ textAlign: 'center' }}>{r.label.replace(' (super admin)', '')}</th>)}</tr></thead>
                <tbody>
                  {g.areas.map((a) => (
                    <tr key={a.key}>
                      <td>{a.label}</td>
                      {g.roles.map((r) => { const [Icon, title, color] = CELL[a.levels[r.key]] || CELL.none; return <td key={r.key} style={{ textAlign: 'center', color }} title={title}><Icon size={16} strokeWidth={2.4} aria-label={title} /></td>; })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hd-note" style={{ marginTop: 10 }}>A tick is "can change" (or "can do" for helpdesk abilities), the eye is "can look but not change", the dash is "no access". To change these rules, IT changes <span className="hd-code">server/src/roles.js</span>.</p>
          </>
        )}
      </Modal>
    </>
  );
}
