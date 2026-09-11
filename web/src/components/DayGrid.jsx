import { Eyebrow } from './ui.jsx';

/**
 * Rooms down the side, the working day across the top. One button per slot.
 * A free slot is clickable and starts a booking pre-filled with that time —
 * this is the "don't make me search twice" path from the dashboard.
 */
export default function DayGrid({ rooms, onPick, isAdmin }) {
  if (!rooms?.length) return <p className="muted">No rooms are available to you yet.</p>;
  const slots = rooms[0].slots;
  const hourTicks = slots.filter((s) => s.start.endsWith(':00'));

  return (
    <>
      <div className="daygrid">
        <div className="daygrid-inner">
          <div className="dg-head">
            <div className="lead">Room</div>
            <div className="dg-ticks">
              {slots.map((s) => (
                <div className="dg-tick" key={s.start}>
                  {s.start.endsWith(':00') ? s.start : ''}
                </div>
              ))}
            </div>
          </div>

          {rooms.map((r) => (
            <div className="dg-row" key={r.room.id}>
              <div className="dg-room">
                <div className="nm">{r.room.name}</div>
                <div className="sub num">
                  {r.room.capacity} seats · {r.room.floor || r.room.location || '—'}
                  {r.room.restricted ? ' · restricted' : ''}
                </div>
              </div>
              <div className="dg-slots">
                {r.slots.map((s) => {
                  const held = r.bookings.find((b) => b.id === s.bookingId);
                  const who = held && (held.holder || (held.status === 'pending' ? 'Awaiting approval' : 'Booked'));
                  const state = r.room.can_book ? s.state : 'locked';
                  const title =
                    state === 'locked'
                      ? `${r.room.name} is restricted — ask an admin to allocate it to you`
                      : s.state === 'free'
                      ? `${r.room.name} · ${s.start}–${s.end} · free`
                      : s.state === 'past'
                        ? `${s.start} has passed`
                        : `${r.room.name} · ${s.start}–${s.end} · ${who}${held?.title && (isAdmin || held.mine) ? ` — ${held.title}` : ''}`;
                  return (
                    <button
                      key={s.start}
                      className="dg-slot"
                      data-state={state}
                      title={title}
                      aria-label={title}
                      disabled={state !== 'free'}
                      onClick={() => onPick?.(r.room, s)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="legend">
        <span><i style={{ background: 'var(--paper)' }} />Available</span>
        <span><i style={{ background: 'var(--navy)', borderColor: 'var(--navy)' }} />Confirmed</span>
        <span><i style={{ background: 'var(--pale)', borderColor: 'var(--pale)' }} />Awaiting approval</span>
        <span><i style={{ background: 'var(--rule-2)', borderColor: 'var(--rule-2)' }} />Past</span>
        <span><i style={{ background: 'var(--rule-2)', borderColor: 'var(--rule)' }} />Not allocated to you</span>
      </div>
      <Eyebrow mute>Click any available block to book it</Eyebrow>
    </>
  );
}
