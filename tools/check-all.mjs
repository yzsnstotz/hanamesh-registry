#!/usr/bin/env node
// Re-checks every plugins/*.json on the working tree against itself as `previous`, so only
// live facts (npm, repository, marketplaces) can change the outcome. Exit 1 when any entry is rejected.
import { checkEntry, readWorkingEntries } from './check-entry.mjs';

const entries = readWorkingEntries();
let rejected = 0;
for (const { path, entry } of entries) {
  const result = await checkEntry({ path, entry, previous: entry, others: entries.filter((o) => o.path !== path) });
  if (result.verdict === 'reject') rejected += 1;
  console.log(JSON.stringify({ path, ...result }));
}
console.error(`${entries.length} entries, ${rejected} rejected`);
process.exitCode = rejected ? 1 : 0;
