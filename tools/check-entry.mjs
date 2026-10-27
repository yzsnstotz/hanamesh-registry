#!/usr/bin/env node
// Deterministic basic checks R1-R8 for one registry entry. Network goes only to
// registry.npmjs.org and raw.githubusercontent.com (no GitHub REST quota).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileNameForId, githubRepoOf, validateShape } from './entry.mjs';

const TIMEOUT_MS = 20_000;
const MARKETPLACE_PATH = { claude: '.claude-plugin/marketplace.json', codex: '.agents/plugins/marketplace.json' };

class NetworkError extends Error {}

async function getJson(fetchImpl, url) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new NetworkError(`${url}: ${e?.cause?.message ?? e?.message ?? e}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new NetworkError(`${url}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new NetworkError(`${url}: invalid JSON`);
  }
}

function npmUrl(name, version) {
  const encoded = name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
  return `https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`;
}

function marketplaceSourceRepo(plugin, marketplaceRepository) {
  const s = plugin.source;
  if (typeof s === 'string' || s?.source === 'local') return marketplaceRepository.toLowerCase();
  if (s?.source === 'github') return githubRepoOf(s.repo);
  if (s?.source === 'url' || s?.source === 'git-subdir') return githubRepoOf(s.url);
  if (s?.source === 'archive') return githubRepoOf(plugin.repository);
  return null;
}

export async function checkEntry({ path, entry, previous = null, others = [], fetch: fetchImpl = globalThis.fetch }) {
  const findings = [];
  const add = (rule, level, message, action) => findings.push({ rule, level, message, ...(action ? { action } : {}) });
  const reject = (rule, message) => add(rule, 'error', message, 'reject');
  const escalate = (rule, message, level = 'warn') => add(rule, level, message, 'escalate');
  let label = 'unverified';
  const finish = () => ({
    verdict: findings.some((f) => f.action === 'reject') ? 'reject' : findings.some((f) => f.action === 'escalate') ? 'escalate' : 'pass',
    label,
    findings,
  });

  // R1 shape, file name, unique id
  const shapeErrors = validateShape(entry);
  for (const message of shapeErrors) reject('R1', message);
  if (shapeErrors.length) return finish();
  if (basename(path) !== fileNameForId(entry.id) || !path.startsWith('plugins/')) reject('R1', `file must be plugins/${fileNameForId(entry.id)}`);
  if (others.some((o) => o.entry?.id === entry.id)) reject('R1', `id ${entry.id} is already used by another file`);

  // R7 review is written only by the review skill
  if (entry.review !== undefined && !isDeepStrictEqual(entry.review, previous?.review)) add('R7', 'warn', 'review is written by the reviewer; the submitted value is ignored');

  // R8 listing status changes go to the owner
  if (previous && previous.status !== entry.status) escalate('R8', `status changed ${previous.status} -> ${entry.status}`);

  // R3 npm uniqueness; identity changes on an existing entry
  if (entry.npm && others.some((o) => o.entry?.npm === entry.npm)) reject('R3', `npm ${entry.npm} is already listed`);
  if (previous && (previous.id !== entry.id || previous.npm !== entry.npm)) escalate('R3', 'id or npm changed on an existing entry');

  // R4 channel constraints
  const channels = new Set(entry.channels);
  if (channels.has('hanamesh-client') && !entry.npm) reject('R4', 'hanamesh-client requires npm');
  if (channels.has('dsh') && !entry.npm) reject('R4', 'dsh requires npm');
  const agentPlugins = entry.agentPlugins ?? [];
  for (const ch of ['claude', 'codex']) {
    if (channels.has(ch) && !agentPlugins.some((a) => a.channel === ch)) reject('R4', `${ch} channel requires an agentPlugins item`);
  }
  for (const a of agentPlugins) if (!channels.has(a.channel)) reject('R4', `agentPlugins item for undeclared channel ${a.channel}`);

  const entryRepo = entry.repository ? githubRepoOf(entry.repository) : null;

  // R4 marketplace lookup (also feeds R5 for agent-only entries)
  const agentRepoMatches = [];
  for (const a of agentPlugins) {
    const url = `https://raw.githubusercontent.com/${a.marketplaceRepository}/${a.ref}/${MARKETPLACE_PATH[a.channel]}`;
    try {
      const market = await getJson(fetchImpl, url);
      const plugin = Array.isArray(market?.plugins) ? market.plugins.find((p) => p?.name === a.pluginName) : undefined;
      if (!plugin) { escalate('R4', `${a.channel}: plugin ${a.pluginName} not found in ${a.marketplaceRepository}@${a.ref}`); agentRepoMatches.push(false); continue; }
      const sourceRepo = marketplaceSourceRepo(plugin, a.marketplaceRepository);
      const matches = sourceRepo !== null && sourceRepo === entryRepo;
      agentRepoMatches.push(matches);
      if (!matches && entry.npm) add('R4', 'warn', `${a.channel}: marketplace source ${sourceRepo ?? 'unknown'} differs from repository; this channel will not be attached`);
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      escalate('R4', `${a.channel}: marketplace unreachable (${e.message})`);
      agentRepoMatches.push(null);
    }
  }

  if (!entry.npm) {
    // R5 agent-only: every declared marketplace must point at the entry repository
    if (agentRepoMatches.length && agentRepoMatches.every((m) => m === true)) label = 'source-verified';
    else if (agentRepoMatches.some((m) => m === false)) reject('R5', 'agent-only entries must be source-verified: marketplace source repository differs from repository');
    return finish();
  }

  // R2 npm package and version exist with the exact name
  let meta;
  try {
    meta = await getJson(fetchImpl, npmUrl(entry.npm, entry.version));
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    escalate('R2', `npm unreachable (${e.message})`);
    return finish();
  }
  if (!meta || typeof meta !== 'object') { reject('R2', `${entry.npm}@${entry.version} not found on npm`); return finish(); }
  if (meta.name !== entry.npm) { reject('R2', `npm returned name ${JSON.stringify(meta.name)}, expected ${JSON.stringify(entry.npm)}`); return finish(); }

  // R6 install scripts
  const scripts = meta.scripts && typeof meta.scripts === 'object' ? meta.scripts : {};
  const hooks = ['preinstall', 'install', 'postinstall'].filter((k) => typeof scripts[k] === 'string');
  if (hooks.length) escalate('R6', `install scripts: ${hooks.map((k) => `${k}=${JSON.stringify(scripts[k])}`).join(', ')}`, 'info');

  // R5 two-way repository check decides the label only
  const npmRepo = githubRepoOf(meta.repository);
  if (entryRepo && npmRepo === entryRepo) {
    try {
      const pkg = await getJson(fetchImpl, `https://raw.githubusercontent.com/${entryRepo}/HEAD/package.json`);
      if (pkg?.name === entry.npm) label = 'source-verified';
      else add('R5', 'info', `repository package.json name is ${JSON.stringify(pkg?.name ?? null)}, expected ${JSON.stringify(entry.npm)}`);
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      escalate('R5', `repository unreachable (${e.message})`);
    }
  } else {
    add('R5', 'info', entryRepo ? `npm repository is ${npmRepo ?? 'missing'}, entry says ${entryRepo}` : 'no repository declared');
  }
  return finish();
}

