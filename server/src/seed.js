import { pool, q } from './lib/db.js';
import { migrate } from './lib/migrate.js';
import { hashPassword } from './lib/auth.js';
import { passCode } from './lib/passcode.js';
import { config } from './config.js';
import { DateTime } from 'luxon';

const ROOMS = [
  ['Ganges',   'Head Office — Noida',  '3rd floor', 14, ['Projector', 'Video conf', 'Whiteboard'], false],
  ['Yamuna',   'Head Office — Noida',  '3rd floor',  8, ['TV screen', 'Whiteboard'], false],
  ['Narmada',  'Head Office — Noida',  '4th floor',  6, ['TV screen'], false],
  ['Kaveri',   'Head Office — Noida',  '4th floor',  4, ['Whiteboard'], false],
  ['Sutlej',   'Head Office — Noida',  '5th floor', 24, ['Projector', 'Audio system', 'Video conf'], false],
  ['Boardroom','Head Office — Noida',  '5th floor', 18, ['Video conf', 'Audio system', 'Catering'], true]
];

const PEOPLE = [
  ['Prashant Malviya', 'prashant.malviya@uneecops.in', 'admin',    'Presales'],
  ['Neha Sharma',      'neha.sharma@uneecops.in',      'admin',    'Admin & Facilities'],
  ['Rahul Verma',      'rahul.verma@uneecops.in',      'employee', 'Delivery'],
  ['Aisha Khan',       'aisha.khan@uneecops.in',       'employee', 'Presales'],
  ['Vikram Rao',       'vikram.rao@uneecops.in',       'employee', 'Engineering'],
  ['Sanjana Iyer',     'sanjana.iyer@uneecops.in',     'employee', 'HR'],
  ['Amit Chauhan',     'amit.chauhan@uneecops.in',     'employee', 'Finance']
];

async function main() {
  await migrate();

  // --- admin from env, always present -------------------------------------
  const adminHash = await hashPassword(config.seedAdminPassword);
  await q(
    `INSERT INTO users (name, email, password_hash, role, department)
     VALUES ($1,$2,$3,'admin','Admin & Facilities')
     ON CONFLICT (email) DO UPDATE SET role='admin', is_active=true`,
    ['Facilities Admin', config.seedAdminEmail, adminHash]
  );
  console.log(`[seed] admin ready: ${config.seedAdminEmail}`);

  if (!config.seedDemoData) { console.log('[seed] demo data disabled'); return; }

  // --- rooms ---------------------------------------------------------------
  for (const [name, location, floor, capacity, amenities, restricted] of ROOMS) {
    await q(
      `INSERT INTO rooms (name, location, floor, capacity, amenities, restricted)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (name) DO NOTHING`,
      [name, location, floor, capacity, amenities, restricted]
    );
  }

  // --- people --------------------------------------------------------------
  const demoHash = await hashPassword('Welcome@123');
  for (const [name, email, role, dept] of PEOPLE) {
    await q(
      `INSERT INTO users (name, email, password_hash, role, department)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
      [name, email.toLowerCase(), demoHash, role, dept]
    );
  }

  const { rows: users } = await q(`SELECT id, name, email, role FROM users ORDER BY role, name`);
  const { rows: rooms } = await q(`SELECT id, name FROM rooms ORDER BY name`);
  const byEmail = (e) => users.find((u) => u.email === e);
  const byRoom = (n) => rooms.find((r) => r.name === n);

  // Boardroom is restricted — allocate it to two people explicitly.
  for (const e of ['prashant.malviya@uneecops.in', 'aisha.khan@uneecops.in']) {
    await q(
      `INSERT INTO room_access (room_id, user_id, granted_by)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [byRoom('Boardroom').id, byEmail(e).id, byEmail('prashant.malviya@uneecops.in').id]
    );
  }

  // --- a realistic spread of bookings across today + next few days ---------
  const { rows: existing } = await q(`SELECT count(*)::int AS n FROM bookings`);
  if (existing[0].n > 0) { console.log('[seed] bookings already present, skipping'); return; }

  const d = (n) => DateTime.now().setZone(config.timezone).plus({ days: n }).toISODate();
  const plan = [
    ['Ganges',   0, '10:00', '11:00', 'rahul.verma@uneecops.in',  'Sprint review',              'approved'],
    ['Ganges',   0, '15:00', '16:30', 'aisha.khan@uneecops.in',   'Bihar RAMP walkthrough',     'approved'],
    ['Yamuna',   0, '09:30', '10:30', 'sanjana.iyer@uneecops.in', 'Interview panel',            'approved'],
    ['Narmada',  0, '14:00', '15:00', 'vikram.rao@uneecops.in',   'Architecture sync',          'pending'],
    ['Sutlej',   1, '11:00', '13:00', 'aisha.khan@uneecops.in',   'Client demo — Gujarat DICT', 'approved'],
    ['Kaveri',   1, '16:00', '17:00', 'amit.chauhan@uneecops.in', 'Vendor call',                'pending'],
    ['Yamuna',   2, '10:00', '11:30', 'rahul.verma@uneecops.in',  'UAT planning',               'approved'],
    ['Ganges',   5, '12:00', '13:00', 'sanjana.iyer@uneecops.in', 'All-hands rehearsal',        'pending'],
    ['Boardroom',4, '10:00', '12:00', 'prashant.malviya@uneecops.in', 'Quarterly business review', 'approved']
  ];

  const approver = byEmail('prashant.malviya@uneecops.in');
  for (const [room, dayOffset, st, et, who, title, status] of plan) {
    const u = byEmail(who);
    try {
      await q(
        `INSERT INTO bookings (room_id, booked_for, requested_by, title, purpose, attendees,
                               booking_date, start_time, end_time, status, decided_by, decided_at, pass_code)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          byRoom(room).id, u.id, title, null, 4,
          d(dayOffset), st, et, status,
          status === 'approved' ? approver.id : null,
          status === 'approved' ? new Date() : null,
          passCode()
        ]
      );
    } catch (e) {
      console.warn(`[seed] skipped ${room} ${d(dayOffset)} ${st}: ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`[seed] ${rooms.length} rooms, ${users.length} users, bookings loaded`);
  console.log('[seed] demo password for all seeded staff: Welcome@123');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e); process.exit(1); });
