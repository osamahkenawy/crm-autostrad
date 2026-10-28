import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, Gauge, MapPin, Receipt } from 'lucide-react';
import { useAuth } from '../auth';

// one demo account per role (they exist only in the seeded demo database)
const DEMO_LOGINS = [['IT (super admin)', 'it@autostrad.ae'], ['Admin', 'admin@autostrad.ae'], ['Operations', 'khalid@autostrad.ae'], ['Customer service', 'noor@autostrad.ae'], ['Finance', 'mariam@autostrad.ae']];

export default function Login() {
  const { user, ready, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to={(location.state && location.state.from && location.state.from.pathname) || '/'} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try { await login(email.trim(), password); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <section className="login-hero">
        <img className="logo" src="/brand/logo-light.svg" alt="Autostrad Rent a Car" />
        <div>
          <h1>Every car, every customer, every journey in one place.</h1>
          <p className="lead">The operations and customer CRM for Autostrad Rent a Car across the UAE.</p>
          <div className="points">
            <div className="point"><span className="ico"><MapPin size={19} /></span>Live fleet, contracts and branches</div>
            <div className="point"><span className="ico"><Receipt size={19} /></span>Bookings, invoices, fines and Salik with VAT</div>
            <div className="point"><span className="ico"><Gauge size={19} /></span>Corporate lease pipeline and customer verification</div>
          </div>
        </div>
        <div className="tagline">The heart of every journey</div>
      </section>

      <section className="login-form-wrap">
        <form className="login-card" onSubmit={submit}>
          <img className="mark" src="/brand/mark.png" alt="" />
          <h2>Welcome back</h2>
          <p className="sub">Sign in to the Autostrad CRM.</p>

          <div className="col" style={{ gap: 16 }}>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" className="input" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@autostrad.ae" />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <div className="input-wrap">
                <input id="password" className="input" style={{ paddingRight: 46 }} type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="icon-btn sm" style={{ position: 'absolute', right: 5, top: 5, boxShadow: 'none', background: 'transparent' }} onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {error ? <div className="notice" role="alert">{error}</div> : null}
            <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', marginTop: 4 }}>
              {busy ? <span className="spin" /> : null}
              Sign in
              <span className="arrow"><ArrowRight size={15} strokeWidth={2.4} /></span>
            </button>
          </div>

          {import.meta.env.DEV ? (
            <div className="demo-box">
              <div className="small muted" style={{ marginBottom: 8 }}>Local demo data: try a role</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {DEMO_LOGINS.map(([label, mail]) => (
                  <button type="button" key={mail} className="btn btn-xs btn-soft" title={mail} onClick={() => { setEmail(mail); setPassword('autostrad123'); }}>{label}</button>
                ))}
              </div>
              <div className="small muted" style={{ marginTop: 8 }}>Pick one to fill in the sign-in, then press Sign in.</div>
            </div>
          ) : null}
        </form>
      </section>
    </div>
  );
}
