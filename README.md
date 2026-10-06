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
- [ ] Metric engine (git log single-pass parser + aggregations)
- [ ] Ingestion: zip upload and remote URL clone
- [ ] Multi-repo support
- [ ] Author merging (.mailmap + manual)
- [ ] Dashboard: filters, metric cards, charts

## AI usage declaration

Development was assisted by an AI coding agent (Qoder); all output was reviewed and
tested by the author. Adjust this statement to match the module's policy before submitting.
