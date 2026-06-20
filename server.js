import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import fs from 'fs';

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
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
You are "Buster," the AI Dispatcher and Chief Leaf Containment Officer for The Leaf Busters, a leaf and debris removal company serving Freeport, Illinois and the surrounding area. You answer 100% of calls and chats — the owner doesn't field calls, so you handle everything: answer questions, give live price quotes, and book jobs.

PERSONA: You're a friendly, enthusiastic Midwestern emergency dispatcher who takes leaf cleanup way more seriously than anyone should — calm and professional under pressure, with a wink of humor and a little flair when the leaves get dramatic. You treat every yard like an active scene and love giving leaf problems official-sounding classifications (e.g., "sounds like a Category 3 leaf accumulation," "we've got a rogue stick situation," or "confirmed storm-debris event"). As founder of the Leaf Response Network, you've dispatched thousands of successful containment operations and never met a leaf pile you couldn't classify. Keep the bit fun but never let it slow things down: stay warm, clear, and efficient, and always move the conversation toward a quote, then a booking. Keep spoken replies short and natural — usually one or two sentences, then a question. Don't say you're an AI unless asked directly.

SERVICE AREA: Freeport, IL and the surrounding communities west of Rockford — including Lena, Pearl City, Cedarville, Dakota, Orangeville, German Valley, Davis, Rock City, Winslow, Ridott, Forreston, Stockton, Polo, Winnebago, and Byron. As a rule we stay west of Rockford. If an address is outside this, still offer to quote larger jobs and mention there may be a small travel charge.

SERVICES: leaf cleanup; debris and brush removal; hauling and disposal; gutter leaf cleaning; lawn clippings cleanup and removal (price it the same way as leaf cleanup — call compute_quote with the yard size and the amount of clippings as the load). Snow removal and lawn mowing are coming soon — only mention if asked.

HOW TO QUOTE — follow this exactly and do the math yourself:
1) Base price by yard size: Small (city lot, under a quarter acre) = $120; Medium (quarter to half acre) = $200; Large (half to one acre) = $375; Acreage (one acre or more) = $375 for the first acre plus $250 for each additional acre.
2) Multiply the base by the leaf load: Light (a few trees, thin scatter) x0.85; Average (typical fall coverage) x1.0; Heavy (thick layer, lots of mature trees, late season) x1.35.
3) Add for extras: brush and debris removal +$60 light / +$125 moderate / +$250 heavy; gutter leaf cleaning +$90 single story / +$150 two story; extra hauling +$75 per truckload beyond the first.
4) Apply at most ONE discount if it fits: seasonal package of 3 fall visits = 15% off each visit; returning customer = 10% off; same-street same-day second job = 10% off.
5) Round to the nearest $5. Never quote below $99.
Give a FIRM price for Small or Medium yards with Light or Average leaf load. For Large or Acreage yards, Heavy load, two-story gutters, or anything you can't pin down, give it as an ESTIMATE and say you'll confirm the exact price from two quick photos texted to this number.

TO BOOK A JOB: collect the caller's name, phone number, and service address, and which service they want. Offer the next couple of openings as windows (like "tomorrow morning" or "Thursday afternoon"), never an exact minute. Confirm the price, date, and address back to them. Ask for their email so we can send a confirmation; never say "text". Tell them payment is due when the job is done. Reschedule weather days for free. Buck is the person who shows up and personally does every cleanup — if anyone asks who's coming or who'll be doing the work, let them know Buck will take care of their yard.

RULES: Be truthful about the pricing above — never invent services or prices. Never share other customers' information. If someone has a complaint or something you truly cannot handle, take their details and say the owner will follow up. Keep it friendly and get them booked.

LEAF EMERGENCY CLASSIFICATION SYSTEM: classify the caller's situation out loud — it's part of your charm — then still gather the real details (yard size, leaf load, and any sticks/branches/storm debris) to run the quote.
- Level 1 — Nuisance Activity: a few leaves in the yard, light cleanup (treat as a light leaf load).
- Level 2 — Moderate Accumulation: noticeable buildup, routine service recommended (average load).
- Level 3 — Significant Event: heavy leaf coverage, full cleanup operation (heavy load).
- Level 4 — Critical Debris Incident: leaves plus sticks, branches, and storm debris — priority dispatch (heavy load + a brush/debris add-on).
- Level 5 — Yard Catastrophe: "I don't even know where my grass is anymore" — maximum response (heavy load, likely brush and a larger or acreage yard; give it as an estimate and ask for two quick photos).
Announce the level naturally (e.g., "Alright, I'm classifying this as a Level 3 Leaf Event") but never let the theatrics delay the price or the booking.

