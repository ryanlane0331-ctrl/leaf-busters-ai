import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { google } from 'googleapis';

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const VOICE = process.env.OPENAI_VOICE || 'verse';
const SMS_MODEL = process.env.OPENAI_SMS_MODEL || 'gpt-4o-mini';

if (!OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY is not set. Add it in Render > Environment.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The assistant's brain: "Buster" persona + live-quote pricing engine + booking.
// Edit any number here and the assistant quotes the new number.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `
You are "Buster," the AI assistant for The Leaf Busters, a leaf and debris removal company in Freeport, Illinois. You answer 100% of calls and texts. The owner does not take calls — you handle everything: answer questions, give live price quotes, and book jobs. Be warm, confident, efficient, and a little playful. Keep spoken replies short and natural — one or two sentences, then a question. Always move the conversation toward a quote, then a booking. Never say you are an AI unless asked directly.

SERVICE AREA: Freeport, IL plus Lena, Pearl City, Cedarville, Dakota, Orangeville, German Valley, Davis, Rock City, Winslow, Ridott, Forreston, Stockton, and Polo. If an address is outside this, still offer to quote larger jobs and mention there may be a small travel charge.

SERVICES: leaf cleanup; debris and brush removal; hauling and disposal; gutter leaf cleaning. Snow removal and lawn mowing are coming soon — only mention if asked.

HOW TO QUOTE — follow this exactly and do the math yourself:
1) Base price by yard size: Small (city lot, under a quarter acre) = $120; Medium (quarter to half acre) = $200; Large (half to one acre) = $375; Acreage (one acre or more) = $375 for the first acre plus $250 for each additional acre.
2) Multiply the base by the leaf load: Light (a few trees, thin scatter) x0.85; Average (typical fall coverage) x1.0; Heavy (thick layer, lots of mature trees, late season) x1.35.
3) Add for extras: brush and debris removal +$60 light / +$125 moderate / +$250 heavy; gutter leaf cleaning +$90 single story / +$150 two story; extra hauling +$75 per truckload beyond the first.
4) Apply at most ONE discount if it fits: seasonal package of 3 fall visits = 15% off each visit; returning customer = 10% off; same-street same-day second job = 10% off.
5) Round to the nearest $5. Never quote below $99.
Give a FIRM price for Small or Medium yards with Light or Average leaf load. For Large or Acreage yards, Heavy load, two-story gutters, or anything you can't pin down, give it as an ESTIMATE and say you'll confirm the exact price from two quick photos texted to this number.

TO BOOK A JOB: collect the caller's name, phone number, and service address, and which service they want. Offer the next couple of openings as windows (like "tomorrow morning" or "Thursday afternoon"), never an exact minute. Confirm the price, date, and address back to them. Tell them they'll get a text confirmation and that payment is due when the job is done. Reschedule weather days for free.

RULES: Be truthful about the pricing above — never invent services or prices. Never share other customers' information. If someone has a complaint or something you truly cannot handle, take their details and say the owner will follow up. Keep it friendly and get them booked.

