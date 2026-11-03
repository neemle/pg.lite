import { describe, expect, it } from 'vitest';
import { BASE_CONFIG, configText, releaseNumber, settingsFor } from './settings.js';

describe('release numbers', () => {
  it('count the two-part majors of releases before 10', () => {
    expect(releaseNumber('9.0.0')).toBe(900);
    expect(releaseNumber('9.6.24')).toBe(906);
    expect(releaseNumber('10.23')).toBe(1000);
    expect(releaseNumber('18.6')).toBe(1800);
  });
});

describe('settings for a release', () => {
  it('keep the base settings on a current release', () => {
    expect(settingsFor('18.6')).toEqual(BASE_CONFIG);
  });

  it('use checkpoint_segments and fdatasync before 9.1, and have no dynamic shared memory before 9.4', () => {
    const s = settingsFor('9.0.0');
    expect(s['max_wal_size']).toBeUndefined();
    expect(s['min_wal_size']).toBeUndefined();
    expect(s['checkpoint_segments']).toBe(3);
    expect(s['dynamic_shared_memory_type']).toBeUndefined();
    expect(s['wal_sync_method']).toBe('fdatasync');
  });

  it('keep the default sync method from 9.1', () => {
    expect(settingsFor('9.1.0')['wal_sync_method']).toBeUndefined();
  });

  it('count WAL size in 16 MB segments in 9.5 and 9.6', () => {
    expect(settingsFor('9.5.0')['max_wal_size']).toBe('32MB');
    expect(settingsFor('9.6.24')['min_wal_size']).toBe('32MB');
    expect(settingsFor('9.4.0')['dynamic_shared_memory_type']).toBe('sysv');
  });

  it('let the caller override a setting', () => {
    expect(settingsFor('9.6.24', { max_wal_size: '64MB' })['max_wal_size']).toBe('64MB');
    expect(settingsFor('9.0.0', { wal_sync_method: 'fsync' })['wal_sync_method']).toBe('fsync');
  });
});

describe('configuration text', () => {
  it('quotes every value and doubles quotes inside', () => {
    expect(configText({ a: 1, b: "it's" })).toBe("a = '1'\nb = 'it''s'\n");
  });
});
