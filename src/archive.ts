import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { daysBetween } from './time';

export interface Payload {
  key: string;
  body: string;
}

export interface Manifest {
  source: string;
  label: string;
  complete: boolean;
  finishedAt: string;
  entries: { file: string; key: string }[];
}

const MANIFEST = 'manifest.json';

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class ArchiveWriter {
  private readonly entries: Manifest['entries'] = [];

  constructor(private readonly dir: string, private readonly source: string, private readonly label: string) {}

  async write(p: Payload): Promise<void> {
    const file = `${String(this.entries.length + 1).padStart(5, '0')}.gz`;
    await writeFile(path.join(this.dir, file), gzipSync(p.body));
    this.entries.push({ file, key: p.key });
  }

  async close(complete: boolean): Promise<void> {
    const manifest: Manifest = {
      source: this.source, label: this.label, complete,
      finishedAt: new Date().toISOString(), entries: this.entries,
    };
    await writeFile(path.join(this.dir, MANIFEST), JSON.stringify(manifest, null, 2));
  }
}

export class RawArchive {
  constructor(private readonly root: string) {}

  private dir(source: string, label: string): string {
    return path.join(this.root, source, label);
  }

  async begin(source: string, label: string): Promise<ArchiveWriter> {
    const dir = this.dir(source, label);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    return new ArchiveWriter(dir, source, label);
  }

  async readManifest(source: string, label: string): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(source, label), MANIFEST), 'utf8')) as Manifest;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *read(source: string, label: string): AsyncGenerator<Payload> {
    const manifest = await this.readManifest(source, label);
    if (!manifest) throw new Error(`No archive for ${source}/${label}`);
    for (const entry of manifest.entries) {
      const body = gunzipSync(await readFile(path.join(this.dir(source, label), entry.file))).toString('utf8');
      yield { key: entry.key, body };
    }
  }

  async labels(source: string): Promise<string[]> {
    try {
      return (await readdir(path.join(this.root, source))).sort();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async remove(source: string, label: string): Promise<void> {
    await rm(this.dir(source, label), { recursive: true, force: true });
  }

  /** Deletes archives whose date (first 10 chars of the label) is more than keepDays before today. */
  async prune(source: string, keepDays: number, today: string): Promise<string[]> {
    const removed: string[] = [];
    for (const label of await this.labels(source)) {
      if (daysBetween(label.slice(0, 10), today) > keepDays) {
        await this.remove(source, label);
        removed.push(label);
      }
    }
    return removed;
  }
}
