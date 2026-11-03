// The server settings of the engine, spelled the way the PostgreSQL release takes them.

export type Settings = Record<string, string | number>;

// Settings of the single-user engine in a browser. Memory is the budget that matters, and there is no
// checkpointer process: a checkpoint is taken when WAL reaches max_wal_size, so keep that small (1 MB segments).
export const BASE_CONFIG: Settings = {
  shared_buffers: '16MB',
  work_mem: '4MB',
  max_wal_size: '16MB',
  min_wal_size: '4MB',
  wal_level: 'minimal',
  max_wal_senders: 0,
  max_connections: 4,
  // The engine runs on the stack JavaScript Promise Integration gives it, which is much smaller than PostgreSQL's 2 MB
  // default allows for. The stack depth check (patch 0290) counts the shadow stack in linear memory; stay clearly below
  // what the host's call stack carries.
  max_stack_depth: '400kB',
  timezone: 'UTC',
  log_timezone: 'UTC',
  client_min_messages: 'notice',
  log_min_messages: 'warning',
  dynamic_shared_memory_type: 'sysv',
};

// 9.6.24 -> 906, 18.6 -> 1800: releases before 10 have a two-part major version
export function releaseNumber(pg: string): number {
  const [a = 0, b = 0] = pg.split('.').map(Number);
  return a >= 10 ? a * 100 : a * 100 + b;
}

// The settings BASE_CONFIG means, spelled the way the release takes them:
//   before 9.5   no max_wal_size/min_wal_size (checkpoint_segments, 16 MB each, is the same limit)
//   9.5 and 9.6  the two are counted in 16 MB segments and may not be below 2, so '16MB' and '4MB' are refused
//   before 9.4   no dynamic_shared_memory_type
//   before 9.1   wal_sync_method defaults to open_datasync on Linux: WAL is written with O_DSYNC and fsync/fdatasync never run, so the
//                storage barrier (which is the wrapped fsync) would never be reached at a commit; fdatasync is what 9.1 and later use
export function settingsFor(pg: string, config?: Settings): Settings {
  const n = releaseNumber(pg);
  const settings: Settings = { ...BASE_CONFIG, ...config };
  if (n < 905) {
    delete settings['max_wal_size']; delete settings['min_wal_size'];
    if (!config || !('checkpoint_segments' in config)) settings['checkpoint_segments'] = 3;
  } else if (n < 1000) {
    if (!config || !('max_wal_size' in config)) settings['max_wal_size'] = '32MB';
    if (!config || !('min_wal_size' in config)) settings['min_wal_size'] = '32MB';
  }
  if (n < 904) delete settings['dynamic_shared_memory_type'];
  if (n < 901 && !(config && 'wal_sync_method' in config)) settings['wal_sync_method'] = 'fdatasync';
  return settings;
}

export function configText(settings: Settings): string {
  return `${Object.entries(settings)
    .map(([k, v]) => `${k} = '${String(v).replace(/'/g, "''")}'`).join('\n')}\n`;
}
