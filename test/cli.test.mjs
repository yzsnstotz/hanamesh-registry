import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

// A throwaway registry clone (with a space in its path) holding one entry on main.
function sandbox(files) {
  const dir = join(mkdtempSync(join(tmpdir(), 'hmreg cli-')), 'repo with space');
  mkdirSync(dir);
  for (const d of ['tools', 'schema', 'node_modules']) cpSync(join(root, d), join(dir, d), { recursive: true });
  mkdirSync(join(dir, 'plugins'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, 'plugins', name), JSON.stringify(body));
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  return { dir, git };
}
const cli = (dir, args) => spawnSync(process.execPath, [join(dir, 'tools/check-entry.mjs'), ...args], { cwd: dir, encoding: 'utf8' });

test('cli reads the path argument with and without --base, from a path with spaces', () => {
  const { dir } = sandbox({ 'acme__bad.json': { id: 'acme/bad' } });
  for (const args of [['plugins/acme__bad.json', '--json'], ['plugins/acme__bad.json', '--base', 'main', '--json'], ['--base', 'main', 'plugins/acme__bad.json']]) {
    const r = cli(dir, args);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, 'reject');
    assert.ok(out.findings.every((f) => f.rule === 'R1'));
  }
});

test('cli rejects bad arguments with exit 2', () => {
  const { dir } = sandbox({ 'acme__bad.json': { id: 'acme/bad' } });
  for (const args of [['plugins/acme__bad.json', '--base=main'], ['plugins/acme__bad.json', '--base'], ['plugins/acme__bad.json', '--bogus'], ['other/acme__bad.json'], ['plugins/sub/acme__bad.json'], []]) {
    const r = cli(dir, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '');
  }
});

test('cli --head reads the PR revision and --base supplies previous', () => {
  const listed = { id: '@acme/w', name: 'W', npm: '@acme/w', version: '1.0.0', channels: ['dsh'], categories: [], description: { en: 'W', zh: 'W' }, publisher: { name: 'A' }, sourceUrl: 'https://www.npmjs.com/package/@acme/w', status: 'listed' };
  const { dir, git } = sandbox({ '@acme__w.json': listed });
  git('switch', '-q', '-c', 'pr');
  writeFileSync(join(dir, 'plugins', '@acme__w.json'), JSON.stringify({ ...listed, status: 'delisted' }));
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'delist without reason');
  git('switch', '-q', 'main');
  const r = cli(dir, ['plugins/@acme__w.json', '--head', 'pr', '--base', 'main', '--json']);
  const out = JSON.parse(r.stdout);
  // delisted without delistReason is a schema reject, decided before any network call
  assert.equal(out.verdict, 'reject', r.stderr);
  assert.ok(out.findings.some((f) => f.rule === 'R1' && /delistReason/.test(f.message)));
});

test('cli treats invalid JSON as an R1 reject', () => {
  const { dir, git } = sandbox({});
  writeFileSync(join(dir, 'plugins', 'x.json'), '{not json');
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'bad');
  const r = cli(dir, ['plugins/x.json', '--head', 'main', '--json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].rule, 'R1');
});
