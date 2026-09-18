import { HttpError, type Fetcher, type RequestOptions } from './types';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface HttpFetcherOptions {
  attempts?: number;
  baseDelayMs?: number;
  rateLimitDelayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export class HttpFetcher implements Fetcher {
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly rateLimitDelayMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpFetcherOptions = {}) {
    this.attempts = opts.attempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.rateLimitDelayMs = opts.rateLimitDelayMs ?? 12_000;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.userAgent = opts.userAgent ?? 'sg-property-collector/0.1 (+personal research)';
    this.sleep = opts.sleep ?? sleep;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const isLast = attempt === this.attempts - 1;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, ...opts.headers },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err;
        if (!isLast) await this.sleep(this.baseDelayMs * 2 ** attempt);
        continue;
      }
      const body = await res.text();
      if (res.ok) return body;
      const err = new HttpError(res.status, url, body);
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
      if (!isLast) await this.sleep(res.status === 429 ? this.rateLimitDelayMs : this.baseDelayMs * 2 ** attempt);
    }
    throw lastError;
  }

  async json<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
    return JSON.parse(await this.text(url, opts)) as T;
  }
}
