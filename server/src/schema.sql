-- ============================================================================
-- UneeRooms — Conference Room Booking
-- Schema. Idempotent: safe to run on every boot.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gist; -- uuid = inside an exclusion constraint

-- ---------------------------------------------------------------- users -----
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  email          text NOT NULL UNIQUE,          -- always stored lower-cased
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'employee'
                 CHECK (role IN ('employee','admin')),
  department     text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- rooms -----
CREATE TABLE IF NOT EXISTS rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  location    text,
  floor       text,
  capacity    integer NOT NULL DEFAULT 4 CHECK (capacity > 0),
  amenities   text[] NOT NULL DEFAULT '{}',
  -- restricted = only users listed in room_access (plus admins) may book it.
  -- This is the "admin can allocate a room to someone" access model.
  restricted  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_access (
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- ------------------------------------------------------------- bookings -----
-- Local office time is stored as (date, time) rather than an instant.  A
-- conference room lives in exactly one timezone; storing wall-clock removes a
-- whole class of DST/offset bugs and lets the overlap constraint be a plain
-- immutable generated range.
CREATE TABLE IF NOT EXISTS bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  booked_for    uuid NOT NULL REFERENCES users(id),  -- whose meeting it is
  requested_by  uuid NOT NULL REFERENCES users(id),  -- who filed the request
  title         text NOT NULL,
  purpose       text,
  attendees     integer NOT NULL DEFAULT 1 CHECK (attendees > 0),
  booking_date  date NOT NULL,
  start_time    time NOT NULL,
  end_time      time NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  pass_code     text NOT NULL UNIQUE,               -- shareable proof-of-booking
  created_at    timestamptz NOT NULL DEFAULT now(),
  slot          tsrange GENERATED ALWAYS AS
                (tsrange(booking_date + start_time, booking_date + end_time, '[)')) STORED,
  CONSTRAINT bookings_time_order CHECK (end_time > start_time)
);

-- Double-booking is prevented by the database, not by an application check.
-- Pending requests hold the slot, so two people cannot queue for the same time.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING gist (room_id WITH =, slot WITH &&)
      WHERE (status IN ('pending','approved'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bookings_date_idx    ON bookings (booking_date);
CREATE INDEX IF NOT EXISTS bookings_room_idx    ON bookings (room_id, booking_date);
CREATE INDEX IF NOT EXISTS bookings_for_idx     ON bookings (booked_for, booking_date DESC);
CREATE INDEX IF NOT EXISTS bookings_pending_idx ON bookings (status) WHERE status = 'pending';

-- -------------------------------------------------------- email outbox ------
-- Every notification is persisted first and sent second, so mail is auditable
-- and the transport (SMTP today, Azure Communication Services later) is swappable.
CREATE TABLE IF NOT EXISTS email_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  to_email    text NOT NULL,
  to_name     text,
  subject     text NOT NULL,
  body_html   text NOT NULL,
  body_text   text NOT NULL,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','sent','failed','skipped')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS email_outbox_status_idx ON email_outbox (status, created_at);

-- ------------------------------------------------------------ audit log -----
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

-- ------------------------------------------------------------- settings -----
CREATE TABLE IF NOT EXISTS settings (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  org_name                text    NOT NULL DEFAULT 'Uneecops Technologies Limited',
  work_start              time    NOT NULL DEFAULT '08:00',
  work_end                time    NOT NULL DEFAULT '20:00',
  slot_minutes            integer NOT NULL DEFAULT 30,
  employee_window_months  integer NOT NULL DEFAULT 2,   -- current month + next
  admin_window_months     integer NOT NULL DEFAULT 12,
  max_booking_minutes     integer NOT NULL DEFAULT 240,
  allow_weekend           boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Added after the first release.  ADD COLUMN IF NOT EXISTS keeps this file
-- idempotent, so the boot-time migration stays a single re-runnable script.
-- ============================================================================

-- Senior leadership: a flag an admin sets on a person, not a separate role.
-- It changes how their requests are *surfaced* and (optionally) decided; it
-- grants no extra booking horizon and no access to restricted rooms.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_senior boolean NOT NULL DEFAULT false;

-- A request confirmed by the auto-approval policy rather than by a person.
-- decided_by stays NULL for these, which is how "approved by system" is told
-- apart from "approved by an administrator who happens to be deleted".
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS auto_approved boolean NOT NULL DEFAULT false;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS allow_self_registration boolean NOT NULL DEFAULT true;
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS allowed_email_domains text[] NOT NULL
                           DEFAULT '{uneecops.in,uneecops.com}';
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS auto_approve_senior boolean NOT NULL DEFAULT false;

-- The approvals queue sorts senior pending requests to the top on every load.
CREATE INDEX IF NOT EXISTS users_senior_idx ON users (is_senior) WHERE is_senior;

-- ---------------------------------------------------------- contested -------
-- A senior leadership request for a slot that an *undecided* request is already
-- holding.  It is deliberately outside the exclusion constraint's status list,
-- so it records the clash without taking the slot from the person who asked
-- first — the whole point is that facilities decide, not the database.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bookings_status_check'
       AND pg_get_constraintdef(oid) LIKE '%contested%'
  ) THEN
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
    ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
      CHECK (status IN ('pending','approved','rejected','cancelled','contested'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bookings_contested_idx
  ON bookings (room_id, booking_date) WHERE status = 'contested';

-- ------------------------------------------------- delivery verification ----
-- A transport accepting a message is not the same as delivering it. ACS returns
-- an operation id on acceptance and reports the outcome separately, so the id is
-- kept and the outcome checked; otherwise a bounce would sit in the table
-- labelled 'sent' forever, which is exactly the silent loss this table exists
-- to prevent.
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS provider_id text;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE INDEX IF NOT EXISTS email_outbox_unverified_idx ON email_outbox (sent_at)
  WHERE status = 'sent' AND provider_id IS NOT NULL AND verified_at IS NULL;
