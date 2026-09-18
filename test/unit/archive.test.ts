import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RawArchive, type Payload } from '../../src/archive';

let root: string;
let archive: RawArchive;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'archive-'));
  archive = new RawArchive(root);
});

async function collect(it: AsyncIterable<Payload>) {
  const out: Payload[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe('RawArchive', () => {
  it('round-trips payloads in order with a manifest', async () => {
    const w = await archive.begin('hdb-resale', '2026-09-18');
    await w.write({ key: 'a.csv', body: 'month,town\n2026-08,BEDOK' });
    await w.write({ key: 'b.csv', body: 'x'.repeat(10_000) });
    await w.close(true);

    expect(await collect(archive.read('hdb-resale', '2026-09-18'))).toEqual([
      { key: 'a.csv', body: 'month,town\n2026-08,BEDOK' },
      { key: 'b.csv', body: 'x'.repeat(10_000) },
    ]);
    const m = await archive.readManifest('hdb-resale', '2026-09-18');
    expect(m?.complete).toBe(true);
    expect(m?.entries.map((e) => e.file)).toEqual(['00001.gz', '00002.gz']);
  });

  it('begin() replaces an earlier archive for the same label', async () => {
    const w1 = await archive.begin('s', '2026-09-18');
    await w1.write({ key: 'old', body: 'old' });
    await w1.close(true);
    const w2 = await archive.begin('s', '2026-09-18');
    await w2.write({ key: 'new', body: 'new' });
    await w2.close(false);
    expect(await collect(archive.read('s', '2026-09-18'))).toEqual([{ key: 'new', body: 'new' }]);
    expect((await archive.readManifest('s', '2026-09-18'))?.complete).toBe(false);
  });

  it('has no manifest when the writer never closed', async () => {
    const w = await archive.begin('s', '2026-09-18');
    await w.write({ key: 'k', body: 'b' });
    expect(await archive.readManifest('s', '2026-09-18')).toBeNull();
    await expect(collect(archive.read('s', '2026-09-18'))).rejects.toThrow(/No archive/);
  });

  it('lists labels sorted, removes and prunes by age', async () => {
    for (const label of ['2026-09-18', '2026-07-01', '2026-07-20-backfill', '2026-07-19']) {
      const w = await archive.begin('99co', label);
      await w.close(true);
    }
    expect(await archive.labels('99co')).toEqual(['2026-07-01', '2026-07-19', '2026-07-20-backfill', '2026-09-18']);
    expect(await archive.labels('missing')).toEqual([]);

    const removed = await archive.prune('99co', 60, '2026-09-18');
    expect(removed).toEqual(['2026-07-01', '2026-07-19']);
    expect(await readdir(path.join(root, '99co'))).toEqual(['2026-07-20-backfill', '2026-09-18']);

    await archive.remove('99co', '2026-09-18');
    expect(await archive.labels('99co')).toEqual(['2026-07-20-backfill']);
  });
});
