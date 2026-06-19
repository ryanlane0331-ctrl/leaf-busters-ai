# The Leaf Busters — AI Phone & Text Assistant

A custom voice + SMS assistant for The Leaf Busters. It answers every call and text 24/7, gives live price quotes, and books jobs — built on **Twilio** + the **OpenAI Realtime** voice model, deployed on **Render**.

The assistant's personality, the pricing rules, and the booking flow all live in one place: the `SYSTEM_PROMPT` near the top of `server.js`. Edit a number there and the assistant quotes the new number.

---

## What it does

- **Voice calls** — Twilio streams the call audio to this server, which bridges it live to OpenAI's realtime voice model. The caller talks to "Buster," who quotes and books in real time.
- **Text messages** — texts hit `/sms` and get an AI reply using the same brain.

---

## What you need before deploying

1. A **GitHub** account (free) — Render deploys from a GitHub repo.
2. A **Render** account (use the **Starter** instance, ~$7/mo — not Free; Free instances sleep and would drop the first call).
3. An **OpenAI API key** with Realtime access (platform.openai.com → API keys).
4. A **Twilio** account + a **phone number** with Voice (and SMS, for texting).

> You create these accounts and keys yourself. Never paste secret keys into chat — set them in Render's dashboard.

---

## Step 1 — Put this code on GitHub

Easiest no-terminal way:
1. Create a new repo at github.com (e.g. `leaf-busters-ai`), Private is fine.
2. On the repo page choose **uploading an existing file**, and drag in everything from this `leaf-busters-ai` folder **except** `node_modules` and `.env` (don't upload secrets). Commit.

## Step 2 — Deploy on Render

1. Render dashboard → your Leaf Busters project → **New** → **Web Service**.
2. Connect the GitHub repo from Step 1.
3. Settings: Runtime **Node**, Build command `npm install`, Start command `node server.js`, Instance type **Starter**.
4. **Environment** tab → add:
   - `OPENAI_API_KEY` = your key
   - `OPENAI_REALTIME_MODEL` = `gpt-4o-realtime-preview-2024-12-17` *(update if OpenAI has retired this; use the current realtime model name)*
   - `OPENAI_VOICE` = `verse` *(or alloy, ash, ballad, coral, echo, sage, shimmer)*
   - `OPENAI_SMS_MODEL` = `gpt-4o-mini`
5. Deploy. When it's live you'll get a URL like `https://leaf-busters-ai.onrender.com`. Open it — it should say "The Leaf Busters AI assistant is running."

## Step 3 — Point your Twilio number at it

In the Twilio Console → Phone Numbers → your number:
- **Voice → A call comes in:** Webhook, `POST`, URL:
  `https://YOUR-RENDER-URL.onrender.com/incoming-call`
- **Messaging → A message comes in:** Webhook, `POST`, URL:
  `https://YOUR-RENDER-URL.onrender.com/sms`

Save. Now call the number — Buster should pick up and greet you.

---

## Testing & tuning

- **Call it** and run through a quote ("medium yard, lots of leaves") and a booking.
- **Text it** to confirm SMS replies.
- Tweak the voice (`OPENAI_VOICE`), the persona/pricing (`SYSTEM_PROMPT` in `server.js`), then redeploy (push to GitHub → Render auto-deploys).

## Notes & gotchas

- **Use Starter, not Free.** Free Render services sleep after inactivity and cold-start takes ~30–60s, which would drop a live call.
- **Realtime model name changes.** If calls connect but there's no audio, the model name is likely outdated — set `OPENAI_REALTIME_MODEL` to the current one from OpenAI's docs.
- **Costs:** Render Starter (~$7/mo) + Twilio number (~$1–2/mo) + per-minute Twilio voice + OpenAI Realtime usage (billed by audio minute). Watch your OpenAI usage at first.
- **Booking storage:** this version captures bookings in the conversation. To log them automatically (Google Sheet, calendar, CRM), that's a clean next add-on — ask and we'll wire it in.
- This assistant uses the same pricing engine and persona documented in `../Leaf-Busters-AI-Assistant-Setup.md`.
