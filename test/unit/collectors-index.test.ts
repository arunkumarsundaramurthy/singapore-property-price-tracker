import { describe, expect, it } from 'vitest';
import { buildCollectors, selectCollectors } from '../../src/collectors';
import { loadConfig } from '../../src/config';
import { FakeFetcher } from '../support/fake-fetcher';

const all = buildCollectors({ fetcher: new FakeFetcher([]), config: loadConfig({ DATABASE_URL: 'postgres://x' }) });

describe('collector registry', () => {
  it('registers the four official collectors', () => {
    expect(all.map((c) => [c.name, c.kind])).toEqual([
      ['hdb-resale', 'official'], ['hdb-rental', 'official'],
      ['ura-private-txn', 'official'], ['ura-private-rental', 'official'],
    ]);
  });

  it('selects by name or --all and rejects unknown names', () => {
    expect(selectCollectors(all, [], true)).toHaveLength(4);
    expect(selectCollectors(all, ['hdb-rental'], false).map((c) => c.name)).toEqual(['hdb-rental']);
    expect(() => selectCollectors(all, ['nope'], false)).toThrow(/Unknown source "nope".*hdb-resale/);
    expect(() => selectCollectors(all, [], false)).toThrow(/--all/);
  });
});
