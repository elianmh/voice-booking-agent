# 🎙️ Voice Booking Agent SaaS

AI-powered voice booking agent that works for **any appointment-based business** — car detailing, salons, nail studios, barbershops, spas, and more.

One config file. Any business. Fully bilingual (EN/ES).

---

## How It Works

```
Customer calls your phone number
        ↓
Retell AI handles telephony
        ↓
WebSocket → Your server (this project)
        ↓
Claude (Haiku) responds in real-time
- Detects EN/ES language dynamically
- Checks availability in Notion
- Recognizes returning customers
        ↓
Call ends → saves full booking to Notion DB
```

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/elianmh/voice-booking-agent.git
cd voice-booking-agent
npm install
```

### 2. Configure Your Business

Edit `business.config.md` with your business details:

```markdown
## Business Name
My Salon

## Business Type
beauty_salon

## Services
| Name | Price | Duration | Description |
|------|-------|----------|-------------|
| Haircut | $45 | 1 hour | Cut and style |
```

See `businesses/salon.md`, `businesses/manicure.md` for examples.

### 3. Set Environment Variables

```bash
cp .env.example .env
```

Fill in your `.env`:

| Variable | Where to get it |
|---|---|
| `RETELL_API_KEY` | dashboard.retellai.com → Settings → API Keys |
| `RETELL_AGENT_ID` | dashboard.retellai.com → your agent URL |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `NOTION_API_KEY` | notion.so → Settings → Integrations |
| `NOTION_DATABASE_ID` | Your Notion DB URL (32-char ID) |

### 4. Set Up Retell Agent

1. Go to [app.retellai.com](https://app.retellai.com)
2. Create a new agent → **Custom LLM** type
3. Set LLM WebSocket URL: `wss://YOUR-DOMAIN/llm-websocket`
4. Set Webhook URL: `https://YOUR-DOMAIN/webhooks/retell`
5. Voice: `cartesia-Hailey-Spanish-latin-america` (bilingual)
6. Language: `multi`

### 5. Set Up Notion Database

Create a Notion database with these columns:

| Column | Type |
|---|---|
| Nombre | Title |
| Teléfono | Phone |
| Estado | Select (Nuevo / Cita Agendada / Seguimiento / Completado) |
| Idioma | Select (Español / Inglés) |
| Fecha de Llamada | Date |
| Fecha de Cita | Date |
| Servicio Solicitado | Multi-select |
| Resumen de Llamada | Text |
| Transcripción | Text |
| Escalado a Humano | Checkbox |
| Notas | Text |
| Call ID Retell | Text |

Connect your Notion integration to this database (⋯ → Connect to → your integration).

### 6. Expose Locally (Development)

```bash
# Install ngrok
winget install ngrok.ngrok

# Run
npm run build
node dist/index.js &
ngrok http 5000
```

Update your Retell agent URLs with the ngrok URL.

### 7. Production Deploy

Deploy to Railway (recommended):

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

Set environment variables in Railway dashboard.

---

## Project Structure

```
voice-booking-agent/
├── src/
│   ├── index.ts              # Express + WebSocket server
│   ├── config.ts             # Env vars + business.config.md parser
│   ├── routes/
│   │   └── webhooks.ts       # Retell webhook handler → saves to Notion
│   └── services/
│       ├── customLLM.ts      # WebSocket → Claude real-time voice brain
│       └── promptBuilder.ts  # Builds system prompt from business.config.md
├── businesses/
│   ├── salon.md              # Example: beauty salon config
│   └── manicure.md           # Example: nail salon config
├── business.config.md        # ← YOUR BUSINESS CONFIG (edit this)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Customizing for a New Business

1. Copy a template from `businesses/` folder
2. Replace `business.config.md` with your content
3. Rebuild: `npm run build && pm2 restart`

That's it. The AI reads the config and adapts automatically.

---

## Features

- ✅ **Bilingual EN/ES** — detects dominant language turn by turn
- ✅ **Instant greeting** — no delay on call connect
- ✅ **Returning customer recognition** — looks up caller in Notion
- ✅ **Real-time availability** — checks Notion before confirming dates
- ✅ **Auto-saves to Notion** — full booking data after each call
- ✅ **Live dashboard** — `http://localhost:5000/dashboard`
- ✅ **Any business type** — just edit `business.config.md`
- ✅ **Mobile or fixed location** — configurable
- ✅ **PM2 ready** — auto-restarts on crash

---

## Tech Stack

- **Retell AI** — telephony & voice
- **Claude Haiku** — real-time LLM (low latency)
- **Notion** — database for bookings & CRM
- **Node.js + TypeScript** — backend
- **Express + WebSocket (ws)** — server

---

## License

MIT
