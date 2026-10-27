import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkingEntries } from '../tools/check-entry.mjs';
import { fileNameForId, validateShape } from '../tools/entry.mjs';

const dir = new URL('../plugins', import.meta.url).pathname;

// Phase-1 migration. yzsnstotz/hanamesh-recommender joins after its repo goes public and a
// release carries `repository`; yzsnstotz/hanamesh-app-vibe-trading is deferred to the next phase.
test('migration covers exactly the five phase-1 legacy ids', () => {
  const entries = readWorkingEntries(dir);
  assert.deepEqual(entries.map((e) => e.entry.id).sort(), [
    '@ai-workbench/workbench',
    '@ai-workbench/workbench-toolbridge',
    'yzsnstotz/hanamesh-core',
    'yzsnstotz/hanamesh-plugin-app-host',
    'yzsnstotz/hanamesh-usage',
  ]);
  for (const { path, entry } of entries) {
    assert.deepEqual(validateShape(entry), [], path);
    assert.equal(path, `plugins/${fileNameForId(entry.id)}`);
    assert.equal(entry.review.notes, 'initial migration');
    assert.equal(entry.review.label, entry.id.startsWith('yzsnstotz/') ? 'source-verified' : 'unverified', path);
  }
});
