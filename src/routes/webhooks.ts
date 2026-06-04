import { Router, Request, Response } from 'express';
import { Client as NotionClient } from '@notionhq/client';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

const router = Router();
const notion = new NotionClient({ auth: config.notionApiKey });
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const NOTION_DB = config.notionDatabaseId;

// ── In-memory live call registry ──────────────────────────────────────────
export const activeCalls: Record<string, {
  callId: string;
  phoneNumber: string;
  status: 'active' | 'ended';
  transcript: string;
  startTime: string;
  lastUpdate: number;
}> = {};

// Prevent saving same call twice (call_ended + call_analyzed both fire)
const savedCalls = new Set<string>();

// SSE clients waiting for live updates
const sseClients: Set<Response> = new Set();

export function broadcastToSSE(data: object) {
  const msg = `data: ${JSON.stringify(data)}

`;
  sseClients.forEach(res => {
    try { res.write(msg); } catch { sseClients.delete(res); }
  });
}

// ── SSE endpoint for live dashboard ──────────────────────────────────────
router.get('/live', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send current active calls immediately
  res.write(`data: ${JSON.stringify({ type: 'init', calls: Object.values(activeCalls) })}

`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Dashboard calls snapshot ──────────────────────────────────────────────
router.get('/dashboard-calls', (_req: Request, res: Response) => {
  res.json({ activeCalls: Object.values(activeCalls) });
});

// ── Extract call data from transcript using Claude ────────────────────────
async function extractCallData(transcript: string, phoneNumber: string) {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are extracting data from a car detailing call transcript to save in a CRM.
Today's date is ${today}. Tomorrow is ${tomorrow}.
Return ONLY a single valid JSON object. No explanation, no markdown, no extra text.

RULES:
- "fecha_cita": Convert ANY date mention to YYYY-MM-DD format.
  - "mañana" or "tomorrow" = ${tomorrow}
  - "hoy" or "today" = ${today}
  - Day names (lunes/monday etc) = next occurrence from today
  - If a specific date was confirmed by agent AND customer, use it. Otherwise null.
- "cita_confirmada": true ONLY if agent explicitly confirmed the appointment (said "confirmado", "agendado", "confirmed", "booked", "see you then", "hasta pronto"). Otherwise false.
- "estado": Use EXACTLY one of: "Cita Agendada" | "Seguimiento" | "No Interesado" | "Nuevo"
  - "Cita Agendada" = appointment was fully confirmed with date AND service
  - "Seguimiento" = interested but did not book / needs follow-up
  - "No Interesado" = customer declined or hung up
  - "Nuevo" = call ended without clear outcome
- "notas": Key highlights for the team: vehicle details, special requests, objections, add-ons mentioned, anything notable. In the call's language.
- "hora_cita": Time of appointment like "9:00 AM" or "14:00", or null.
- "escalado": true if customer asked for a human or supervisor.

TRANSCRIPT:
${transcript.substring(0, 3500)}

Return this exact JSON:
{
  "nombre": "full name or null",
  "telefono": "phone number or null",
  "vehiculo": "make model year or null",
  "servicio": "exact service name or null",
  "fecha_cita": "YYYY-MM-DD or null",
  "hora_cita": "HH:MM AM/PM or null",
  "cita_confirmada": false,
  "estado": "Nuevo",
  "idioma": "Español or Inglés",
  "escalado": false,
  "resumen": "1-2 sentence summary of the call in the call language",
  "notas": "key highlights for the team or null"
}`
    }]
  });

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}';
  const match = text.match(/\{[\s\S]*\}/);
  try { return match ? JSON.parse(match[0]) : {}; } catch { return {}; }
}

// ── Map service name to Notion multi_select option ────────────────────────
function mapServicio(servicio: string | null): string[] {
  if (!servicio) return [];
  const s = servicio.toLowerCase();
  const result: string[] = [];
  if (s.includes('platinum') || s.includes('platino')) result.push('Platinum Detail');
  else if (s.includes('gold') || s.includes('oro')) result.push('Gold Detail');
  else if (s.includes('silver') || s.includes('plata') || s.includes('wash') || s.includes('lavado')) result.push('Silver Wash');
  if (s.includes('pet') || s.includes('pelo') || s.includes('mascota')) result.push('Pet hair');
  if (s.includes('engine') || s.includes('motor')) result.push('Engine');
  if (s.includes('headlight') || s.includes('faro')) result.push('Headlights');
  return result.length ? result : [];
}

// ── Save call to Notion DB ────────────────────────────────────────────────
async function saveToNotion(callId: string, phoneNumber: string, transcript: string, durationMs?: number) {
  try {
    const data = await extractCallData(transcript, phoneNumber);
    const callDate = new Date().toISOString().split('T')[0];
    const servicios = mapServicio(data.servicio);

    // Estado: trust Claude's extraction, fallback to date presence
    const estado: string = data.estado && ['Cita Agendada','Seguimiento','No Interesado','Nuevo'].includes(data.estado)
      ? data.estado
      : (data.cita_confirmada || data.fecha_cita) ? 'Cita Agendada' : 'Seguimiento';

    // Build appointment datetime string
    let appointmentDate: string | null = data.fecha_cita || null;
    if (appointmentDate && data.hora_cita) {
      // Notion date with time: combine date + time
      try {
        const timeParts = data.hora_cita.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
        if (timeParts) {
          let h = parseInt(timeParts[1]);
          const m = timeParts[2];
          const ampm = timeParts[3]?.toUpperCase();
          if (ampm === 'PM' && h < 12) h += 12;
          if (ampm === 'AM' && h === 12) h = 0;
          appointmentDate = `${appointmentDate}T${String(h).padStart(2,'0')}:${m}:00`;
        }
      } catch { /* keep date only */ }
    }

    const properties: Record<string, any> = {
      'Nombre':           { title: [{ text: { content: data.nombre || phoneNumber || 'Desconocido' } }] },
      'Teléfono':         { phone_number: data.telefono || phoneNumber || null },
      'Estado':           { select: { name: estado } },
      'Idioma':           { select: { name: data.idioma || 'Inglés' } },
      'Fecha de Llamada': { date: { start: callDate } },
      'Resumen de Llamada': { rich_text: [{ text: { content: (data.resumen || '').substring(0, 2000) } }] },
      'Transcripción':    { rich_text: [{ text: { content: transcript.substring(0, 2000) } }] },
      'Escalado a Humano':{ checkbox: Boolean(data.escalado) },
      'Call ID Retell':   { rich_text: [{ text: { content: callId } }] },
      'Notas':            { rich_text: [{ text: { content: (data.notas || '').substring(0, 2000) } }] },
    };

    // Servicio Solicitado (multi_select)
    if (servicios.length > 0) {
      properties['Servicio Solicitado'] = { multi_select: servicios.map(s => ({ name: s })) };
    }

    // Fecha de Cita — only when confirmed booking
    if (appointmentDate) {
      properties['Fecha de Cita'] = { date: { start: appointmentDate } };
    }

    console.log(`[Webhook] 💾 Saving → Estado: ${estado} | Fecha cita: ${appointmentDate || 'none'} | Servicio: ${data.servicio || 'none'} | Notas: ${data.notas?.substring(0,60) || 'none'}`);

    const page = await notion.pages.create({ parent: { database_id: NOTION_DB }, properties });
    console.log(`[Webhook] ✅ Saved: ${page.id} | ${data.nombre} | ${estado}`);
    broadcastToSSE({ type: 'notion_saved', callId, nombre: data.nombre, estado, servicio: data.servicio, fecha: appointmentDate });
    return page;
  } catch (err: any) {
    console.error('[Webhook] ❌ Notion save failed:', err.message);
    throw err;
  }
}

// ── Normalize transcript: Retell sends string OR array of objects ─────────────
function normalizeTranscript(raw: any): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((t: any) => {
      const role    = t.role === 'agent' ? 'Agent' : 'User';
      const content = t.content || t.message || '';
      return `${role}: ${content}`;
    }).join('\n');
  }
  return String(raw);
}

// ── Main Retell webhook handler ────────────────────────────────────────────────
router.post('/retell', async (req: Request, res: Response) => {
  try {
    const { event, call } = req.body;
    if (!call) return res.status(400).json({ error: 'Missing call data' });

    const callId      = call.call_id;
    const phoneNumber = call.from_number || call.to_number || '';
    // Normalize transcript — Retell can send string or array
    const transcript  = normalizeTranscript(call.transcript);

    console.log(`[Webhook] Event: ${event} | Call: ${callId} | Transcript length: ${transcript.length}`);

    if (event === 'call_started') {
      activeCalls[callId] = {
        callId, phoneNumber, status: 'active',
        transcript: '', startTime: new Date().toISOString(), lastUpdate: Date.now(),
      };
      broadcastToSSE({ type: 'call_started', callId, phoneNumber });
    }

    if (event === 'call_ongoing' || event === 'transcript_updated') {
      if (activeCalls[callId]) {
        activeCalls[callId].transcript = transcript;
        activeCalls[callId].lastUpdate = Date.now();
      }
      broadcastToSSE({ type: 'transcript_update', callId, transcript });
    }

    if (event === 'call_ended') {
      if (activeCalls[callId]) {
        activeCalls[callId].status = 'ended';
        activeCalls[callId].transcript = transcript;
      }
      broadcastToSSE({ type: 'call_ended', callId, transcript });
      // Don't save yet — wait for call_analyzed which has the full final transcript
      setTimeout(() => { delete activeCalls[callId]; }, 300000);
    }

    // ── ONLY save to Notion on call_analyzed (complete data, fires once per call) ──
    if (event === 'call_analyzed') {
      if (activeCalls[callId]) {
        activeCalls[callId].status = 'ended';
        activeCalls[callId].transcript = transcript;
      }
      broadcastToSSE({ type: 'call_ended', callId, transcript });

      // Guard against duplicates
      if (savedCalls.has(callId)) {
        console.log(`[Webhook] Skipping duplicate save for call: ${callId}`);
        return res.status(200).json({ received: true });
      }

      const minLength = 30;
      if (transcript && transcript.length > minLength) {
        savedCalls.add(callId);
        setTimeout(() => savedCalls.delete(callId), 3600000);
        console.log(`[Webhook] 💾 Saving call to Notion: ${callId}`);
        await saveToNotion(callId, phoneNumber, transcript, call.duration_ms);
      } else {
        console.log(`[Webhook] Skipping save — transcript too short (${transcript.length} chars)`);
      }

      setTimeout(() => { delete activeCalls[callId]; }, 300000);
    }

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('[Webhook] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;



