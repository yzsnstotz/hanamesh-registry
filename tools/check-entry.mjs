#!/usr/bin/env node
// Deterministic basic checks R1-R9 for one registry entry. Network goes only to
// registry.npmjs.org and raw.githubusercontent.com (no GitHub REST quota), never follows
// redirects, and reads at most MAX_BYTES per response.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { fileNameForId, githubRepoOf, validateShape } from './entry.mjs';

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['registry.npmjs.org', 'raw.githubusercontent.com']);
const MARKETPLACE_PATH = { claude: '.claude-plugin/marketplace.json', codex: '.agents/plugins/marketplace.json' };
// Namespaces and categories that only HanaMesh's own entries use; new entries using them go to the owner.
const RESERVED_PREFIXES = ['yzsnstotz/', '@hanamesh/', '@ai-workbench/'];
const RESERVED_CATEGORIES = new Set(['hanamesh-plugin', 'hanamesh-app']);
// Fields an existing entry may change without owner review (status/delistReason are R8).
// version may only move forward; review is R7; status (with delistReason) is R8.
const FREE_FIELDS = new Set(['version', 'latestVersion', 'review', 'status']);

class NetworkError extends Error {}

// Untrusted text (from npm or a marketplace) quoted and truncated before it reaches comments or prompts.
const q = (value) => (value == null ? 'null' : JSON.stringify(String(value).slice(0, 200)));
const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Semver precedence (no build metadata; the schema forbids it). Returns <0, 0, >0.
export function compareSemver(a, b) {
  const split = (v) => { const [core, pre] = v.split(/-(.*)/s); return [core.split('.').map(Number), pre === undefined ? null : pre.split('.')]; };
  const [ca, pa] = split(a);
  const [cb, pb] = split(b);
  for (let i = 0; i < 3; i += 1) if (ca[i] !== cb[i]) return ca[i] - cb[i];
  if (pa === null || pb === null) return (pa === null) - (pb === null);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}
const owner = (repo) => repo?.split('/')[0] ?? null;

async function getJson(fetchImpl, url) {
  if (!ALLOWED_HOSTS.has(new URL(url).hostname)) throw new Error(`host not allowed: ${url}`);
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new NetworkError(`${url}: ${e?.cause?.message ?? e?.message ?? e}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new NetworkError(`${url}: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new NetworkError(`${url}: response over ${MAX_BYTES} bytes`);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new NetworkError(`${url}: response over ${MAX_BYTES} bytes`);
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof NetworkError) throw e;
    throw new NetworkError(`${url}: ${e?.message ?? e}`);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new NetworkError(`${url}: invalid JSON`);
  }
}

function npmUrl(name, version) {
  const encoded = name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
  return `https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`;
}

