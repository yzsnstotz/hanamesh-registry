import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEntry } from '../tools/check-entry.mjs';
import { fileNameForId } from '../tools/entry.mjs';

const REF = 'a'.repeat(40);

function entry(overrides = {}) {
  return {
    id: 'acme/widget',
    name: 'Widget',
    npm: '@acme/widget',
    repository: 'https://github.com/acme/widget',
    version: '1.0.0',
    channels: ['dsh'],
    categories: ['hanamesh-plugin'],
    description: { en: 'Widget.', zh: '小部件。' },
    publisher: { name: 'Acme' },
    sourceUrl: 'https://github.com/acme/widget#readme',
    status: 'listed',
    ...overrides,
  };
}

// Fake network: only registry.npmjs.org and raw.githubusercontent.com are reachable.
function fakeFetch({ npm = {}, raw = {} } = {}) {
  return async (url) => {
    const u = new URL(url);
    let body;
    if (u.hostname === 'registry.npmjs.org') body = npm[decodeURIComponent(u.pathname.slice(1))];
    else if (u.hostname === 'raw.githubusercontent.com') body = raw[u.pathname.slice(1)];
    else throw new Error(`unexpected host ${u.hostname}`);
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const verifiedNet = {
  npm: { '@acme/widget/1.0.0': { name: '@acme/widget', version: '1.0.0', repository: { type: 'git', url: 'git+https://github.com/acme/widget.git' } } },
  raw: { 'acme/widget/HEAD/package.json': { name: '@acme/widget' } },
};

function run(e, { previous = null, others = [], net = verifiedNet, path } = {}) {
  return checkEntry({ path: path ?? `plugins/${fileNameForId(e.id)}`, entry: e, previous, others, fetch: fakeFetch(net) });
}
const rules = (r, level) => r.findings.filter((f) => !level || f.level === level).map((f) => f.rule);

test('fileNameForId maps scope slash', () => {
  assert.equal(fileNameForId('@ai-workbench/workbench'), '@ai-workbench__workbench.json');
  assert.equal(fileNameForId('yzsnstotz/hanamesh-core'), 'yzsnstotz__hanamesh-core.json');
});

test('passes verified entry', async () => {
  const r = await run(entry());
  assert.equal(r.verdict, 'pass');
  assert.equal(r.label, 'source-verified');
});

test('npm-only entry is unverified', async () => {
  const e = entry({ repository: undefined });
  delete e.repository;
  const r = await run(e, { net: { npm: { '@acme/widget/1.0.0': { name: '@acme/widget' } } } });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.label, 'unverified');
});

test('rejects filename mismatch', async () => {
  const r = await run(entry(), { path: 'plugins/other.json' });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R1'));
});

test('rejects schema violation', async () => {
  const r = await run(entry({ channels: [] }));
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R1'));
});

test('rejects duplicate id across files', async () => {
  const r = await run(entry(), { others: [{ path: 'plugins/x.json', entry: entry({ npm: '@acme/other' }) }] });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R1'));
});

test('rejects missing npm version', async () => {
  const r = await run(entry({ version: '9.9.9' }));
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R2'));
});

test('rejects case-different npm name', async () => {
  const r = await run(entry(), { net: { ...verifiedNet, npm: { '@acme/widget/1.0.0': { name: '@ACME/widget' } } } });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R2'));
});

test('npm network failure escalates instead of rejecting', async () => {
  const r = await checkEntry({ path: 'plugins/acme__widget.json', entry: entry(), previous: null, others: [], fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(r.verdict, 'escalate');
});

test('rejects npm already listed', async () => {
  const r = await run(entry(), { others: [{ path: 'plugins/acme__old.json', entry: entry({ id: 'acme/old' }) }] });
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R3'));
});

test('escalates changed npm on existing entry', async () => {
  const r = await run(entry(), { previous: entry({ npm: '@acme/legacy' }) });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r).includes('R3'));
});

test('rejects hanamesh-client without npm', async () => {
  const e = entry({ channels: ['hanamesh-client'] });
  delete e.npm; delete e.version;
  const r = await run(e);
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R4'));
});

test('rejects claude channel without agentPlugins', async () => {
  const r = await run(entry({ channels: ['dsh', 'claude'] }));
  assert.equal(r.verdict, 'reject');
  assert.ok(rules(r, 'error').includes('R4'));
});

test('agent plugin found in marketplace passes', async () => {
  const e = entry({ channels: ['dsh', 'claude'], agentPlugins: [{ channel: 'claude', marketplaceRepository: 'acme/market', ref: REF, marketplaceUrl: 'https://github.com/acme/market', pluginName: 'widget' }] });
  const net = { ...verifiedNet, raw: { ...verifiedNet.raw, [`acme/market/${REF}/.claude-plugin/marketplace.json`]: { name: 'acme', plugins: [{ name: 'widget', source: { source: 'github', repo: 'acme/widget' } }] } } };
  const r = await run(e, { net });
  assert.equal(r.verdict, 'pass');
});

test('agent plugin missing from marketplace escalates', async () => {
  const e = entry({ channels: ['dsh', 'codex'], agentPlugins: [{ channel: 'codex', marketplaceRepository: 'acme/market', ref: REF, marketplaceUrl: 'https://github.com/acme/market', pluginName: 'widget' }] });
  const net = { ...verifiedNet, raw: { ...verifiedNet.raw, [`acme/market/${REF}/.agents/plugins/marketplace.json`]: { name: 'acme', plugins: [{ name: 'other', source: './x' }] } } };
  const r = await run(e, { net });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r).includes('R4'));
});

