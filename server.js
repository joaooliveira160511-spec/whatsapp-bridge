// HTTP: /health, página de pareamento (QR/código) e endpoint MCP somente-leitura.
import express from 'express';
import QRCode from 'qrcode';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const safeEqual = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
};

export function createServer({ store, wa, mcpSecret, adminSecret, allowedContacts }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req, res) => {
    res.json({ ok: true, whatsapp: wa.status.connection, ...(await store.stats()) });
  });

  // Página de pareamento. Quem tem esta URL pode vincular um aparelho à sua conta: mantenha o segredo.
  app.get('/pair/:secret', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    if (!safeEqual(req.params.secret, adminSecret)) return res.status(404).send('Not found');

    let body;
    if (wa.status.connection === 'open') {
      body = '<h1>Conectado ✓</h1><p>O WhatsApp já está vinculado. Você pode fechar esta página.</p>';
    } else if (wa.status.pairingCode) {
      body = `<h1>Código de pareamento</h1><p style="font-size:2.4rem;letter-spacing:.3rem;font-family:monospace">${wa.status.pairingCode}</p>
        <p>No WhatsApp: Configurações → Aparelhos conectados → Conectar aparelho → <b>Conectar com número de telefone</b>.</p>`;
    } else if (wa.status.qr) {
      const img = await QRCode.toDataURL(wa.status.qr, { margin: 2, scale: 8 });
      body = `<h1>Escaneie com o WhatsApp</h1><img alt="QR Code" src="${img}" width="320" height="320">
        <p>WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho.</p>`;
    } else {
      body = `<h1>Aguardando…</h1><p>Estado: ${wa.status.connection}. A página atualiza sozinha.</p>`;
    }
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
      <meta http-equiv="refresh" content="5"><title>Pareamento</title>
      <style>body{font-family:system-ui,sans-serif;text-align:center;padding:2rem;color:#222}</style></head>
      <body>${body}</body></html>`);
  });

  function buildMcp() {
    const server = new McpServer({ name: 'whatsapp-bridge', version: '1.0.0' });

    server.registerTool(
      'get_recent_messages',
      {
        title: 'Mensagens recentes do WhatsApp (contatos permitidos)',
        description:
          `Retorna, em ordem cronológica, as mensagens recentes das conversas de WhatsApp com os contatos permitidos (${allowedContacts.join(', ')}). ` +
          'Somente leitura; conversas de outros contatos nunca são armazenadas nem retornadas. ' +
          'Horários em time_local já estão no fuso do usuário.',
        inputSchema: { hours: z.number().int().min(1).max(168).default(24).describe('Janela de busca em horas (1 a 168).') },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ hours }) => {
        const messages = await store.getRecent(hours ?? 24);
        const payload = {
          window_hours: hours ?? 24,
          whatsapp_connection: wa.status.connection,
          count: messages.length,
          messages,
          ...(wa.status.connection !== 'open' && {
            note: 'O WhatsApp não está conectado agora; podem faltar mensagens recentes.',
          }),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    );

    server.registerTool(
      'get_connection_status',
      {
        title: 'Estado da conexão com o WhatsApp',
        description: 'Informa se a ponte está conectada ao WhatsApp e quantas mensagens estão armazenadas.',
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async () => {
        const payload = { whatsapp_connection: wa.status.connection, last_open_at: wa.status.lastOpenAt, ...(await store.stats()) };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    );

    return server;
  }

  // MCP (Streamable HTTP, sem estado). O segredo vai no caminho da URL.
  app.post('/mcp/:secret', async (req, res) => {
    if (!safeEqual(req.params.secret, mcpSecret)) return res.status(404).send('Not found');
    const server = buildMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const notAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  app.get('/mcp/:secret', notAllowed);
  app.delete('/mcp/:secret', notAllowed);

  return app;
}
