import Redis from 'ioredis';
import pino from 'pino';
import { createStore } from './store.js';
import { createWhatsApp } from './whatsapp.js';
import { createServer } from './server.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

function requireEnv(name, { minLength = 1 } = {}) {
  const v = process.env[name];
  if (!v || v.length < minLength) {
    log.fatal(`Variável de ambiente ${name} ausente ou curta demais (mínimo ${minLength} caracteres).`);
    process.exit(1);
  }
  return v;
}

const redisUrl = requireEnv('REDIS_URL');
const mcpSecret = requireEnv('MCP_SECRET', { minLength: 24 });
const adminSecret = requireEnv('ADMIN_SECRET', { minLength: 24 });
const allowedContacts = (process.env.ALLOWED_CONTACTS || 'uber')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const retentionDays = Number(process.env.RETENTION_DAYS || 14);
const timeZone = process.env.TZ_NAME || 'America/Sao_Paulo';
const pairingPhone = (process.env.PAIRING_PHONE || '').replace(/\D/g, '') || undefined;
const port = Number(process.env.PORT || 10000);

const redis = new Redis(redisUrl);
redis.on('error', (e) => log.error({ err: e.message }, 'erro no Redis'));

const store = createStore(redis, { allowedContacts, retentionDays, timeZone });
await store.init();

const wa = createWhatsApp({ redis, store, pairingPhone, log });
const app = createServer({ store, wa, mcpSecret, adminSecret, allowedContacts });

const httpServer = app.listen(port, () => log.info({ port, allowedContacts }, 'ponte no ar'));
await wa.connect();

setInterval(() => store.prune().catch(() => {}), 60 * 60 * 1000).unref();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log.info({ sig }, 'encerrando');
    await wa.stop();
    httpServer.close();
    await redis.quit().catch(() => {});
    process.exit(0);
  });
}
process.on('unhandledRejection', (e) => log.error({ err: String(e) }, 'unhandledRejection'));
