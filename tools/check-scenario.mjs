#!/usr/bin/env node
// Dry-run input for the review skill: runs checkEntry on a scenario file
// {base:[{path,entry}], head:{path,entry}, expect?} instead of a live PR.
import { readFileSync } from 'node:fs';
import { checkEntry, isMain } from './check-entry.mjs';

export async function checkScenario(scenario, fetchImpl = globalThis.fetch) {
  const { base = [], head } = scenario;
  const previous = base.find((o) => o.path === head.path)?.entry ?? null;
  return checkEntry({ path: head.path, entry: head.entry, previous, others: base.filter((o) => o.path !== head.path), fetch: fetchImpl });
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: check-scenario.mjs <scenario.json>'); process.exit(2); }
  const result = await checkScenario(JSON.parse(readFileSync(file, 'utf8')));
  console.log(JSON.stringify(result));
  process.exitCode = result.verdict === 'reject' ? 1 : 0;
}