function readEntriesAt(ref) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const names = git('ls-tree', '--name-only', `${ref}:plugins/`).split('\n').filter((n) => n.endsWith('.json'));
  return names.map((n) => ({ path: `plugins/${n}`, entry: JSON.parse(git('show', `${ref}:plugins/${n}`)) }));
}

export function readWorkingEntries(dir = 'plugins') {
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => ({ path: `plugins/${n}`, entry: JSON.parse(readFileSync(join(dir, n), 'utf8')) }));
}

async function main(argv) {
  const baseIdx = argv.indexOf('--base');
  const path = argv.find((a, i) => !a.startsWith('--') && (baseIdx < 0 || i !== baseIdx + 1));
  if (!path) { console.error('usage: check-entry.mjs plugins/<file>.json [--base <git-ref>] --json'); process.exit(2); }
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  const rel = `plugins/${basename(path)}`;
  const pool = baseIdx >= 0 ? readEntriesAt(argv[baseIdx + 1]) : readWorkingEntries();
  const previous = baseIdx >= 0 ? pool.find((o) => o.path === rel)?.entry ?? null : null;
  const result = await checkEntry({ path: rel, entry, previous, others: pool.filter((o) => o.path !== rel) });
  console.log(JSON.stringify(result, null, argv.includes('--json') ? 0 : 2));
  process.exitCode = result.verdict === 'reject' ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
