# RAT — Repo Analysis Tool

Web dashboard that visualises how a git repository has evolved: per-author, per-file,
per-directory, whole-repository and commit-set metrics (added / removed lines, growth,
churn, modifications, modification frequency, churn rate and author ownership).

Built for the COMS3011A software design test.

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

## Status

- [x] Project scaffold (Express + static dashboard)
- [x] Metric engine (git log single-pass parser + aggregations)
- [x] Ingestion: zip upload and remote URL clone
- [x] Multi-repo support
- [x] Author merging (.mailmap + manual)
- [x] Dashboard: filters, metric cards, charts
- [x] Reference validation against golden CSVs (cJSON / redis / git)
- [x] Performance pass on 1k / 10k / 60k / 119k commit repositories

## Metric definitions

For a set of commits H and an object o (file, directory, repository):

| symbol | name | definition |
|--------|------|------------|
| l⁺ | added | lines added to o across H |
| l⁻ | removed | lines removed from o across H |
| δ | growth | l⁺ − l⁻ |
| λ | churn | l⁺ + l⁻ |
| n | modifications | commits in H that changed o (λ > 0) |
| η | modification frequency | n / \|H\| |
| ρ | churn rate | λ / \|H\| |
| ω | ownership | author's churn on o / total churn on o |

Directories aggregate their recursive subtree; the repository is the root.
Binary files and merge commits are excluded (H is the non-merge history of HEAD);
renames are detected with `-M50%`, pure renames contribute no lines and both the
old and new path remain addressable objects. Author identities are exact
`(name, email)` pairs; grouping distinct identities is an explicit user action
(`.mailmap` is applied automatically, manual merges merge further).

## Architecture

- `server/gitlog.js` — one streaming `git log --no-merges -z --numstat -M50%` pass
  per repository (never a spawn per commit); NUL-token wire format parsed on the fly.
- `server/model.js` — in-memory model: per-object sparse arrays of (commit, added,
  removed), directory subtrees aggregated at parse time, binary-search range
  queries, small FIFO cache for computed metric sets.
- `server/store.js` — repository registry (`data/repos.json`), clone with progress
  (`--progress` stderr parsing), zip upload (root `.git` detection, linked-gitdir
  validation), background analysis, re-hydration on restart.
- `server/index.js` — REST API: repos, upload, analyze/delete, tree, authors,
  author-merge, dashboard (metrics, timeline, ranking, hotspots, children), commits.
- `public/` — static dashboard (ECharts): metric cards, timeline, treemap, hotspots,
  ownership donut, filters (author / file-or-directory / time period / manual commit
  list), path picker, commit picker, author-merge modal.

## Validation

- Fixture repository with hand-computed golden values: **110/110 assertions** (`npm test`).
- Golden reference metric CSVs for three public repositories at pinned commits:

| repo | ref | non-merge commits | rows checked | result |
|------|-----|-------------------|--------------|--------|
| cJSON | 6d9f2443ab07 | 955 | 4,806 | all match |
| redis | b540ca49cba8 | 11,874 | 25,613 | all match |
| git | 5a7d1e8045ce | 61,101 | 63,298 | all match |

Every object's added/removed/growth/churn/modifications/modification-frequency/churn-rate
and every per-author added/removed/churn/ownership value matches the reference exactly
(including case-sensitive author identities, file-vs-directory object namespacing and
rename end-points). Run:

```bash
node scripts/validate-reference.js <repo-dir> <reference.csv> [--full]
```

## Performance

Measured with `node scripts/perf.js <label>=<repo-dir> ...` (single process, warm disk):

| repo | non-merge commits | raw `git log` | engine parse | model build | dashboard queries | RSS |
|------|-------------------|---------------|--------------|-------------|-------------------|-----|
| cJSON | 955 | 0.23 s | 0.23 s | 0.01 s | 17 ms | 59 MB |
| redis | 11,874 | 10.4 s | 9.6 s | 0.07 s | 16 ms | 103 MB |
| git.git | 61,101 | 32.1 s | 39.1 s | 0.16 s | 59 ms | 182 MB |
| php-src | 118,756 | 107.7 s | 131.2 s | 0.81 s | 305 ms | 336 MB |

Engine time is dominated by git's own diff computation (parse ≈ raw `git log` + ~20%);
all dashboard queries are served from the in-memory model in milliseconds.

## AI usage declaration

Development was assisted by an AI coding agent (Qoder); all output was reviewed and
tested by the author. Adjust this statement to match the module's policy before submitting.
