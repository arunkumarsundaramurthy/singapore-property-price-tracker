import type { Fetcher } from '../fetch/types';

const URA_BASE = 'https://eservice.ura.gov.sg/uraDataService';

interface UraEnvelope {
  Status?: string;
  Message?: string;
  Result?: unknown;
}

function parseEnvelope(body: string): UraEnvelope {
  try {
    return JSON.parse(body) as UraEnvelope;
  } catch {
    throw new Error(`URA returned non-JSON: ${body.slice(0, 200)}`);
  }
}

export class UraClient {
  private token?: string;

  constructor(private readonly fetcher: Fetcher, private readonly accessKey: string | undefined) {}

  private async newToken(): Promise<string> {
    if (!this.accessKey) throw new Error('URA_ACCESS_KEY is not set; register at https://eservice.ura.gov.sg/maps/api/reg.html');
    const res = parseEnvelope(await this.fetcher.text(`${URA_BASE}/insertNewToken/v1`, {
      headers: { AccessKey: this.accessKey },
    }));
    if (res.Status !== 'Success' || typeof res.Result !== 'string' || !res.Result) {
      throw new Error(`URA token request failed: ${res.Message ?? res.Status}`);
    }
    return res.Result;
  }

  /** Returns the raw JSON body of a successful call. */
  async invoke(params: Record<string, string>): Promise<string> {
    const url = `${URA_BASE}/invokeUraDS/v1?${new URLSearchParams(params)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.token ??= await this.newToken();
      const body = await this.fetcher.text(url, { headers: { AccessKey: this.accessKey!, Token: this.token } });
      const env = parseEnvelope(body);
      if (env.Status === 'Success') return body;
      if (attempt === 0 && /token/i.test(env.Message ?? '')) {
        this.token = undefined;
        continue;
      }
      throw new Error(`URA ${params.service} failed: ${env.Message ?? env.Status}`);
    }
    throw new Error(`URA ${params.service} failed after token refresh`);
  }
}
