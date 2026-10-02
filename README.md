# whatsapp-bridge

Ponte minimalista entre o WhatsApp pessoal (via [Baileys](https://github.com/WhiskeySockets/Baileys)) e o Claude (via MCP).

- Sessão do WhatsApp persistida em Redis (Render Key Value): o QR Code é escaneado só uma vez.
- Armazena **apenas** mensagens dos contatos listados em `ALLOWED_CONTACTS` (padrão: `uber`). Todo o resto é descartado na entrada.
- Expõe um endpoint MCP somente-leitura em `/mcp/<MCP_SECRET>` com as ferramentas `get_recent_messages` e `get_connection_status`.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `REDIS_URL` | sim | URL interna do Render Key Value |
| `MCP_SECRET` | sim (≥24 caracteres) | Segredo no caminho do endpoint: `POST /mcp/<MCP_SECRET>` |
| `ADMIN_SECRET` | sim (≥24 caracteres) | Segredo da página de pareamento: `GET /pair/<ADMIN_SECRET>` |
| `ALLOWED_CONTACTS` | não | Palavras-chave de contatos permitidos, separadas por vírgula (padrão `uber`) |
| `RETENTION_DAYS` | não | Dias de retenção (padrão 14) |
| `TZ_NAME` | não | Fuso dos horários (padrão `America/Sao_Paulo`) |
| `PAIRING_PHONE` | não | Número com DDI (ex.: `5531...`) para parear por código em vez de QR |

## Aviso

O Baileys é uma implementação não oficial do protocolo do WhatsApp e não é afiliado a ele. O uso pode violar os Termos de Uso e a conta pode ser limitada ou banida. Use por sua conta e risco, de preferência com um número que você possa perder.
