import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEntry } from '../tools/check-entry.mjs';
import { fileNameForId, githubRepoOf } from '../tools/entry.mjs';

const REF = 'a'.repeat(40);

function entry(overrides = {}) {
  return {
    id: '@acme/widget',
    name: 'Widget',
    npm: '@acme/widget',
    repository: 'https://github.com/acme/widget',
    version: '1.0.0',
    channels: ['dsh'],
    categories: ['tools'],
    description: { en: 'Widget.', zh: '小部件。' },
    publisher: { name: 'Acme' },
    sourceUrl: 'https://github.com/acme/widget#readme',
    status: 'listed',
    ...overrides,
  };
}
const without = (e, ...keys) => { const c = { ...e }; for (const k of keys) delete c[k]; return c; };
const agent = (channel = 'claude', over = {}) => ({ channel, marketplaceRepository: 'acme/market', ref: REF, marketplaceUrl: 'https://github.com/acme/market', pluginName: 'widget', ...over });
const marketPath = (channel = 'claude') => `acme/market/${REF}/${channel === 'claude' ? '.claude-plugin' : '.agents/plugins'}/marketplace.json`;

// Fake network: only registry.npmjs.org and raw.githubusercontent.com are reachable.
function fakeFetch({ npm = {}, raw = {} } = {}, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    const u = new URL(url);
    let body;
    if (u.hostname === 'registry.npmjs.org') body = npm[decodeURIComponent(u.pathname.slice(1))];
    else if (u.hostname === 'raw.githubusercontent.com') body = raw[u.pathname.slice(1)];
    else throw new Error(`unexpected host ${u.hostname}`);
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const npmMeta = (over = {}) => ({ name: '@acme/widget', version: '1.0.0', repository: { type: 'git', url: 'git+https://github.com/acme/widget.git' }, ...over });
const verifiedNet = { npm: { '@acme/widget/1.0.0': npmMeta() }, raw: { 'acme/widget/HEAD/package.json': { name: '@acme/widget' } } };

function run(e, { previous = null, others = [], net = verifiedNet, path, seen } = {}) {
  return checkEntry({ path: path ?? `plugins/${fileNameForId(e.id)}`, entry: e, previous, others, fetch: fakeFetch(net, seen) });
}
const rules = (r, level) => r.findings.filter((f) => !level || f.level === level).map((f) => f.rule);

test('fileNameForId maps scope slash', () => {
  assert.equal(fileNameForId('@ai-workbench/workbench'), '@ai-workbench__workbench.json');
  assert.equal(fileNameForId('yzsnstotz/hanamesh-core'), 'yzsnstotz__hanamesh-core.json');
  assert.equal(fileNameForId('chalk'), 'chalk.json');
});

test('unscoped npm package uses its name as id', async () => {
  const e = entry({ id: 'widget', npm: 'widget' });
  const r = await run(e, { net: { npm: { 'widget/1.0.0': npmMeta({ name: 'widget' }) }, raw: { 'acme/widget/HEAD/package.json': { name: 'widget' } } } });
  assert.deepEqual([r.verdict, r.label], ['pass', 'source-verified']);
});

test('passes verified entry', async () => {
  const seen = [];
  const r = await run(entry(), { seen });
  assert.deepEqual(r, { verdict: 'pass', label: 'source-verified', findings: [] });
  assert.ok(seen.every((s) => s.init.redirect === 'error'), 'never follows redirects');
});

test('npm-only entry is unverified', async () => {
  const r = await run(without(entry({ sourceUrl: 'https://www.npmjs.com/package/@acme/widget' }), 'repository'), { net: { npm: { '@acme/widget/1.0.0': npmMeta({ repository: undefined }) } } });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.label, 'unverified');
});

// R1
test('rejects filename mismatch', async () => {
  const r = await run(entry(), { path: 'plugins/other.json' });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R1'));
});

test('rejects nested or non-plugins path', async () => {
  for (const path of ['plugins/sub/@acme__widget.json', 'other/@acme__widget.json']) {
    const r = await run(entry(), { path });
    assert.ok(rules(r, 'error').includes('R1'), path);
  }
});

