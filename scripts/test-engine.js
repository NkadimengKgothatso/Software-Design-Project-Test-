// Golden tests for the metric engine, verified against hand-computed values
// from the scripted fixture repository (see scripts/fixture.js).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, BASE_TS } from './fixture.js';
import { parseLog, countCommits, countAllCommits } from '../server/gitlog.js';
import { buildModel } from '../server/model.js';

const DAY = 86400;
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, '..', 'data', 'fixture');

const results = [];
function check(name, actual, expected, eps = 1e-9) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) < eps
    : JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
}
function checkMetrics(label, m, exp) {
  for (const [k, v] of Object.entries(exp)) check(`${label}.${k}`, m?.[k], v);
}

const { hashes } = buildFixture(fixtureDir);

const count = await countCommits(fixtureDir, 'HEAD');
check('parsed commit count (merges excluded)', count, 8);
check('total commit count (merges included, = GitHub-style)', await countAllCommits(fixtureDir, 'HEAD'), 9);

const parsed = await parseLog(fixtureDir, 'HEAD');
const model = buildModel(parsed);

check('model commit count', model.n, 8);
check('merge commit excluded', model.hashIndex.has(hashes.c9), false);
check('non-merge commit included', model.hashIndex.has(hashes.c1), true);

// Authors: .mailmap must merge bob2@x.io into Bob <bob@x.io>
check('author count after mailmap', model.authors.length, 2);
check('author names', model.authors.map((a) => a.name).sort(), ['Alice Author', 'Bob']);

const all = model.resolveRange({});
check('|H| all commits', all.size, 8);

// ---- object metrics over the whole history (hand-computed) ---------------
const expAll = {
  '': { added: 16, removed: 6, growth: 10, churn: 22, modifications: 7, modFreq: 7 / 8, churnRate: 22 / 8 },
  'foo': { added: 13, removed: 4, growth: 9, churn: 17, modifications: 6 },
  'foo/sub': { added: 7, removed: 2, growth: 5, churn: 9, modifications: 2 },
  'foo/sub/deep.txt': { added: 7, removed: 2, growth: 5, churn: 9, modifications: 2 },
  'foo/bar.txt': { added: 4, removed: 1, growth: 3, churn: 5, modifications: 2 },
  'foo/baz.txt': { added: 2, removed: 1, growth: 1, churn: 3, modifications: 2 },
  'root.txt': { added: 2, removed: 2, growth: 0, churn: 4, modifications: 2 },
  '.mailmap': { added: 1, removed: 0, growth: 1, churn: 1, modifications: 1 },
};
for (const [p, exp] of Object.entries(expAll)) {
  const id = model.idOf(p);
  check(`object exists: ${p || '/'}`, id !== undefined, true);
  checkMetrics(`full[${p || '/'}]`, model.metrics(id, all), exp);
}

// binary files are not measured
check('binary file absent from objects', model.idOf('bin.dat'), undefined);

// ---- author metrics -------------------------------------------------------
const bob = model.authors.find((a) => a.name === 'Bob');
const alice = model.authors.find((a) => a.name === 'Alice Author');
checkMetrics('author[Bob]', model.metrics(model.rootId, all, bob.id), { added: 2, removed: 1, churn: 3, modifications: 2 });
checkMetrics('author[Alice]', model.metrics(model.rootId, all, alice.id), { added: 14, removed: 5, churn: 19, modifications: 5 });

const fooId = model.idOf('foo');
check('ownership[foo] Alice', model.metrics(fooId, all, alice.id).ownership, 14 / 17);
check('ownership[foo] Bob', model.metrics(fooId, all, bob.id).ownership, 3 / 17);

const ranking = model.authorRanking(all);
check('ranking size', ranking.length, 2);
check('ranking first is Alice', ranking[0].name, 'Alice Author');
check('ranking Alice churn', ranking[0].churn, 19);
check('ranking Bob commits', ranking.find((r) => r.name === 'Bob').commits, 2);

// ---- commit-set metrics: time range [day1, day4) => c2, c3, c4 ------------
const range = model.resolveRange({ from: BASE_TS + 1 * DAY, to: BASE_TS + 4 * DAY });
check('|H| time range', range.size, 3);
checkMetrics('range[root]', model.metrics(model.rootId, range), {
  added: 2, removed: 1, growth: 1, churn: 3, modifications: 2, modFreq: 2 / 3, churnRate: 1,
});
checkMetrics('range[foo]', model.metrics(fooId, range), { added: 2, removed: 1, churn: 3, modifications: 2 });

// ---- commit-set metrics: manual commit list [c2, c6] ----------------------
const manual = model.resolveRange({ commits: [hashes.c2, hashes.c6] });
check('|H| manual list', manual.size, 2);
checkMetrics('manual[root]', model.metrics(model.rootId, manual), {
  added: 6, removed: 1, growth: 5, churn: 7, modifications: 2, modFreq: 1, churnRate: 3.5,
});
checkMetrics('manual[foo]', model.metrics(fooId, manual), { added: 6, removed: 1, churn: 7, modifications: 2 });

// unknown hashes and empty selections must degrade to zero, not crash (spec: division by zero => 0)
const bogus = model.resolveRange({ commits: ['0'.repeat(40)] });
check('|H| bogus list', bogus.size, 0);
checkMetrics('bogus[root]', model.metrics(model.rootId, bogus), {
  added: 0, removed: 0, churn: 0, modifications: 0, modFreq: 0, churnRate: 0,
});

// ---- extras used by the dashboard ----------------------------------------
const tl = model.timeline(model.rootId, all);
check('timeline non-empty', tl.labels.length > 0, true);
check('timeline churn total', tl.churn.reduce((s, v) => s + v, 0), 22);

const hot = model.hotspots(all, null, 'file', 5);
check('hotspot top file', hot[0].path, 'foo/sub/deep.txt');
check('hotspot top churn', hot[0].churn, 9);

const page = model.commitsInRange(all, null, 0, 5);
check('commits page total', page.total, 8);
check('commits page newest first', page.items[0].subject, 'c8');

const tree = model.tree();
check('tree root has children', tree.children.length > 0, true);

// ---- report ---------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.ok) {
    failed++;
    console.log(`FAIL  ${r.name}\n      expected ${JSON.stringify(r.expected)}\n      actual   ${JSON.stringify(r.actual)}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`);
console.log(`parse stats: ${JSON.stringify(parsed.stats)}, commits parsed: ${parsed.commits.length}`);
if (failed) process.exit(1);