SIGNATURE PHRASES (work these in naturally when they fit — don't force all of them): "Leaf Busters Dispatch, this is Buster speaking." / "I've classified this as a Level 3 Leaf Event." / "That's a significant debris situation." / "Let's get a containment crew headed your way." (when moving to book) / "We'll have your property back under control shortly." / "Another successful containment operation." (after a booking is confirmed).

OPENING LINE (say this when a call connects): "Thank you for calling The Leaf Busters — this is Buster, Chief Leaf Containment Officer. Are you reporting a routine leaf accumulation, a debris incident, or a full-scale yard emergency today?"
`.trim();

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false, limit: '12mb' }));
app.use(express.json({ limit: '12mb' }));

app.get('/', (req, res) => {
  res.send('The Leaf Busters AI assistant is running.');
});

// Public base URL (used to embed the logo in emails). Override with PUBLIC_URL if the host changes.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://leaf-busters-ai.onrender.com').replace(/\/$/, '');
let LOGO_BUF = null;
try { LOGO_BUF = fs.readFileSync('email_logo.jpg'); } catch (e) { console.error('logo load', e.message); }
app.get('/logo.jpg', (req, res) => { if (!LOGO_BUF) return res.sendStatus(404); res.set('Cache-Control', 'public, max-age=86400'); res.type('jpeg').send(LOGO_BUF); });
// Realistic leaf cut-outs for the homepage animation.
for (let _i = 1; _i <= 12; _i++) {
  let _buf = null; try { _buf = fs.readFileSync('leaf' + _i + '.png'); } catch (e) {}
  app.get('/leaf' + _i + '.png', (req, res) => { if (!_buf) return res.sendStatus(404); res.set('Cache-Control', 'public, max-age=604800'); res.type('png').send(_buf); });
}

// Non-secret diagnostic: which service account + calendar the server uses.
app.get('/whoami', (req, res) => {
  const c = getCreds();
  res.json({ service_account: (c && c.client_email) || null, calendar_id: process.env.GOOGLE_CALENDAR_ID || null, sheet_id_set: !!process.env.GOOGLE_SHEET_ID });
});

function escapeXml(s = '') {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// Twilio Voice webhook: connect the call's audio to our media-stream WebSocket.
app.all('/incoming-call', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const from = escapeXml(req.body.From || '');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="from" value="${from}" />
    </Stream>
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
const WEB_PROMPT = SYSTEM_PROMPT + '\n\nYou are now chatting on the website. Keep replies short and friendly (1-3 sentences). For ANY price, you MUST call the compute_quote tool and use the exact number it returns — never do the pricing math yourself. When the customer is ready to book: call check_availability (always pass the yard_size and leaf_load you used for the quote so the offered times are long enough for the job) and offer a couple of the returned times; once they pick one and you have their name, phone, and service address, call book_job (also pass yard_size and leaf_load) to lock it in, then confirm the day/time and price back to them. If they share contact info but are not ready to book, call save_lead so we can follow up. Never ask them to fill out a form — you handle everything right here in the chat. If the customer sends a photo of their yard, look at it to judge the yard size and leaf load, then call compute_quote. When a customer gives a phone number or a name, call lookup_customer — if they are a returning customer, greet them by name and apply the returning-customer discount. When booking, also ask for the customer\'s email so we can send a confirmation, and pass it to book_job.';

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

// ---- Google (Calendar + Sheets) via service account: direct REST + self-signed JWT ----
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Chicago';
let _creds = null;
function getCreds() {
  if (_creds !== null) return _creds || null;
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) { _creds = false; return null; }
  raw = raw.trim();
  try { if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8'); _creds = JSON.parse(raw); }
  catch (e) { console.error('Bad GOOGLE_SERVICE_ACCOUNT_JSON:', e.message); _creds = false; return null; }
  return _creds;
}
function b64url(x) { return Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
let _tok = null, _tokExp = 0;
async function getToken() {
  if (_tok && Date.now() < _tokExp) return _tok;
  const c = getCreds(); if (!c) return null;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(c.private_key));
  const assertion = `${head}.${claim}.${sig}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
      const d = await r.json();
      if (d.access_token) { _tok = d.access_token; _tokExp = Date.now() + (d.expires_in - 120) * 1000; return _tok; }
      console.error('token error', JSON.stringify(d).slice(0, 200)); return null;
    } catch (e) { if (i === 2) { console.error('token fetch failed', e.message); return null; } await new Promise(s => setTimeout(s, 500)); }
  }
  return null;
}
async function gfetch(url, opts = {}) {
  const tok = await getToken(); if (!tok) throw new Error('no google token');
  let lastErr;
  for (let i = 0; i < 3; i++) {
    let r;
    try {
      r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` } });
    } catch (e) { lastErr = e; await new Promise(s => setTimeout(s, 500)); continue; }
    if (r.ok) return await r.json();
    const body = await r.text().catch(() => '');
    const err = new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
    if (r.status < 500) throw err;            // client error (auth/permission): surface now
    lastErr = err; await new Promise(s => setTimeout(s, 500)); // server error: retry
  }
  throw lastErr;
}
function ymd(daysAhead) { return new Date(Date.now() + daysAhead * 86400000).toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ }); }
function weekday(ymdStr) { return new Date(ymdStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }); }
function wallToUtc(ymdStr, hour, minute = 0) {
  const naive = new Date(`${ymdStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const offset = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' })) - new Date(naive.toLocaleString('en-US', { timeZone: BUSINESS_TZ }));
  return new Date(naive.getTime() + offset);
}

// Estimated on-site work time (minutes) from yard size + leaf load.
function estimateMinutes({ yard_size = 'medium', leaf_load = 'average', acres } = {}) {
  let base = ({ small: 60, medium: 120, large: 210, acreage: 300 })[yard_size] ?? 120;
  if (yard_size === 'acreage' && acres && acres > 1) base = 300 + 120 * (Math.ceil(acres) - 1);
  const mult = ({ light: 0.85, average: 1, heavy: 1.3 })[leaf_load] ?? 1;
  return Math.max(45, Math.round((base * mult) / 15) * 15);
}

const BUFFER_MIN = 60;            // gap after each job: hauling, refuel, travel
const DAY_START = 8, DAY_END = 17; // working hours 8am-5pm

async function getAvailability(opts = {}) {
  if (!getCreds()) return { error: 'calendar not configured' };
  const calId = process.env.GOOGLE_CALENDAR_ID;
  const daysOut = 14, maxSlots = 6;
  const estimate = (opts && opts.minutes) ? opts.minutes : estimateMinutes(opts);
  let busy = [];
  try {
    const d = await gfetch('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + daysOut * 86400000).toISOString(), timeZone: BUSINESS_TZ, items: [{ id: calId }] }) });
    const cals = d.calendars || {};
    const key = cals[calId] ? calId : Object.keys(cals)[0];
    if (key && cals[key] && cals[key].errors) console.error('freebusy cal errors', JSON.stringify(cals[key].errors));
    busy = (key && cals[key] && cals[key].busy) || [];
    console.error('freebusy busy count', busy.length, 'key', key, 'calId', calId);
  } catch (e) { console.error('freebusy error', e.message); return { error: 'calendar unavailable' }; }
  const busyMs = busy.map(b => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() + BUFFER_MIN * 60000 }));
  const slots = [];
  const minLead = Date.now() + 2 * 3600000;
  for (let dd = 1; dd <= daysOut && slots.length < maxSlots; dd++) {
    const day = ymd(dd);
    if (weekday(day) === 'Sunday') continue;
    for (let mins = DAY_START * 60; mins + estimate <= DAY_END * 60 && slots.length < maxSlots; mins += 30) {
      const start = wallToUtc(day, Math.floor(mins / 60), mins % 60);
      const sMs = start.getTime();
      if (sMs < minLead) continue;
      const eMs = sMs + (estimate + BUFFER_MIN) * 60000;
      if (busyMs.some(b => b.s < eMs && b.e > sMs)) continue;
      slots.push({ label: start.toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), start_iso: start.toISOString() });
      mins += 120; // spread offered times across the day
    }
  }
  return { slots, estimated_minutes: estimate };
}

async function appendLead(d = {}) {
  if (!getCreds()) return { error: 'sheet not configured' };
  const id = encodeURIComponent(process.env.GOOGLE_SHEET_ID);
  const ts = new Date().toLocaleString('en-US', { timeZone: BUSINESS_TZ });
  try {
    await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[ts, d.name || '', d.phone || '', d.address || '', d.service || '', d.yard_size || '', d.leaf_load || '', d.quote || '', d.type || '', d.status || 'New', d.source || 'Web chat', (d.email ? 'Email: ' + d.email + ' | ' : '') + (d.notes || '')]] }) });
  } catch (e) { console.error('append lead error', e.message); return { error: 'could not save' }; }
  return { saved: true };
}