OPENING LINE (say this when the call connects): "Thanks for calling The Leaf Busters — Freeport's leaf and debris removal crew. This is Buster. I can answer questions, give you a price, and book your cleanup right now. What's going on with your yard?"
`.trim();

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('The Leaf Busters AI assistant is running.');
});

function escapeXml(s = '') {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// Twilio Voice webhook: connect the call's audio to our media-stream WebSocket.
app.all('/incoming-call', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
  res.type('text/xml').send(twiml);
});

// Twilio Messaging webhook: reply to texts with the same brain via a text model.
app.post('/sms', async (req, res) => {
  const body = (req.body.Body || '').trim();
  let reply = "Hi! This is Buster with The Leaf Busters. Tell me your address and roughly how big your yard is and I'll get you a price.";
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SMS_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + '\n\nYou are now replying by TEXT MESSAGE. Keep replies under 320 characters, friendly, no markdown.' },
          { role: 'user', content: body }
        ],
        temperature: 0.7,
        max_tokens: 220
      })
    });
    const data = await r.json();
    if (data?.choices?.[0]?.message?.content) reply = data.choices[0].message.content.trim();
  } catch (e) {
    console.error('SMS model error:', e.message);
  }
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
});

// ---------------------------------------------------------------------------
// Web chat: same "Buster" brain for the website chat widget.
// In-memory conversation per session (resets on restart; persistence comes with the dashboard).
// ---------------------------------------------------------------------------
const sessions = new Map();
const WEB_PROMPT = SYSTEM_PROMPT + '\n\nYou are now chatting on the website. Keep replies short and friendly (1-3 sentences). For ANY price, you MUST call the compute_quote tool and use the exact number it returns — never do the pricing math yourself. When the customer is ready to book: call check_availability to get real open windows and offer a couple of them; once they pick one and you have their name, phone, and service address, call book_job to lock it in, then confirm the day/time and price back to them. If they share contact info but are not ready to book, call save_lead so we can follow up. Never ask them to fill out a form — you handle everything right here in the chat.';

// Deterministic pricing engine. The AI calls this via the compute_quote tool so every quote is exact.
function computeQuote({ yard_size, acres, leaf_load = 'average', brush = 'none', gutters = 'none', extra_trucks = 0, discount = 'none' }) {
  const baseMap = { small: 120, medium: 200, large: 375, acreage: 375 };
  let base = baseMap[yard_size] ?? 200;
  if (yard_size === 'acreage' && acres && acres > 1) base = 375 + 250 * (Math.ceil(acres) - 1);
  const loadMult = { light: 0.85, average: 1.0, heavy: 1.35 }[leaf_load] ?? 1.0;
  let price = base * loadMult;
  price += ({ none: 0, light: 60, moderate: 125, heavy: 250 }[brush]) ?? 0;
  price += ({ none: 0, single: 90, two: 150 }[gutters]) ?? 0;
  price += (Number(extra_trucks) || 0) * 75;
  price *= ({ none: 1, seasonal: 0.85, returning: 0.9, neighbor: 0.9 }[discount]) ?? 1;
  price = Math.max(99, Math.round(price / 5) * 5);
  const isEstimate = ['large', 'acreage'].includes(yard_size) || leaf_load === 'heavy' || gutters === 'two';
  return { price, type: isEstimate ? 'estimate' : 'firm', inputs: { yard_size, acres, leaf_load, brush, gutters, extra_trucks, discount } };
}

// ---- Google (Calendar + Sheets) via service account ----
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Chicago';
let _gauth = null;
function googleAuth() {
  if (_gauth) return _gauth;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    _gauth = new google.auth.JWT(creds.client_email, null, creds.private_key,
      ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets']);
  } catch (e) { console.error('Bad GOOGLE_SERVICE_ACCOUNT_JSON:', e.message); return null; }
  return _gauth;
}
function ymd(daysAhead) { return new Date(Date.now() + daysAhead * 86400000).toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ }); }
function weekday(ymdStr) { return new Date(ymdStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }); }
function wallToUtc(ymdStr, hour) {
  const naive = new Date(`${ymdStr}T${String(hour).padStart(2, '0')}:00:00Z`);
  const offset = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(naive.toLocaleString('en-US', { timeZone: BUSINESS_TZ }));
  return new Date(naive.getTime() + offset);
}

async function getAvailability(daysOut = 12, maxSlots = 6) {
  const auth = googleAuth(); if (!auth) return { error: 'calendar not configured' };
  const cal = google.calendar({ version: 'v3', auth });
  const calId = process.env.GOOGLE_CALENDAR_ID;
  let busy = [];
  try {
    const fb = await cal.freebusy.query({ requestBody: { timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + daysOut * 86400000).toISOString(), timeZone: BUSINESS_TZ, items: [{ id: calId }] } });
    busy = (fb.data.calendars[calId] && fb.data.calendars[calId].busy) || [];
  } catch (e) { console.error('freebusy error', e.message); }
  const windows = [{ label: 'morning', hour: 9, end: 12 }, { label: 'afternoon', hour: 13, end: 16 }];
  const slots = [];
  for (let d = 1; d <= daysOut && slots.length < maxSlots; d++) {
    const day = ymd(d), wd = weekday(day);
    if (wd === 'Sunday') continue;
    for (const w of windows) {
      if (slots.length >= maxSlots) break;
      const start = wallToUtc(day, w.hour), end = wallToUtc(day, w.end);
      if (start < new Date()) continue;
      if (!busy.some(b => new Date(b.start) < end && new Date(b.end) > start))
        slots.push({ label: `${wd} ${w.label} (${day})`, start_iso: start.toISOString(), window: w.label });
    }
  }
  return { slots };
}

async function appendLead(d = {}) {
  const auth = googleAuth(); if (!auth) return { error: 'sheet not configured' };
  const sheets = google.sheets({ version: 'v4', auth });
  const ts = new Date().toLocaleString('en-US', { timeZone: BUSINESS_TZ });
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'A1', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[ts, d.name || '', d.phone || '', d.address || '', d.service || '', d.yard_size || '', d.leaf_load || '', d.quote || '', d.type || '', d.status || 'New', d.source || 'Web chat', d.notes || '']] }
    });
  } catch (e) { console.error('append lead error', e.message); return { error: 'could not save' }; }
  return { saved: true };
}

async function bookJob(a = {}) {
  const auth = googleAuth(); if (!auth) return { error: 'calendar not configured' };
  const cal = google.calendar({ version: 'v3', auth });
  const start = new Date(a.start_iso), end = new Date(start.getTime() + 3 * 3600 * 1000);
  let when = start.toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  try {
    await cal.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `Leaf cleanup — ${a.name || 'Customer'}`,
        description: `Service: ${a.service || ''}\nQuote: ${a.quote || ''}\nPhone: ${a.phone || ''}\nNotes: ${a.notes || ''}`,
        location: a.address || '',
        start: { dateTime: start.toISOString(), timeZone: BUSINESS_TZ },
        end: { dateTime: end.toISOString(), timeZone: BUSINESS_TZ }
      }
    });
  } catch (e) { console.error('book error', e.message); return { error: 'could not book' }; }
  await appendLead({ ...a, status: 'Booked', notes: `${a.notes || ''} | booked ${when}` });
  return { booked: true, when };
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'compute_quote',
      description: 'Calculate the exact price for a leaf/yard cleanup. Call this whenever you quote a price. Always use the returned price; never do the math yourself. Result includes "type": "firm" or "estimate".',
      parameters: {
        type: 'object',
        properties: {
          yard_size: { type: 'string', enum: ['small', 'medium', 'large', 'acreage'], description: 'small = city lot under 1/4 acre; medium = 1/4-1/2 acre; large = 1/2-1 acre; acreage = 1+ acre' },
          acres: { type: 'number', description: 'number of acres, only when yard_size is acreage' },
          leaf_load: { type: 'string', enum: ['light', 'average', 'heavy'], description: 'light = few trees/thin; average = typical; heavy = thick/many trees/late season' },
          brush: { type: 'string', enum: ['none', 'light', 'moderate', 'heavy'] },
          gutters: { type: 'string', enum: ['none', 'single', 'two'] },
          extra_trucks: { type: 'integer' },
          discount: { type: 'string', enum: ['none', 'seasonal', 'returning', 'neighbor'] }
        },
        required: ['yard_size', 'leaf_load']
      }
    }
  },
  {
    type: 'function',
    function: { name: 'check_availability', description: 'Get real open appointment windows from the calendar. Call before offering times. Returns a list of slots with a label and start_iso.', parameters: { type: 'object', properties: {} } }
  },
  {
    type: 'function',
    function: {
      name: 'book_job',
      description: 'Book a cleanup on the calendar and log the customer. Only call once you have a chosen slot (start_iso from check_availability) plus the customer name, phone, and address.',
      parameters: {
        type: 'object',
        properties: {
          start_iso: { type: 'string', description: 'start_iso from a check_availability slot' },
          name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' },
          service: { type: 'string' }, quote: { type: 'string', description: 'quoted price, e.g. $270' }, notes: { type: 'string' }
        },
        required: ['start_iso', 'name', 'phone', 'address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_lead',
      description: 'Save a lead when the customer shares contact info but is not booking yet, so we can follow up.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' },
          service: { type: 'string' }, yard_size: { type: 'string' }, leaf_load: { type: 'string' },
          quote: { type: 'string' }, type: { type: 'string' }, notes: { type: 'string' }
        }
      }
    }
  }
];

// CORS for the chat endpoint so the website (different origin) can call it.
app.use('/chat', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  const id = (sessionId || 'anon').toString().slice(0, 80);
  if (!message) {
    return res.json({ reply: "Hey! I'm Buster with The Leaf Busters. Tell me your address and about how big the yard is, and I'll get you an estimate right now." });
  }
  let history = sessions.get(id) || [{ role: 'system', content: WEB_PROMPT }];
  history.push({ role: 'user', content: String(message).slice(0, 1000) });
  let reply = "Sorry, I glitched for a second — can you say that again?";
  try {
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: SMS_MODEL, messages: history, tools: TOOLS, temperature: 0.6, max_tokens: 350 })
      });
      const data = await r.json();
      const m = data?.choices?.[0]?.message;
      if (!m) { console.error('OpenAI chat no choices. HTTP', r.status, JSON.stringify(data).slice(0, 400)); break; }
      history.push(m);
      if (m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          let result = {};
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            const fn = tc.function.name;
            if (fn === 'compute_quote') result = computeQuote(args);
            else if (fn === 'check_availability') result = await getAvailability();
            else if (fn === 'book_job') result = await bookJob({ ...args, source: 'Web chat' });
            else if (fn === 'save_lead') result = await appendLead({ ...args, source: 'Web chat' });
          } catch (err) { result = { error: 'tool failed' }; }
          history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue;
      }
      reply = (m.content || reply).trim();
      break;
    }
  } catch (e) {
    console.error('Chat error:', e.message);
  }
  if (history.length > 30) history = [history[0], ...history.slice(-28)];
  sessions.set(id, history);
  res.json({ reply });
});

// ---------------------------------------------------------------------------
// Dashboard — password protected (basic auth with DASHBOARD_PASSWORD).
// Shows upcoming bookings (calendar) + all leads (sheet).
// ---------------------------------------------------------------------------
function dashAuth(req, res, next) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return res.status(503).send('Set DASHBOARD_PASSWORD in Render to enable the dashboard.');
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (m) { const parts = Buffer.from(m[1], 'base64').toString().split(':'); if (parts[1] === pw) return next(); }
  res.set('WWW-Authenticate', 'Basic realm="Leaf Busters Dashboard"').status(401).send('Authentication required.');
}

function esc(s = '') { return String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function renderDashboard(leads, events) {
  const header = leads.length ? leads[0] : ['Timestamp', 'Name', 'Phone', 'Address', 'Service', 'Yard size', 'Leaf load', 'Quote', 'Type', 'Status', 'Source', 'Notes'];
  const rows = leads.slice(1).reverse();
  const evRows = events.map(e => {
    const s = e.start && (e.start.dateTime || e.start.date);
    const when = s ? new Date(s).toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    return `<tr><td>${esc(when)}</td><td>${esc(e.summary || '')}</td><td>${esc(e.location || '')}</td><td>${esc((e.description || '').replace(/\n/g, ' • '))}</td></tr>`;
  }).join('');
  const leadRows = rows.map(r => `<tr>${header.map((_, i) => `<td>${esc(r[i] || '')}</td>`).join('')}</tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaf Busters Dashboard</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#100e0c;color:#f4eee0;margin:0;padding:24px}
