# UneeRooms — conference room booking

A single Azure web app that lets employees see what is free, book it in two clicks, and
lets facilities approve, allocate and audit every reservation.

Built for Uneecops Technologies Limited. Node.js + React + PostgreSQL, deployed as one
container on Azure App Service.

---

## What it does

**Dashboard first, search second.** The landing page is not a search form. It shows how
many rooms are free this minute, then a ranked list of slots that already fit the meeting
you are about to book — soonest first, smallest room that seats the party, core hours
preferred, diversified so it reads as real choice. One click books a suggested slot.

**Two booking horizons, enforced server-side.** An employee may book the current calendar
month and the next one — in September that is September and October; November is closed,
and the window rolls forward on the 1st on its own. An administrator may book any day up
to a year ahead. Both numbers are settings, not constants in the code.

**Employees sign themselves up.** Anyone with a working Uneecops mailbox creates their
own account — the email domain is the whole gate, enforced server-side, and both the
switch and the accepted domains (`uneecops.in`, `uneecops.com`) are settings. There is no
account queue for facilities to staff. Everyone, administrators included, changes their
own password from **Profile**; resetting *someone else's* stays on the People screen.

**Senior leadership.** An administrator can mark a person as senior leadership on the
People screen. Their requests are pinned to the top of the approvals queue and get their
own tab with a count, so a leadership request cannot scroll out of sight. Switch on
**auto-approve** in Settings and those requests are confirmed the moment they are made,
provided the room is actually free — the exclusion constraint below is what proves it, so
there is no second availability check to race. Such a booking records no human decider and
reads as **approved by system** in the register; facilities are emailed either way. A slot
already held by someone else's pending request is not free: the request is refused rather
than displacing the person waiting. The flag grants no extra booking horizon and no access
to restricted rooms.

**Two requests, one slot.** The database stops a slot being held twice, which used to mean
a senior leadership request for a slot an employee had already asked for was simply
refused. It is now recorded as **contested** instead: a state deliberately outside the
exclusion constraint, so it takes nothing from whoever asked first but does put both
requests in front of facilities. The earlier request turns red in the queue and gets its
own **Clashes** tab. Confirming the earlier one closes the contested one automatically and
emails both people; confirming the contested one first is refused until the earlier request
is actually decided — the database will not let a held slot be quietly reassigned, and
neither will the API.

**Recurring, but only this week.** A booking can repeat every day or on alternate days,
running from the date chosen to the Sunday of that same week and no further. The cap is the
point: a standing booking stretching months ahead sits on slots nobody can plan around.
Each date is a separate booking needing its own approval, so a repeat can partly succeed —
dates whose slots are already taken are skipped and named back to the requester rather than
silently dropped.

**Approval workflow.** An employee request is created as `pending` and *holds its slot* —
nobody else can take the same time while facilities decides. Approve or decline from the
Approvals screen; declining requires a reason, and both outcomes email the requester.
Bookings an admin makes are confirmed immediately.

**Admins see who, employees see when.** On the shared calendar an employee sees a slot as
taken and nothing more. Administrators see the holder, department, meeting title and
purpose. That split is enforced in the API, not hidden in the UI.

**Booking pass.** Every confirmed booking gets an unguessable pass code and a public
read-only page — the answer to "someone else is sitting in my room". It shows the room,
the slot, the holder and who approved it; it carries no email address and no other
booking. Print it or show it on a phone.

**Room administration.** Create and retire rooms, set capacity, floor and amenities. A
room marked **restricted** can only be booked by the people it is allocated to — that is
how a boardroom stays a boardroom.

**Email that cannot be silently lost.** Every notification is written to an outbox table
first and sent second. Transport is one function with three branches: `acs` (Azure
Communication Services, over its REST API), `smtp` (Microsoft 365 or any relay) and `log`
(nothing sent, everything still recorded). The Settings screen shows the queue, failures
and errors, so a transport that stops working is visible rather than silent.

Production sends through ACS with an **Azure-managed domain**, which Azure verifies itself
— no DNS record, no mailbox, and no tenant-level SMTP AUTH to get enabled. The cost is the
sender address: a generated `donotreply@<guid>.azurecomm.net`. Moving to
`uneerooms@uneecops.in` means verifying a custom domain on the same ACS resource; the
application does not change. ACS is driven by its access key over signed REST rather than
its SMTP front door, because SMTP there additionally needs an Entra app registration.

---

## Architecture

```
Browser ──HTTPS──► Azure App Service (Linux container, one origin)
                     ├── Express API   /api/*
                     └── React SPA     everything else
                            │
                            ├── Azure Database for PostgreSQL — Flexible Server
                            └── SMTP relay (M365 / ACS / SendGrid)
```

**One origin, one deployment.** The API serves the built SPA, so there is no CORS, no
second app to keep in sync and no separate certificate. The session is an HttpOnly,
SameSite=Lax, Secure cookie — nothing sensitive reaches `localStorage`.

