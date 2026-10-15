import { randomBytes, randomUUID } from 'node:crypto';

// Prints fresh secrets as KEY=VALUE lines to stdout, ready to paste into .env.
// Nothing is written to disk and nothing is logged. Treat the output as secret.

const KEY_BYTES = 32;

function newKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

function newKeyring(): { entry: string; activeId: string } {
  const id = `kek-${randomUUID().slice(0, 8)}`;
  return { entry: `${id}:${newKey()}`, activeId: id };
}

const token = newKeyring();
const session = newKeyring();

const lines = [
  `BETTER_AUTH_SECRET=${newKey()}`,
  `TOKEN_KEKS=${token.entry}`,
  `TOKEN_KEK_ACTIVE=${token.activeId}`,
  `SESSION_KEKS=${session.entry}`,
  `SESSION_KEK_ACTIVE=${session.activeId}`,
];

process.stdout.write(`${lines.join('\n')}\n`);
