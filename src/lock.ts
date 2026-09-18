import { open, rm, stat } from 'node:fs/promises';

export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockHeldError';
  }
}

const SIX_HOURS = 6 * 3600_000;

export async function acquireLock(
  path: string, staleMs = SIX_HOURS, now: () => number = Date.now,
): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const info = await stat(path);
      if (now() - info.mtimeMs > staleMs) {
        await rm(path, { force: true });
        continue;
      }
      throw new LockHeldError(`Another run holds ${path} (since ${info.mtime.toISOString()})`);
    }
  }
  throw new LockHeldError(`Could not acquire ${path}`);
}