test('rejects schema violation', async () => {
  const r = await run(entry({ channels: [] }));
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R1'));
});

test('rejects id containing double underscore', async () => {
  const r = await run(entry({ id: 'a__b/c' }), { path: 'plugins/a__b__c.json' });
  assert.ok(rules(r, 'error').includes('R1'));
});

test('rejects duplicate id across files, case-insensitively', async () => {
  const r = await run(entry(), { others: [{ path: 'plugins/x.json', entry: entry({ id: '@ACME/widget', npm: '@acme/other' }) }] });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R1'));
});

test('rejects non-semver versions and dist-tags', async () => {
  for (const version of ['.', 'latest', '1.0', '1.0.0+build.1']) {
    const r = await run(entry({ version }));
    assert.equal(r.verdict, 'reject', version);
    assert.ok(rules(r, 'error').includes('R1'), version);
  }
});

// R2
test('rejects missing npm version', async () => {
  const r = await run(entry({ version: '9.9.9' }));
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R2'));
});

test('rejects case-different npm name', async () => {
  const r = await run(entry(), { net: { ...verifiedNet, npm: { '@acme/widget/1.0.0': npmMeta({ name: '@ACME/widget' }) } } });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R2'));
});

test('rejects npm answer for a different version', async () => {
  const r = await run(entry(), { net: { ...verifiedNet, npm: { '@acme/widget/1.0.0': npmMeta({ version: '2.0.0' }) } } });
  assert.ok(rules(r, 'error').includes('R2'));
});

test('npm network failure escalates instead of rejecting', async () => {
  const r = await checkEntry({ path: 'plugins/@acme__widget.json', entry: entry(), previous: null, others: [], fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.verdict, 'escalate');
});

test('oversized response escalates', async () => {
  const big = JSON.stringify({ name: '@acme/widget', pad: 'x'.repeat(3 * 1024 * 1024) });
  const r = await run(entry(), { net: { ...verifiedNet, npm: { '@acme/widget/1.0.0': big } } });
  assert.equal(r.verdict, 'escalate');
  assert.ok(r.findings.some((f) => f.rule === 'R2' && /over/.test(f.message)));
});

// R3
test('rejects npm already listed by a verified entry', async () => {
  const holder = entry({ id: 'acme/old', review: { reviewedAt: '2026-10-28T00:00:00Z', rulesVersion: '1', label: 'source-verified', notes: '' } });
  const r = await run(entry(), { others: [{ path: 'plugins/acme__old.json', entry: holder }] });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R3'));
});

test('verified newcomer against unverified holder escalates', async () => {
  const holder = entry({ id: 'squatter/widget', review: { reviewedAt: '2026-10-28T00:00:00Z', rulesVersion: '1', label: 'unverified', notes: '' } });
  const r = await run(entry(), { others: [{ path: 'plugins/squatter__widget.json', entry: holder }] });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r).includes('R3'));
});

test('escalates changed npm on existing entry', async () => {
  const r = await run(entry(), { previous: entry({ npm: '@acme/legacy' }) });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r).includes('R3'));
});

test('escalates any non-version field change on an existing entry', async () => {
  const previous = entry();
  const edits = [
    without(entry(), 'repository'),
    entry({ sourceUrl: 'https://evil.example' }),
    entry({ publisher: { name: 'Acme', url: 'https://evil.example' } }),
    entry({ channels: ['dsh', 'hanamesh-client'] }),
  ];
  for (const e of edits) {
    const r = await run(e, { previous });
    assert.equal(r.verdict, 'escalate', JSON.stringify(e));
    assert.ok(rules(r).includes('R3'));
  }
});

test('version bump on an existing entry passes', async () => {
  const net = { ...verifiedNet, npm: { '@acme/widget/1.1.0': npmMeta({ version: '1.1.0' }) } };
  const r = await run(entry({ version: '1.1.0' }), { previous: entry(), net });
  assert.equal(r.verdict, 'pass');
});