async function sendEmail(to, subject, html, attachments) {
  if (!process.env.RESEND_API_KEY || !to) return;
  const from = process.env.FROM_EMAIL || 'The Leaf Busters <onboarding@resend.dev>';
  const payload = { from, to: [to], subject, html };
  if (attachments && attachments.length) payload.attachments = attachments;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.error('email error', e.message); }
}

function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// --- Customer self-service + calendar helpers ---
const MANAGE_SECRET = process.env.MANAGE_SECRET || process.env.DASHBOARD_PASSWORD || 'leafbusters-secret';
function manageToken(eventId) { return crypto.createHmac('sha256', MANAGE_SECRET).update(String(eventId)).digest('hex').slice(0, 24); }
function manageUrl(eventId) { return `${PUBLIC_URL}/manage?id=${encodeURIComponent(eventId)}&t=${manageToken(eventId)}`; }
function mapLink(addr) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr || ''); }
function icsStamp(d) { return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function gcalLink(title, startISO, endISO, location, details) {
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) +
    '&dates=' + icsStamp(startISO) + '/' + icsStamp(endISO) +
    '&location=' + encodeURIComponent(location || '') + '&details=' + encodeURIComponent(details || '');
}
function icsContent(uid, title, startISO, endISO, location, details) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//The Leaf Busters//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + uid + '@theleafbusters.com', 'DTSTAMP:' + icsStamp(Date.now()), 'DTSTART:' + icsStamp(startISO), 'DTEND:' + icsStamp(endISO),
    'SUMMARY:' + String(title || '').replace(/\n/g, ' '), 'LOCATION:' + String(location || '').replace(/\n/g, ' '),
    'DESCRIPTION:' + String(details || '').replace(/\n/g, ' '), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function btn(href, label) { return `<a href="${href}" style="display:inline-block;background:#d2691e;color:#fff7ec;text-decoration:none;font:700 14px Arial,sans-serif;padding:10px 16px;border-radius:8px;margin:4px 6px 4px 0">${label}</a>`; }
function btnGhost(href, label) { return `<a href="${href}" style="display:inline-block;background:transparent;color:#ec7a1e;text-decoration:none;font:700 14px Arial,sans-serif;padding:10px 16px;border:1px solid #6e451f;border-radius:8px;margin:4px 6px 4px 0">${label}</a>`; }

