import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../src/fetch/types';
import { HttpFetcher } from '../../../src/fetch/http';

function setup(responses: Array<Response | Error>) {
  const delays: number[] = [];
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const fetcher = new HttpFetcher({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async (ms) => { delays.push(ms); },
    baseDelayMs: 100,
    rateLimitDelayMs: 5000,
  });
  return { fetcher, fetchImpl, delays };
}

describe('HttpFetcher', () => {
  it('returns the body and sends a user agent plus custom headers', async () => {
    const { fetcher, fetchImpl } = setup([new Response('hello')]);
    expect(await fetcher.text('https://x.test/a', { headers: { AccessKey: 'k' } })).toBe('hello');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ AccessKey: 'k' });
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/sg-property-collector/);
  });

  it('parses JSON', async () => {
    const { fetcher } = setup([new Response('{"a":1}')]);
    expect(await fetcher.json('https://x.test')).toEqual({ a: 1 });
  });

  it('retries 5xx and network errors with exponential backoff', async () => {
    const { fetcher, delays } = setup([new Response('boom', { status: 502 }), new Error('ECONNRESET'), new Response('ok')]);
    expect(await fetcher.text('https://x.test')).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  it('waits the rate-limit delay on 429', async () => {
    const { fetcher, delays } = setup([new Response('slow down', { status: 429 }), new Response('ok')]);
    expect(await fetcher.text('https://x.test')).toBe('ok');
    expect(delays).toEqual([5000]);
  });

  it('gives up after 3 attempts with the last error', async () => {
    const { fetcher, fetchImpl } = setup([
      new Response('a', { status: 500 }), new Response('b', { status: 500 }), new Response('c', { status: 503 }),
    ]);
    await expect(fetcher.text('https://x.test')).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry other 4xx', async () => {
    const { fetcher, fetchImpl } = setup([new Response('nope', { status: 403 })]);
    const err = await fetcher.text('https://x.test').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
