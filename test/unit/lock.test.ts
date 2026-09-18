import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, LockHeldError } from '../../src/lock';

describe('acquireLock', () => {
  it('is exclusive until released', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'lock-')), 'c.lock');
    const release = await acquireLock(file);
    await expect(acquireLock(file)).rejects.toBeInstanceOf(LockHeldError);
    await release();
    const again = await acquireLock(file);
    await again();
  });

  it('takes over a stale lock', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'lock-')), 'c.lock');
    await writeFile(file, '999999');
    const old = new Date(Date.now() - 7 * 3600_000);
    await utimes(file, old, old);
    const release = await acquireLock(file, 6 * 3600_000);
    await release();
  });
});