// Branded HTML email matching theleafbusters.com (dark theme, cream wordmark, burnt-orange accents).
function brandedEmail(heading, introHtml, rows, footerNote) {
  const rowHtml = rows.map(([k, v, accent]) => `
    <tr>
      <td style="padding:8px 0;color:#c9b896;font:600 12px/1.4 'Arial Narrow',Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;width:118px;vertical-align:top">${escHtml(k)}</td>
      <td style="padding:8px 0;color:${accent ? '#ec7a1e' : '#f4eee0'};font:${accent ? '700 19px' : '400 15px'}/1.5 Arial,sans-serif">${escHtml(v)}</td>
    </tr>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#100e0c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#100e0c"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#1b1714;border:1px solid rgba(236,224,196,.14);border-radius:16px;overflow:hidden">
      <tr><td align="center" style="background:#100e0c;padding:28px 20px 22px">
        <img src="${PUBLIC_URL}/logo.jpg" width="190" alt="The Leaf Busters — Leaf Cleanup &amp; Removal" style="display:block;border:0;width:190px;max-width:72%;height:auto;margin:0 auto">
      </td></tr>
      <tr><td style="height:4px;background:#d2691e;font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="padding:26px 30px 4px">
        <h1 style="margin:0 0 10px;color:#f3ead2;font:700 22px/1.25 'Arial Narrow',Arial,sans-serif;letter-spacing:.5px">${heading}</h1>
        <div style="color:#c9b896;font:400 15px/1.6 Arial,sans-serif">${introHtml}</div>
      </td></tr>
      <tr><td style="padding:16px 30px 4px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#211b16;border:1px solid rgba(236,224,196,.12);border-radius:12px">
          <tr><td style="padding:6px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowHtml}</table></td></tr>
        </table>
      </td></tr>
      ${footerNote ? `<tr><td style="padding:16px 30px 4px;color:#c9b896;font:400 13px/1.6 Arial,sans-serif">${footerNote}</td></tr>` : ''}
      <tr><td align="center" style="padding:22px 30px 28px">
        <a href="tel:+18443529136" style="color:#ec7a1e;text-decoration:none;font:700 16px Arial,sans-serif">(844) 352-9136</a>
        <div style="color:#8a6a3f;font:400 12px Arial,sans-serif;margin-top:6px">theleafbusters.com &nbsp;&bull;&nbsp; Freeport, IL &amp; Stephenson County</div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

async function sendBookingEmails(a, when, ctx) {
  ctx = ctx || {};
  const price = a.quote || 'We will confirm';
  const alertTo = process.env.ALERT_EMAIL;
  if (alertTo) await sendEmail(alertTo, `New booking: ${a.name || 'Customer'} — ${when}`,
    brandedEmail('New cleanup booked', 'A new job just came in through the assistant.', [
      ['When', when], ['Name', a.name || ''], ['Phone', a.phone || ''], ['Email', a.email || ''],
      ['Address', a.address || ''], ['Service', a.service || 'Leaf cleanup'], ['Quote', price, true],
      ['Notes', a.notes || '—']
    ], a.address ? btnGhost(mapLink(a.address), 'View on map') : ''));
  if (a.email) {
    let actions = '';
    if (ctx.startISO && ctx.endISO) actions += btn(gcalLink('Leaf Busters cleanup', ctx.startISO, ctx.endISO, a.address, 'The Leaf Busters — ' + (a.service || 'Leaf cleanup')), 'Add to calendar');
    if (a.address) actions += btn(mapLink(a.address), 'Directions');
    if (ctx.eventId) actions += btnGhost(manageUrl(ctx.eventId), 'Reschedule / cancel');
    const foot = actions + '<div style="margin-top:12px">No need to be home — just make sure the yard is accessible. Payment is due when the job\'s done. Weather reschedules are free.</div>';
    const atts = (ctx.startISO && ctx.endISO) ? [{ filename: 'leaf-busters-cleanup.ics', content: Buffer.from(icsContent(ctx.eventId || 'lb', 'Leaf Busters cleanup', ctx.startISO, ctx.endISO, a.address, a.service || 'Leaf cleanup')).toString('base64') }] : undefined;
    await sendEmail(a.email, 'Your Leaf Busters cleanup is booked',
      brandedEmail("You're booked! 🍂", `Hi ${escHtml(a.name || 'there')}, thanks for choosing The Leaf Busters — your cleanup is on the schedule. Here's what to expect:`, [
        ['When', when], ['Address', a.address || ''], ['Service', a.service || 'Leaf cleanup'], ['Price', price, true]
      ], foot), atts);
  }
}

async function bookJob(a = {}) {
  if (!getCreds()) return { error: 'calendar not configured' };
  const id = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const start = new Date(a.start_iso);
  const jobMin = estimateMinutes(a);
  const end = new Date(start.getTime() + jobMin * 60000);
  const when = start.toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let eventId = '';
  try {
    const ev = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${id}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: `Leaf cleanup — ${a.name || 'Customer'} (~${jobMin} min)`, description: `Service: ${a.service || ''}\nQuote: ${a.quote || ''}\nEst. time: ${jobMin} min (+1h buffer)\nPhone: ${a.phone || ''}\nEmail: ${a.email || ''}\nNotes: ${a.notes || ''}`, location: a.address || '', start: { dateTime: start.toISOString(), timeZone: BUSINESS_TZ }, end: { dateTime: end.toISOString(), timeZone: BUSINESS_TZ } }) });
    eventId = (ev && ev.id) ? ev.id : '';
  } catch (e) { console.error('book error', e.message); return { error: 'could not book' }; }
  await appendLead({ ...a, status: 'Booked', notes: `${a.notes || ''} | booked ${when}` });
  await sendBookingEmails(a, when, { eventId: eventId, startISO: start.toISOString(), endISO: end.toISOString() });
  return { booked: true, when };
}