**The database owns correctness, not the application.** Double-booking is prevented by a
PostgreSQL exclusion constraint:

```sql
EXCLUDE USING gist (room_id WITH =, slot WITH &&) WHERE (status IN ('pending','approved'))
```

Two people clicking the same slot at the same instant cannot both succeed, however many
app instances are running. The API turns the constraint violation into a clear 409 rather
than re-checking availability in application code and racing.

**Wall-clock, not instants.** A booking is stored as `(date, start_time, end_time)`, not a
`timestamptz`. A conference room lives in exactly one timezone; storing local time removes
a whole class of DST and offset bugs and lets the overlap range be an immutable generated
column. "Free right now" is derived from the server's slot states, so a laptop on the
wrong timezone cannot change what the dashboard claims.

**Policy in one place.** `server/src/lib/rules.js` holds the booking horizons, working
hours, slot grid, weekend rule and length cap, driven by the `settings` row. Changing the
employee horizon from 2 months to 3 is a settings change, not a release.

### Data model

| Table | Purpose |
|---|---|
| `users` | staff, `role` = employee \| admin, `is_senior` leadership flag, bcrypt hashes |
| `rooms` | name, capacity, floor, amenities, `restricted` flag |
| `room_access` | which people a restricted room is allocated to |
| `bookings` | the reservation, its status (incl. `contested`), decision, `auto_approved` and pass code |
| `email_outbox` | every notification, queued → sent/failed/skipped |
| `audit_log` | who did what, with what payload |
| `settings` | working hours, slot length, horizons, caps, sign-up domains, auto-approve |

---

## Running it locally

```bash
git clone <this repo> && cd roomiq
npm run install:all
cp .env.example server/.env      # set DATABASE_URL and JWT_SECRET
npm run seed                     # schema + demo rooms, people and bookings
npm start                        # http://localhost:8080
```

Or the whole stack in one command:

```bash
docker compose up --build        # http://localhost:8080
```

Front-end with hot reload: `npm run dev:web` (port 5173, proxies `/api` to 8080).

**Demo accounts** (created by `npm run seed`, never in production —
`SEED_DEMO_DATA=false`):

| Account | Password | Role |
|---|---|---|
| `admin@uneecops.in` | `Admin@123` | administrator |
| `rahul.verma@uneecops.in` | `Welcome@123` | employee |
| every other seeded name | `Welcome@123` | employee |

### Tests

```bash
npm run smoke                    # 76 end-to-end checks against a running server
```

Covers sign-in, self-registration and its domain gate, changing your own password, both
booking horizons, the exclusion constraint, the approval workflow, senior leadership
ordering and auto-approval, contested slots and how they are arbitrated, recurring
bookings including partial success, the admin/employee visibility split, pass codes,
cancellation and the mail outbox.

The suite is **not idempotent** — it books a date three months out on a fixed day, so a
second run against the same database fails on that slot. Reset first:
`dropdb roomiq && createdb roomiq && npm run seed`.

---

## Deploying to Azure

### 1. Provision

```bash
az group create -n rg-roomiq -l centralindia

az deployment group create -g rg-roomiq -f infra/main.bicep \
  -p namePrefix=roomiq \
     webAppName=bookuneerooms \
     pgAdminPassword="$(openssl rand -base64 24)Aa9#" \
     jwtSecret="$(openssl rand -base64 48)" \
     seedAdminPassword="$(openssl rand -base64 18)Aa9#" \
     seedAdminEmail=facilities@uneecops.in
```

This creates the container registry, the Linux App Service Plan and web app, PostgreSQL
Flexible Server (with `BTREE_GIST` and `PGCRYPTO` allow-listed — Azure blocks extensions
that are not), Log Analytics and Application Insights.

`webAppName` is the public hostname, so this deployment answers on
`bookuneerooms.azurewebsites.net`; leave it out and the app gets a suffixed name. It must
be globally unique — check with
`az rest --method post --url ".../providers/Microsoft.Web/checknameavailability?api-version=2023-12-01" --body '{"name":"…","type":"Microsoft.Web/sites"}'`.

`seedAdminPassword` is **required**, and deliberately so: `config.js` falls back to a
hard-coded default, so a deployment that omits it publishes an administrator whose
password is in this repository.

By default the web app pulls from the registry with its managed identity and no registry
password is stored anywhere. Creating that role assignment needs **Owner** or **User
Access Administrator** — Contributor alone cannot do it, and the deployment fails with
`AuthorizationFailed`. With only Contributor, add `useManagedIdentityForAcr=false`: the
registry admin user is enabled and its credentials go into app settings instead. Switch
back by redeploying with the flag true once someone grants the role.

Note the outputs — `acrName`, `webAppName`, `appUrl`.

### 2. Ship the image

```bash
az acr build --registry <acrName> --image roomiq:latest --file Dockerfile .
az webapp restart -g rg-roomiq -n <webAppName>
```