// R4
test('rejects hanamesh-client without npm', async () => {
  const r = await run(without(entry({ channels: ['hanamesh-client'] }), 'npm', 'version'));
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R4'));
});

test('rejects claude channel without agentPlugins', async () => {
  const r = await run(entry({ channels: ['dsh', 'claude'] }));
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R4'));
});

test('rejects marketplaceUrl that is not the marketplace repository', async () => {
  const e = entry({ channels: ['dsh', 'claude'], agentPlugins: [agent('claude', { marketplaceUrl: 'https://evil.example/market' })] });
  const r = await run(e, { net: { ...verifiedNet, raw: { ...verifiedNet.raw, [marketPath()]: { plugins: [{ name: 'widget', source: './' }] } } } });
  assert.ok(rules(r, 'error').includes('R4'));
});

test('agent plugin found in marketplace passes', async () => {
  const e = entry({ channels: ['dsh', 'claude'], agentPlugins: [agent()] });
  const net = { ...verifiedNet, raw: { ...verifiedNet.raw, [marketPath()]: { name: 'acme', plugins: [{ name: 'widget', source: { source: 'github', repo: 'acme/widget' } }] } } };
  const r = await run(e, { net });
  assert.equal(r.verdict, 'pass');
});

test('agent plugin missing from marketplace escalates', async () => {
  const e = entry({ channels: ['dsh', 'codex'], agentPlugins: [agent('codex')] });
  const net = { ...verifiedNet, raw: { ...verifiedNet.raw, [marketPath('codex')]: { name: 'acme', plugins: [{ name: 'other', source: './x' }] } } };
  const r = await run(e, { net });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r).includes('R4'));
});

test('npm entry whose marketplace points elsewhere escalates', async () => {
  const e = entry({ channels: ['dsh', 'claude'], agentPlugins: [agent()] });
  const net = { ...verifiedNet, raw: { ...verifiedNet.raw, [marketPath()]: { plugins: [{ name: 'widget', source: { source: 'github', repo: 'acme/elsewhere' } }] } } };
  const r = await run(e, { net });
  assert.equal(r.verdict, 'escalate');
});

// R5 agent-only
const agentOnly = (over = {}) => without(entry({ id: 'acme/widget', channels: ['claude'], agentPlugins: [agent()], ...over }), 'npm', 'version');
const marketWith = (plugin) => ({ raw: { [marketPath()]: { name: 'acme', plugins: [{ name: 'widget', ...plugin }] } } });

test('agent-only entry verified by its own marketplace', async () => {
  const local = await run(agentOnly({ repository: 'https://github.com/acme/market', sourceUrl: 'https://github.com/acme/market' }), { net: marketWith({ source: './plugins/widget' }) });
  assert.equal(local.verdict, 'pass');
  assert.equal(local.label, 'source-verified');
  const sameOwner = await run(agentOnly(), { net: marketWith({ source: { source: 'url', url: 'https://github.com/acme/widget.git' } }) });
  assert.equal(sameOwner.verdict, 'pass');
  assert.equal(sameOwner.label, 'source-verified');
});

test('agent-only entry cannot borrow a famous repository through its own marketplace', async () => {
  const famous = agentOnly({ id: 'famous/project', repository: 'https://github.com/famous/project', sourceUrl: 'https://github.com/famous/project' });
  for (const plugin of [
    { source: { source: 'github', repo: 'famous/project' } },
    { source: { source: 'url', url: 'https://github.com/famous/project.git' } },
    { source: { source: 'archive', url: 'https://evil.example/p.tgz', sha256: 'b'.repeat(64) }, repository: 'https://github.com/famous/project' },
  ]) {
    const r = await run(famous, { net: marketWith(plugin) });
    assert.notEqual(r.label, 'source-verified', JSON.stringify(plugin));
    assert.notEqual(r.verdict, 'pass', JSON.stringify(plugin));
  }
});

test('agent-only entry contradicting its marketplace is rejected', async () => {
  const r = await run(agentOnly(), { net: marketWith({ source: { source: 'github', repo: 'acme/other' } }) });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R5'));
});

