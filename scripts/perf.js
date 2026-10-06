// Measures the engine on large histories: commit count, parse time, model
// build time, query latency and peak RSS.
//
// usage: node scripts/perf.js <label>=<repo-dir> [<label>=<repo-dir> ...]

import { parseLog, countCommits } from '../server/gitlog.js';
import { buildModel } from '../server/model.js';

const specs = process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return { label: a.slice(0, i), dir: a.slice(i + 1) };
});
if (!specs.length) {
  console.error('usage: node scripts/perf.js <label>=<repo-dir> ...');
  process.exit(2);
}

const rows = [];
for (const { label, dir } of specs) {
  const t0 = Date.now();
  const commits = await countCommits(dir);
  const tCount = Date.now() - t0;

  const t1 = Date.now();
  let lastProgress = 0;
  const parsed = await parseLog(dir, 'HEAD', { onProgress: (n) => { lastProgress = n; } });
  const tParse = Date.now() - t1;
  const merged = parsed.commits.length;

  const t2 = Date.now();
  const model = buildModel(parsed);
  const tBuild = Date.now() - t2;

  const range = model.resolveRange({});
  const t3 = Date.now();
  const q = [
    ['metrics(root)', () => model.metrics(model.rootId, range)],
    ['authorRanking', () => model.authorRanking(range)],
    ['timeline', () => model.timeline(model.rootId, range)],
    ['hotspots(15)', () => model.hotspots(range, null, 'file', 15)],
    ['childrenMetrics', () => model.childrenMetrics(model.rootId, range)],
    ['tree', () => model.tree()],
  ];
  const qt = q.map(([name, fn]) => {
    const s = Date.now();
    fn();
    return [name, Date.now() - s];
  });
  const tQuery = Date.now() - t3;

  rows.push({
    label,
    commits,
    nonMerge: merged,
    tCount,
    tParse,
    tBuild,
    tQuery,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    objects: model.objects.length,
    qt,
    sawAll: lastProgress === merged,
  });
}

console.log('\n| repo | commits | non-merge | count s | parse s | build s | queries ms | peak RSS MB | objects |');
console.log('|------|---------|-----------|---------|---------|---------|------------|-------------|---------|');
for (const r of rows) {
  console.log(
    `| ${r.label} | ${r.commits} | ${r.nonMerge} | ${(r.tCount / 1000).toFixed(2)} | ${(r.tParse / 1000).toFixed(2)}` +
    ` | ${(r.tBuild / 1000).toFixed(2)} | ${r.tQuery} | ${r.rssMB} | ${r.objects} |`,
  );
}
for (const r of rows) {
  console.log(`\n${r.label} query breakdown (ms): ${r.qt.map(([n, t]) => `${n} ${t}`).join(', ')}`);
  if (!r.sawAll) console.log(`  NOTE: progress callback never reached the final commit count`);
}
