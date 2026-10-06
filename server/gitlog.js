import { spawn } from 'node:child_process';

/** Run a git command against a repository directory, resolve stdout as string. */
export function runGit(repoDir, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', repoDir, ...args], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${err.trim()}`));
    });
  });
}

export async function countCommits(repoDir, ref = 'HEAD') {
  const out = await runGit(repoDir, ['rev-list', '--count', '--no-merges', ref]);
  return parseInt(out.trim(), 10) || 0;
}

const HASH_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Single streaming pass over the whole history:
 *   git log --no-merges -z --numstat -M50%
 *
 * Wire format verified empirically (byte-level) against git 2.43:
 *  - the stream is a sequence of NUL-separated tokens
 *  - commit header = hash, author name, author email, subject, committer ts
 *    (name/email are mailmap-applied because we ask for %aN/%aE)
 *  - entries: `added\tremoved\tpath`; binary: `-\t-\tpath` (not measured)
 *  - rename entry: `added\tremoved\t` (trailing tab) followed by the old path
 *    and the new path as separate tokens. A pure rename is `0\t0\t` and must not
 *    change any metric; edits on a rename are emitted as a regular entry at the
 *    new path by git's 50% rename detection.
 *  - the first entry token of each record carries a stray leading newline
 */
export function parseLog(repoDir, ref = 'HEAD', { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const format = '%x00%H%x00%aN%x00%aE%x00%s%x00%ct';
    const proc = spawn('git', [
      '-C', repoDir, 'log', '--no-merges', '-z', '--numstat', '-M50%',
      `--format=${format}`, ref,
    ]);
    const commits = [];
    const stats = { binaries: 0, renames: 0, ignored: 0 };

    let buf = '';
    let cur = null;
    let state = 'scan'; // scan -> name -> email -> subject -> ts -> scan
    let rename = null; // { added, removed, paths: [] } consuming rename path tokens

    function startCommit() {
      cur = { hash: '', name: '', email: '', subject: '', ts: 0, entries: [] };
    }

    function feed(rawToken) {
      // Rename continuation has priority: the next two tokens are raw paths.
      if (rename) {
        rename.paths.push(rawToken);
        if (rename.paths.length === 2) {
          stats.renames++;
          if (rename.binary) {
            stats.binaries++;
          } else {
            // A rename changes no lines: register the old path too (it stays
            // addressable, with zero metrics) and give the new path the
            // edit counts of the rename pair, if any.
            cur.entries.push({ path: rename.paths[0], added: 0, removed: 0 });
            cur.entries.push({ path: rename.paths[1], added: rename.added, removed: rename.removed });
          }
          rename = null;
        }
        return;
      }
      if (state === 'name') { cur.name = rawToken; state = 'email'; return; }
      if (state === 'email') { cur.email = rawToken; state = 'subject'; return; }
      if (state === 'subject') { cur.subject = rawToken.replace(/^\n/, ''); state = 'ts'; return; }
      if (state === 'ts') { cur.ts = parseInt(rawToken, 10) || 0; state = 'scan'; return; }

      const token = rawToken.startsWith('\n') ? rawToken.slice(1) : rawToken;
      if (token === '') return; // record markers / separators
      if (HASH_RE.test(token)) {
        // Entries always follow their own header, so the previous commit is
        // complete only once the next hash appears.
        if (cur) commits.push(cur);
        startCommit();
        cur.hash = token;
        state = 'name';
        return;
      }

      // numstat entry
      const tab1 = token.indexOf('\t');
      if (tab1 === -1) { stats.ignored++; return; }
      const addedStr = token.slice(0, tab1);
      const rest = token.slice(tab1 + 1);
      const tab2 = rest.indexOf('\t');
      const removedStr = tab2 === -1 ? rest : rest.slice(0, tab2);
      const path = tab2 === -1 ? '' : rest.slice(tab2 + 1);
      const binary = addedStr === '-' || removedStr === '-';

      if (path === '') { // rename prefix: next two tokens are old/new paths
        rename = {
          added: binary ? -1 : parseInt(addedStr, 10) || 0,
          removed: binary ? -1 : parseInt(removedStr, 10) || 0,
          paths: [],
          binary,
        };
        return;
      }
      if (binary) { stats.binaries++; return; }
      const added = parseInt(addedStr, 10);
      const removed = parseInt(removedStr, 10);
      // Zero-line entries (empty file add, mode-only change) still register the
      // object in the tree; they simply contribute nothing to any metric.
      cur.entries.push({ path, added: added || 0, removed: removed || 0 });
    }

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\0')) !== -1) {
        feed(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
      if (onProgress) onProgress(commits.length);
    });

    let err = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git log failed (${code}): ${err.trim()}`));
      if (buf.length) feed(buf);
      if (cur) commits.push(cur);
      if (onProgress) onProgress(commits.length); // make sure progress reaches 100%
      resolve({ commits, stats });
    });
  });
}
