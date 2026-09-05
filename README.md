# Bed Sync AI SMS Agent

Next.js app at **sms.bed-sync.com**. Runs the SMS assistant that talks to
mattress shoppers on behalf of independent dealers, and the dashboard where a
dealer reads those conversations and manages their appointments.

Separate deploy from the main Bed Sync app (`C:\Users\13183\Bed_Sync`), separate
database (Supabase). The two are linked by `dealers.bedsync_user_id`.

```bash
git push origin master && npx vercel --prod
```

Verify a deploy by hitting the thing you changed — `vercel ls` ages can be
stale, and a clean exit code only describes the build.

---

## Who is speaking

**Bed Sync sends every message; the dealer never does.** This is not a style
preference — it is what the 10DLC campaign declares, and the filing has to
match the traffic. `src/lib/agent/system-prompt.ts` opens with a WHO IS SPEAKING
block that overrides the examples, and every example is third person: "they",
"their store", never "we" or "our".

If the agent ever starts writing as the dealer, the campaign registration stops
describing reality. Protect this on any prompt edit.

---

## Appointments

### Three guards, checked before the agent speaks and again at the write

| Guard | Stored as |
|---|---|
| Weekly hours | `settings.day_hours` — per day, in the dealer's timezone |
| Time off | `settings.blackouts` — ISO ranges, whole days or part days |
| No double booking | overlap against that dealer's `scheduled`/`confirmed` rows |

`orchestrator.ts` puts booked slots and blackouts for the next 21 days into the
prompt, so the agent does not offer a time it cannot keep. The guard at the
write is the backstop, and logs which rule refused: `outside_business_hours`,
`dealer_unavailable`, `slot_already_booked`.

> ⚠️ A dealer with no `day_hours` falls through to a hardcoded **9–6 every day,
> including Sunday** (`business-hours.ts`). That is a default, not a choice.
> Set real hours with every new dealer.

### The availability editor

`src/app/admin/appointments/AvailabilityPanel.tsx`. Weekly hours and a month
calendar for time off, split the way Calendly and Cal.com split it: the
recurring schedule is set once, exceptions are what a dealer touches often.
Clicking a day offers the whole day or specific hours.

Pickers give store-local wall clock and are converted with
`zonedWallClockToUtcIso()` — the same call the agent uses on a time a customer
gives it, so a block means the same instant to both.

### Manual appointments

`POST /api/appointments` with `customer_name` / `phone` instead of a
conversation. `conversation_id` and `lead_id` are NOT NULL, so it creates both.

- The conversation is created **`closed`**, a status `reminders.ts` skips. A
  dealer typing a customer's number into a booking box is not SMS consent.
- No phone stores a **non-numeric placeholder**, which can never match an
  inbound message and pull a stranger into someone's thread.
- A clash returns **409 before anything is written**.

### Daily reminder to the dealer

`/api/cron/daily-appointments`, **hourly**. Each run asks which dealers read 8am
on their own clock. Skips demo dealers, no alert number, nothing booked, and
already-sent-today (`settings.last_daily_digest`).

Sends from `DEALER_ALERT_FROM` (default `+18335292631`). That number's toll-free
verification declares App Notifications going "exclusively to the dealer"; a
dealer's local number is registered under the 10DLC campaign for **customer**
conversations. Do not send dealer alerts from it.

---

## API authentication

Every route is dealer-scoped. `src/lib/api-auth.ts`:

- **`canAccessDealer(req, dealerId)`** — the token must resolve to *that* dealer
  or a Bed Sync super-admin. A valid token alone is deliberately not enough: it
  says who is asking, not which dealer they are.
- **`dealerIdForConversation` / `dealerIdForAppointment`** — for routes that
  take only a record id.
- **`hasInternalSecret(req)`** — server-to-server, and **fails closed**.
  `secret !== process.env.X` is false when both are undefined, which would turn
  an unset env into a public endpoint.

> ⚠️ Adding auth to a route means **the pages calling it must send a token**.
> Eleven admin calls broke silently the first time and rendered as
> "Conversation not found". Use **`adminFetch()`** from `src/lib/admin-fetch.ts`
> for every `/api/` call except `/api/auth/verify`, which takes the token in the
> body.

Public by design: the Telnyx and Twilio webhooks (signature-verified) and
`/api/leads/create` (storefront inquiry forms, with `notify_phone` gated behind
the internal secret).

---

## Dealer settings worth knowing

| Key | Effect |
|---|---|
| `appointment_only` | Agent keeps inviting people in but never implies walk-in |
| `demo` | Never sends a real message. Two seeded dealers rely on this |
| `ships_nationwide` | Allows a delivery conversation with no store nearby |
| `day_hours`, `blackouts` | Availability, above |
| `lead_notify_phone` | Where dealer alerts go |
| `auto_reply` | Master switch. Off means the agent answers nobody |

Styling follows the Bed Sync dealer admin (`admin-styles.css`): black page,
`#111` cards, `#2a2a2a` borders, `#dc2626` accent. Tailwind exposes these as
`ink-*` and `brand-*`.

---

**Last updated:** 2026-09-05
