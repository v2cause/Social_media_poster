import { generateKeys } from './lib/keys';

// Prints fresh secrets as KEY=VALUE lines to stdout, ready to paste into .env.
// Nothing is written to disk and nothing is logged. Treat the output as secret.

const lines = Object.entries(generateKeys()).map(([name, value]) => `${name}=${value}`);

process.stdout.write(`${lines.join('\n')}\n`);