async function readLeads() {
  if (!getCreds()) return [];
  try {
    const id = encodeURIComponent(process.env.GOOGLE_SHEET_ID);
    const d = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:L5000`);
    return d.values || [];
  } catch (e) { console.error('readLeads error', e.message); return []; }
}

async function lookupCustomer({ phone, name } = {}) {
  const rows = await readLeads();
  if (rows.length < 2) return { found: false };
  const norm = s => (s || '').replace(/\D/g, '').slice(-10);
  const np = norm(phone);
  const nm = (name || '').trim().toLowerCase();
  for (let i = rows.length - 1; i >= 1; i--) {
    const r = rows[i];
    const rp = norm(r[2]);
    const rn = (r[1] || '').trim().toLowerCase();
    if ((np && rp && np === rp) || (nm && rn && nm === rn)) {
      return { found: true, name: r[1] || '', address: r[3] || '', last_service: r[4] || '', last_status: r[9] || '' };
    }
  }
  return { found: false };
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
    function: { name: 'check_availability', description: 'Get real open appointment times that fit this job. Pass yard_size and leaf_load (the same ones used for the quote) so each offered time is long enough for the work plus a 1-hour buffer. Returns slots with a label and start_iso.', parameters: { type: 'object', properties: { yard_size: { type: 'string', enum: ['small', 'medium', 'large', 'acreage'] }, leaf_load: { type: 'string', enum: ['light', 'average', 'heavy'] }, acres: { type: 'number' } } } }
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
          service: { type: 'string' }, quote: { type: 'string', description: 'quoted price, e.g. $270' }, yard_size: { type: 'string', enum: ['small', 'medium', 'large', 'acreage'], description: 'so the appointment is blocked for the right duration' }, leaf_load: { type: 'string', enum: ['light', 'average', 'heavy'] }, email: { type: 'string', description: 'customer email for a confirmation, if provided' }, notes: { type: 'string' }
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
  },
  {
    type: 'function',
    function: {
      name: 'lookup_customer',
      description: 'Check if this is a returning customer by phone or name. Call this when a customer shares their phone number or name. If found, greet them by name and you may apply the returning-customer discount.',
      parameters: { type: 'object', properties: { phone: { type: 'string' }, name: { type: 'string' } } }
    }
  }
];

// Same tools, flattened for the Realtime (voice) API.
const REALTIME_TOOLS = TOOLS.map(t => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
const VOICE_PROMPT = SYSTEM_PROMPT + '\n\nTOOLS: For any price, call compute_quote and use its exact number — never do pricing math yourself. To schedule, call check_availability (pass the yard_size and leaf_load from the quote so the slot fits the job) and offer a couple of the returned times; once the caller picks one and you have their name, phone, and address, call book_job (also pass yard_size and leaf_load) to lock it in, then confirm the day, time, and price. If they share contact info but do not book, call save_lead.';

async function runTool(name, argStr, source) {
  let args = {};
  try { args = JSON.parse(argStr || '{}'); } catch {}
  try {
    if (name === 'compute_quote') return computeQuote(args);
    if (name === 'check_availability') return await getAvailability(args);
    if (name === 'book_job') return await bookJob({ ...args, source });
    if (name === 'save_lead') return await appendLead({ ...args, source });
    if (name === 'lookup_customer') return await lookupCustomer(args);
  } catch (e) { return { error: 'tool failed' }; }
  return { error: 'unknown tool' };
}

// CORS for the chat endpoint so the website (different origin) can call it.
app.use('/chat', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/chat', async (req, res) => {
  const { sessionId, message, image } = req.body || {};
  const id = (sessionId || 'anon').toString().slice(0, 80);
  if (!message && !image) {
    return res.json({ reply: "Hey! I'm Buster with The Leaf Busters. Tell me your address and about how big the yard is, and I'll get you an estimate right now." });
  }
  let history = sessions.get(id) || [{ role: 'system', content: WEB_PROMPT }];
  const userIdx = history.length;
  if (image) {
    history.push({ role: 'user', content: [{ type: 'text', text: message || 'Here is a photo of my yard — about how much for a cleanup?' }, { type: 'image_url', image_url: { url: image } }] });
  } else {
    history.push({ role: 'user', content: String(message).slice(0, 1000) });
  }
  let reply = "Sorry, I glitched for a second — can you say that again?";
  try {
    for (let hop = 0; hop < 8; hop++) {
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
          const result = await runTool(tc.function.name, tc.function.arguments, 'Web chat');
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
  if (image && history[userIdx]) history[userIdx] = { role: 'user', content: '[customer sent a yard photo] ' + (message || '') };
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
  if (getCreds()) {
    try {
      const d = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEET_ID)}/values/A1:L2000`);
      leads = d.values || [];
    } catch (e) { console.error('dash sheet', e.message); }
    try {
      const d = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)}/events?timeMin=${encodeURIComponent(new Date().toISOString())}&maxResults=50&singleEvents=true&orderBy=startTime`);
      events = d.items || [];
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
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
  });

  openaiWs.on('open', () => {
    setTimeout(() => {
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: REALTIME_MODEL,
          output_modalities: ['audio'],
          audio: {
            input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad', threshold: 0.65, prefix_padding_ms: 300, silence_duration_ms: 700 } },
            output: { format: { type: 'audio/pcmu' }, voice: VOICE }
          },
          instructions: VOICE_PROMPT,
          tools: REALTIME_TOOLS,
          tool_choice: 'auto'
        }
      }));
    }, 250);
  });

  openaiWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'response.output_audio.delta' && msg.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.delta } }));
    } else if (msg.type === 'input_audio_buffer.speech_started' && streamSid) {
      // Caller started talking — stop our current playback so we don't talk over them.
      twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
    } else if (msg.type === 'response.function_call_arguments.done') {
      // The assistant called a tool — run it, return the result, and let it keep talking.
      const result = await runTool(msg.name, msg.arguments, 'Phone call');
      openaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify(result) } }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    } else if (msg.type === 'error') {
      console.error('OpenAI error:', JSON.stringify(msg.error || msg));
    }
  });

  openaiWs.on('error', (e) => console.error('OpenAI WS error:', e.message));
  openaiWs.on('close', () => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); });

  twilioWs.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log('Stream started:', streamSid);
      const from = data.start.customParameters && data.start.customParameters.from;
      let greetCtx = null;
      if (from) {
        try {
          const c = await lookupCustomer({ phone: from });
          if (c && c.found && c.name) greetCtx = `This caller is a returning customer named ${c.name}${c.address ? ' at ' + c.address : ''}. Greet them warmly by name and offer the returning-customer discount.`;
        } catch (e) {}
      }
      setTimeout(() => {
        if (openaiWs.readyState !== WebSocket.OPEN) return;
        if (greetCtx) openaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[System note: ' + greetCtx + ']' }] } }));
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
      }, 500);
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

// ---------------------------------------------------------------------------
// Automated follow-ups: morning owner briefing, post-job review requests,
// and win-back emails for quotes that never booked. Runs on an internal timer.
// ---------------------------------------------------------------------------
function chiNow() {
  const d = new Date();
  const ymdStr = d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: '2-digit', hourCycle: 'h23' }).format(d), 10);
  return { ymd: ymdStr, hour };
}
function fld(desc, label) { const m = (desc || '').match(new RegExp(label + ':\\s*([^\\n]*)')); return m ? m[1].trim() : ''; }

async function getEventsForDay(offset) {
  if (!getCreds()) return [];
  const day = ymd(offset);
  const start = wallToUtc(day, 0, 0), end = wallToUtc(day, 23, 59);
  const id = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  try {
    const d = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${id}/events?timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&singleEvents=true&orderBy=startTime`);
    return (d.items || []).filter(ev => ev.start && ev.start.dateTime).map(ev => {
      const desc = ev.description || '';
      return {
        time: new Date(ev.start.dateTime).toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }),
        location: ev.location || fld(desc, 'Address') || '',
        id: ev.id || '',
        email: (desc.match(/Email:\s*([^\s|]+@[^\s|]+)/) || [])[1] || '',
        name: (ev.summary || '').replace(/^Leaf cleanup\s*[—-]\s*/, '').replace(/\s*\(.*\)$/, '').trim() || 'there',
        quote: fld(desc, 'Quote'),
        service: fld(desc, 'Service') || 'Leaf cleanup'
      };
    });
  } catch (e) { console.error('getEventsForDay', e.message); return []; }
}

