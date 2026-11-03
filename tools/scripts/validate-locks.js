#!/usr/bin/env node
'use strict';
// Validates sources.lock.json, toolchain.lock.json and feature-profile.json against
// schemas/*.schema.json (a small JSON Schema subset interpreter, no dependencies) and
// against the semantic rules a schema cannot express.
//
// Usage: validate-locks.js [--sources FILE] [--toolchain FILE] [--features FILE] [--require] [--strict-coverage]
// Without file options the files in the repo root are used. A missing file is reported
// as NOT PRESENT and only fails the run with --require. Exit codes: 0 ok, 1 invalid,
// 2 usage error.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = {
  sources: path.join(root, 'sources.lock.json'),
  toolchain: path.join(root, 'toolchain.lock.json'),
  features: path.join(root, 'feature-profile.json'),
  ranges: path.join(root, 'ranges.json'),
  require: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--require') opt.require = true;
  else if (a === '--strict-coverage') opt.strictCoverage = true;
  else if (a === '--sources' || a === '--toolchain' || a === '--features' || a === '--ranges') opt[a.slice(2)] = path.resolve(args[++i] || '');
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}

// ---- JSON Schema subset: type, enum, required, properties, additionalProperties:false,
// items, minItems, minProperties, minLength, pattern, additionalProperties as schema.
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}
function check(schema, value, where, errors) {
  const t = typeOf(value);
  if (schema.type && !(schema.type === t || (schema.type === 'number' && t === 'integer'))) {
    errors.push(`${where}: expected ${schema.type}, got ${t}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: must be one of ${JSON.stringify(schema.enum)}`);
  if (t === 'string') {
    if (schema.minLength && value.length < schema.minLength) errors.push(`${where}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: "${value}" does not match ${schema.pattern}`);
  }
  if (t === 'array') {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${where}[${i}]`, errors));
  }
  if (t === 'object') {
    const props = schema.properties || {};
    const keys = Object.keys(value);
    if (schema.minProperties && keys.length < schema.minProperties) errors.push(`${where}: needs at least ${schema.minProperties} propert(ies)`);
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${where}: missing required "${r}"`);
    for (const k of keys) {
      if (k in props) check(props[k], value[k], `${where}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${where}: unknown field "${k}"`);
      else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, value[k], `${where}.${k}`, errors);
    }
  }
}