// Where a marketplace says the plugin's source lives, and whether that claim can be trusted.
// A marketplace can only vouch for its own repository or one under the same GitHub owner.
function marketplaceSource(plugin, marketplaceRepository) {
  const market = marketplaceRepository.toLowerCase();
  const s = plugin.source;
  if (typeof s === 'string' || s?.source === 'local') return { repo: market, trusted: true };
  if (s?.source === 'archive') return { repo: null, trusted: false, why: 'archive sources cannot be verified' };
  const repo = s?.source === 'github' ? githubRepoOf(s.repo) : s?.source === 'url' || s?.source === 'git-subdir' ? githubRepoOf(s.url) : null;
  if (!repo) return { repo: null, trusted: false, why: 'source is not a GitHub repository' };
  if (owner(repo) !== owner(market)) return { repo, trusted: false, why: `marketplace ${market} does not share an owner with ${repo}` };
  return { repo, trusted: true };
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

  // R7 review is written only by the review skill; it is ignored, never validated.
  if (entry && typeof entry === 'object' && entry.review !== undefined) {
    if (!isDeepStrictEqual(entry.review, previous?.review)) add('R7', 'warn', 'review is written by the reviewer; the submitted value is ignored');
    entry = { ...entry };
    delete entry.review;
  }

  // R1 shape, path, unique id
  const shapeErrors = validateShape(entry);
  for (const message of shapeErrors) reject('R1', message);
  if (shapeErrors.length) return finish();
  if (path !== `plugins/${fileNameForId(entry.id)}`) reject('R1', `file must be plugins/${fileNameForId(entry.id)}`);
  if (others.some((o) => o.entry?.id?.toLowerCase() === entry.id.toLowerCase())) reject('R1', `id ${entry.id} is already used by another file`);

  // R8 listing status changes go to the owner
  if (previous && previous.status !== entry.status) escalate('R8', `status changed ${previous.status} -> ${entry.status}`);

  // R3 an existing entry may only move its version without owner review
  if (previous) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(entry)]);
    const changed = [...keys].filter((k) => !FREE_FIELDS.has(k) && !isDeepStrictEqual(previous[k], entry[k]));
    if (changed.length) escalate('R3', `existing entry changed: ${changed.join(', ')}`);
    if (previous.version && entry.version && compareSemver(entry.version, previous.version) < 0) escalate('R3', `version moved back ${previous.version} -> ${entry.version}`);
  }

  const entryRepo = entry.repository ? githubRepoOf(entry.repository) : null;

  // R9 identity and presentation of a new entry
  if (!previous) {
    if (entry.npm && entry.id !== entry.npm) escalate('R9', `new entries use the npm name as id (expected ${q(entry.npm)})`);
    if (!entry.npm && owner(entry.id.toLowerCase()) !== owner(entryRepo)) escalate('R9', 'agent-only id must start with the repository owner');
    if (RESERVED_PREFIXES.some((p) => entry.id.toLowerCase().startsWith(p) || entry.npm?.toLowerCase().startsWith(p))) escalate('R9', 'reserved HanaMesh namespace');
    const reserved = entry.categories.filter((c) => RESERVED_CATEGORIES.has(c));
    if (reserved.length) escalate('R9', `reserved categories: ${reserved.join(', ')}`);
    const allowed = [entryRepo && `https://github.com/${entryRepo}`, entry.npm && `https://www.npmjs.com/package/${entry.npm}`].filter(Boolean);
    const onAllowed = (url) => allowed.some((a) => url.toLowerCase() === a.toLowerCase() || url.toLowerCase().startsWith(`${a.toLowerCase()}/`) || url.toLowerCase().startsWith(`${a.toLowerCase()}#`));
    if (!onAllowed(entry.sourceUrl)) escalate('R9', 'sourceUrl must point at the repository or the npm package page');
    const claimants = [owner(entryRepo), entry.npm?.startsWith('@') ? entry.npm.slice(1).split('/')[0] : null].filter(Boolean).map(norm);
    if (!claimants.some((c) => c && norm(entry.publisher.name).includes(c))) escalate('R9', `publisher.name ${q(entry.publisher.name)} does not name the repository owner or npm scope`);
    if (entry.publisher.url && !(entryRepo && entry.publisher.url.toLowerCase().replace(/\/$/, '') === `https://github.com/${owner(entryRepo)}`)) escalate('R9', 'publisher.url must be the repository owner on GitHub');
  }

  // R4 channel constraints
  const channels = new Set(entry.channels);
  if (channels.has('hanamesh-client') && !entry.npm) reject('R4', 'hanamesh-client requires npm');
  if (channels.has('dsh') && !entry.npm) reject('R4', 'dsh requires npm');
  const agentPlugins = entry.agentPlugins ?? [];
  for (const ch of ['claude', 'codex']) {
    if (channels.has(ch) && !agentPlugins.some((a) => a.channel === ch)) reject('R4', `${ch} channel requires an agentPlugins item`);
  }
  for (const a of agentPlugins) {
    if (!channels.has(a.channel)) reject('R4', `agentPlugins item for undeclared channel ${a.channel}`);
    const expectedUrl = `https://github.com/${a.marketplaceRepository}`.toLowerCase();
    if (![expectedUrl, `${expectedUrl}.git`].includes(a.marketplaceUrl.toLowerCase())) reject('R4', `marketplaceUrl must be https://github.com/${a.marketplaceRepository}`);
  }

  // R4 the checker cannot prove a ref belongs to the marketplace's own branches (fork networks share
  // objects), so new or changed agent channels go to the owner until the indexer checks reachability.
  if (agentPlugins.length && !isDeepStrictEqual(agentPlugins, previous?.agentPlugins)) escalate('R4', 'agent channel added or changed: ref reachability is confirmed by the owner this phase');

  // R4 marketplace lookup; feeds R5 for agent-only entries. true = verified, false = contradicts, null = undecidable.
  const agentMatches = [];
  for (const a of agentPlugins) {
    const url = `https://raw.githubusercontent.com/${a.marketplaceRepository}/${a.ref}/${MARKETPLACE_PATH[a.channel]}`;
    let market;
    try {
      market = await getJson(fetchImpl, url);
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      escalate('R4', `${a.channel}: marketplace unreachable (${q(e.message)})`);
      agentMatches.push(null);
      continue;
    }
    const plugin = Array.isArray(market?.plugins) ? market.plugins.find((p) => p?.name === a.pluginName) : undefined;
    if (!plugin) { escalate('R4', `${a.channel}: plugin ${q(a.pluginName)} not found in ${a.marketplaceRepository}@${a.ref}`); agentMatches.push(null); continue; }
    const source = marketplaceSource(plugin, a.marketplaceRepository);
    if (!source.trusted) {
      if (source.why === 'archive sources cannot be verified') { reject('R5', `${a.channel}: ${source.why}`); agentMatches.push(false); }
      else { escalate('R4', `${a.channel}: ${source.why}`); agentMatches.push(null); }
      continue;
    }
    if (source.repo !== entryRepo) {
      if (entry.npm) escalate('R4', `${a.channel}: marketplace source ${q(source.repo)} differs from repository`);
      else reject('R5', `agent-only entries must be source-verified: marketplace source ${q(source.repo)} differs from repository`);
      agentMatches.push(false);
      continue;
    }
    agentMatches.push(true);
  }

  if (!entry.npm) {
    if (agentMatches.length && agentMatches.every((m) => m === true)) label = 'source-verified';
    return finish();
  }

  // R2 npm package and exact version exist with the exact name
  let meta;
  try {
    meta = await getJson(fetchImpl, npmUrl(entry.npm, entry.version));
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    escalate('R2', `npm unreachable (${q(e.message)})`);
    return finish();
  }
  if (!meta || typeof meta !== 'object') { reject('R2', `${entry.npm}@${entry.version} not found on npm`); return finish(); }
  if (meta.name !== entry.npm) { reject('R2', `npm returned name ${q(meta.name)}, expected ${q(entry.npm)}`); return finish(); }
  if (meta.version !== entry.version) { reject('R2', `npm returned version ${q(meta.version)}, expected ${q(entry.version)}`); return finish(); }

  // R6 install scripts
  const scripts = meta.scripts && typeof meta.scripts === 'object' ? meta.scripts : {};
  const hooks = ['preinstall', 'install', 'postinstall'].filter((k) => typeof scripts[k] === 'string');
  if (hooks.length) escalate('R6', `install scripts: ${hooks.map((k) => `${k}=${q(scripts[k])}`).join(', ')}`, 'info');

  // R5 two-way repository check decides the label
  const npmRepo = githubRepoOf(meta.repository);
  if (entryRepo && npmRepo === entryRepo) {
    try {
      const pkg = await getJson(fetchImpl, `https://raw.githubusercontent.com/${entryRepo}/HEAD/package.json`);
      if (pkg?.name === entry.npm) label = 'source-verified';
      else add('R5', 'info', `repository package.json name is ${q(pkg?.name)}, expected ${q(entry.npm)}`);
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      escalate('R5', `repository unreachable (${q(e.message)})`);
    }
  } else {
    add('R5', 'info', entryRepo ? `npm repository is ${q(npmRepo)}, entry says ${entryRepo}` : 'no repository declared');
  }

  if (!previous && label !== 'source-verified' && !entry.sourceUrl.toLowerCase().startsWith(`https://www.npmjs.com/package/${entry.npm.toLowerCase()}`)) escalate('R9', 'unverified entries link to their npm package page');
  if (previous?.review?.label && previous.review.label !== label && isDeepStrictEqual({ ...previous, review: undefined }, { ...entry, review: undefined })) escalate('R5', `label changed ${previous.review.label} -> ${label}`);

  // R3 npm uniqueness, decided after the label: a verified newcomer against an unverified holder goes to the owner
  const holder = others.find((o) => o.entry?.npm === entry.npm);
  if (holder) {
    if (label === 'source-verified' && holder.entry.review?.label !== 'source-verified') escalate('R3', `npm ${entry.npm} is held by unverified ${holder.path}`);
    else reject('R3', `npm ${entry.npm} is already listed in ${holder.path}`);
  }
  return finish();
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Files that do not parse are left out of the pool; they are rejected when checked themselves.
function parsed(path, text) {
  try {
    return [{ path, entry: JSON.parse(text) }];
  } catch {
    return [];
  }
}