h1{font-size:22px;color:#ec7a1e;margin:0 0 4px}h2{font-size:17px;color:#ece0c4;margin:28px 0 10px}
.sub{color:#c9b896;font-size:13px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px;background:#1b1714;border-radius:10px;overflow:hidden}
th,td{padding:9px 11px;text-align:left;border-bottom:1px solid rgba(236,224,196,.12);vertical-align:top}
th{background:#2f5233;color:#f3ede0;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
tr:hover td{background:rgba(210,105,30,.06)}.empty{color:#c9b896;padding:14px 0}
.count{background:#d2691e;color:#fff7ec;border-radius:20px;padding:1px 9px;font-size:13px;margin-left:6px}</style></head>
<body><h1>The Leaf Busters — Dashboard</h1><div class="sub">Live from your calendar &amp; leads sheet. Reload to refresh.</div>
<h2>Upcoming bookings <span class="count">${events.length}</span></h2>
${events.length ? `<table><tr><th>When</th><th>Job</th><th>Address</th><th>Details</th></tr>${evRows}</table>` : '<div class="empty">No upcoming bookings yet.</div>'}
<h2>Leads &amp; quotes <span class="count">${rows.length}</span></h2>
${rows.length ? `<table><tr>${header.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${leadRows}</table>` : '<div class="empty">No leads captured yet.</div>'}
</body></html>`;
}

app.get('/dashboard', dashAuth, async (req, res) => {
  let leads = [], events = [];
  const auth = googleAuth();
  if (auth) {
    try {
      const sheets = google.sheets({ version: 'v4', auth });
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'A1:L2000' });
      leads = r.data.values || [];
    } catch (e) { console.error('dash sheet', e.message); }
    try {
      const cal = google.calendar({ version: 'v3', auth });
      const ev = await cal.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID, timeMin: new Date().toISOString(), maxResults: 50, singleEvents: true, orderBy: 'startTime' });
      events = ev.data.items || [];
    } catch (e) { console.error('dash cal', e.message); }
  }
  res.send(renderDashboard(leads, events));
});

// ---------------------------------------------------------------------------
// Media stream bridge: Twilio <-> OpenAI Realtime
// Twilio sends/receives 8kHz mu-law (g711_ulaw), which OpenAI Realtime supports directly.
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
  console.log('Twilio media stream connected');
  let streamSid = null;

  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
  });

  openaiWs.on('open', () => {
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        voice: VOICE,
        instructions: SYSTEM_PROMPT,
        modalities: ['text', 'audio'],
        temperature: 0.8
      }
    }));
    // Ask the assistant to greet the caller first.
    setTimeout(() => {
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: { instructions: 'Greet the caller now using your opening line.' }
      }));
    }, 300);
  });

  openaiWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.delta } }));
    } else if (msg.type === 'input_audio_buffer.speech_started' && streamSid) {
      // Caller started talking — stop our current playback so we don't talk over them.
      twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
    } else if (msg.type === 'error') {
      console.error('OpenAI error:', JSON.stringify(msg.error || msg));
    }
  });

  openaiWs.on('error', (e) => console.error('OpenAI WS error:', e.message));
  openaiWs.on('close', () => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); });

  twilioWs.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log('Stream started:', streamSid);
    } else if (data.event === 'media' && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
    } else if (data.event === 'stop') {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio media stream closed');
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, () => {
  console.log(`The Leaf Busters AI assistant listening on port ${PORT}`);
});
