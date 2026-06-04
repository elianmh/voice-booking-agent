import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import { config, validateConfig } from './config';
import webhookRoutes from './routes/webhooks';
import { attachCustomLLMToServer } from './services/customLLM';

const app = express();
const PORT = config.port;

validateConfig();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard.html'));
});

app.use('/webhooks', webhookRoutes);

app.get('/', (_req, res) => {
  res.json({ status: 'online', business: config.businessName, agent: config.agentName });
});

app.get('/health', (_req, res) => res.status(200).send('OK'));

const server = http.createServer(app);

if (config.anthropicApiKey) {
  attachCustomLLMToServer(server);
}

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 ${config.businessName} — Voice Agent`);
  console.log(`📞 Webhook:    http://localhost:${PORT}/webhooks/retell`);
  console.log(`🎙️  Custom LLM: ws://localhost:${PORT}/llm-websocket`);
  console.log(`==================================================\n`);
});
