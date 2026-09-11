import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Eyebrow, Field, Loading, Modal, Notice } from '../components/ui.jsx';

const blank = { name: '', email: '', role: 'employee', department: '', is_senior: false };

export default function AdminPeople() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [reset, setReset] = useState(null);
  const [newPass, setNewPass] = useState('');

  const load = useCallback(async () => {
    setUsers((await api.get('/api/admin/users')).users);
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api.post('/api/admin/users', {
        name: form.name.trim(), email: form.email.trim().toLowerCase(),
        role: form.role, department: form.department.trim() || null,
        is_senior: !!form.is_senior
      });
      setFlash(r.tempPassword
        ? `${r.user.name} added. Temporary password ${r.tempPassword} — it has also been emailed.`
        : `${r.user.name} added.`);
      setForm(blank); await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const patch = async (u, body, msg) => {
    setError('');
    try { await api.patch(`/api/admin/users/${u.id}`, body); setFlash(msg); await load(); }
    catch (e) { setError(e.message); }
  };

  const doReset = async () => {
    setBusy(true); setError('');
    try {
      await api.patch(`/api/admin/users/${reset.id}`, { password: newPass });
      setFlash(`Password reset for ${reset.name}. Share it with them directly.`);
      setReset(null); setNewPass('');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="shell page">
      <Eyebrow>Directory</Eyebrow>
      <h1 style={{ marginTop: 12 }}>People</h1>
      <p style={{ marginTop: 12 }}>
        Administrators approve requests, allocate rooms and book up to a year ahead.
        Employees book this month and next, subject to approval. Marking someone
        <strong> senior leadership</strong> pins their requests to the top of the approvals
        queue and gives them their own tab — and, if the policy is switched on in Settings,
        confirms their bookings automatically whenever the room is free. It grants no extra
        booking horizon and no access to restricted rooms.
      </p>

      {flash && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="good">{flash}</Notice></div>}
      {error && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="bad">{error}</Notice></div>}

      <div className="split section">
        <section>
          {!users ? <Loading /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Name</th><th>Department</th><th>Role</th><th className="right">Upcoming</th><th className="right">Actions</th></tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.name}
                        {u.is_senior && <span className="chip chip-senior">Senior leadership</span>}
                        <div className="mono muted">{u.email}</div>
                        {!u.is_active && <div className="mono" style={{ color: 'var(--bad)' }}>DEACTIVATED</div>}
                      </td>
                      <td>{u.department || '—'}</td>
                      <td><span className="mono" style={{ letterSpacing: '0.14em', textTransform: 'uppercase' }}>{u.role}</span></td>
                      <td className="right num">{u.upcoming}</td>
                      <td className="right">
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sec btn-sm"
                                  disabled={u.id === user.id}
                                  onClick={() => patch(u, { role: u.role === 'admin' ? 'employee' : 'admin' },
                                                       `${u.name} is now ${u.role === 'admin' ? 'an employee' : 'an administrator'}.`)}>
                            {u.role === 'admin' ? 'Make employee' : 'Make admin'}
                          </button>
                          <button className="btn btn-sec btn-sm"
                                  onClick={() => patch(u, { is_senior: !u.is_senior },
                                                       u.is_senior
                                                         ? `${u.name} is no longer marked senior leadership.`
                                                         : `${u.name} is marked senior leadership — their requests now sort to the top.`)}>
                            {u.is_senior ? 'Unmark senior' : 'Mark senior'}
                          </button>
                          <button className="btn btn-sec btn-sm" onClick={() => setReset(u)}>Reset password</button>
                          <button className="btn btn-sec btn-sm"
                                  disabled={u.id === user.id}
                                  onClick={() => patch(u, { is_active: !u.is_active },
                                                       `${u.name} ${u.is_active ? 'deactivated' : 'reactivated'}.`)}>
                            {u.is_active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="card">
          <Eyebrow>Onboard</Eyebrow>
          <h3 style={{ margin: '10px 0 18px' }}>Add a person</h3>
          <form onSubmit={create}>
            <Field label="Full name"><input value={form.name} onChange={set('name')} required minLength={2} /></Field>
            <Field label="Work email"><input type="email" value={form.email} onChange={set('email')} required placeholder="name@uneecops.in" /></Field>
            <Field label="Department"><input value={form.department} onChange={set('department')} placeholder="Presales" /></Field>
            <Field label="Role">
              <select value={form.role} onChange={set('role')}>
                <option value="employee">Employee</option>
                <option value="admin">Administrator</option>
              </select>
            </Field>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14, marginBottom: 18 }}>
              <input type="checkbox" checked={!!form.is_senior} style={{ width: 16, height: 16 }}
                     onChange={(e) => setForm((f) => ({ ...f, is_senior: e.target.checked }))} />
              Senior leadership
            </label>
            <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
            <p className="mono muted" style={{ marginTop: 14 }}>
              A temporary password is generated and emailed with sign-in instructions.
            </p>
          </form>
        </aside>
      </div>

      {reset && (
        <Modal title={`Reset password — ${reset.name}`} eyebrow="Set a new password" onClose={() => setReset(null)}
               footer={<>
                 <button className="btn btn-sec" onClick={() => setReset(null)}>Cancel</button>
                 <button className="btn" onClick={doReset} disabled={busy || newPass.length < 8}>Set password</button>
               </>}>
          <Field label="New password (min 8 characters)">
            <input value={newPass} onChange={(e) => setNewPass(e.target.value)} autoFocus />
          </Field>
          <p className="muted">Ask them to change it after signing in.</p>
        </Modal>
      )}
    </div>
  );
}