test('agent-only entry verified by marketplace source repo', async () => {
  const e = entry({ channels: ['claude'], agentPlugins: [{ channel: 'claude', marketplaceRepository: 'acme/market', ref: REF, marketplaceUrl: 'https://github.com/acme/market', pluginName: 'widget' }] });
  delete e.npm; delete e.version;
  const market = (repo) => ({ raw: { [`acme/market/${REF}/.claude-plugin/marketplace.json`]: { name: 'acme', plugins: [{ name: 'widget', source: { source: 'url', url: `https://github.com/${repo}.git` } }] } } });
  const ok = await run(e, { net: market('acme/widget') });
  assert.equal(ok.verdict, 'pass');
  assert.equal(ok.label, 'source-verified');
  const bad = await run(e, { net: market('famous/project') });
  assert.equal(bad.verdict, 'reject');
  assert.equal(bad.label, 'unverified');
  assert.ok(rules(bad, 'error').includes('R5'));
});

test('one-way repository match is unverified', async () => {
  const net = { ...verifiedNet, raw: { 'acme/widget/HEAD/package.json': { name: '@acme/something-else' } } };
  const r = await run(entry(), { net });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.label, 'unverified');
});

test('install script escalates', async () => {
  const net = { ...verifiedNet, npm: { '@acme/widget/1.0.0': { ...verifiedNet.npm['@acme/widget/1.0.0'], scripts: { postinstall: 'node x.js' } } } };
  const r = await run(entry(), { net });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r, 'info').includes('R6'));
});

test('author review is ignored with warn', async () => {
  const r = await run(entry({ review: { reviewedAt: '2026-10-28T00:00:00Z', rulesVersion: '1', label: 'source-verified', notes: 'trust me' } }), { net: { npm: { '@acme/widget/1.0.0': { name: '@acme/widget' } } } });
  assert.ok(rules(r, 'warn').includes('R7'));
  assert.equal(r.label, 'unverified');
  assert.equal(r.verdict, 'pass');
});

test('carried-over review from base is not flagged', async () => {
  const review = { reviewedAt: '2026-10-28T00:00:00Z', rulesVersion: '1', label: 'source-verified', notes: 'initial migration' };
  const r = await run(entry({ review, version: '1.0.0' }), { previous: entry({ review }) });
  assert.ok(!rules(r).includes('R7'));
});

test('status change escalates', async () => {
  const r = await run(entry(), { previous: entry({ status: 'delisted', delistReason: 'spam' }) });
  assert.equal(r.verdict, 'escalate');
  assert.ok(rules(r).includes('R8'));
});

test('githubRepoOf accepts npm and marketplace forms', async () => {
  const { githubRepoOf } = await import('../tools/entry.mjs');
  for (const v of ['git+https://github.com/Acme/Widget.git', 'https://github.com/acme/widget', 'github:acme/widget', 'acme/widget', 'git@github.com:acme/widget.git', { url: 'git://github.com/acme/widget.git' }]) {
    assert.equal(githubRepoOf(v), 'acme/widget', JSON.stringify(v));
  }
  for (const v of [null, 'https://gitlab.com/acme/widget', 'https://github.com/acme', 'file:../widget']) assert.equal(githubRepoOf(v), null, JSON.stringify(v));
});