On first boot the app applies the schema and, finding an empty users table, creates the
administrator from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. **Sign in and change that
password immediately** from the Profile screen, then remove `SEED_ADMIN_PASSWORD` from the
app settings. The bootstrap only runs while the users table is empty, so removing it later
changes nothing.

### 3. Continuous deployment

`.github/workflows/deploy.yml` builds in ACR and rolls the web app forward on every push
to `main`, then waits for `/healthz` to go green. It uses OIDC federated credentials, so
there is no publish profile to leak. Repository secrets:

`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`,
`ACR_NAME`, `AZURE_WEBAPP_NAME`.

### 4. Email

`enableAcsEmail=true` (the default) provisions an ACS Email resource, an Azure-managed
domain and a Communication Service, and wires `MAIL_DRIVER=acs` with the right endpoint,
key and sender into app settings. Nothing further is needed — mail sends on the next flush.

Note that the ACS resources are created conditionally, and ARM does not reliably
short-circuit the unused branch of a ternary that calls `listKeys()`. Flipping
`enableAcsEmail` to `false` on a stack whose ACS resources have been deleted may need the
email block removed from the template rather than merely disabled.

To send from `uneerooms@uneecops.in` through a Microsoft 365 mailbox instead, deploy with
`enableAcsEmail=false` and set these app settings — queued mail flushes on the next cycle:

```
MAIL_DRIVER=smtp
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=uneerooms@uneecops.in
SMTP_PASS=<app password or client secret>
MAIL_FROM=UneeRooms <uneerooms@uneecops.in>
```

Microsoft 365 needs SMTP AUTH enabled on that mailbox, which many tenants block by default.
If yours does, the better route to a `@uneecops.in` sender is not SMTP at all: verify
uneecops.in as a custom domain on the ACS resource that already exists, and change only
`MAIL_FROM`.

### Configuration reference

Every setting is in `.env.example`. The ones that matter in production: `DATABASE_URL`,
`JWT_SECRET`, `PUBLIC_URL` (email links), `COOKIE_SECURE=true`, `PGSSL=true`,
`APP_TIMEZONE`, `SEED_DEMO_DATA=false`, and `SEED_ADMIN_PASSWORD` — without which the
bootstrap administrator is created with the insecure default in `config.js`.

Sign-up domains, self-registration and senior-leadership auto-approval are **not** app
settings; they live in the `settings` table and are edited from the Settings screen, so
changing them needs no release and no restart.

Email is driven by `MAIL_DRIVER`. `acs` needs `ACS_ENDPOINT` and `ACS_ACCESS_KEY`; the
endpoint carries the data location (`<name>.india.communication.azure.com`), so take it
from the resource rather than assembling it. `smtp` needs the `SMTP_*` settings instead.
`MAIL_FROM` must match a sender the transport is allowed to send as.

### Running costs

B1 App Service + Burstable B1ms PostgreSQL + Basic ACR is roughly ₹5,000–7,000 a month in
Central India at list price — comfortably inside a departmental budget. B1 has no
Always On, so the first request after an idle period is slow; move to P0v3 if that shows.

### Operations

- **Health**: `GET /healthz` checks the database and is wired to App Service health checks.
- **Logs**: `az webapp log tail -g rg-roomiq -n <webAppName>`; traces and failures in
  Application Insights.
- **Backups**: Flexible Server keeps 14 days of automatic backups. Point-in-time restore
  from the portal.
- **Audit**: `audit_log` records every login, booking, decision, room and user change.

---

## Security posture

Bcrypt password hashing (cost 11); HttpOnly/Secure/SameSite session cookie; Helmet with a
strict CSP; rate limits on sign-in and on the API; Zod validation on every request body;
role checks on the server for every admin route; parameterised SQL throughout; the public
pass endpoint deliberately exposes the minimum and no email addresses; the database
enforces overlap rather than trusting the client.

Not yet done, and worth doing before a wide rollout: password complexity policy, forced
rotation of the bootstrap admin password, and a private endpoint for PostgreSQL instead of
the "allow Azure services" firewall rule.

---

## Where this goes next

1. **Entra ID single sign-on.** Authentication is already behind one middleware
   (`requireAuth`) and one session issuer. Swapping the login route for the MSAL
   authorisation-code flow and mapping an AD group to the `admin` role is a contained
   change; the rest of the app does not move. Removes password management entirely.
2. **Outlook calendar invites.** Send a real `.ics` on approval, or write straight to the
   room mailbox with Microsoft Graph, so bookings appear in people's calendars.
3. **Check-in and auto-release.** If nobody confirms within ten minutes, release the room.
   This is where the utilisation numbers become honest — no-shows are the real cost.
4. **Recurring bookings** (weekly standups) — the exclusion constraint already handles the
   collision case, the work is in the UI and expansion logic.
5. **Utilisation reporting** for facilities: peak hours, rooms that are always full, rooms
   nobody uses, department-wise split.
6. **Teams notification** alongside email, using the same outbox and one more driver.
