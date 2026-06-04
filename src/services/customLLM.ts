import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { Client as NotionClient } from '@notionhq/client';
import { config } from '../config';

const NOTION_DB = config.notionDatabaseId || '99284b018092445a846ad79cee79b725';
// Prefetch cache: callId -> caller info (fetched while user speaks)
const callerCache = new Map<string, string | null>();
// Auto-cleanup caller cache every 30 min to prevent memory leaks
setInterval(() => { callerCache.clear(); }, 30 * 60 * 1000);

import { buildSystemPrompt } from './promptBuilder';

// System prompt is built dynamically from business.config.md
const SYSTEM_PROMPT = buildSystemPrompt();

async function checkAvailability(notion: NotionClient, dateStr: string): Promise<string> {
  try {
    const response = await notion.databases.query({
      database_id: NOTION_DB,
      filter: {
        and: [
          { property: 'Fecha de Cita', date: { equals: dateStr } },
          { property: 'Estado', select: { equals: 'Cita Agendada' } },
        ],
      },
    });
    const remaining = Math.max(0, 6 - response.results.length);
    if (remaining === 0) return `${dateStr} is fully booked. Please suggest an alternative date.`;
    return `${dateStr} has ${remaining} slot${remaining > 1 ? 's' : ''} available.`;
  } catch { return 'Availability unavailable, proceed with booking.'; }
}

async function lookupCaller(notion: NotionClient, phone: string): Promise<string | null> {
  try {
    const normalized = phone.replace(/[^0-9+]/g, '');
    const response = await notion.databases.query({
      database_id: NOTION_DB,
      filter: { property: 'Teléfono', phone_number: { equals: normalized } },
    });
    if (response.results.length === 0) return null;
    const p = response.results[0] as any;
    const props = p.properties;
    const nombre = props['Nombre']?.title?.[0]?.plain_text || 'Cliente';
    const servicio = props['Servicio Solicitado']?.multi_select?.map((s: any) => s.name).join(', ') || 'none';
    const fecha = props['Fecha de Cita']?.date?.start || 'none';
    const estado = props['Estado']?.select?.name || '';
    return `Returning customer: ${nombre}. Last service: ${servicio}. Last appt: ${fecha}. Status: ${estado}. Greet by name warmly.`;
  } catch { return null; }
}

function extractDate(text: string): string | null {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const months: Record<string, string> = {
    january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
    july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',
    enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',
    julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'
  };
  const re = new RegExp(`(${Object.keys(months).join('|')})\\s+(\\d{1,2})`, 'i');
  const m = text.match(re);
  if (m) return `${new Date().getFullYear()}-${months[m[1].toLowerCase()]}-${m[2].padStart(2,'0')}`;
  return null;
}
export function attachCustomLLMToServer(server: http.Server) {
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  const notion = new NotionClient({ auth: config.notionApiKey });
  const wss = new WebSocketServer({ server });

  console.log('🎙️  Custom LLM WebSocket attached to /llm-websocket');

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    // accept all websocket connections on this server
    let callId = '';
    let phoneNumber = '';

    ws.on('message', async (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString());

        if (message.interaction_type === 'ping_pong') {
          ws.send(JSON.stringify({ response_type: 'ping_pong', timestamp: Date.now() }));
          return;
        }

        if (message.interaction_type === 'call_details') {
          callId = message.call?.call_id || '';
          phoneNumber = message.call?.from_number || message.call?.to_number || '';
          console.log(`[LLM-WS] Call: ${callId} from ${phoneNumber}`);
          return;
        }

        if (message.interaction_type === 'response_required' || message.interaction_type === 'reminder_required') {
          const transcript = message.transcript || [];
          const responseId = message.response_id;

          // ── INSTANT GREETING on empty transcript (call just connected) ──────
          if (transcript.length === 0) {
            const greeting = 'Thank you for calling Apex Mobile Detailing! This is Alex — hablo inglés y español. How can I help you today?';
            ws.send(JSON.stringify({ response_type: 'response', response_id: responseId, content: greeting, content_complete: true, end_call: false }));
            // Prefetch caller info while user is speaking — store in cache
            if (phoneNumber) {
              lookupCaller(notion, phoneNumber).then(info => {
                callerCache.set(callId, info);
              }).catch(() => callerCache.set(callId, null));
            }
            return;
          }

          // Run Notion lookups in parallel — with 2s timeout so they never block Claude
          const fullText = transcript.map((t: any) => t.content || '').join(' ');
          const detectedDate = extractDate(fullText);
          const isFirstUserMsg = transcript.filter((t: any) => t.role === 'user').length === 1;
          const timeout = <T>(ms: number, p: Promise<T>): Promise<T | null> =>
            Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);

          // Use prefetched caller info (ready from background fetch during greeting)
          const cachedCaller = callerCache.get(callId);
          const callerInfo = isFirstUserMsg
            ? (cachedCaller !== undefined ? cachedCaller : await timeout(1500, lookupCaller(notion, phoneNumber)))
            : null;
          const availResult = detectedDate ? await timeout(2000, checkAvailability(notion, detectedDate)) : null;

          const callerContext = callerInfo ? `\n[CALLER_CONTEXT: ${callerInfo}]` : '';
          const availabilityContext = availResult ? `\n[AVAILABILITY: ${availResult}]` : '';

          // Build clean alternating messages
          const rawMsgs: Anthropic.MessageParam[] = transcript
            .filter((t: any) => t.content && t.content.trim())
            .map((t: any) => ({
              role: (t.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
              content: t.content.trim(),
            }));

          const messages: Anthropic.MessageParam[] = [];
          let lastRole = '';
          for (const m of rawMsgs) {
            if (m.role !== lastRole) { messages.push({ ...m }); lastRole = m.role; }
            else if (m.role === 'user') (messages[messages.length - 1] as any).content += ' ' + m.content;
          }

          if (!messages.length || messages[messages.length - 1].role !== 'user')
            messages.push({ role: 'user', content: 'Hello' });

          if (callerContext || availabilityContext) {
            const last = messages[messages.length - 1];
            if (last.role === 'user') (last as any).content += callerContext + availabilityContext;
          }

          const stream = await anthropic.messages.stream({
            model: 'claude-haiku-4-5', max_tokens: 130,
            system: SYSTEM_PROMPT, messages, temperature: 0.3,
          });

          for await (const chunk of stream) {
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
              ws.send(JSON.stringify({ response_type: 'response', response_id: responseId, content: chunk.delta.text, content_complete: false, end_call: false }));
            }
          }
          ws.send(JSON.stringify({ response_type: 'response', response_id: responseId, content: '', content_complete: true, end_call: false }));
        }
      } catch (err: any) {
        console.error('[LLM-WS] Error:', err.message);
        ws.send(JSON.stringify({ response_type: 'response', response_id: 0, content: 'One moment please.', content_complete: true, end_call: false }));
      }
    });
    ws.on('close', () => console.log(`[LLM-WS] Call ${callId} ended.`));
    ws.on('error', (err: Error) => console.error('[LLM-WS] Error:', err.message));
  });
  return wss;
}

export function startCustomLLMServer(port = 8081) {
  const s = http.createServer();
  attachCustomLLMToServer(s);
  s.listen(port);
  return s;
}




