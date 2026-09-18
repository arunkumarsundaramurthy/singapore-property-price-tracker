import { z } from 'zod';

const blank = (v: unknown) => (v === '' ? undefined : v);
const optionalString = z.preprocess(blank, z.string().optional());

const EnvSchema = z.object({
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  URA_ACCESS_KEY: optionalString,
  DATA_GOV_SG_API_KEY: optionalString,
  HEALTHCHECK_URL: z.preprocess(blank, z.url().optional()),
  RAW_ARCHIVE_DIR: z.preprocess(blank, z.string().default('./raw')),
  LOCK_FILE: z.preprocess(blank, z.string().default('./collector.lock')),
  LOG_LEVEL: z.preprocess(blank, z.string().default('info')),
});

export interface Config {
  databaseUrl: string;
  uraAccessKey?: string;
  dataGovSgApiKey?: string;
  healthcheckUrl?: string;
  rawArchiveDir: string;
  lockFile: string;
  logLevel: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    uraAccessKey: e.URA_ACCESS_KEY,
    dataGovSgApiKey: e.DATA_GOV_SG_API_KEY,
    healthcheckUrl: e.HEALTHCHECK_URL,
    rawArchiveDir: e.RAW_ARCHIVE_DIR,
    lockFile: e.LOCK_FILE,
    logLevel: e.LOG_LEVEL,
  };
}
