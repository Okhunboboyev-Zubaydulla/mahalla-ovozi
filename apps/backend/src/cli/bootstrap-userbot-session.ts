import fs from 'node:fs';
import readline from 'node:readline';
import { createDbPool, createDbClient } from '../adapters/db/client.js';
import { bootstrapUserbotSession } from '../modules/userbot-session/index.js';

let pipedLines: string[] | null = null;

function readNextPipedLine(): string {
  if (pipedLines === null) {
    try {
      const raw = fs.readFileSync(0, 'utf-8');
      pipedLines = raw.split(/\r?\n/);
    } catch {
      pipedLines = [];
    }
  }
  return pipedLines.shift() ?? '';
}

function promptLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(readNextPipedLine().trim());
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve(readNextPipedLine().replace(/[\r\n]+$/, ''));
  }

  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let password = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (chunk: Buffer) => {
      const str = chunk.toString('utf-8');
      for (const char of str) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(password);
          return;
        } else if (char === '\u0003') {
          // Ctrl+C
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(1);
        } else if (char === '\b' || char === '\x7f') {
          // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
        } else {
          password += char;
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

export async function runCli(): Promise<void> {
  console.log('=== Mahalla Ovozi — District Userbot Session Bootstrap ===\n');

  let districtId = '';
  const districtArgIdx = process.argv.findIndex(
    (arg) => arg === '--district-id' || arg === '-d',
  );
  if (districtArgIdx !== -1 && process.argv[districtArgIdx + 1]) {
    districtId = process.argv[districtArgIdx + 1]!.trim();
  }

  if (!districtId) {
    districtId = await promptLine('Туман ID сини киритинг (districtId): ');
  }

  if (!districtId) {
    console.error('Хатолик: Туман ID си бўш бўлиши мумкин эмас.');
    process.exit(1);
  }

  const pool = createDbPool();
  const db = createDbClient(pool);

  try {
    const session = await bootstrapUserbotSession(db, {
      districtId,
      getPhoneCode: async () => {
        console.log('\nTelegram тасдиқлаш коди юборилди.');
        const code = await promptLine('Telegram тасдиқлаш кодини киритинг (SMS / App code): ');
        return code;
      },
      getPassword: async () => {
        const pass = await promptHiddenPassword(
          'Икки босқичли хавфсизлик паролини киритинг (2FA password): ',
        );
        return pass;
      },
      actorId: 'cli_bootstrap',
    });

    console.log(`\n✅ Туман userbot сессияси муваффақиятли фаоллаштирилди (ACTIVE).`);
    console.log(`   Туман: ${session.districtId}`);
    console.log(`   Телефон рақами: ${session.phoneNumber}`);
    console.log(`   Сессия ҳолати: ${session.status}`);
    console.log(`   Фаоллаштирилган вақт: ${session.updatedAt.toISOString()}`);
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Сессияни фаоллаштиришда хатолик: ${errorMsg}`);
    process.exitCode = 1;
    throw error;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes('bootstrap-userbot-session')) {
  runCli().catch(() => {
    process.exit(1);
  });
}
