import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Load business config from business.config.md
function loadBusinessConfig(): Record<string, string> {
  const configPath = path.join(process.cwd(), 'business.config.md');
  if (!fs.existsSync(configPath)) {
    console.warn('[Config] business.config.md not found — using defaults');
    return {};
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  const cfg: Record<string, string> = {};

  // Parse ## Section headers and their content
  const sections = content.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split('\n');
    const key = lines[0].trim().toLowerCase().replace(/\s+/g, '_');
    const value = lines.slice(1).filter(l => l.trim() && !l.startsWith('#')).join('\n').trim();
    cfg[key] = value;
  }
  return cfg;
}

export const businessConfig = loadBusinessConfig();

export const config = {
  port: process.env.PORT || '5000',
  nodeEnv: process.env.NODE_ENV || 'development',
  retellApiKey: process.env.RETELL_API_KEY || '',
  retellAgentId: process.env.RETELL_AGENT_ID || '',
  retellSigningKey: process.env.RETELL_SIGNING_KEY || '',
  notionApiKey: process.env.NOTION_API_KEY || '',
  notionDatabaseId: process.env.NOTION_DATABASE_ID || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  // From business.config.md
  businessName: businessConfig['business_name'] || 'My Business',
  agentName: businessConfig['agent_name'] || 'Alex',
  greeting: businessConfig['greeting'] || 'Thank you for calling {business_name}! This is {agent_name}. How can I help?',
  isMobile: (businessConfig['mobile_service'] || 'false').startsWith('true'),
  maxPerDay: parseInt(businessConfig['max_appointments_per_day'] || '8', 10),
};

export function validateConfig() {
  const missing: string[] = [];
  if (!config.retellApiKey) missing.push('RETELL_API_KEY');
  if (!config.notionApiKey) missing.push('NOTION_API_KEY');
  if (!config.notionDatabaseId) missing.push('NOTION_DATABASE_ID');
  if (!config.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) console.warn(`[WARNING] Missing env vars: ${missing.join(', ')}`);
  else console.log('[INFO] All environment variables validated ✅');
  console.log(`[INFO] Business: ${config.businessName} | Agent: ${config.agentName} | Mobile: ${config.isMobile}`);
}
