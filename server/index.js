import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

const upload = multer({
  dest: path.join(__dirname, '..', 'data', 'tmp'),
  limits: { fileSize: 1500 * 1024 * 1024 },
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function withModel(fn) {
  return (req, res, next) => {
    try {
      const meta = store.getRepo(req.params.id);
      if (!meta) throw httpError(404, 'unknown repository');
      const model = store.getModel(req.params.id);
      if (!model) {
        return res.status(409).json({
          error: `repository is not ready (${meta.status})`,
          status: meta.status,
          progress: meta.progress,
        });
      }
      fn(req, res, model, meta);
    } catch (err) {
      next(err);
    }
  };
}

function parseFilters(req, model) {
  const q = req.query || {};
  const rangeQ = {};
  if (q.from !== undefined && q.from !== '') rangeQ.from = Number(q.from);
  if (q.to !== undefined && q.to !== '') rangeQ.to = Number(q.to);
  if (rangeQ.from !== undefined && !Number.isFinite(rangeQ.from)) throw httpError(400, 'invalid from');
  if (rangeQ.to !== undefined && !Number.isFinite(rangeQ.to)) throw httpError(400, 'invalid to');
  if (q.commits !== undefined && q.commits !== '') {
    rangeQ.commits = String(q.commits).split(',').map((s) => s.trim()).filter(Boolean);
  }
  const range = model.resolveRange(rangeQ);

  let gid = null;
  if (q.author !== undefined && q.author !== '') {
    const n = Number(q.author);
    if (!Number.isInteger(n) || model.groupSet(n).size === 0) throw httpError(400, 'unknown author');
    gid = n;
  }

  const objectPath = q.object !== undefined ? String(q.object) : '';
  const objId = objectPath === '' ? model.rootId : model.idOf(objectPath);
  if (objId === undefined) throw httpError(404, `unknown object: ${objectPath}`);
  return { range, gid, objId, objectPath };
}

// ---- repositories -----------------------------------------------------------

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'RAT' }));

app.get('/api/repos', (_req, res) => {
  res.json(store.listRepos().map((r) => store.publicMeta(r)));
});

app.post('/api/repos', (req, res, next) => {
  try {
    const { url, ref, name } = req.body || {};
    if (typeof url !== 'string' || !/^(https?:\/\/|git@|ssh:\/\/)/.test(url.trim())) {
      throw httpError(400, 'Provide a git repository URL (https://... or git@...)');
    }
    res.json(store.publicMeta(store.addRepoFromUrl(url.trim(), ref, name)));
  } catch (err) {
    next(err);
  }
});

app.post('/api/repos/upload', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) throw httpError(400, 'No zip uploaded (multipart field name must be "file")');
    res.json(store.publicMeta(store.addRepoFromZip(req.file.path, req.file.originalname, req.body?.ref, req.body?.name)));
  } catch (err) {
    next(err);
  }
});

app.get('/api/repos/:id/status', (req, res) => {
  const meta = store.getRepo(req.params.id);
  if (!meta) return res.status(404).json({ error: 'unknown repository' });
  res.json(store.publicMeta(meta));
});

app.post('/api/repos/:id/analyze', (req, res, next) => {
  try {
    const meta = store.getRepo(req.params.id);
    if (!meta) throw httpError(404, 'unknown repository');
    store.analyzeRepo(req.params.id).catch(() => {});
    res.json(store.publicMeta(meta));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/repos/:id', (req, res) => {
  const ok = store.deleteRepo(req.params.id);
  if (!ok) return res.status(404).json({ error: 'unknown repository' });
  res.json({ ok: true });
});

// ---- metrics -----------------------------------------------------------------

app.get('/api/repos/:id/tree', withModel((req, res, model) => {
  res.json(model.tree());
}));

app.get('/api/repos/:id/authors', withModel((req, res, model) => {
  res.json({ groups: model.authorGroups(), authors: model.authors });
}));

app.post('/api/repos/:id/merge', withModel((req, res, model) => {
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
  model.applyMerge(groups);
  res.json({ groups: model.authorGroups() });
}));

app.get('/api/repos/:id/dashboard', withModel((req, res, model, meta) => {
  const { range, gid, objId, objectPath } = parseFilters(req, model);
  res.json({
    repo: store.publicMeta(meta),
    object: { path: objectPath, type: model.objects[objId].type },
    range: { kind: range.kind, size: range.size },
    metrics: model.metrics(objId, range, gid),
    timeline: model.timeline(objId, range, gid),
    ranking: model.authorRanking(range, objId),
    hotspots: model.hotspots(range, gid, 'file', 12),
    children: model.childrenMetrics(objId, range, gid),
    groups: model.authorGroups(),
    stats: model.baseStats(),
  });
}));

app.get('/api/repos/:id/commits', withModel((req, res, model) => {
  const { range, gid } = parseFilters(req, model);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(model.commitsInRange(range, gid, offset, limit));
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.name === 'MulterError' ? 400 : 500);
  res.status(status).json({ error: err.message || 'internal error' });
});

app.listen(PORT, () => {
  console.log(`RAT listening on http://localhost:${PORT}`);
  store.bootRehydrate();
});
