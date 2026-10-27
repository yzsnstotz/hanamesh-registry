import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

// Schema failure is decided offline, so the CLI can be exercised without network.
test('cli reads the path argument with and without --base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hmreg-cli-'));
  cpSync(join(root, 'tools'), join(dir, 'tools'), { recursive: true });
  cpSync(join(root, 'schema'), join(dir, 'schema'), { recursive: true });
  cpSync(join(root, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  mkdirSync(join(dir, 'plugins'));
  writeFileSync(join(dir, 'plugins', 'acme__bad.json'), JSON.stringify({ id: 'acme/bad' }));
  const git = (...a) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  for (const args of [['plugins/acme__bad.json', '--json'], ['plugins/acme__bad.json', '--base', 'main', '--json'], ['--base', 'main', 'plugins/acme__bad.json']]) {
    const r = spawnSync(process.execPath, ['tools/check-entry.mjs', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verdict, 'reject');
    assert.ok(out.findings.every((f) => f.rule === 'R1'));
  }
});