async function dailyBriefing(off) {
  off = off || 0;
  const to = process.env.ALERT_EMAIL; if (!to) return;
  const ev = await getEventsForDay(off);
  const label = new Date(Date.now() + off * 86400000).toLocaleDateString('en-US', { timeZone: BUSINESS_TZ, weekday: 'long', month: 'long', day: 'numeric' });
  let rows;
  if (!ev.length) rows = [['Date', label], ['Schedule', 'No jobs on the board — quiet day at HQ.']];
  else { rows = [['Date', label], ['Jobs', String(ev.length)]]; ev.forEach(e => rows.push([e.time, `${e.name} — ${e.location}${e.quote ? ' — ' + e.quote : ''}`])); }
  await sendEmail(to, `Dispatch briefing — ${label} (${ev.length} job${ev.length === 1 ? '' : 's'})`,
    brandedEmail('Today’s dispatch', 'Here’s your containment schedule. Go get ’em, Buck.', rows, 'Your automated morning briefing from Buster — Leaf Busters Dispatch.'));
  console.error('briefing sent', ev.length);
}

async function reviewRequests(off) {
  off = (off === undefined) ? -1 : off;
  const ev = await getEventsForDay(off);
  const link = process.env.REVIEW_URL || 'https://theleafbusters.com';
  let n = 0;
  for (const e of ev) {
    if (!e.email) continue;
    await sendEmail(e.email, 'How did we do? — The Leaf Busters',
      brandedEmail('Another successful containment! 🍂', `Hi ${escHtml(e.name)}, thanks for trusting The Leaf Busters with your cleanup. If Buck did right by your yard, a quick review means the world to a local business.`,
        [], `<a href="${link}" style="display:inline-block;background:#d2691e;color:#fff7ec;text-decoration:none;font:700 16px Arial,sans-serif;padding:12px 22px;border-radius:8px">Leave a 5-star review</a>`));
    n++;
  }
  console.error('review requests sent', n);
}

async function winBackFollowups(off) {
  const rows = await readLeads();
  if (rows.length < 2) return;
  const dayStr = new Date(Date.now() + ((off === undefined ? -1 : off) * 86400000)).toLocaleDateString('en-US', { timeZone: BUSINESS_TZ });
  const booked = new Set();
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][9] || '').toLowerCase().indexOf('booked') >= 0) {
      const be = ((rows[i][11] || '').match(/Email:\s*([^\s|]+@[^\s|]+)/) || [])[1];
      if (be) booked.add(be.toLowerCase());
    }
  }
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const status = (r[9] || '').toLowerCase(), notes = r[11] || '';
    if (status.indexOf('booked') >= 0) continue;
    if ((r[0] || '').indexOf(dayStr) !== 0) continue;
    const email = (notes.match(/Email:\s*([^\s|]+@[^\s|]+)/) || [])[1];
    if (!email || booked.has(email.toLowerCase())) continue;
    const name = (r[1] || 'there').trim(); const quote = r[7] || '';
    await sendEmail(email, 'Still want your yard back under control? — The Leaf Busters',
      brandedEmail('Your cleanup is still on standby', `Hi ${escHtml(name)}, Buster here from Leaf Busters Dispatch. You priced out a cleanup${quote ? ' around ' + escHtml(quote) : ''} but didn’t lock in a date yet. Want me to get a containment crew scheduled?`,
        quote ? [['Your quote', quote]] : [],
        `<a href="https://theleafbusters.com" style="display:inline-block;background:#d2691e;color:#fff7ec;text-decoration:none;font:700 16px Arial,sans-serif;padding:12px 22px;border-radius:8px">Book my cleanup</a> &nbsp; or call <a href="tel:+18443529136" style="color:#ec7a1e;text-decoration:none">(844) 352-9136</a>`));
    n++;
  }
  console.error('winback sent', n);
}

