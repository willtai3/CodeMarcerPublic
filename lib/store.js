// JSON record store. Plain JSON on disk (owner-only file permissions); encryption at rest comes from the host's disk encryption.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function openStore(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'store.json'), recs = new Map(), kinds = new Map(); // kinds: kind → Map(id → record), so all(kind) never scans other kinds
  const index = r => { recs.set(r.id, r); (kinds.get(r.kind) ?? kinds.set(r.kind, new Map()).get(r.kind)).set(r.id, r); };
  const drop = r => { recs.delete(r.id); kinds.get(r.kind)?.delete(r.id); };
  let version = 0, queue = Promise.resolve();
  try { for (const r of JSON.parse(await readFile(file, 'utf8'))) index(r); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }

  const write = async () => { await writeFile(file + '.tmp', JSON.stringify([...recs.values()]), { mode: 0o600 }); await rename(file + '.tmp', file); };

  // Writes are serialised and atomic; a failed write puts the record back as it was and rejects (fail closed).
  const put = r => {
    const prev = recs.get(r.id);
    index(r); version++;
    const p = queue.then(write).then(() => r, e => { prev ? index(prev) : drop(r); version++; throw e; });
    queue = p.catch(() => {});
    return p;
  };

  return {
    all: kind => [...(kinds.get(kind)?.values() ?? [])],
    get: id => recs.get(id),
    add: (kind, data) => put({ id: randomUUID(), kind, created: new Date().toISOString(), ...data }),
    update: (id, patch) => put({ ...recs.get(id), ...patch }),
    get version() { return version; },
  };
}
