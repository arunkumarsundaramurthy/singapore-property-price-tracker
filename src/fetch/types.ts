export interface RequestOptions {
  headers?: Record<string, string>;
}

export interface Fetcher {
  text(url: string, opts?: RequestOptions): Promise<string>;
  json<T = unknown>(url: string, opts?: RequestOptions): Promise<T>;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}
