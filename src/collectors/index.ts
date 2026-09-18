import type { Config } from '../config';
import type { Fetcher } from '../fetch/types';
import { createHdbRentalCollector } from '../official/hdb-rental';
import { createHdbResaleCollector } from '../official/hdb-resale';
import { createUraPrivateRentalCollector } from '../official/ura-private-rental';
import { createUraPrivateTxnCollector } from '../official/ura-private-txn';
import type { Collector } from './types';

export function buildCollectors(deps: { fetcher: Fetcher; config: Config }): Collector[] {
  const { fetcher, config } = deps;
  const dataGovSg = { apiKey: config.dataGovSgApiKey };
  return [
    createHdbResaleCollector({ fetcher, dataGovSg }),
    createHdbRentalCollector({ fetcher, dataGovSg }),
    createUraPrivateTxnCollector({ fetcher, uraAccessKey: config.uraAccessKey }),
    createUraPrivateRentalCollector({ fetcher, uraAccessKey: config.uraAccessKey }),
  ];
}

export function selectCollectors(all: Collector[], names: string[], useAll: boolean): Collector[] {
  if (useAll) return all;
  if (names.length === 0) throw new Error('Name one or more sources, or pass --all');
  return names.map((name) => {
    const found = all.find((c) => c.name === name);
    if (!found) throw new Error(`Unknown source "${name}". Valid sources: ${all.map((c) => c.name).join(', ')}`);
    return found;
  });
}
