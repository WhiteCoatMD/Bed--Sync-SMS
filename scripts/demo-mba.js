// MBA demo dataset: reset and/or seed the demo dealer with a believable board.
// Usage:  node demo-mba.js --reset          wipe everything on the demo dealer
//         node demo-mba.js --seed           add the demo dataset
//         node demo-mba.js                  reset then seed (clean demo state)
//
// Writes straight to the databases, so NO texts are sent. Every customer number
// is a 555 test number that cannot reach a real person.
const fs = require('fs');
const { Pool } = require('C:/Users/13183/Bed_Sync/node_modules/pg');

for (const f of ['C:/Users/13183/Bed_Sync/.env.local', 'C:/Users/13183/bed-sync-ai-sms/.env.sms-production']) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const DEALER = '8ab69009-f223-4a1f-91c2-794e84dfb701';
const MAIN_USER = 21;
const U = process.env.NEXT_PUBLIC_SUPABASE_URL, K = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const pool = new Pool({ connectionString: process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });

const get = async (p) => (await fetch(`${U}/rest/v1/${p}`, { headers: h })).json();
const post = async (t, b) => {
  const r = await fetch(`${U}/rest/v1/${t}`, { method: 'POST', headers: h, body: JSON.stringify(b) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`${t}: ${JSON.stringify(j)}`);
  return j[0];
};
const del = async (p) => {
  const r = await fetch(`${U}/rest/v1/${p}`, { method: 'DELETE', headers: h });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j.length : 0;
};

/** Store-local wall clock (America/New_York) -> UTC ISO. */
function localToUtc(daysAhead, hour, minute = 0) {
  const base = new Date(Date.now() + daysAhead * 86400000);
  const y = base.getFullYear(), mo = base.getMonth(), d = base.getDate();
  // EDT is UTC-4 in August; resolve properly rather than assuming.
  const guess = new Date(Date.UTC(y, mo, d, hour, minute));
  const local = new Date(guess.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utcSame = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = utcSame.getTime() - local.getTime();
  return new Date(guess.getTime() + offsetMs).toISOString();
}
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

// ---------------------------------------------------------------- the dataset
// Five customers at different points in the funnel, so the dashboard tells a
// story: someone just landed, someone is being qualified, someone is looking at
// options, two are booked, one went quiet and is being followed up.
const CAST = [
  {
    name: 'Danielle Prescott', phone: '+15550123301', email: 'danielle.p@example.com',
    state: 'recommending', status: 'qualifying', score: 65,
    context: { customer_name: 'Danielle Prescott', mattress_size: 'queen', sleeping_position: 'side', firmness: 'medium_soft' },
    minutesAgo: 22,
    messages: [
      ['inbound', "Hi! I was just on your website and I'd like more info about your mattresses."],
      ['outbound', "Hey Danielle! This is Mattress By Appointment Demo City. Happy to help! What's bugging you about your current mattress?"],
      ['inbound', 'My shoulder goes numb at night'],
      ['outbound', "That's usually pressure build-up. Do you sleep on your side?"],
      ['inbound', 'Yeah mostly my side'],
      ['outbound', "Side sleepers need pressure relief at the shoulders and hips. Three that fit: Mystical Copper (memory foam, hugs you), Blissful (deep pressure relief), Divine (plush pillow top). What size — twin, full, queen or king?"],
      ['inbound', 'Queen'],
      ['outbound', "Perfect. All three come in queen. Honestly the only way to know is to lie on them — want me to set up a time to come try them?"],
    ],
  },
  {
    name: 'Marcus Bell', phone: '+15550123302', email: 'mbell@example.com',
    state: 'closing', status: 'hot', score: 85, appointment: { days: 1, hour: 11, type: 'showroom_visit' },
    context: { customer_name: 'Marcus Bell', mattress_size: 'king', sleeping_position: 'back', firmness: 'medium_firm' },
    minutesAgo: 95,
    messages: [
      ['inbound', 'Do you have anything for lower back pain?'],
      ['outbound', "Hey! This is Mattress By Appointment Demo City. Lower back pain usually means your mattress lost its support. Do you sleep on your back?"],
      ['inbound', 'Back sleeper, king bed'],
      ['outbound', "For a back sleeper in a king: Angelic Luxury Firm Cooling Hybrid, Dreamy (hybrid, great support), or Radiant Medium. Which sounds best? Want to come try them?"],
      ['inbound', 'Can I come by tomorrow morning'],
      ['outbound', "Absolutely — how's 11am?"],
      ['inbound', 'Works for me'],
      ['outbound', "You're all set for tomorrow at 11am! We're at 123 Main St, Port Orange, FL 32127. See you then."],
    ],
  },
  {
    name: 'Priya Raman', phone: '+15550123303', email: 'praman@example.com',
    state: 'closing', status: 'hot', score: 80, appointment: { days: 2, hour: 14, type: 'showroom_visit' },
    context: { customer_name: 'Priya Raman', mattress_size: 'full', sleeping_position: 'combo', firmness: 'medium' },
    minutesAgo: 210,
    messages: [
      ['inbound', "Hi! I was just on your website and I'd like more info about your mattresses."],
      ['outbound', "Hey Priya! This is Mattress By Appointment Demo City. What are you looking for?"],
      ['inbound', 'Guest room bed, nothing fancy but comfortable'],
      ['outbound', "Got it — full size? For a guest room the Blissful ET and Star Euro Top are both comfortable all-rounders."],
      ['inbound', 'Full yes. Can I come Monday afternoon?'],
      ['outbound', "Absolutely — how's 2pm?"],
      ['inbound', 'Monday at 2 is good'],
      ['outbound', "You're all set for Monday at 2pm! We're at 123 Main St, Port Orange, FL 32127. See you then."],
    ],
  },
  {
    name: 'Terrence Wu', phone: '+15550123304', email: 'twu@example.com',
    state: 'follow_up', status: 'qualifying', score: 45,
    context: { customer_name: 'Terrence Wu', mattress_size: 'queen', sleeping_position: 'stomach', firmness: 'firm' },
    minutesAgo: 2760,
    messages: [
      ['inbound', 'whats your cheapest queen'],
      ['outbound', "Hey! This is Mattress By Appointment Demo City. We don't quote prices over text — you get our real pricing in person, and honestly you should feel these before you decide. For a stomach sleeper the Paradise Super Firm is the one I'd start with. Want to come try it?"],
      ['inbound', 'maybe next week'],
      ['outbound', "Sounds good! I'll check back — what day usually works for you?"],
    ],
  },
  {
    name: 'Sandra Oyelaran', phone: '+15550123305', email: 'soyelaran@example.com',
    state: 'greeting', status: 'new', score: 15,
    context: { customer_name: 'Sandra Oyelaran' },
    minutesAgo: 6,
    messages: [
      ['inbound', "Hi! I was just on your website and I'd like more info about your mattresses."],
      ['outbound', "Hey Sandra! This is Mattress By Appointment Demo City. Great to hear from you! What's going on with your current mattress — anything bugging you, or just ready for an upgrade?"],
    ],
  },
];

async function reset() {
  let convs = 0, msgs = 0, logs = 0, appts = 0, leads = 0;
  for (const l of await get(`leads?dealer_id=eq.${DEALER}&select=id`)) {
    for (const c of await get(`conversations?lead_id=eq.${l.id}&select=id`)) {
      appts += await del(`appointments?conversation_id=eq.${c.id}`);
      msgs += await del(`messages?conversation_id=eq.${c.id}`);
      logs += await del(`agent_logs?conversation_id=eq.${c.id}`);
      await del(`recommendations?conversation_id=eq.${c.id}`);
      convs++;
    }
    await del(`conversations?lead_id=eq.${l.id}`);
    leads += await del(`leads?id=eq.${l.id}`);
  }
  const main = await pool.query('SELECT id FROM leads WHERE user_id = $1', [MAIN_USER]);
  for (const row of main.rows) {
    await pool.query('DELETE FROM nurture_events WHERE lead_id = $1', [row.id]);
    await pool.query('DELETE FROM nurture_queue WHERE lead_id = $1', [row.id]);
    await pool.query('DELETE FROM leads WHERE id = $1', [row.id]);
  }
  console.log(`reset: sms ${leads} leads / ${convs} conversations / ${msgs} messages / ${logs} logs / ${appts} appointments; main app ${main.rowCount} leads`);
}

async function seed() {
  let appts = 0;
  for (const person of CAST) {
    const created = ago(person.minutesAgo);
    const lead = await post('leads', {
      dealer_id: DEALER, phone: person.phone, customer_name: person.name, email: person.email,
      source: 'website', status: person.status, lead_score: person.score, created_at: created,
    });
    const conv = await post('conversations', {
      lead_id: lead.id, dealer_id: DEALER, status: 'active',
      agent_state: person.state, context: person.context, created_at: created,
    });

    // Space the messages out across the conversation so timestamps look real.
    const span = Math.max(person.messages.length * 2, 8);
    person.messages.forEach(() => {});
    for (let i = 0; i < person.messages.length; i++) {
      const [direction, body] = person.messages[i];
      const at = new Date(new Date(created).getTime() + (i * span * 60000) / person.messages.length).toISOString();
      await post('messages', {
        conversation_id: conv.id, direction,
        sender: direction === 'inbound' ? 'customer' : 'agent', body, created_at: at,
      });
    }

    // The conversation list renders "N msgs" from message_count, which the
    // app maintains via an RPC on send. Seeding rows directly bypasses that,
    // so set it here or every demo conversation reads "0 msgs".
    await fetch(`${U}/rest/v1/conversations?id=eq.${conv.id}`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ message_count: person.messages.length }),
    });

    await post('agent_logs', {
      conversation_id: conv.id, action: 'message_received',
      details: { source: 'website', is_new: true, demo: true }, created_at: created,
    });

    if (person.appointment) {
      const when = localToUtc(person.appointment.days, person.appointment.hour);
      await post('appointments', {
        conversation_id: conv.id, dealer_id: DEALER, lead_id: lead.id,
        type: person.appointment.type, scheduled_at: when, duration_minutes: 30,
        status: 'scheduled', created_by: 'agent',
        notes: `${person.name} — ${person.context.sleeping_position || 'unknown'} sleeper, ${person.context.mattress_size || 'size TBD'}.`,
      });
      appts++;
    }

    // Mirror onto the main app so the dealer dashboard shows the same board.
    await pool.query(
      `INSERT INTO leads (user_id, customer_name, customer_email, customer_phone, notes, source, status, is_seed, created_at)
       VALUES ($1,$2,$3,$4,$5,'website',$6,false,$7)`,
      [MAIN_USER, person.name, person.email, person.phone.replace('+1', ''),
       `AI SMS agent — ${person.state.replace(/_/g, ' ')}`, person.status === 'qualified' ? 'new' : 'new', created]
    );
    console.log(`  seeded ${person.name.padEnd(20)} ${person.state.padEnd(13)} ${person.appointment ? 'appointment booked' : ''}`);
  }

  // Closed sales, so the store reads as a working business rather than a
  // brand-new account with no revenue. These are the figures the franchisor
  // dashboard sums, so without them the network view shows Demo City at $0.
  // is_seed = true, which is what drives the "sample data" banner.
  const SALES = [
    ['Rebecca Lindqvist', 'rlindqvist@example.com', '5550123311', 1899.00, 6],
    ['Dwight Abernathy',  'dabernathy@example.com', '5550123312', 1249.00, 12],
    ['Yolanda Marsh',     'ymarsh@example.com',     '5550123313', 2399.00, 19],
  ];
  let revenue = 0;
  for (const [name, email, phone, amount, daysAgo] of SALES) {
    await pool.query(
      `INSERT INTO leads (user_id, customer_name, customer_email, customer_phone, notes,
                          source, status, sold_amount, is_seed, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'website','sold',$6,true,
               NOW() - ($7 || ' days')::interval, NOW() - ($7 || ' days')::interval)`,
      [MAIN_USER, name, email, phone, 'Booked by the AI agent, closed in store', amount, String(daysAgo)]
    );
    revenue += amount;
  }
  console.log(`  seeded ${SALES.length} closed sales — ${revenue.toLocaleString()} revenue`);

  console.log(`seed: ${CAST.length} conversations, ${appts} upcoming appointments`);
}

(async () => {
  const args = process.argv.slice(2);
  const doReset = args.includes('--reset') || args.length === 0;
  const doSeed = args.includes('--seed') || args.length === 0;
  if (doReset) await reset();
  if (doSeed) await seed();
  const left = await get(`leads?dealer_id=eq.${DEALER}&select=id`);
  const ap = await get(`appointments?dealer_id=eq.${DEALER}&select=id,scheduled_at,status`);
  console.log(`\nnow on the demo dealer: ${left.length} leads, ${ap.length} appointments`);
  for (const a of ap) console.log('   ', a.scheduled_at, a.status);
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
