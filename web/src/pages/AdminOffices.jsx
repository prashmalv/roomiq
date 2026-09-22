import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Eyebrow, Field, Loading, Modal, Notice } from '../components/ui.jsx';

/**
 * Offices, their branches, and who administers each.
 *
 * An administrator is scoped: they decide requests for the offices they are
 * appointed to and nothing else. Appointing somebody here is what makes them an
 * administrator — the alternative was a two-step dance where the role and the
 * appointment could disagree.
 */
export default function AdminOffices() {
  const { user } = useAuth();
  const isSuper = user.role === 'superadmin';

  const [offices, setOffices] = useState(null);
  const [people, setPeople] = useState([]);
  const [appointing, setAppointing] = useState(null);
  const [addingBranch, setAddingBranch] = useState(null);
  const [branchForm, setBranchForm] = useState({ name: '', address: '' });
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [l, u] = await Promise.all([
      api.get('/api/locations/admin'),
      isSuper ? api.get('/api/admin/users?limit=500') : Promise.resolve({ users: [] })
    ]);
    setOffices(l.locations);
    setPeople((u.users || []).filter((p) => p.is_active));
  }, [isSuper]);
  useEffect(() => { load(); }, [load]);

  const appoint = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/api/locations/admin/${appointing.id}/admins`, { userId: pick });
      const who = people.find((p) => p.id === pick);
      setFlash(r.promoted
        ? `${who?.name} now administers ${appointing.name}, and was made an administrator.`
        : `${who?.name} now administers ${appointing.name}.`);
      setAppointing(null); setPick(''); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const revoke = async (office, person) => {
    setError('');
    try {
      const r = await api.del(`/api/locations/admin/${office.id}/admins/${person.id}`);
      setFlash(r.demoted
        ? `${person.name} no longer administers ${office.name}, and administers nowhere else, so is back to employee.`
        : `${person.name} no longer administers ${office.name}.`);
      await load();
    } catch (e) { setError(e.message); }
  };

  const addBranch = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/api/locations/admin/${addingBranch.id}/branches`, {
        name: branchForm.name.trim(), address: branchForm.address.trim() || null
      });
      setFlash(`${branchForm.name} added to ${addingBranch.name}. Rooms can go in it now.`);
      setAddingBranch(null); setBranchForm({ name: '', address: '' }); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!offices) return <div className="shell page"><Loading /></div>;

  return (
    <div className="shell page">
      <Eyebrow>Where the rooms are</Eyebrow>
      <h1 style={{ marginTop: 12 }}>Offices</h1>
      <p style={{ marginTop: 12 }}>
        A room belongs to a branch, and a branch to a city office. Approval requests go to
        the administrators of the office the room is in — so a Bangalore booking never
        lands in a Noida inbox.
        {isSuper
          ? ' As super administrator you appoint those administrators, and appointing somebody here is what grants them the role.'
          : ' You are seeing only the offices you administer.'}
      </p>

      {flash && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="good">{flash}</Notice></div>}
      {error && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="bad">{error}</Notice></div>}

      <section className="section">
        {offices.length === 0 ? (
          <p className="muted">You do not administer any office yet. Ask the super administrator.</p>
        ) : offices.map((o) => (
          <div key={o.id} className="card" style={{ marginBottom: 'var(--s-5)' }}>
            <div className="section-head" style={{ marginBottom: 'var(--s-3)' }}>
              <h2 style={{ margin: 0 }}>{o.name}</h2>
              <span className="mono muted">
                {o.city}{o.region ? `, ${o.region}` : ''} · {o.country} · {o.rooms} room{o.rooms === 1 ? '' : 's'}
              </span>
              {isSuper && (
                <div className="btn-row" style={{ marginLeft: 'auto' }}>
                  <button className="btn btn-sec btn-sm" onClick={() => setAddingBranch(o)}>Add branch</button>
                  <button className="btn btn-sm" onClick={() => { setAppointing(o); setPick(''); }}>
                    Appoint administrator
                  </button>
                </div>
              )}
            </div>

            <div className="grid-2">
              <div>
                <Eyebrow mute>Branches</Eyebrow>
                {o.branches.length === 0 ? (
                  <p className="mono muted" style={{ marginTop: 8 }}>
                    None yet — a room needs a branch to sit in.
                  </p>
                ) : o.branches.map((b) => (
                  <div key={b.id} style={{ borderTop: '1px solid var(--rule)', padding: '8px 0' }}>
                    <div style={{ color: 'var(--ink)' }}>{b.name}</div>
                    {b.address && <div className="mono muted">{b.address}</div>}
                  </div>
                ))}
              </div>

              <div>
                <Eyebrow mute>Administrators — these people get the approval mail</Eyebrow>
                {o.admins.length === 0 ? (
                  <p className="mono" style={{ marginTop: 8, color: 'var(--bad)' }}>
                    Nobody appointed. Requests here fall back to the super administrator.
                  </p>
                ) : o.admins.map((a) => (
                  <div key={a.id} style={{ borderTop: '1px solid var(--rule)', padding: '8px 0',
                                           display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div>
                      <div style={{ color: 'var(--ink)' }}>{a.name}</div>
                      <div className="mono muted">{a.email}</div>
                    </div>
                    {isSuper && a.id !== user.id && (
                      <button className="btn btn-sec btn-sm" style={{ marginLeft: 'auto' }}
                              onClick={() => revoke(o, a)}>Remove</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </section>

      {appointing && (
        <Modal title={`Appoint an administrator — ${appointing.name}`}
               eyebrow="They will receive every approval request for this office"
               onClose={() => { setAppointing(null); setError(''); }}
               footer={<>
                 <button className="btn btn-sec" onClick={() => setAppointing(null)}>Cancel</button>
                 <button className="btn" onClick={appoint} disabled={busy || !pick}>
                   {busy ? 'Appointing…' : 'Appoint'}
                 </button>
               </>}>
          <Field label="Person">
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose someone…</option>
              {people
                .filter((p) => !appointing.admins.some((a) => a.id === p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.email}{p.role !== 'employee' ? ` (${p.role})` : ''}
                  </option>
                ))}
            </select>
          </Field>
          <p className="muted">
            An employee is made an administrator automatically. They will be able to approve
            requests and manage rooms for {appointing.name} — and for no other office.
          </p>
          {error && <Notice tone="bad">{error}</Notice>}
        </Modal>
      )}

      {addingBranch && (
        <Modal title={`Add a branch — ${addingBranch.name}`}
               eyebrow="A building or site within this office"
               onClose={() => { setAddingBranch(null); setError(''); }}
               footer={<>
                 <button className="btn btn-sec" onClick={() => setAddingBranch(null)}>Cancel</button>
                 <button className="btn" onClick={addBranch} disabled={busy || branchForm.name.trim().length < 2}>
                   {busy ? 'Adding…' : 'Add branch'}
                 </button>
               </>}>
          <Field label="Branch name">
            <input value={branchForm.name} autoFocus maxLength={80}
                   onChange={(e) => setBranchForm((f) => ({ ...f, name: e.target.value }))}
                   placeholder="Q Tower" />
          </Field>
          <Field label="Address (optional)">
            <input value={branchForm.address} maxLength={240}
                   onChange={(e) => setBranchForm((f) => ({ ...f, address: e.target.value }))}
                   placeholder="6th Floor, A-8, Block A, Sector 68" />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
        </Modal>
      )}
    </div>
  );
}
