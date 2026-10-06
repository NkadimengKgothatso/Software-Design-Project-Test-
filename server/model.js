// Metric engine: in-memory index over parsed commits, answering the metric
// queries defined by the brief (file / directory / repository / commit set /
// author metrics, each over any commit subset selected by time or hash list).

const ROOT = '';

export function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** All ancestor directory paths of a file path, deepest first, root last. */
function ancestorsOf(p) {
  const out = [];
  let i = p.lastIndexOf('/');
  while (i > 0) { out.push(p.slice(0, i)); i = p.lastIndexOf('/', i - 1); }
  out.push(ROOT);
  return out;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function buildModel(parsed) {
  return new RepoModel(parsed);
}

export class RepoModel {
  constructor(parsed) {
    const commits = parsed.commits.slice().sort((a, b) => a.ts - b.ts); // stable, chronological
    this.commits = commits;
    this.n = commits.length;
    this.parsedStats = parsed.stats ?? {};

    this.cTs = [];
    this.cAuthor = [];
    this.cChurn = [];

    this.authors = []; // { id, name, email, commitCount }
    this.authorKey = new Map();

    this.objects = []; // { path, type }  — index is the object id
    this.objectId = new Map();
    this.objC = [];
    this.objA = [];
    this.objR = [];

    this.hashIndex = new Map();

    for (let ci = 0; ci < this.n; ci++) {
      const c = commits[ci];
      this.cTs[ci] = c.ts;
      const aid = this.authorIdOf(c.name, c.email);
      this.cAuthor[ci] = aid;
      this.authors[aid].commitCount++;
      this.hashIndex.set(c.hash, ci);

      let churn = 0;
      const dirAgg = new Map();
      for (const e of c.entries) {
        const foid = this.ensureObject(e.path, 'file');
        this.objC[foid].push(ci);
        this.objA[foid].push(e.added);
        this.objR[foid].push(e.removed);
        churn += e.added + e.removed;
        for (const d of ancestorsOf(e.path)) {
          let slot = dirAgg.get(d);
          if (!slot) { slot = [0, 0]; dirAgg.set(d, slot); }
          slot[0] += e.added;
          slot[1] += e.removed;
        }
      }
      for (const [d, [a, r]] of dirAgg) {
        const doid = this.ensureObject(d, 'dir');
        this.objC[doid].push(ci);
        this.objA[doid].push(a);
        this.objR[doid].push(r);
      }
      this.cChurn[ci] = churn;
    }

    if (!this.objectId.has(ROOT)) this.ensureObject(ROOT, 'dir');
    this.rootId = this.objectId.get(ROOT);

    this.mergeMap = new Map(); // authorId -> groupId
    this.mergeVersion = 0;
    this.cache = new Map();
    this.gsetCache = new Map();
  }

  ensureObject(path, type) {
    let id = this.objectId.get(path);
    if (id === undefined) {
      id = this.objects.length;
      this.objects.push({ path, type });
      this.objectId.set(path, id);
      this.objC.push([]);
      this.objA.push([]);
      this.objR.push([]);
    } else if (type === 'dir' && this.objects[id].type !== 'dir') {
      this.objects[id].type = 'dir';
    }
    return id;
  }

  authorIdOf(name, email) {
    const key = `${name}\u0000${email.toLowerCase()}`;
    let id = this.authorKey.get(key);
    if (id === undefined) {
      id = this.authors.length;
      this.authors.push({ id, name, email, commitCount: 0 });
      this.authorKey.set(key, id);
    }
    return id;
  }

  // ---- public API -------------------------------------------------------

  idOf(path) { return this.objectId.get(path); }

  listObjects() {
    return this.objects.map((o, i) => ({ id: i, path: o.path, type: o.type }));
  }

  baseStats() {
    return {
      commits: this.n,
      objects: this.objects.length,
      authors: this.authors.length,
      firstTs: this.n ? this.cTs[0] : null,
      lastTs: this.n ? this.cTs[this.n - 1] : null,
      binaries: this.parsedStats.binaries ?? 0,
      renames: this.parsedStats.renames ?? 0,
    };
  }

  groupOf(aid) {
    const g = this.mergeMap.get(aid);
    return g === undefined ? aid : g;
  }

  groupSet(gid) {
    let s = this.gsetCache.get(gid);
    if (!s) {
      s = new Set();
      for (const a of this.authors) if (this.groupOf(a.id) === gid) s.add(a.id);
      this.gsetCache.set(gid, s);
    }
    return s;
  }

  authorGroups() {
    const map = new Map();
    for (const a of this.authors) {
      const gid = this.groupOf(a.id);
      let g = map.get(gid);
      if (!g) { g = { id: gid, name: a.name, emails: [], members: [], commitCount: 0 }; map.set(gid, g); }
      g.members.push(a.id);
      if (!g.emails.includes(a.email)) g.emails.push(a.email);
      g.commitCount += a.commitCount;
    }
    return [...map.values()];
  }

  /** groups: array of arrays of author ids that should be merged together. */
  applyMerge(groups) {
    const seen = new Set();
    const next = new Map();
    for (const group of groups) {
      const ids = group.filter((id) => Number.isInteger(id) && id >= 0 && id < this.authors.length);
      if (ids.length < 2) continue;
      const gid = ids[0];
      for (const id of ids) {
        if (seen.has(id)) throw new Error(`author ${id} appears in multiple merge groups`);
        seen.add(id);
        next.set(id, gid);
      }
    }
    this.mergeMap = next;
    this.mergeVersion++;
    this.cache.clear();
    this.gsetCache.clear();
  }

  /** q: { from?, to?, commits? }  (unix seconds; commits = array of hashes) */
  resolveRange(q = {}) {
    if (Array.isArray(q.commits) && q.commits.length) {
      const set = new Set();
      for (const h of q.commits) {
        const ci = this.hashIndex.get(String(h).trim().toLowerCase());
        if (ci !== undefined) set.add(ci);
      }
      const list = [...set].sort((a, b) => a - b);
      return {
        kind: 'list', set, list, size: list.length,
        first: list[0] ?? 0,
        last: list[list.length - 1] ?? -1,
        key: `l:${list.length}:${list[0] ?? 'x'}:${list[list.length - 1] ?? 'x'}:${fnv1a(list.join(','))}`,
      };
    }
    const hasFrom = Number.isFinite(q.from);
    const hasTo = Number.isFinite(q.to);
    const lo = hasFrom ? lowerBound(this.cTs, q.from) : 0;
    const hi = hasTo ? lowerBound(this.cTs, q.to) : this.n;
    const size = Math.max(0, hi - lo);
    return { kind: 'range', lo, hi: Math.max(lo, hi), size, set: null, key: `r:${lo}:${hi}` };
  }

  #scan(objId, range, authorSet, cb) {
    const c = this.objC[objId];
    const aArr = this.objA[objId];
    const rArr = this.objR[objId];
    let m0;
    let m1;
    if (range.kind === 'range') {
      m0 = lowerBound(c, range.lo);
      m1 = lowerBound(c, range.hi);
    } else if (c.length === 0) {
      return;
    } else {
      m0 = lowerBound(c, range.first);
      m1 = lowerBound(c, range.last + 1);
    }
    for (let m = m0; m < m1; m++) {
      const ci = c[m];
      if (authorSet && !authorSet.has(this.groupOf(this.cAuthor[ci]))) continue;
      if (range.kind === 'list' && !range.set.has(ci)) continue;
      cb(aArr[m], rArr[m], ci);
    }
  }

  #put(key, value) {
    if (this.cache.size > 4000) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }

  /**
   * All metrics for one object (file, directory, or the repository root) over a
   * commit set, optionally filtered to one author group.
   */
  metrics(objId, range, gid = null) {
    if (objId === undefined || objId === null) return null;
    const ck = `${objId}|${range.key}|${gid ?? '-'}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;

    const authorSet = gid == null ? null : this.groupSet(gid);
    let added = 0;
    let removed = 0;
    let mods = 0;
    this.#scan(objId, range, authorSet, (a, r) => {
      added += a;
      removed += r;
      if (a + r > 0) mods++;
    });

    const churn = added + removed;
    const size = range.size;
    const out = {
      added,
      removed,
      growth: added - removed,
      churn,
      modifications: mods,
      modFreq: size > 0 ? mods / size : 0,
      churnRate: size > 0 ? churn / size : 0,
      size,
    };
    if (authorSet) {
      const all = this.metrics(objId, range, null);
      out.ownership = all.churn > 0 ? churn / all.churn : 0;
    }
    this.#put(ck, out);
    return out;
  }

  authorRanking(range, objId = this.rootId) {
    const ck = `ar|${objId}|${range.key}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;

    const acc = new Map(); // gid -> { added, removed, churn, commits = modifications }
    this.#scan(objId, range, null, (a, r, ci) => {
      const gid = this.groupOf(this.cAuthor[ci]);
      let e = acc.get(gid);
      if (!e) { e = { added: 0, removed: 0, churn: 0, commits: 0 }; acc.set(gid, e); }
      if (a + r > 0) e.commits++; // m: commits by the author that modify this object
      e.added += a;
      e.removed += r;
      e.churn += a + r;
    });

    const totalChurn = [...acc.values()].reduce((s, e) => s + e.churn, 0);
    const out = [...acc.entries()]
      .filter(([, e]) => e.churn > 0)
      .map(([gid, e]) => ({
        id: gid,
        name: this.authors[gid]?.name ?? `author ${gid}`,
        emails: this.authors[gid] ? [this.authors[gid].email] : [],
        added: e.added,
        removed: e.removed,
        churn: e.churn,
        commits: e.commits,
        share: totalChurn > 0 ? e.churn / totalChurn : 0,
      }))
      .sort((x, y) => y.churn - x.churn);
    this.#put(ck, out);
    return out;
  }

  timeline(objId, range, gid = null) {
    const ck = `tl|${objId}|${range.key}|${gid ?? '-'}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;

    let t0;
    let t1;
    if (range.kind === 'range') {
      if (range.size === 0) {
        const empty = { unit: 'day', labels: [], added: [], removed: [], churn: [], commits: [] };
        this.#put(ck, empty);
        return empty;
      }
      t0 = this.cTs[range.lo];
      t1 = this.cTs[range.hi - 1] + 1;
    } else {
      if (range.size === 0) {
        const empty = { unit: 'day', labels: [], added: [], removed: [], churn: [], commits: [] };
        this.#put(ck, empty);
        return empty;
      }
      t0 = this.cTs[range.first];
      t1 = this.cTs[range.last] + 1;
    }
    const span = Math.max(1, t1 - t0);
    const unit = span <= 90 * 86400 ? 86400 : span <= 3 * 365 * 86400 ? 7 * 86400 : 30 * 86400;
    const nb = Math.max(1, Math.ceil(span / unit));
    const added = new Array(nb).fill(0);
    const removed = new Array(nb).fill(0);
    const churn = new Array(nb).fill(0);
    const commits = new Array(nb).fill(0);

    const authorSet = gid == null ? null : this.groupSet(gid);
    this.#scan(objId, range, authorSet, (a, r, ci) => {
      const b = Math.min(nb - 1, Math.floor((this.cTs[ci] - t0) / unit));
      added[b] += a;
      removed[b] += r;
      churn[b] += a + r;
    });

    if (range.kind === 'range') {
      for (let ci = range.lo; ci < range.hi; ci++) {
        if (authorSet && !authorSet.has(this.groupOf(this.cAuthor[ci]))) continue;
        const b = Math.min(nb - 1, Math.floor((this.cTs[ci] - t0) / unit));
        commits[b]++;
      }
    } else {
      for (const ci of range.list) {
        if (authorSet && !authorSet.has(this.groupOf(this.cAuthor[ci]))) continue;
        const b = Math.min(nb - 1, Math.floor((this.cTs[ci] - t0) / unit));
        commits[b]++;
      }
    }

    const labels = [];
    for (let b = 0; b < nb; b++) labels.push(new Date((t0 + b * unit) * 1000).toISOString().slice(0, 10));
    const out = { unit: unit === 86400 ? 'day' : unit === 604800 ? 'week' : 'month', labels, added, removed, churn, commits };
    this.#put(ck, out);
    return out;
  }

  hotspots(range, gid = null, type = 'file', limit = 15) {
    const out = [];
    for (let id = 0; id < this.objects.length; id++) {
      const o = this.objects[id];
      if (o.type !== type || o.path === ROOT) continue;
      const m = this.metrics(id, range, gid);
      if (m.churn > 0) out.push({ path: o.path, type: o.type, ...m });
    }
    out.sort((a, b) => b.churn - a.churn);
    return out.slice(0, limit);
  }

  /** Immediate children (files + subdirectories) of a directory, with metrics. */
  childrenMetrics(objId, range, gid = null) {
    const obj = this.objects[objId];
    if (!obj || obj.type !== 'dir') return [];
    const ck = `ch|${objId}|${range.key}|${gid ?? '-'}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;

    const prefix = obj.path === ROOT ? '' : `${obj.path}/`;
    const seen = new Set();
    const out = [];
    for (let id = 0; id < this.objects.length; id++) {
      const o = this.objects[id];
      if (!o.path.startsWith(prefix) || o.path === obj.path) continue;
      const seg = o.path.slice(prefix.length).split('/')[0];
      const childPath = prefix + seg;
      if (seen.has(childPath)) continue;
      seen.add(childPath);
      const childId = this.objectId.get(childPath);
      if (childId === undefined) continue;
      const m = this.metrics(childId, range, gid);
      if (m.churn > 0 || m.modifications > 0) {
        out.push({ path: childPath, name: seg, type: this.objects[childId].type, ...m });
      }
    }
    out.sort((a, b) => b.churn - a.churn);
    this.#put(ck, out);
    return out;
  }

  tree() {
    const root = { name: '/', path: ROOT, type: 'dir', children: [] };
    const dirNodes = new Map([[ROOT, root]]);
    const ensureDir = (p) => {
      const existing = dirNodes.get(p);
      if (existing) return existing;
      const i = p.lastIndexOf('/');
      const parent = ensureDir(i === -1 ? ROOT : p.slice(0, i));
      const node = { name: p.slice(i + 1), path: p, type: 'dir', children: [] };
      parent.children.push(node);
      dirNodes.set(p, node);
      return node;
    };
    for (const o of this.objects) {
      if (o.path === ROOT) continue;
      const i = o.path.lastIndexOf('/');
      const parent = ensureDir(i === -1 ? ROOT : o.path.slice(0, i));
      if (o.type === 'dir') ensureDir(o.path);
      else parent.children.push({ name: o.path.slice(i + 1), path: o.path, type: 'file' });
    }
    const sortRec = (node) => {
      node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      for (const c of node.children) if (c.children) sortRec(c);
    };
    sortRec(root);
    return root;
  }

  commitsInRange(range, gid = null, offset = 0, limit = 100) {
    const authorSet = gid == null ? null : this.groupSet(gid);
    const idx = [];
    if (range.kind === 'range') {
      for (let ci = range.hi - 1; ci >= range.lo; ci--) idx.push(ci);
    } else {
      for (let i = range.list.length - 1; i >= 0; i--) idx.push(range.list[i]);
    }
    const items = [];
    let total = 0;
    for (const ci of idx) {
      if (authorSet && !authorSet.has(this.groupOf(this.cAuthor[ci]))) continue;
      total++;
      if (total > offset && items.length < limit) items.push(this.commitInfo(ci));
    }
    return { total, items };
  }

  commitInfo(ci) {
    const c = this.commits[ci];
    return {
      hash: c.hash,
      ts: c.ts,
      subject: c.subject,
      author: this.authors[this.groupOf(this.cAuthor[ci])]?.name ?? '?',
      churn: this.cChurn[ci],
    };
  }
}
