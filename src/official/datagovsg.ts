import { sleep as realSleep } from '../fetch/http';
import type { Fetcher } from '../fetch/types';

/** Verified against data.gov.sg on 2026-09-18. */
export const DATAGOVSG_DATASETS = {
  hdbResaleCurrent: 'd_8b84c4ee58e3cfc0ece0d773c8ca6abc', // Jan 2017 onwards (registration date)
  hdbResaleHistorical: [
    'd_ebc5ab87086db484f88045b47411ebc5', // 1990–1999 (approval date)
    'd_43f493c6c50d54243cc1eab0df142d6a', // 2000–Feb 2012 (approval date)
    'd_2d5ff9ea31397b66239f245f57751537', // Mar 2012–Dec 2014 (registration date)
    'd_ea9ed51da2787afaf8e51f827c304208', // Jan 2015–Dec 2016 (registration date)
  ],
  hdbRental: 'd_c9f57187485a850908655db0e8cfe651', // Renting out of flats, Jan 2021 onwards
} as const;

const BASE = 'https://api-open.data.gov.sg/v1/public/api/datasets';
const RATE_LIMITED = 24;

interface ApiResponse {
  code: number;
  errorMsg?: string;
  data: { status?: string; url?: string; message?: string } | null;
}

export interface DataGovSgOptions {
  apiKey?: string;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  rateLimitDelayMs?: number;
}

export async function downloadDatasetCsv(
  fetcher: Fetcher, datasetId: string, opts: DataGovSgOptions = {},
): Promise<string> {
  const sleep = opts.sleep ?? realSleep;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const maxPolls = opts.maxPolls ?? 20;
  const rateLimitDelayMs = opts.rateLimitDelayMs ?? 12_000;
  const headers: Record<string, string> = opts.apiKey ? { 'x-api-key': opts.apiKey } : {};

  const call = async (action: 'initiate-download' | 'poll-download') => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetcher.json<ApiResponse>(`${BASE}/${datasetId}/${action}`, { headers });
      if (res.code === 0) return res.data ?? {};
      if (res.code === RATE_LIMITED) {
        await sleep(rateLimitDelayMs);
        continue;
      }
      throw new Error(`data.gov.sg ${action} failed for ${datasetId}: ${res.errorMsg ?? `code ${res.code}`}`);
    }
    throw new Error(`data.gov.sg ${action} for ${datasetId}: still rate limited after 5 attempts`);
  };

  await call('initiate-download');
  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollIntervalMs);
    const data = await call('poll-download');
    if (data.status === 'DOWNLOAD_SUCCESS' && data.url) return fetcher.text(data.url);
  }
  throw new Error(`data.gov.sg download for ${datasetId} not ready after ${maxPolls} polls`);
}