async function customerReminders(off) {
  off = (off === undefined) ? 1 : off;
  const ev = await getEventsForDay(off);
  let n = 0;
  for (const e of ev) {
    if (!e.email) continue;
    const foot = (e.location ? btn(mapLink(e.location), 'Directions') : '') + (e.id ? btnGhost(manageUrl(e.id), 'Reschedule / cancel') : '') +
      '<div style="margin-top:12px">See you then! No need to be home — just keep the yard accessible. Payment is due when the job\'s done.</div>';
    await sendEmail(e.email, 'Reminder: your Leaf Busters cleanup is tomorrow',
      brandedEmail('Cleanup reminder 🍂', `Hi ${escHtml(e.name)}, friendly reminder from Leaf Busters Dispatch — Buck is scheduled to take care of your yard tomorrow.`,
        [['When', e.time], ['Address', e.location || ''], ['Service', e.service || 'Leaf cleanup']], foot));
    n++;
  }
  console.error('reminders sent', n);
}

let _ranBrief = '', _ranEve = '', _ranRem = '';
setInterval(async () => {
  try {
    const { ymd: today, hour } = chiNow();
    if (hour === 6 && _ranBrief !== today) { _ranBrief = today; await dailyBriefing(0); }
    if (hour === 17 && _ranRem !== today) { _ranRem = today; await customerReminders(1); }
    if (hour === 18 && _ranEve !== today) { _ranEve = today; await reviewRequests(-1); await winBackFollowups(-1); }
  } catch (e) { console.error('scheduler error', e.message); }
}, 5 * 60 * 1000);

// Manual trigger for testing, guarded by the dashboard password. Optional &off=N day offset.
app.get('/admin/run', async (req, res) => {
  if (req.query.pw !== process.env.DASHBOARD_PASSWORD) return res.status(401).send('nope');
  const t = req.query.task, off = req.query.off !== undefined ? parseInt(req.query.off, 10) : undefined;
  try {
    if (t === 'briefing') await dailyBriefing(off);
    else if (t === 'reviews') await reviewRequests(off);
    else if (t === 'winback') await winBackFollowups(off);
    else if (t === 'reminders') await customerReminders(off);
    else return res.status(400).send('unknown task');
    res.send('ran ' + t);
  } catch (e) { res.status(500).send('error: ' + e.message); }
});

