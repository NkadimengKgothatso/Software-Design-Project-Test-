// Validates the engine output for a repository against a reference metric CSV
// (golden values for cJSON / redis / git at pinned commits).
//
// usage: node scripts/validate-reference.js <repo-dir> <reference.csv> [--full]
//   --full  also compare per-author rows for every object (fine on small repos)

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseLog } from '../server/gitlog.js';
import { buildModel } from '../server/model.js';

const [, , dir, csvPath, ...flags] = process.argv;
const full = flags.includes('--full');
if (!dir || !csvPath) {
  console.error('usage: node scripts/validate-reference.js <repo-dir> <reference.csv> [--full]');
  process.exit(2);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return { header, rows: rows.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

const t0 = Date.now();
const parsed = await parseLog(dir, 'HEAD');
const model = buildModel(parsed);
const range = model.resolveRange({});
console.log(`parsed ${parsed.commits.length} commits in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

const { rows } = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const refCommitCount = Number(rows[0].commit_count);

// The reference CSVs were exported with the merge-excluded history as |H|:
// their commit_count column equals `git rev-list --count --no-merges`, and
// their modFreq/churnRate columns divide by that same value. The engine now
// counts every commit GitHub shows (merges included) so |H| matches the
// repository page; merge commits carry no diff, so all measured diff columns
// are unchanged and still compared directly below. The two |H|-derived
// columns are re-derived from the CSV's own numerators over the git-verified
// |H|.
const gitOut = (args) => execFileSync('git', ['-C', dir, 'rev-list', '--count', ...args, 'HEAD'], { encoding: 'utf8' }).trim();
const noMergeCount = Number(gitOut(['--no-merges']));
const fullCount = Number(gitOut([]));

let pass = 0;
let fail = 0;
const failures = [];
const note = (ok, label, got, want) => {
  if (ok) pass++;
  else {
    fail++;
    if (failures.length < 50) failures.push(`${label}\n    got  ${got}\n    want ${want}`);
  }
};
const near = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) < 1e-9 : a === b);

// commit set size: the CSV's merge-excluded count is a subset of |H|, and the
// engine's |H| must equal the full history git (and GitHub) reports for the ref.
note(range.size === fullCount, `commit set size |H| (= git rev-list --count, merges included)`, range.size, fullCount);
note(fullCount - refCommitCount >= 0, `CSV commit_count is merge-excluded history of the same ref`, `${refCommitCount} <= ${fullCount}`, 'true');

const objIdFor = (type, path) => {
  if (type === 'repository') return model.rootId;
  return type === 'directory' ? model.dirIdOf(path) : model.fileIdOf(path);
};

// group rows by object
const byObject = new Map();
for (const r of rows) {
  const key = `${r.object_type}|${r.path}`;
  if (!byObject.has(key)) byObject.set(key, []);
  byObject.get(key).push(r);
}

const extraAuthors = [];
for (const [key, group] of byObject) {
  const sample = group[0];
  const objId = objIdFor(sample.object_type, sample.path);
  if (objId === undefined) { note(false, `missing object ${key}`, 'undefined', 'exists'); continue; }
  const m = model.metrics(objId, range);

  const all = group.find((r) => r.author === 'ALL');
  if (all) {
    note(m.added === Number(all.added), `${key} added`, m.added, all.added);
    note(m.removed === Number(all.removed), `${key} removed`, m.removed, all.removed);
    note(m.growth === Number(all.growth), `${key} growth`, m.growth, all.growth);
    note(m.churn === Number(all.churn), `${key} churn`, m.churn, all.churn);
    note(Number(all.modifications) === m.modifications, `${key} modifications`, m.modifications, all.modifications);
    note(near(Number(all.modifications) / fullCount, m.modFreq), `${key} modFreq`, m.modFreq, Number(all.modifications) / fullCount);
    note(near(Number(all.churn) / fullCount, m.churnRate), `${key} churnRate`, m.churnRate, Number(all.churn) / fullCount);
  }

  const authorRows = group.filter((r) => r.author !== 'ALL');
  if (authorRows.length && (full || sample.object_type === 'repository')) {
    const ranking = model.authorRanking(range, objId);
    const mine = new Map(ranking.map((x) => [`${x.name} <${x.emails[0] ?? ''}>`, x]));
    for (const r of authorRows) {
      const x = mine.get(r.author);
      if (!x) { note(false, `${key} author ${r.author}`, 'missing', `churn ${r.churn}`); continue; }
      note(x.added === Number(r.added), `${key} author ${r.author} added`, x.added, r.added);
      note(x.removed === Number(r.removed), `${key} author ${r.author} removed`, x.removed, r.removed);
      note(x.churn === Number(r.churn), `${key} author ${r.author} churn`, x.churn, r.churn);
      note(near(Number(r.ownership), x.share), `${key} author ${r.author} ownership`, x.share, r.ownership);
      mine.delete(r.author);
    }
    for (const [label, x] of mine) {
      if (x.churn > 0) note(false, `${key} extra author with churn`, `${label} churn ${x.churn}`, 'not in reference');
      else extraAuthors.push(`${key} :: ${label}`);
    }
  }
}

console.log(`\nreference rows: ${rows.length}   assertions: ${pass + fail}   pass: ${pass}   fail: ${fail}`);
if (extraAuthors.length) {
  console.log(`\nextra zero-churn authors (rename-only contributions, not a failure): ${extraAuthors.length}`);
  for (const e of extraAuthors.slice(0, 10)) console.log(`  ${e}`);
}
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nALL REFERENCE VALUES MATCH');
