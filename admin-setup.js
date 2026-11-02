// npm run admin — creates or replaces the admin email and password. Run it on the server.
import { createInterface } from 'node:readline';
import { setAdmin } from './lib/auth.js';

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
const lines = rl[Symbol.asyncIterator]();
let muted = false; // while true, typed characters aren't echoed (password entry on a real terminal)
const echo = rl._writeToOutput.bind(rl); rl._writeToOutput = s => muted || echo(s);
const ask = async (q, hide) => { process.stdout.write(q); muted = hide; const { value = '' } = await lines.next(); if (hide) muted = false, process.stdout.write('\n'); return value; };

try {
  const email = (await ask('Admin email: ')).trim(), pw = await ask('Password (12+ characters): ', true);
  if (pw !== await ask('Same password again: ', true)) throw new Error("The passwords don't match. Nothing was saved.");
  await setAdmin(process.env.DATA_DIR ?? './data', email, pw);
  console.log(`Admin account saved for ${email}. Sign in at /admin.`);
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { rl.close(); }
