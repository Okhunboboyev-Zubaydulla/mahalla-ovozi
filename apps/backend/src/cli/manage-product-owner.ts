import fs from 'node:fs';
import readline from 'node:readline';
import { createDbPool, createDbClient } from '../adapters/db/client.js';
import { createOrResetProductOwner } from '../modules/auth/account-service.js';

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

export async function runCli() {
  console.log('=== Mahalla Ovozi — Product Owner Account Management ===\n');

  // Prevent password passed via CLI flags
  for (const arg of process.argv) {
    if (arg.startsWith('--password') || arg.startsWith('-p')) {
      console.error(
        'Хавфсизлик қоидаси: Паролни буйруқлар қатори аргументи сифатида узатиш таъқиқланади.'
      );
      process.exit(1);
    }
  }

  let username = '';
  const usernameArgIdx = process.argv.indexOf('--username');
  if (usernameArgIdx !== -1 && process.argv[usernameArgIdx + 1]) {
    username = process.argv[usernameArgIdx + 1]!.trim();
  }

  if (!username) {
    username = await promptLine('Фойдаланувчи номини киритинг (username): ');
  }

  if (!username) {
    console.error('Хатолик: Фойдаланувчи номи бўш бўлиши мумкин эмас.');
    process.exit(1);
  }

  const password = await promptHiddenPassword('Янги паролни киритинг (15-128 белги): ');
  const confirmPassword = await promptHiddenPassword('Паролни тасдиқланг: ');

  if (password !== confirmPassword) {
    console.error('Хатолик: Киритган паролларингиз бир-бирига мос келмади.');
    process.exit(1);
  }

  const pool = createDbPool();
  const db = createDbClient(pool);

  try {
    const result = await createOrResetProductOwner(db, { username, password });
    if (result.isNew) {
      console.log(`\n✅ Product Owner аккаунти муваффақиятли яратилди.`);
      console.log(`   Фойдаланувчи: ${result.username} (ID: ${result.accountId})`);
    } else {
      console.log(`\n✅ Product Owner пароли муваффақиятли янгиланди.`);
      console.log(`   Фойдаланувчи: ${result.username} (Credential Version: ${result.credentialVersion})`);
      console.log(`   Эски очиқ сессиялар бекор қилинди.`);
    }
  } catch (error) {
    console.error(`\n❌ Хатолик: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes('manage-product-owner')) {
  runCli().catch((err) => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
}
