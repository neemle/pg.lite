#!/usr/bin/env node
'use strict';
// The list of releases an unattended run (scripts/overnight.sh) works through, one per line (tools container):
//
//   overnight-order.js [--versions all|newest|<list>] [--order spread|ascending] [--shard K/N]
//
//   --versions   all (default), newest (the newest release of every major), or a comma list of releases (12.22) and majors (12, 9.6)
//   --order      spread (default): the newest and the oldest release of every family first, then the middle ones by repeated bisection,
//                families taking turns, so the first hours already cover very different releases; ascending: 9.0.0, 9.0.1, ...
//   --shard K/N  keep every Nth release starting at the Kth (1-based), to split one list over N machines or runners
const lock = require('/w/sources.lock.json').releases;
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const spec = arg('versions', 'all');
const order = arg('order', 'spread');
const shard = arg('shard', '1/1');

const key = (v) => v.split('.').map(Number);
const cmp = (a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const all = lock.map((r) => ({ v: r.version, major: r.major })).sort((a, b) => cmp(a.v, b.v));
const familyOf = (v) => v.split('.')[0];

let chosen;
if (spec === 'all') chosen = all;
else if (spec === 'newest') {
  const last = new Map();
  for (const r of all) last.set(r.major, r);
  chosen = [...last.values()];
} else {
  const set = new Set();
  for (const item of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    const exact = all.filter((r) => r.v === item);
    const major = all.filter((r) => r.major === item);
    if (!exact.length && !major.length) { console.error(`overnight-order: ${item} is neither a release nor a major (list: builder.sh list)`); process.exit(2); }
    for (const r of exact.length ? exact : major) set.add(r.v);
  }
  chosen = all.filter((r) => set.has(r.v));
}

let ordered;
if (order === 'ascending') ordered = chosen.map((r) => r.v);
else if (order === 'spread') {
  // per family: newest, oldest, then the middle by bisection; families take turns, newest family first
  const bisect = (list) => {
    const n = list.length;
    if (n === 0) return [];
    const out = [n - 1];
    if (n > 1) out.push(0);
    const queue = [[0, n - 1]];
    while (queue.length) {
      const [lo, hi] = queue.shift();
      if (hi - lo < 2) continue;
      const mid = Math.floor((lo + hi) / 2);
      out.push(mid);
      queue.push([lo, mid], [mid, hi]);
    }
    return out.map((i) => list[i].v);
  };
  const fams = [...new Set(chosen.map((r) => familyOf(r.v)))].sort((a, b) => Number(b) - Number(a));
  const seqs = fams.map((f) => bisect(chosen.filter((r) => familyOf(r.v) === f)));
  ordered = [];
  for (let i = 0; seqs.some((s) => i < s.length); i++) for (const s of seqs) if (i < s.length) ordered.push(s[i]);
} else { console.error(`overnight-order: unknown order ${order}`); process.exit(2); }

const m = /^(\d+)\/(\d+)$/.exec(shard);
if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) { console.error(`overnight-order: --shard needs K/N with 1 <= K <= N, got ${shard}`); process.exit(2); }
const [k, n] = [Number(m[1]), Number(m[2])];
console.log(ordered.filter((_, i) => i % n === k - 1).join('\n'));
