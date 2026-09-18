import { describe, expect, it } from 'vitest';
import { downloadDatasetCsv } from '../../../src/official/datagovsg';
import { FakeFetcher } from '../../support/fake-fetcher';

const ID = 'd_test';
const BASE = `https://api-open.data.gov.sg/v1/public/api/datasets/${ID}`;
const noWait = { sleep: async () => {}, pollIntervalMs: 0 };

describe('downloadDatasetCsv', () => {
  it('initiates, polls until ready and downloads the CSV', async () => {
    let polls = 0;
    const fetcher = new FakeFetcher([
      [`${BASE}/initiate-download`, JSON.stringify({ code: 0, data: { message: 'initiated' } })],
      [`${BASE}/poll-download`, () => JSON.stringify(++polls < 2
        ? { code: 0, data: { status: 'IN_PROGRESS' } }
        : { code: 0, data: { status: 'DOWNLOAD_SUCCESS', url: 'https://s3.test/file.csv' } })],
      ['https://s3.test/file.csv', 'month,town\n2026-08,BEDOK\n'],
    ]);
    expect(await downloadDatasetCsv(fetcher, ID, { ...noWait, apiKey: 'k' })).toBe('month,town\n2026-08,BEDOK\n');
    expect(polls).toBe(2);
    expect(fetcher.calls[0].headers).toEqual({ 'x-api-key': 'k' });
    expect(fetcher.calls.at(-1)?.headers).toEqual({});
  });

  it('waits and retries on the rate-limit code 24', async () => {
    const waits: number[] = [];
    let initiates = 0;
    const fetcher = new FakeFetcher([
      [`${BASE}/initiate-download`, () => JSON.stringify(++initiates === 1
        ? { code: 24, errorMsg: 'Rate limit exceeded' } : { code: 0, data: {} })],
      [`${BASE}/poll-download`, JSON.stringify({ code: 0, data: { status: 'DOWNLOAD_SUCCESS', url: 'https://s3.test/f' } })],
      ['https://s3.test/f', 'csv'],
    ]);
    await downloadDatasetCsv(fetcher, ID, { sleep: async (ms) => { waits.push(ms); }, pollIntervalMs: 0, rateLimitDelayMs: 12_000 });
    expect(initiates).toBe(2);
    expect(waits).toContain(12_000);
  });

  it('fails on other API error codes', async () => {
    const fetcher = new FakeFetcher([[`${BASE}/initiate-download`, JSON.stringify({ code: 4, errorMsg: 'Not found' })]]);
    await expect(downloadDatasetCsv(fetcher, ID, noWait)).rejects.toThrow(/Not found/);
  });

  it('gives up when the download never becomes ready', async () => {
    const fetcher = new FakeFetcher([
      [`${BASE}/initiate-download`, JSON.stringify({ code: 0, data: {} })],
      [`${BASE}/poll-download`, JSON.stringify({ code: 0, data: { status: 'IN_PROGRESS' } })],
    ]);
    await expect(downloadDatasetCsv(fetcher, ID, { ...noWait, maxPolls: 3 })).rejects.toThrow(/not ready after 3 polls/);
  });
});
