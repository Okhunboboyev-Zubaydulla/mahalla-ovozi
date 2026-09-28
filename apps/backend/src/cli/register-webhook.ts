import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { createDbPool } from '../adapters/db/client.js';
import { decryptToken } from '../adapters/crypto/token-cipher.js';
import { deriveWebhookSecret } from '../modules/telegram-intake/webhook-security.js';

export async function run() {
  const ngrokUrl = process.argv[2] || 'https://mulled-revivable-satirical.ngrok-free.dev';
  const dropPending = process.argv.includes('--drop-pending');
  const pool = createDbPool();

  try {
    const res = await pool.query(
      'SELECT bot_id, encrypted_token, token_iv, token_tag FROM district_telegram_bots WHERE bot_id = $1',
      ['8293431272'],
    );
    const row = res.rows[0];
    if (!row) {
      console.error('Bot 8293431272 not found in DB');
      return;
    }

    const token = decryptToken({
      encryptedToken: row.encrypted_token,
      tokenIv: row.token_iv,
      tokenTag: row.token_tag,
    });

    const webhookUrl = `${ngrokUrl}/api/v1/webhooks/telegram/${row.bot_id}`;
    const secretToken = deriveWebhookSecret(row.bot_id);

    const webhookPayload: Record<string, unknown> = {
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message'],
      max_connections: 100,
      drop_pending_updates: dropPending,
    };

    console.log(`Setting Telegram webhook -> ${webhookUrl}`);
    console.log('Payload configuration:', JSON.stringify(webhookPayload, null, 2));

    // Clear any previous IP override or backoff state without dropping citizen updates
    await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    });

    const tgData = await tgRes.json();
    console.log('Telegram API setWebhook response:', tgData);

    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const infoData = await infoRes.json();
    console.log('Telegram Webhook Info:', infoData);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes('register-webhook')) {
  run().catch(console.error);
}
