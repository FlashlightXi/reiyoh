import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadState(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { users: {} };
    throw error;
  }
}

export function createStateWriter(filePath) {
  let pending = Promise.resolve();
  return {
    save(state) {
      const data = JSON.stringify(state, null, 2);
      pending = pending.catch(() => {}).then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp`;
        await writeFile(temporary, data, 'utf8');
        await rename(temporary, filePath);
      });
      return pending;
    },
    flush() { return pending; },
  };
}
