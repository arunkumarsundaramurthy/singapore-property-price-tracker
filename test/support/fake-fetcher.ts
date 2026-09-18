import type { Fetcher, RequestOptions } from '../../src/fetch/types';

type Route = [string | RegExp, string | ((url: string) => string)];

export class FakeFetcher implements Fetcher {
  readonly calls: { url: string; headers: Record<string, string> }[] = [];

  constructor(private readonly routes: Route[]) {}

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    this.calls.push({ url, headers: opts.headers ?? {} });
    const route = this.routes.find(([m]) => (typeof m === 'string' ? m === url : m.test(url)));
    if (!route) throw new Error(`FakeFetcher: no route for ${url}`);
    return typeof route[1] === 'function' ? route[1](url) : route[1];
  }

  async json<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
    return JSON.parse(await this.text(url, opts)) as T;
  }
}
