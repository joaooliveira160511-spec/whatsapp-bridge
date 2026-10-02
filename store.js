// Armazena APENAS mensagens de contatos permitidos (ALLOWED_CONTACTS, padrão: "uber").
// Mensagens de qualquer outra conversa são descartadas na entrada — minimização de dados.
import { normalizeMessageContent } from '@whiskeysockets/baileys';

const KEY_MSGS = 'wa:msgs';
const KEY_JIDS = 'wa:allowed_jids';
const MAX_TEXT = 2000;

export function createStore(redis, { allowedContacts, retentionDays, timeZone }) {
  const contactNames = new Map(); // jid -> "nome | nome" (minúsculo)
  let allowedJids = new Set();
  const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' });

  const nameMatches = (names) => {
    const hay = names.filter(Boolean).join(' | ').toLowerCase();
    return hay && allowedContacts.some((a) => hay.includes(a));
  };

  async function init() {
    allowedJids = new Set(await redis.smembers(KEY_JIDS));
  }

  function rememberContact(c) {
    if (!c?.id) return;
    const names = [c.name, c.notify, c.verifiedName].filter(Boolean).join(' | ').toLowerCase();
    if (names) contactNames.set(c.id, names);
  }

  function extractText(m) {
    const content = normalizeMessageContent(m.message);
    if (!content) return '';
    return (
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      content.buttonsMessage?.contentText ||
      content.templateMessage?.hydratedTemplate?.hydratedContentText ||
      content.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
      content.interactiveMessage?.body?.text ||
      content.listMessage?.description ||
      ''
    );
  }

  const toSeconds = (ts) => {
    const n = Number(ts?.toString?.() ?? ts);
    return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000);
  };

  // Retorna true se a mensagem foi armazenada.
  async function handleMessage(m) {
    const jid = m.key?.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter')) return false;

    if (!allowedJids.has(jid)) {
      const names = [m.key.fromMe ? null : m.pushName, m.verifiedBizName, contactNames.get(jid)];
      if (!nameMatches(names)) return false;
      allowedJids.add(jid);
      await redis.sadd(KEY_JIDS, jid);
    }

    const text = extractText(m).trim();
    if (!text) return false;

    const ts = toSeconds(m.messageTimestamp);
    if (ts < Date.now() / 1000 - retentionDays * 86400) return false;

    const id = m.key.id;
    if (id) {
      const isNew = await redis.set(`wa:seen:${id}`, '1', 'EX', retentionDays * 86400, 'NX');
      if (!isNew) return false;
    }

    const record = {
      id,
      ts,
      direction: m.key.fromMe ? 'enviada' : 'recebida',
      sender: m.key.fromMe ? 'eu' : m.verifiedBizName || m.pushName || '',
      text: text.slice(0, MAX_TEXT),
    };
    await redis.zadd(KEY_MSGS, ts, JSON.stringify(record));
    return true;
  }

  async function getRecent(hours) {
    const from = Math.floor(Date.now() / 1000) - hours * 3600;
    const rows = await redis.zrangebyscore(KEY_MSGS, from, '+inf');
    return rows.map((r) => {
      const rec = JSON.parse(r);
      return {
        time_local: fmt.format(new Date(rec.ts * 1000)),
        time_utc: new Date(rec.ts * 1000).toISOString(),
        direction: rec.direction,
        sender: rec.sender,
        text: rec.text,
      };
    });
  }

  async function prune() {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    await redis.zremrangebyscore(KEY_MSGS, '-inf', cutoff);
  }

  async function stats() {
    return { stored_messages: await redis.zcard(KEY_MSGS), tracked_chats: allowedJids.size };
  }

  return { init, rememberContact, handleMessage, getRecent, prune, stats };
}
