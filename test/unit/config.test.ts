import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', URA_ACCESS_KEY: '', HEALTHCHECK_URL: '' });
    expect(c).toEqual({
      databaseUrl: 'postgres://x',
      uraAccessKey: undefined,
      dataGovSgApiKey: undefined,
      healthcheckUrl: undefined,
      rawArchiveDir: './raw',
      lockFile: './collector.lock',
      logLevel: 'info',
    });
  });
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('rejects a malformed HEALTHCHECK_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', HEALTHCHECK_URL: 'nope' })).toThrow();
  });
});