export function readEntriesAt(ref) {
  const names = git('ls-tree', '--name-only', `${ref}:plugins/`).split('\n').filter((n) => n.endsWith('.json')).sort();
  return names.flatMap((n) => parsed(`plugins/${n}`, git('show', `${ref}:plugins/${n}`)));
}

export function readWorkingEntries(dir = 'plugins') {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).sort().flatMap((n) => parsed(`plugins/${n}`, readFileSync(join(dir, n), 'utf8')));
}

const USAGE = 'usage: check-entry.mjs plugins/<file>.json [--head <git-ref>] [--base <git-ref>] [--json]';

export function parseArgs(argv) {
  const opts = { path: null, head: null, base: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--head' || a === '--base') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (opts.path) throw new Error(`unexpected argument ${a}`);
    else opts.path = a;
  }
  if (!opts.path || !/^plugins\/[^/]+\.json$/.test(opts.path)) throw new Error('path must be plugins/<file>.json, relative to the repository root');
  if (opts.head && !opts.base) throw new Error('--head needs --base');
  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  const text = opts.head ? git('show', `${opts.head}:${opts.path}`) : readFileSync(opts.path, 'utf8');
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    entry = null;
  }
  const pool = opts.base ? readEntriesAt(opts.base) : readWorkingEntries();
  const previous = opts.base ? pool.find((o) => o.path === opts.path)?.entry ?? null : null;
  const result = entry === null
    ? { verdict: 'reject', label: 'unverified', findings: [{ rule: 'R1', level: 'error', message: 'file is not valid JSON', action: 'reject' }] }
    : await checkEntry({ path: opts.path, entry, previous, others: pool.filter((o) => o.path !== opts.path) });
  console.log(JSON.stringify(result, null, opts.json ? 0 : 2));
  process.exitCode = result.verdict === 'reject' ? 1 : 0;
}

export function isMain(metaUrl) {
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
