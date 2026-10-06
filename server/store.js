// Repository store: ingestion (clone URL / zip upload), analysis orchestration,
// multi-repo registry and in-memory models.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, countCommits, runGit } from './gitlog.js';
import { buildModel } from './model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const REPO_DIR = path.join(DATA, 'repos');
const TMP_DIR = path.join(DATA, 'tmp');
const REGISTRY = path.join(DATA, 'repos.json');

fs.mkdirSync(REPO_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const repos = loadRegistry();
const models = new Map();

function loadRegistry() {
  try {
    const arr = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return new Map(arr.map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
}

function saveRegistry() {
  try { fs.writeFileSync(REGISTRY, JSON.stringify([...repos.values()], null, 2)); } catch { /* best effort */ }
}

function newId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function baseName(urlOrFile) {
  const s = String(urlOrFile || '').replace(/\/+$/, '');
  return (s.split(/[/\\]/).pop() || 'repo').replace(/\.git$|\.zip$/i, '') || 'repo';
}

function setMeta(id, patch, persist = false) {
  const meta = repos.get(id);
  if (!meta) return;
  Object.assign(meta, patch);
  if (persist) saveRegistry();
}

function runProc(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`${cmd} failed (${code}): ${err.trim().slice(-300)}`))));
  });
}

export function listRepos() { return [...repos.values()]; }
export function getRepo(id) { return repos.get(id); }
export function getModel(id) { return models.get(id); }

export function publicMeta(meta) {
  if (!meta) return null;
  const { path: _internal, ...rest } = meta;
  return { ...rest, analyzed: models.has(meta.id) };
}

// ---- ingestion: remote URL -------------------------------------------------

export function addRepoFromUrl(url, ref = 'HEAD', name) {
  const id = newId();
  const dir = path.join(REPO_DIR, id);
  const meta = {
    id,
    name: name || baseName(url),
    source: { type: 'url', url },
    ref: ref || 'HEAD',
    status: 'cloning',
    progress: { phase: 'clone', pct: 0 },
    error: null,
    addedAt: Date.now(),
    stats: null,
  };
  repos.set(id, meta);
  saveRegistry();
  cloneAndAnalyze(id, dir, url, meta.ref)
    .catch((err) => setMeta(id, { status: 'error', error: String(err?.message || err) }, true));
  return meta;
}

async function cloneAndAnalyze(id, dir, url, ref) {
  await new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', '--progress', '--', url, dir]);
    let err = '';
    let lastPct = -1;
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      err += d;
      if (err.length > 100000) err = err.slice(-50000);
      const m = /(?:Receiving objects|Resolving deltas|Checking out files):\s+(\d+)%/.exec(d);
      if (m) {
        const pct = Number(m[1]);
        if (pct !== lastPct) {
          lastPct = pct;
          setMeta(id, { progress: { phase: 'clone', pct } });
        }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const fatal = err.split('\n').filter((l) => /fatal|error/i.test(l)).pop() || err.slice(-300);
      reject(new Error(`git clone failed: ${fatal.trim()}`));
    });
  });
  await analyzeRepo(id);
}

// ---- ingestion: zip upload -------------------------------------------------

export function addRepoFromZip(zipPath, originalName, ref = 'HEAD', name) {
  const id = newId();
  const dir = path.join(REPO_DIR, id);
  const meta = {
    id,
    name: name || baseName(originalName),
    source: { type: 'zip', filename: originalName || 'upload.zip' },
    ref: ref || 'HEAD',
    status: 'extracting',
    progress: { phase: 'extract', pct: 0 },
    error: null,
    addedAt: Date.now(),
    stats: null,
  };
  repos.set(id, meta);
  saveRegistry();
  extractAndAnalyze(id, dir, zipPath)
    .catch((err) => setMeta(id, { status: 'error', error: String(err?.message || err) }, true));
  return meta;
}

async function extractAndAnalyze(id, dir, zipPath) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    await runProc('unzip', ['-q', '-o', zipPath, '-d', dir]);
  } catch (err) {
    throw new Error(`Could not extract the zip: ${err.message}`);
  }
  fs.rmSync(zipPath, { force: true });

  // The .git directory may sit at the zip root or one folder deep.
  const candidates = [dir];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) candidates.push(path.join(dir, e.name));
  }
  let root = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.git'))) { root = c; break; }
  }
  if (!root) {
    throw new Error('No .git found in the zip. Upload a zip of the repository folder *including* its .git directory (a plain source archive has no history to measure).');
  }
  try {
    await runGit(root, ['rev-parse', '--git-dir']);
  } catch {
    throw new Error('The .git entry in this zip is a *file* (a link to a git directory outside the archive), so there is no history to measure. Zip the repository including the full .git directory.');
  }
  setMeta(id, { path: root });
  await analyzeRepo(id);
}

// ---- analysis ---------------------------------------------------------------

export async function analyzeRepo(id) {
  const meta = repos.get(id);
  if (!meta) throw new Error('unknown repository');
  const root = meta.path || path.join(REPO_DIR, id);
  const ref = meta.ref || 'HEAD';

  setMeta(id, { status: 'analyzing', progress: { phase: 'analyze', done: 0, total: 0 }, error: null }, true);
  try {
    const total = await countCommits(root, ref);
    setMeta(id, { progress: { phase: 'analyze', done: 0, total } });
    const step = Math.max(25, Math.floor(total / 100));
    let last = 0;
    const parsed = await parseLog(root, ref, {
      onProgress: (done) => {
        if (done - last >= step || done === total) {
          last = done;
          setMeta(id, { progress: { phase: 'analyze', done, total } });
        }
      },
    });
    const model = buildModel(parsed);
    models.set(id, model);
    setMeta(id, {
      status: 'ready',
      progress: { phase: 'ready', done: total, total },
      stats: model.baseStats(),
      analyzedAt: Date.now(),
    }, true);
    return model;
  } catch (err) {
    setMeta(id, { status: 'error', error: String(err?.message || err) }, true);
    throw err;
  }
}

export function deleteRepo(id) {
  const meta = repos.get(id);
  if (!meta) return false;
  models.delete(id);
  repos.delete(id);
  saveRegistry();
  fs.rmSync(path.join(REPO_DIR, id), { recursive: true, force: true });
  return true;
}

/** After a restart, re-analyze repositories whose clone still exists on disk. */
export function bootRehydrate() {
  for (const meta of repos.values()) {
    if (models.has(meta.id)) continue;
    const root = meta.path || path.join(REPO_DIR, meta.id);
    if (fs.existsSync(path.join(root, '.git'))) {
      analyzeRepo(meta.id).catch(() => {});
    } else if (meta.status !== 'error') {
      setMeta(meta.id, { status: 'error', error: 'Repository data is missing after a restart — add the repository again.' }, true);
    }
  }
}
