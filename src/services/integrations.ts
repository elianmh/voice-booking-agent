/**
 * integrations.ts
 * Optional integrations: Twilio SMS + Google Calendar
 * If credentials are not set, these silently skip.
 */
import twilio from 'twilio';
import { google } from 'googleapis';
import { config } from '../config';

// ── Twilio SMS ────────────────────────────────────────────────────────────────
export async function sendSMSConfirmation(params: {
  toPhone: string;
  clientName: string;
  service: string;
  date: string;
  address?: string;
  businessName: string;
  agentPhone: string;
}): Promise<void> {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log('[SMS] Twilio not configured — skipping SMS confirmation');
    return;
  }
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const isSpa = config.businessName.toLowerCase().includes('spa') || config.businessName.toLowerCase().includes('salon');
    const msg = params.address
      ? `Hi ${params.clientName}! Your ${params.service} with ${params.businessName} is confirmed for ${params.date} at ${params.address}. Questions? Call ${params.agentPhone}`
      : `Hi ${params.clientName}! Your ${params.service} appointment with ${params.businessName} is confirmed for ${params.date}. See you then!`;

    await client.messages.create({
      body: msg,
      from: process.env.TWILIO_FROM_NUMBER!,
      to: params.toPhone,
    });
    console.log(`[SMS] ✅ Confirmation sent to ${params.toPhone}`);
  } catch (err: any) {
    console.warn(`[SMS] Failed to send SMS: ${err.message}`);
  }
}

// ── Google Calendar ───────────────────────────────────────────────────────────
export async function createCalendarEvent(params: {
  title: string;
  description: string;
  startDate: string;    // ISO or YYYY-MM-DD
  durationMinutes: number;
  location?: string;
  attendeeEmail?: string;
}): Promise<string | null> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const serviceKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!calendarId || !serviceEmail || !serviceKey) {
    console.log('[Calendar] Google Calendar not configured — skipping');
    return null;
  }
  try {
    const credentials = JSON.parse(serviceKey);
    const auth = new google.auth.JWT({ email: serviceEmail, key: credentials.private_key || serviceKey, scopes: ['https://www.googleapis.com/auth/calendar'] });

    const calendar = google.calendar({ version: 'v3', auth });
    const start = new Date(params.startDate);
    const end = new Date(start.getTime() + params.durationMinutes * 60000);

    const event = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: params.title,
        description: params.description,
        location: params.location,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: params.attendeeEmail ? [{ email: params.attendeeEmail }] : [],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 60 },
          ],
        },
      },
    });
    console.log(`[Calendar] ✅ Event created: ${event.data.htmlLink}`);
    return event.data.htmlLink || null;
  } catch (err: any) {
    console.warn(`[Calendar] Failed to create event: ${err.message}`);
    return null;
  }
}

