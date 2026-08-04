import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEPLOY_MANIFEST_SCHEMA_ID =
  'https://agentmesh360.com/schemas/deploy-manifest.v1.json';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(MODULE_DIR, '..', 'schemas', 'deploy-manifest.v1.schema.json');

export function deployManifestSchemaPath() {
  return SCHEMA_FILE;
}

export function loadDeployManifestSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}