test('agent-only plugin missing from marketplace escalates', async () => {
  const r = await run(agentOnly(), { net: { raw: { [marketPath()]: { plugins: [] } } } });
  assert.equal(r.verdict, 'escalate');
  assert.equal(r.label, 'unverified');
});

test('one-way repository match is unverified', async () => {
  const net = { ...verifiedNet, raw: { 'acme/widget/HEAD/package.json': { name: '@acme/something-else' } } };
  const r = await run(entry(), { net });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.label, 'unverified');
});

// R6
test('install script escalates with quoted, truncated text', async () => {
  const net = { ...verifiedNet, npm: { '@acme/widget/1.0.0': npmMeta({ scripts: { postinstall: 'node x.js ' + 'y'.repeat(500) } }) } };
  const r = await run(entry(), { net });
  assert.equal(r.verdict, 'escalate');
  const f = r.findings.find((x) => x.rule === 'R6');
  assert.equal(f.level, 'info');
  assert.ok(f.message.length < 260);
});

// R7
test('author review is ignored with warn, even when malformed', async () => {
  for (const review of [{ reviewedAt: '2026-10-28T00:00:00Z', rulesVersion: '1', label: 'source-verified', notes: 'trust me' }, { label: 'source-verified', extra: true }]) {
    const r = await run(entry({ review }), { net: { npm: { '@acme/widget/1.0.0': npmMeta({ repository: undefined }) } } });
    assert.ok(rules(r, 'warn').includes('R7'));
    assert.equal(r.label, 'unverified');
    assert.equal(r.verdict, 'pass');
  }
});

test('carried-over review from base is not flagged', async () => {
  const review = { reviewedAt: '2026-10-28T00:00:00Z', rulesVersion: '1', label: 'source-verified', notes: 'initial migration' };
  const r = await run(entry({ review }), { previous: entry({ review }) });
  assert.ok(!rules(r).includes('R7'));
  assert.equal(r.verdict, 'pass');
});

// R8
test('status change escalates', async () => {
  const r = await run(entry(), { previous: entry({ status: 'delisted', delistReason: 'spam' }) });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r).includes('R8'));
});

// R9
test('new entry identity and presentation go to the owner', async () => {
  const cases = [
    entry({ id: 'acme/widget' }),
    entry({ id: '@hanamesh/widget', npm: '@hanamesh/widget' }),
    entry({ categories: ['hanamesh-plugin'] }),
    entry({ sourceUrl: 'https://evil.example' }),
    entry({ publisher: { name: 'Anthropic', url: 'https://evil.example' } }),
  ];
  for (const e of cases) {
    const npm = e.npm === '@acme/widget' ? verifiedNet.npm : { [`${e.npm}/1.0.0`]: npmMeta({ name: e.npm }) };
    const r = await run(e, { net: { ...verifiedNet, npm } });
    assert.equal(r.verdict, 'escalate', JSON.stringify(e));
    assert.ok(rules(r).includes('R9'), JSON.stringify(e));
  }
});

test('legacy entry rechecked against itself raises no identity findings', async () => {
  const legacy = entry({ id: 'yzsnstotz/widget', categories: ['hanamesh-plugin'], publisher: { name: 'HanaMesh', url: 'https://hanamesh.com' } });
  const r = await run(legacy, { previous: legacy });
  assert.equal(r.verdict, 'pass');
});

test('githubRepoOf accepts npm and marketplace forms', () => {
  for (const v of ['git+https://github.com/Acme/Widget.git', 'https://github.com/acme/widget', 'github:acme/widget', 'acme/widget', 'git@github.com:acme/widget.git', { url: 'git://github.com/acme/widget.git' }]) {
    assert.equal(githubRepoOf(v), 'acme/widget', JSON.stringify(v));
  }
  for (const v of [null, 'https://gitlab.com/acme/widget', 'https://github.com/acme', 'file:../widget', 'https://github.com/acme/..', 'acme/.', 'acme/.git']) {
    assert.equal(githubRepoOf(v), null, JSON.stringify(v));
  }
});
