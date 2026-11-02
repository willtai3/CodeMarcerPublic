// Passwords: scrypt hashes for engineers (stored on their record) and the single admin (DATA_DIR/admin.json).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';

const kdf = promisify(scrypt), DUMMY = { salt: '00', hash: '00'.repeat(64) };
const derive = (pw, salt) => kdf(pw.normalize('NFKC'), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });

export const hash = async pw => { const salt = randomBytes(16).toString('hex'); return { salt, hash: (await derive(pw, salt)).toString('hex') }; };
// Always derives a hash (a dummy one when there's no account) so response time doesn't reveal which accounts exist.
export const verify = async (auth, pw) => {
  if (typeof pw !== 'string' || pw.length > 1024) return false;
  const h = await derive(pw, (auth ?? DUMMY).salt);
  return !!auth && timingSafeEqual(h, Buffer.from(auth.hash, 'hex'));
};

const adminFile = dir => join(dir, 'admin.json');
export const setAdmin = async (dir, email, pw) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('That email is not valid.');
  if (pw.length < 12) throw new Error('Use a password of at least 12 characters.');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(adminFile(dir), JSON.stringify({ email: email.trim().toLowerCase(), ...await hash(pw) }), { mode: 0o600 });
};
// 'setup' when no admin account exists yet, otherwise true/false.
export const adminLogin = dir => async (email, pw) => {
  const a = await readFile(adminFile(dir), 'utf8').then(JSON.parse, () => null);
  if (!a) return 'setup';
  return await verify(a, pw) && typeof email === 'string' && email.trim().toLowerCase() === a.email;
};
