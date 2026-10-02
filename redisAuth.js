// Estado de autenticação do Baileys persistido em Redis (Render Key Value).
// Assim a sessão sobrevive a redeploys e o QR Code só precisa ser escaneado uma vez.
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

const PREFIX = 'wa:auth';

export async function useRedisAuthState(redis) {
  const k = (name) => `${PREFIX}:${name}`;
  const read = async (name) => {
    const raw = await redis.get(k(name));
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
  };
  const write = (name, value) => redis.set(k(name), JSON.stringify(value, BufferJSON.replacer));
  const remove = (name) => redis.del(k(name));

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              tasks.push(value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

// Apaga toda a sessão (usado quando o WhatsApp desvincula o aparelho).
export async function clearAuthState(redis) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}
