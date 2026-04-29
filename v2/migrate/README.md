# Lead pipeline — migrations

Two migration paths to Firestore leads — pick whichever auth your account allows.

## ⭐ migrate-ical-leads.mjs (OAuth-free, recommended)

Parses a `.ics` calendar export. **Zero Calendar API auth needed** — only
Firestore write perms (covered by your existing gcloud ADC `cloud-platform`
scope). Use this when Google blocks the Calendar OAuth scope on your account.

### Get the .ics file

1. Open Google Calendar → ⚙️ → **Settings**
2. **Import & export** (left nav) → **Export** → downloads a `.zip`
3. Unzip — you get one `.ics` per calendar (e.g. `msmobileapps@gmail.com.ics`)

### Run

```bash
cd v2/migrate
npm install   # one-time

# Dry run first
ICS_PATH="$HOME/Downloads/msmobileapps@gmail.com.ics" \
  TARGET_OWNER_EMAIL=michal@msapps.mobi DRY_RUN=1 \
  node migrate-ical-leads.mjs

# Real import
ICS_PATH="$HOME/Downloads/msmobileapps@gmail.com.ics" \
  TARGET_OWNER_EMAIL=michal@msapps.mobi \
  node migrate-ical-leads.mjs
```

Idempotent — re-running upserts in place by `source.eventId` (iCal UID).

---

## migrate-calendar-leads.mjs (live Google Calendar API)

Imports Google Calendar events into Firestore as lead documents.

### One-time setup on the Mac that runs this

```bash
# Authenticate gcloud ADC with calendar + cloud-platform scopes.
# Choose msmobileapps@gmail.com when the browser opens.
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/calendar.readonly,\
https://www.googleapis.com/auth/cloud-platform,email,openid

# Install migration deps
cd v2/migrate
npm install
```

### Run

```bash
# Dry run first — see what events would be imported without writing
TARGET_OWNER_EMAIL=michal@msapps.mobi \
  SOURCE_CAL_ID=primary \
  DRY_RUN=1 \
  node migrate-calendar-leads.mjs

# Real run
TARGET_OWNER_EMAIL=michal@msapps.mobi \
  SOURCE_CAL_ID=primary \
  node migrate-calendar-leads.mjs
```

### Knobs

| Env var | Default | Notes |
|---|---|---|
| `TARGET_OWNER_EMAIL` | (required) | Sets `ownerEmail` on every imported lead |
| `SOURCE_CAL_ID` | `primary` | The Google calendar id (try a specific calendar like `leads@msmobileapps.iam.gserviceaccount.com` if you keep leads in their own calendar) |
| `FIREBASE_PROJECT_ID` | `opsagent-prod` | Firestore destination |
| `TIME_MIN` | 1 year ago | ISO-8601 cutoff. Override to import older events. |
| `DRY_RUN` | unset | Set to `1` to log without writing |

### What gets mapped

- `summary` → `name`
- `description` (HTML stripped) → `rawNotes`
- `start.dateTime` (or `start.date`) → `date`
- First non-self attendee → `contactEmail`
- `attachments[]` → `attachments[]`
- `id` → `source.eventId` (used for idempotent upsert)

Stage and heat are inferred from the event title (Hebrew + English keywords like "הצעה / proposal", "חם / hot"). Defaults: `ליד חדש`, `normal`.

### Idempotent

Re-running the script updates existing leads in place (matched by `source.eventId` + `ownerEmail`) instead of creating duplicates.
