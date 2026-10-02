// Conexão com o WhatsApp via Baileys (protocolo de "aparelho vinculado", sem navegador).
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { useRedisAuthState, clearAuthState } from './redisAuth.js';

export function createWhatsApp({ redis, store, pairingPhone, log }) {
  const status = {
    connection: 'starting', // starting | connecting | open | close | logged_out
    qr: null,
    pairingCode: null,
    lastOpenAt: null,
    lastCloseCode: null,
  };

  let sock = null;
  let retries = 0;
  let stopped = false;
  let reconnectTimer = null;
  const baileysLog = pino({ level: 'warn' });

  function scheduleReconnect(delayMs) {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect().catch((e) => log.error({ err: e.message }, 'falha ao reconectar')), delayMs);
  }

  async function connect() {
    const { state, saveCreds } = await useRedisAuthState(redis);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    status.connection = 'connecting';
    let pairingRequested = false;

    // O aparelho aparecerá no celular como "Chrome (Ubuntu)" em Aparelhos conectados.
    sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLog) },
      logger: baileysLog,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false, // não "rouba" as notificações do celular
      generateHighQualityLinkPreview: false,
    });
    const current = sock;

    current.ev.on('creds.update', saveCreds);

    current.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        status.qr = qr;
        if (pairingPhone && !pairingRequested && !state.creds.registered) {
          pairingRequested = true;
          try {
            status.pairingCode = await current.requestPairingCode(pairingPhone);
          } catch (e) {
            log.error({ err: e.message }, 'falha ao pedir código de pareamento');
          }
        }
      }

      if (connection === 'open') {
        status.connection = 'open';
        status.qr = null;
        status.pairingCode = null;
        status.lastOpenAt = new Date().toISOString();
        retries = 0;
        log.info('WhatsApp conectado');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        status.lastCloseCode = code ?? null;
        status.qr = null;
        status.pairingCode = null;
        current.ev.removeAllListeners();

        if (code === DisconnectReason.loggedOut) {
          // Aparelho desvinculado pelo celular: limpa a sessão e gera um novo QR.
          status.connection = 'logged_out';
          log.warn('sessão desvinculada; limpando credenciais');
          await clearAuthState(redis);
          scheduleReconnect(3000);
        } else if (code === DisconnectReason.connectionReplaced) {
          // Outra instância usando as mesmas credenciais: espera mais para não brigar por elas.
          status.connection = 'close';
          log.warn('conexão substituída por outra instância; aguardando 60s');
          scheduleReconnect(60_000);
        } else {
          status.connection = 'close';
          const delay = Math.min(30_000, 2000 * 2 ** retries++);
          log.warn({ code, delay }, 'conexão fechada; reconectando');
          scheduleReconnect(delay);
        }
      }
    });

    current.ev.on('contacts.upsert', (cs) => cs.forEach((c) => store.rememberContact(c)));
    current.ev.on('contacts.update', (cs) => cs.forEach((c) => store.rememberContact(c)));

    current.ev.on('messaging-history.set', async ({ contacts, messages }) => {
      (contacts || []).forEach((c) => store.rememberContact(c));
      let saved = 0;
      for (const m of messages || []) if (await store.handleMessage(m).catch(() => false)) saved++;
      log.info({ saved }, 'histórico inicial processado');
    });

    current.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        try {
          await store.handleMessage(m);
        } catch (e) {
          log.error({ err: e.message }, 'erro ao processar mensagem');
        }
      }
    });
  }

  async function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    try {
      sock?.end(undefined);
    } catch {}
  }

  return { status, connect, stop };
}
