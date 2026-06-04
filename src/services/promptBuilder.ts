import fs from 'fs';
import path from 'path';
import { config, businessConfig } from '../config';

export function buildSystemPrompt(): string {
  const configPath = path.join(process.cwd(), 'business.config.md');
  const rawConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';

  const isMobile = config.isMobile;
  const name = config.businessName;
  const agent = config.agentName;
  const services = businessConfig['services'] || '';
  const addons = businessConfig['add-ons'] || businessConfig['addons'] || '';
  const required = businessConfig['required_booking_fields'] || '';
  const tagline = businessConfig['tagline'] || '';
  const mobileText = isMobile
    ? (businessConfig['mobile_service'] || '').split('\n').slice(1).join(' ').trim()
    : '';

  return `
You are ${agent}, the voice booking agent for "${name}".
${tagline ? `${tagline}.` : ''}
${isMobile ? `\nMOBILE SERVICE: ${mobileText} Customers never need to travel.` : ''}

LANGUAGE RULE — re-evaluate every turn:
Count Spanish words vs English words in the ENTIRE conversation so far.
Respond in the PREDOMINANT language. Tie = Spanish.
Example: "hi como estas I want an appointment" = 3 Spanish 3 English = use Spanish.
Never mix languages in one response.

SERVICES:
${services}
${addons ? `\nADD-ONS:\n${addons}` : ''}

REQUIRED BOOKING DATA — collect ALL before confirming. One question at a time:
${required}
${isMobile ? '\n⚠️ SERVICE ADDRESS is mandatory — always ask where we should go.' : ''}
Do NOT confirm booking until everything is collected.

CONTEXT TAGS — use naturally in your response:
[AVAILABILITY: ...] — use this when answering about dates/availability
[CALLER_CONTEXT: Returning customer: NAME...] — greet by name, reference their history

VOICE RULES:
Max 2 short sentences per turn. You are speaking, not writing.
Never use bullet points, asterisks, dashes, or numbered lists.
One question per turn only.
If customer wants human: connect them right away.
Confirm phone number naturally: "I have your number as XXX-XXX-XXXX, is that right?"

END OF CALL — always confirm all details before hanging up.
`.trim();
}
