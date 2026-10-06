// Builds a tiny deterministic repository used to verify the metric engine.
// Layout of the scripted history (merge commit must be excluded from metrics):
//
//   c1  Alice  +.mailmap(1) +root.txt(2) +foo/bar.txt(3) +bin.dat(binary, not measured)
//   c2  Alice  foo/bar.txt  +1 -1
//   c3  Bob    rename foo/bar.txt -> foo/baz.txt  (pure, 0/0, changes nothing)
//   c4  Bob    foo/baz.txt  +1 -0
//   c5  Alice  delete root.txt      -2
//   c6  Alice  +foo/sub/deep.txt(5)
//   c7  Bob    (branch) foo/baz.txt +1 -1
//   c8  Alice  (main)   foo/sub/deep.txt +2 -2
//   c9  merge --no-ff  (ignored)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASE_TS = 1700000000; // 2023-11-14T22:13:20Z, one day per commit index

const DAY = 86400;
const ALICE = { name: 'Alice Author', email: 'alice@x.io' };
const BOB = { name: 'Bob B', email: 'bob2@x.io' }; // raw email; .mailmap canonicalises it

export function buildFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const run = (args, env = {}) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env } });
  const commit = (dayIndex, message, who) => {
    const iso = new Date((BASE_TS + dayIndex * DAY) * 1000).toISOString();
    run(['add', '-A']);
    run(['commit', '-qm', message], {
      GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
      GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
    });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  };
  const write = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  run(['init', '-q', '-b', 'main']);

  const hashes = {};

  write('.mailmap', 'Bob <bob@x.io> <bob2@x.io>\n');
  write('root.txt', 'r1\nr2\n');
  write('foo/bar.txt', '1\n2\n3\n');
  write('bin.dat', Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x07]));
  hashes.c1 = commit(0, 'c1', ALICE);

  write('foo/bar.txt', '1\nX\n3\n');
  hashes.c2 = commit(1, 'c2', ALICE);

  run(['mv', 'foo/bar.txt', 'foo/baz.txt']);
  hashes.c3 = commit(2, 'c3', BOB);

  write('foo/baz.txt', '1\nX\n3\n4\n');
  hashes.c4 = commit(3, 'c4', BOB);

  fs.rmSync(path.join(dir, 'root.txt'));
  hashes.c5 = commit(4, 'c5', ALICE);

  write('foo/sub/deep.txt', 'd1\nd2\nd3\nd4\nd5\n');
  hashes.c6 = commit(5, 'c6', ALICE);

  run(['checkout', '-q', '-b', 'feature']);
  write('foo/baz.txt', '1\nY\n3\n4\n');
  hashes.c7 = commit(6, 'c7', BOB);

  run(['checkout', '-q', 'main']);
  write('foo/sub/deep.txt', 'd1\nD2\nd3\nD4\nd5\n');
  hashes.c8 = commit(7, 'c8', ALICE);

  const mergeIso = new Date((BASE_TS + 8 * DAY) * 1000).toISOString();
  run(['merge', '-q', '--no-ff', '-m', 'c9-merge', 'feature'], {
    GIT_AUTHOR_NAME: BOB.name, GIT_AUTHOR_EMAIL: BOB.email,
    GIT_COMMITTER_NAME: BOB.name, GIT_COMMITTER_EMAIL: BOB.email,
    GIT_AUTHOR_DATE: mergeIso, GIT_COMMITTER_DATE: mergeIso,
  });
  hashes.c9 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  return { dir, hashes };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'fixture');
  const { hashes } = buildFixture(dir);
  console.log(`fixture built at ${dir}`);
  console.log(hashes);
}
