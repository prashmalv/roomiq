import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Eyebrow, Field, Logo, Notice, Loading } from '../components/ui.jsx';

export default function Login() {
  const { user, loading, login } = useAuth();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signupOpen, setSignupOpen] = useState(false);

  useEffect(() => {
    api.get('/api/auth/registration')
      .then((r) => setSignupOpen(!!r.open))
      .catch(() => setSignupOpen(false));
  }, []);

  if (loading) return <div className="shell"><Loading /></div>;
  if (user) return <Navigate to={loc.state?.from || '/'} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await login(email.trim().toLowerCase(), password); }
    catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="center-page">
      <div className="left">
        <Logo plate />
        <h1 style={{ marginTop: 16 }}>Every meeting room,<br />one screen.</h1>
        <p style={{ marginTop: 20 }}>
          RoomIQ shows you what is free right now, suggests the next slots that fit your
          meeting, and routes the request to facilities for approval — without a single
          email thread.
        </p>
      </div>

      <div className="right">
        <Eyebrow>Sign in</Eyebrow>
        <h1 style={{ marginTop: 12, marginBottom: 24 }}>Welcome back</h1>

        <form onSubmit={submit}>
          <Field label="Work email">
            <input type="email" autoComplete="username" value={email}
                   onChange={(e) => setEmail(e.target.value)} required
                   placeholder="name@uneecops.in" />
          </Field>
          <Field label="Password">
            <input type="password" autoComplete="current-password" value={password}
                   onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
          <button className="btn" style={{ marginTop: 16, width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {signupOpen && (
          <>
            <hr className="rule" />
            <p style={{ color: 'var(--ink-3)' }}>
              New to RoomIQ? <Link to="/register">Create an account</Link> with your
              Uneecops work email.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