// ---- versions: 9.x are A.B.C, 10+ are A.B; both compare as [A, B, C] with C defaulting to 0.
function ver(s) {
  const p = s.split('.').map(Number);
  return [p[0], p[1], p[2] || 0];
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function loadJson(file, errors, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${label}: cannot read/parse ${file}: ${e.message}`);
    return null;
  }
}

function semanticSources(doc, errors) {
  const seen = new Set();
  for (const r of doc.releases) {
    if (seen.has(r.version)) errors.push(`sources: duplicate release ${r.version}`);
    seen.add(r.version);
    const v = ver(r.version);
    const expectedMajor = v[0] >= 10 ? String(v[0]) : `${v[0]}.${v[1]}`;
    if (r.major !== expectedMajor) errors.push(`sources: ${r.version} has major "${r.major}", expected "${expectedMajor}"`);
  }
  if (!seen.has(doc.baseline)) errors.push(`sources: baseline ${doc.baseline} is not in releases`);
}

function semanticToolchain(doc, sources, errors) {
  const rs = doc.ranges.map((r) => ({ ...r, f: ver(r.from), t: ver(r.to) }));
  for (const r of rs) {
    if (cmp(r.f, r.t) > 0) errors.push(`toolchain: range ${r.from}..${r.to} has from > to`);
    for (const k of ['nativeImage', 'wasmImage']) {
      if (!(r[k] in doc.images)) errors.push(`toolchain: range ${r.from}..${r.to} uses unknown image "${r[k]}"`);
    }
  }
  const sorted = [...rs].sort((a, b) => cmp(a.f, b.f));
  for (let i = 1; i < sorted.length; i++) {
    if (cmp(sorted[i].f, sorted[i - 1].t) <= 0) {
      errors.push(`toolchain: ranges overlap: ${sorted[i - 1].from}..${sorted[i - 1].to} and ${sorted[i].from}..${sorted[i].to}`);
    }
  }
  if (sources) {
    const uncovered = [];
    for (const rel of sources.releases) {
      const v = ver(rel.version);
      const hits = rs.filter((r) => cmp(r.f, v) <= 0 && cmp(v, r.t) <= 0).length;
      if (hits === 0) uncovered.push(rel.version);
      if (hits > 1) errors.push(`toolchain: release ${rel.version} is covered by ${hits} ranges`);
    }
    if (opt.strictCoverage) {
      uncovered.forEach((v) => errors.push(`toolchain: release ${v} is not covered by any range (gap)`));
    } else if (uncovered.length) {
      // Until every release has a builder range (CDB-24) this is a warning, not an error;
      // --strict-coverage makes it one and is what the release gate uses.
      warnings.push(`toolchain: ${uncovered.length} of ${sources.releases.length} releases have no builder range yet (first ${uncovered[0]}, last ${uncovered[uncovered.length - 1]}); run with --strict-coverage to fail on this`);
    }
  }
}

// The version-range model must tile the release index: ordered, no overlap, and every release
// in sources.lock.json inside exactly one range (this one is always an error).
function semanticRanges(doc, sources, errors) {
  const ids = new Set();
  const rs = doc.ranges.map((r) => ({ ...r, f: ver(r.from), t: ver(r.to) }));
  for (const r of rs) {
    if (ids.has(r.id)) errors.push(`ranges: duplicate id ${r.id}`);
    ids.add(r.id);
    if (cmp(r.f, r.t) > 0) errors.push(`ranges: ${r.id} has from > to`);
  }
  const sorted = [...rs].sort((a, b) => cmp(a.f, b.f));
  for (let i = 1; i < sorted.length; i++) {
    if (cmp(sorted[i].f, sorted[i - 1].t) <= 0) errors.push(`ranges: ${sorted[i - 1].id} and ${sorted[i].id} overlap`);
  }
  if (sources) {
    for (const rel of sources.releases) {
      const v = ver(rel.version);
      const hits = rs.filter((r) => cmp(r.f, v) <= 0 && cmp(v, r.t) <= 0).length;
      if (hits !== 1) errors.push(`ranges: release ${rel.version} is covered by ${hits} ranges (must be exactly 1)`);
    }
  }
}

function semanticFeatures(doc, errors) {
  const names = new Map();
  for (const f of doc.features) {
    if (f.appliesFrom && f.appliesTo && cmp(ver(f.appliesFrom), ver(f.appliesTo)) > 0) {
      errors.push(`features: ${f.name} has appliesFrom > appliesTo`);
    }
    const key = `${f.name}|${f.appliesFrom || ''}|${f.appliesTo || ''}`;
    if (names.has(key)) errors.push(`features: duplicate entry for ${f.name}`);
    names.set(key, true);
  }
}

const errors = [];
const warnings = [];
const results = [];
function validate(label, file, schemaFile, semantic) {
  if (!fs.existsSync(file)) {
    results.push(`${label}: NOT PRESENT (${path.relative(root, file)})`);
    if (opt.require) errors.push(`${label}: required file missing`);
    return null;
  }
  const doc = loadJson(file, errors, label);
  if (!doc) return null;
  const before = errors.length;
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', schemaFile), 'utf8'));
  check(schema, doc, label, errors);
  if (errors.length === before && semantic) semantic(doc);
  results.push(`${label}: ${errors.length === before ? 'OK' : 'INVALID'}`);
  return errors.length === before ? doc : null;
}

const sources = validate('sources', opt.sources, 'sources.lock.schema.json', (d) => semanticSources(d, errors));
validate('toolchain', opt.toolchain, 'toolchain.lock.schema.json', (d) => semanticToolchain(d, sources, errors));
validate('ranges', opt.ranges, 'ranges.schema.json', (d) => semanticRanges(d, sources, errors));
validate('features', opt.features, 'feature-profile.schema.json', (d) => semanticFeatures(d, errors));

results.forEach((r) => console.log(r));
warnings.forEach((w) => console.log(`WARNING: ${w}`));
if (errors.length) {
  console.error('validate-locks: FAIL');
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log('validate-locks: PASS');
