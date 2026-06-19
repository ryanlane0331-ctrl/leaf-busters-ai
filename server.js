import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

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