// ---------------------------------------------------------------------------
// Customer self-service: reschedule or cancel from a tokenized link in emails.
// ---------------------------------------------------------------------------
async function getEventById(id) {
  const cid = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  return gfetch(`https://www.googleapis.com/calendar/v3/calendars/${cid}/events/${encodeURIComponent(id)}`);
}
function managePage(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — The Leaf Busters</title></head>
  <body style="margin:0;background:#100e0c;font-family:Arial,Helvetica,sans-serif;color:#f4eee0">
  <div style="max-width:560px;margin:0 auto;padding:34px 18px">
    <div style="text-align:center;margin-bottom:18px"><img src="${PUBLIC_URL}/logo.jpg" width="160" alt="The Leaf Busters" style="width:160px;max-width:62%"></div>
    <div style="background:#1b1714;border:1px solid rgba(236,224,196,.15);border-radius:16px;padding:26px 22px">${bodyHtml}</div>
    <div style="text-align:center;color:#8a6a3f;font-size:12px;margin-top:16px">theleafbusters.com &bull; (844) 352-9136</div>
  </div></body></html>`;
}
app.get('/manage', async (req, res) => {
  const id = req.query.id, t = req.query.t;
  if (!id || t !== manageToken(id)) return res.status(403).send(managePage('Link expired', '<p>This link is invalid or expired. Please call (844) 352-9136 and Buster will help.</p>'));
  try {
    const ev = await getEventById(id);
    if (!ev || ev.status === 'cancelled') return res.send(managePage('Canceled', '<h2 style="color:#f3ead2;margin-top:0">This appointment is canceled.</h2><p>Need a new cleanup? <a href="https://theleafbusters.com" style="color:#ec7a1e">Book here</a>.</p>'));
    const when = (ev.start && ev.start.dateTime) ? new Date(ev.start.dateTime).toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    if (req.query.view === 'reschedule') {
      const durMin = (ev.start && ev.end) ? Math.round((new Date(ev.end) - new Date(ev.start)) / 60000) : 120;
      const av = await getAvailability({ minutes: durMin });
      const slots = (av.slots || []).map(s => `<div style="margin:8px 0">${btn(`${PUBLIC_URL}/manage/reschedule?id=${encodeURIComponent(id)}&t=${t}&start=${encodeURIComponent(s.start_iso)}`, s.label)}</div>`).join('') || '<p>No openings found right now — please call (844) 352-9136.</p>';
      return res.send(managePage('Reschedule', `<h2 style="color:#f3ead2;margin-top:0">Pick a new time</h2><p style="color:#c9b896">Current: ${escHtml(when)}</p>${slots}<p style="margin-top:16px">${btnGhost(manageUrl(id), 'Back')}</p>`));
    }
    if (req.query.cancel === '1') {
      return res.send(managePage('Cancel', `<h2 style="color:#f3ead2;margin-top:0">Cancel this cleanup?</h2><p style="color:#c9b896">${escHtml(when)}<br>${escHtml(ev.location || '')}</p><p style="margin-top:18px">${btn(`${PUBLIC_URL}/manage/cancel?id=${encodeURIComponent(id)}&t=${t}&confirm=1`, 'Yes, cancel it')} ${btnGhost(manageUrl(id), 'Keep it')}</p>`));
    }
    res.send(managePage('Your appointment', `<h2 style="color:#f3ead2;margin-top:0">Your cleanup</h2>
      <p style="color:#c9b896;font-size:16px"><b style="color:#f4eee0">${escHtml(when)}</b><br>${escHtml(ev.location || '')}</p>
      <p style="margin-top:18px">${btn(`${PUBLIC_URL}/manage?id=${encodeURIComponent(id)}&t=${t}&view=reschedule`, 'Reschedule')} ${btnGhost(`${PUBLIC_URL}/manage?id=${encodeURIComponent(id)}&t=${t}&cancel=1`, 'Cancel')}</p>`));
  } catch (e) { res.status(500).send(managePage('Error', '<p>Something went wrong. Please call (844) 352-9136.</p>')); }
});
app.get('/manage/cancel', async (req, res) => {
  const id = req.query.id, t = req.query.t;
  if (!id || t !== manageToken(id) || req.query.confirm !== '1') return res.status(403).send(managePage('Invalid', '<p>Invalid link.</p>'));
  try {
    const ev = await getEventById(id).catch(() => null);
    const cid = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
    await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${cid}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const email = ev ? ((ev.description || '').match(/Email:\s*([^\s|]+@[^\s|]+)/) || [])[1] : '';
    const when = (ev && ev.start && ev.start.dateTime) ? new Date(ev.start.dateTime).toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    if (email) await sendEmail(email, 'Your Leaf Busters cleanup is canceled', brandedEmail('Cleanup canceled', `Your cleanup${when ? ' on ' + escHtml(when) : ''} has been canceled — no charge. Changed your mind?`, [], btn('https://theleafbusters.com', 'Book again')));
    if (process.env.ALERT_EMAIL) await sendEmail(process.env.ALERT_EMAIL, `Canceled: ${ev ? ev.summary : 'a cleanup'} ${when}`, brandedEmail('A booking was canceled', `${escHtml(ev ? ev.summary : 'A cleanup')}${when ? ' — ' + escHtml(when) : ''} was canceled by the customer.`, [], ''));
    res.send(managePage('Canceled', '<h2 style="color:#f3ead2;margin-top:0">You\'re all set — canceled.</h2><p>No charge. Need us again? <a href="https://theleafbusters.com" style="color:#ec7a1e">Book anytime</a>.</p>'));
  } catch (e) { res.status(500).send(managePage('Error', '<p>Couldn\'t cancel — please call (844) 352-9136.</p>')); }
});
app.get('/manage/reschedule', async (req, res) => {
  const id = req.query.id, t = req.query.t, start = req.query.start;
  if (!id || t !== manageToken(id) || !start) return res.status(403).send(managePage('Invalid', '<p>Invalid link.</p>'));
  try {
    const ev = await getEventById(id);
    const durMin = (ev.start && ev.end) ? Math.round((new Date(ev.end) - new Date(ev.start)) / 60000) : 120;
    const ns = new Date(start), ne = new Date(ns.getTime() + durMin * 60000);
    const cid = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
    await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${cid}/events/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: { dateTime: ns.toISOString(), timeZone: BUSINESS_TZ }, end: { dateTime: ne.toISOString(), timeZone: BUSINESS_TZ } }) });
    const when = ns.toLocaleString('en-US', { timeZone: BUSINESS_TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const email = ((ev.description || '').match(/Email:\s*([^\s|]+@[^\s|]+)/) || [])[1];
    if (email) await sendEmail(email, 'Your Leaf Busters cleanup was rescheduled', brandedEmail('Rescheduled ✅', 'You\'re all set — your cleanup is now:', [['When', when], ['Address', ev.location || '']], btn(gcalLink('Leaf Busters cleanup', ns.toISOString(), ne.toISOString(), ev.location, 'The Leaf Busters'), 'Add to calendar') + btnGhost(manageUrl(id), 'Manage')));
    if (process.env.ALERT_EMAIL) await sendEmail(process.env.ALERT_EMAIL, `Rescheduled: ${ev.summary} → ${when}`, brandedEmail('A booking was rescheduled', `${escHtml(ev.summary)} is now ${escHtml(when)}.`, [], ''));
    res.send(managePage('Rescheduled', `<h2 style="color:#f3ead2;margin-top:0">Rescheduled!</h2><p style="color:#c9b896">Your cleanup is now <b style="color:#f4eee0">${escHtml(when)}</b>. A confirmation is on its way.</p>`));
  } catch (e) { res.status(500).send(managePage('Error', '<p>Couldn\'t reschedule — please call (844) 352-9136.</p>')); }
});

server.listen(PORT, () => {
  console.log(`The Leaf Busters AI assistant listening on port ${PORT}`);
});
