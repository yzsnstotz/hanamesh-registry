import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/plugin.schema.json', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, validateFormats: false });
const validate = ajv.compile(schema);

export const RULES_VERSION = '1';

export function fileNameForId(id) {
  return id.replace('/', '__') + '.json';
}

// Returns a list of human-readable schema errors; empty means the shape is valid.
export function validateShape(entry) {
  if (validate(entry)) return [];
  return validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);
}

// "owner/repo" from the forms npm and marketplaces use; null when it is not a GitHub repository.
export function githubRepoOf(value) {
  const raw = typeof value === 'string' ? value : typeof value?.url === 'string' ? value.url : null;
  if (!raw) return null;
  const m = /^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw)
    ?? /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?:#.*)?$/.exec(raw)
    ?? /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
