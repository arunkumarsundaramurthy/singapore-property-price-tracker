import { describe, expect, it } from 'vitest';
import { UraClient } from '../../../src/official/ura-client';
import { FakeFetcher } from '../../support/fake-fetcher';

const TOKEN_URL = 'https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1';
const ok = JSON.stringify({ Status: 'Success', Result: [] });

describe('UraClient', () => {
  it('gets a token once and sends AccessKey + Token headers', async () => {
    const fetcher = new FakeFetcher([
      [TOKEN_URL, JSON.stringify({ Status: 'Success', Result: 'tok-1', Message: '' })],
      [/invokeUraDS/, ok],
    ]);
    const client = new UraClient(fetcher, 'key-1');
    await client.invoke({ service: 'PMI_Resi_Transaction', batch: '1' });
    await client.invoke({ service: 'PMI_Resi_Transaction', batch: '2' });
    expect(fetcher.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
    const data = fetcher.calls.find((c) => c.url.includes('batch=2'))!;
    expect(data.url).toBe('https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1?service=PMI_Resi_Transaction&batch=2');
    expect(data.headers).toEqual({ AccessKey: 'key-1', Token: 'tok-1' });
  });

  it('refreshes the token once on a token error', async () => {
    let tokens = 0;
    let calls = 0;
    const fetcher = new FakeFetcher([
      [TOKEN_URL, () => JSON.stringify({ Status: 'Success', Result: `tok-${++tokens}` })],
      [/invokeUraDS/, () => (++calls === 1 ? JSON.stringify({ Status: 'Error', Message: 'Invalid Token' }) : ok)],
    ]);
    expect(await new UraClient(fetcher, 'k').invoke({ service: 'X' })).toBe(ok);
    expect(tokens).toBe(2);
  });

  it('fails clearly without an access key, on a bad key, and on non-JSON', async () => {
    await expect(new UraClient(new FakeFetcher([]), undefined).invoke({ service: 'X' })).rejects.toThrow(/URA_ACCESS_KEY/);
    const badKey = new FakeFetcher([[TOKEN_URL, JSON.stringify({ Status: 'Error', Message: 'Invalid Access Key', Result: '' })]]);
    await expect(new UraClient(badKey, 'k').invoke({ service: 'X' })).rejects.toThrow(/Invalid Access Key/);
    const html = new FakeFetcher([[TOKEN_URL, JSON.stringify({ Status: 'Success', Result: 't' })], [/invokeUraDS/, '<html>blocked</html>']]);
    await expect(new UraClient(html, 'k').invoke({ service: 'X' })).rejects.toThrow(/non-JSON/);
  });
});
