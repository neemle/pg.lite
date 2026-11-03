#!/usr/bin/env node
'use strict';
// Markdown report of an unattended run (scripts/overnight.sh): which releases build and pass their tests, as the image (cli) and as
// WebAssembly (wasm). It only reads tools/reports/overnight/results.tsv and the step logs; it builds nothing.
//
//   overnight-report.js [--out FILE] [--from 9.0.0] [--to 18.6]      (tools container, or any node: tools/dc node scripts/overnight-report.js)
//
//   --out    where to write the report (default tools/reports/overnight/report.md); the report is also printed
//   --from/--to  restrict the releases listed (default: every release in sources.lock.json, 9.0.0 to the newest)
const fs = require('fs');
const path = require('path');

const tools = path.join(__dirname, '..');
const dir = path.join(tools, 'reports', 'overnight');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const outFile = arg('out', path.join(dir, 'report.md'));

const key = (v) => v.split('.').map(Number);
const cmp = (a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
let releases = JSON.parse(fs.readFileSync(path.join(tools, 'sources.lock.json'), 'utf8')).releases.map((r) => ({ v: r.version, major: r.major }));
const from = arg('from', null);
const to = arg('to', null);
releases = releases.filter((r) => (!from || cmp(r.v, from) >= 0) && (!to || cmp(r.v, to) <= 0)).sort((a, b) => cmp(a.v, b.v));
if (!releases.length) { console.error('overnight-report: no release in that range'); process.exit(2); }

// results.tsv: time, release, target, step, status, seconds, log. A step that ran more than once counts as its last line.
const last = new Map();
const first = { t: null }; const lastT = { t: null };
const tsv = path.join(dir, 'results.tsv');
if (fs.existsSync(tsv)) {
  for (const line of fs.readFileSync(tsv, 'utf8').split('\n').slice(1)) {
    const [time, release, target, step, status, seconds, log] = line.split('\t');
    if (!release) continue;
    last.set(`${release}|${target}|${step}`, { time, status, seconds: Number(seconds), log });
    first.t = first.t || time; lastT.t = time;
  }
}
const get = (v, t, s) => last.get(`${v}|${t}|${s}`);

const dur = (s) => { if (s < 90) return `${s}s`; if (s < 5400) return `${Math.round(s / 60)}m`; return `${(s / 3600).toFixed(1)}h`; };
const cell = (x) => {
  if (!x) return '·';
  if (x.status === 'ok') return `✅ ${dur(x.seconds)}`;
  if (x.status === 'timeout') return `⏱ ${dur(x.seconds)}`;
  return `❌ ${dur(x.seconds)}`;
};
// a release/target is: ok (build and test ok), failed (either failed or timed out), or not run
const verdict = (v, t) => {
  const b = get(v, t, 'build'); const x = get(v, t, 'test');
  if (b && b.status !== 'ok') return 'failed';
  if (x && x.status !== 'ok') return 'failed';
  if (b && x) return 'ok';
  return 'todo';
};
const builds = (v, t) => { const b = get(v, t, 'build'); return b ? b.status === 'ok' : null; };

const targets = [['cli', 'Image (static, `FROM scratch`)'], ['wasm', 'WebAssembly (browser module)']];
const L = [];
const p = (s = '') => L.push(s);

// ---- header and verdict
const count = (t, f) => releases.filter((r) => f(r.v, t)).length;
p('# compact.db: does every release build from source?');
p();
p(`Releases ${releases[0].v} to ${releases[releases.length - 1].v}: **${releases.length}**. Report written ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC` +
  `${first.t ? `; results recorded ${first.t} to ${lastT.t}` : '; no results recorded yet'}.`);
p();
p('| Target | builds from source | build + tests pass | build failed | tests failed | not run yet |');
p('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [t, label] of targets) {
  const n = releases.length;
  const built = count(t, (v, tt) => builds(v, tt) === true);
  const ok = count(t, (v, tt) => verdict(v, tt) === 'ok');
  const bf = count(t, (v, tt) => builds(v, tt) === false);
  const tf = count(t, (v, tt) => builds(v, tt) === true && get(v, tt, 'test') && get(v, tt, 'test').status !== 'ok');
  const todo = count(t, (v, tt) => !get(v, tt, 'build'));
  p(`| ${label} | ${built} / ${n} | ${ok} / ${n} | ${bf} | ${tf} | ${todo} |`);
}
p();
const allOk = targets.every(([t]) => count(t, (v, tt) => verdict(v, tt) === 'ok') === releases.length);
const anyTodo = targets.some(([t]) => count(t, (v, tt) => verdict(v, tt) === 'todo') > 0);
const anyFail = targets.some(([t]) => count(t, (v, tt) => verdict(v, tt) === 'failed') > 0);
p(allOk ? `**Result: every release from ${releases[0].v} to ${releases[releases.length - 1].v} builds and passes its tests, as image and as WebAssembly.**`
  : anyFail ? `**Result: not every release builds or passes: see "Failures" below.**${anyTodo ? ' Some releases have not been run yet; start the run again to continue.' : ''}`
    : '**Result: no failure so far, but not every release has been run yet; start the run again to continue.**');
p();
p('Cells: ✅ ok, ❌ failed, ⏱ killed by the step time limit (each with the time it took), · not run. A test is only run after its build succeeded.');

// ---- per major
const majors = [...new Set(releases.map((r) => r.major))];
p();
p('## Releases');
for (const m of majors) {
  const list = releases.filter((r) => r.major === m);
  const stat = targets.map(([t]) => `${t} ${list.filter((r) => verdict(r.v, t) === 'ok').length}/${list.length}`).join(', ');
  p();
  p(`### ${m} (${list.length} releases; ok: ${stat})`);
  p();
  p('| Release | image build | image test | wasm build | wasm test |');
  p('| --- | --- | --- | --- | --- |');
  for (const r of list) p(`| ${r.v} | ${cell(get(r.v, 'cli', 'build'))} | ${cell(get(r.v, 'cli', 'test'))} | ${cell(get(r.v, 'wasm', 'build'))} | ${cell(get(r.v, 'wasm', 'test'))} |`);
}

// ---- failures: grouped by what failed, so that 40 releases failing the same way read as one entry
const readLog = (logPath) => {
  if (!logPath) return [];
  // results.tsv names the log from the repository root (tools/reports/overnight/logs/...); in the tools container the root is not mounted
  const i = logPath.indexOf('logs/');
  const f = path.join(dir, i < 0 ? logPath : logPath.slice(i));
  if (!fs.existsSync(f)) return [];
  const size = fs.statSync(f).size;
  const len = Math.min(size, 512 * 1024);
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  return buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
};
const clip = (l) => (l.length > 200 ? `${l.slice(0, 200)}...` : l);
// what a failed step says about itself: the tests that failed (Playwright's ✘ lines) and the first distinct errors, else the lines that look like errors
const diagnose = (logPath) => {
  const lines = readLog(logPath);
  const tests = [...new Set(lines.filter((l) => /^\s*✘/.test(l)).map((l) => l.replace(/^\s*✘\s+\d+\s+/, '').replace(/\s+\([\d.]+(ms|s|m)\)$/, '').replace(/^tests\/browser\//, '')))];
  const errors = [...new Set(lines.filter((l) => /^\s*Error: /.test(l)).map((l) => l.trim()))];
  const count = lines.filter((l) => /^\s+\d+ (passed|failed)\b/.test(l)).map((l) => l.trim());
  let text = [];
  if (tests.length) text = [...count, ...tests.slice(0, 8).map((t) => `✘ ${t}`), ...(tests.length > 8 ? [`... and ${tests.length - 8} more`] : []), ...errors.slice(0, 3).map(clip)];
  else {
    const bad = lines.filter((l) => !/^\s*✓/.test(l) && /\berror\b|\bfatal\b|not ok|FAIL|No such file|undefined reference|Hunk #|\.rej\b|exit code|timed out/i.test(l));
    text = (bad.length ? bad.slice(-8) : lines.slice(-10)).map(clip);
  }
  return { sig: tests.length ? tests.join('\n') : (text[0] || '(no log)'), text };
};

const failures = [];
for (const r of releases) for (const [t] of targets) for (const s of ['build', 'test']) {
  const x = get(r.v, t, s);
  if (x && x.status !== 'ok') failures.push({ v: r.v, t, s, x, ...diagnose(x.log) });
}
p();
p('## Failures');
p();
if (!failures.length) p('None recorded.');
else {
  const groups = new Map();
  for (const f of failures) {
    const k = `${f.t}|${f.s}|${f.x.status}|${f.sig}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  p(`${failures.length} failed step(s) in ${groups.size} group(s); releases that fail the same way are listed together. Logs: \`tools/reports/overnight/logs/<release>-<target>-<step>.log\` (git-ignored, on the machine that ran it).`);
  let n = 0;
  for (const g of [...groups.values()].sort((a, b) => b.length - a.length)) {
    n++;
    const f = g[0];
    p();
    p(`### ${n}. ${f.t === 'cli' ? 'image' : 'wasm'} ${f.s} ${f.x.status}: ${g.length} release(s)`);
    p();
    p(g.map((x) => x.v).join(', '));
    p();
    p(`Example log: \`${f.x.log}\``);
    p();
    p('```');
    p(f.text.join('\n'));
    p('```');
  }
}

// ---- time
p();
p('## Time spent');
p();
p('| Target | build | test | total |');
p('| --- | ---: | ---: | ---: |');
for (const [t, label] of targets) {
  const sum = (s) => releases.reduce((a, r) => a + ((get(r.v, t, s) || {}).seconds || 0), 0);
  p(`| ${label} | ${dur(sum('build'))} | ${dur(sum('test'))} | ${dur(sum('build') + sum('test'))} |`);
}
p();
p('Generated by `tools/scripts/overnight-report.js` from `tools/reports/overnight/results.tsv`.');

const text = `${L.join('\n')}\n`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, text);
process.stdout.write(text);
console.error(`overnight-report: written ${outFile}`);
