import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { operationError } from './errors.js';
import { projectPath } from './project-store.js';

export const LAUNCH_NODE_STATUSES = new Set([
  'planned',
  'ready',
  'running',
  'waiting-external',
  'needs-approval',
  'blocked',
  'succeeded',
  'failed-retryable',
  'failed-terminal',
  'compensating',
  'compensated',
  'skipped',
]);

export const LAUNCH_SIDE_EFFECTS = new Set([
  'read-only',
  'local-control-write',
  'provider-mutation',
  'cost-mutation',
  'destructive',
]);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(MODULE_DIR, '..', 'schemas');

export function loadV2Schemas() {
  return {
    deploymentManifest: readJson(path.join(SCHEMA_DIR, 'deployment-manifest.v2.schema.json')),
    deploymentState: readJson(path.join(SCHEMA_DIR, 'deployment-state.v2.schema.json')),
    launchGraph: readJson(path.join(SCHEMA_DIR, 'launch-graph.v1.schema.json')),
    approval: readJson(path.join(SCHEMA_DIR, 'approval.v1.schema.json')),
    launchRun: readJson(path.join(SCHEMA_DIR, 'launch-run.v1.schema.json')),
    providerConnection: readJson(path.join(SCHEMA_DIR, 'provider-connection.v1.schema.json')),
    launchRecipe: readJson(path.join(SCHEMA_DIR, 'launch-recipe.v1.schema.json')),
    providerBootstrapPlan: readJson(path.join(SCHEMA_DIR, 'provider-bootstrap-plan.v1.schema.json')),
    humanHandoff: readJson(path.join(SCHEMA_DIR, 'human-handoff.v1.schema.json')),
    humanHandoffAttestation: readJson(path.join(SCHEMA_DIR, 'human-handoff-attestation.v1.schema.json')),
    firstLaunchSession: readJson(path.join(SCHEMA_DIR, 'first-launch-session.v1.schema.json')),
    firstLaunchSessionRevision: readJson(path.join(SCHEMA_DIR, 'first-launch-session-revision.v1.schema.json')),
    launchConfiguration: readJson(path.join(SCHEMA_DIR, 'launch-configuration.v1.schema.json')),
    dnsChangeSet: readJson(path.join(SCHEMA_DIR, 'dns-change-set.v1.schema.json')),
    databaseMigrationPlan: readJson(path.join(SCHEMA_DIR, 'database-migration-plan.v1.schema.json')),
    backupEvidence: readJson(path.join(SCHEMA_DIR, 'backup-evidence.v1.schema.json')),
    databaseRuntimeProfile: readJson(path.join(SCHEMA_DIR, 'database-runtime-profile.v1.schema.json')),
    adapterExecutionPlan: readJson(path.join(SCHEMA_DIR, 'adapter-execution-plan.v1.schema.json')),
    sandboxExecutionProfile: readJson(path.join(SCHEMA_DIR, 'sandbox-execution-profile.v1.schema.json')),
    sandboxPreflightEvidence: readJson(path.join(SCHEMA_DIR, 'sandbox-preflight-evidence.v1.schema.json')),
    sandboxAcceptanceReport: readJson(path.join(SCHEMA_DIR, 'sandbox-acceptance-report.v1.schema.json')),
    providerAcceptanceSuite: readJson(path.join(SCHEMA_DIR, 'provider-acceptance-suite.v1.schema.json')),
    providerAcceptancePortfolio: readJson(path.join(SCHEMA_DIR, 'provider-acceptance-portfolio.v1.schema.json')),
    acceptanceCleanupPlan: readJson(path.join(SCHEMA_DIR, 'acceptance-cleanup-plan.v1.schema.json')),
    acceptanceCleanupAttestation: readJson(path.join(SCHEMA_DIR, 'acceptance-cleanup-attestation.v1.schema.json')),
    sourcePatchProposal: readJson(path.join(SCHEMA_DIR, 'source-patch-proposal.v1.schema.json')),
    productVerificationPlan: readJson(path.join(SCHEMA_DIR, 'product-verification-plan.v1.schema.json')),
    productVerificationEvidence: readJson(path.join(SCHEMA_DIR, 'product-verification-evidence.v1.schema.json')),
    rollbackPlan: readJson(path.join(SCHEMA_DIR, 'rollback-plan.v1.schema.json')),
    rollbackApproval: readJson(path.join(SCHEMA_DIR, 'rollback-approval.v1.schema.json')),
    rollbackApprovalRevocation: readJson(path.join(SCHEMA_DIR, 'rollback-approval-revocation.v1.schema.json')),
    rollbackRun: readJson(path.join(SCHEMA_DIR, 'rollback-run.v1.schema.json')),
  };
}

export function readExternalDeployment(home, projectId) {
  const root = projectPath(home, projectId);
  const manifestFile = path.join(root, 'manifest.json');
  const stateFile = path.join(root, 'state.json');
  if (!fs.existsSync(manifestFile)) {
    throw operationError('NOT_FOUND', `External Deployment Manifest not found: ${manifestFile}`);
  }
  if (!fs.existsSync(stateFile)) {
    throw operationError('NOT_FOUND', `External Deployment State not found: ${stateFile}`);
  }
  let manifest;
  let state;
  try {
    manifest = readJson(manifestFile);
    state = readJson(stateFile);
  } catch (error) {
    throw operationError('VALIDATION_FAILED', `External deployment JSON is invalid: ${error.message}`);
  }
  validateDeploymentManifestV2(manifest, projectId);
  validateDeploymentStateV2(state, projectId, manifest);
  return { manifest, state, manifestFile, stateFile };
}

export function validateDeploymentManifestV2(manifest, projectId = '') {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) issues.push('$');
  if (manifest?.schemaVersion !== 2) issues.push('$.schemaVersion');
  if (manifest?.kind !== 'DeploymentManifest') issues.push('$.kind');
  if (typeof manifest?.projectId !== 'string' || !manifest.projectId) issues.push('$.projectId');
  if (projectId && manifest?.projectId !== projectId) issues.push('$.projectId');
  validateSourceRef(manifest?.sourceRef, '$.sourceRef', issues);
  if (!deploymentAppId(manifest)) issues.push('$.app.id|$.intent.app.id');
  if (!manifest?.intent && !manifest?.recipeRef) issues.push('$.intent|$.recipeRef');
  throwValidationIssues('Deployment Manifest V2', issues);
  return manifest;
}

export function validateDeploymentStateV2(state, projectId = '', manifest = null) {
  const issues = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) issues.push('$');
  if (state?.schemaVersion !== 2) issues.push('$.schemaVersion');
  if (state?.kind !== 'DeploymentState') issues.push('$.kind');
  if (typeof state?.projectId !== 'string' || !state.projectId) issues.push('$.projectId');
  if (projectId && state?.projectId !== projectId) issues.push('$.projectId');
  if (typeof state?.appId !== 'string' || !state.appId) issues.push('$.appId');
  if (manifest && state?.appId !== deploymentAppId(manifest)) issues.push('$.appId');
  if (!Number.isInteger(state?.revision) || state.revision < 1) issues.push('$.revision');
  validateSourceRef(state?.sourceRef, '$.sourceRef', issues);
  for (const key of ['nodes', 'resources', 'facts']) {
    if (!state?.[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) issues.push(`$.${key}`);
  }
  if (!Array.isArray(state?.runs)) issues.push('$.runs');
  if (manifest && !sameSourceRef(state.sourceRef, manifest.sourceRef)) issues.push('$.sourceRef');
  throwValidationIssues('Deployment State V2', issues);
  return state;
}

export function validateLaunchGraph(graph, expected = {}) {
  const issues = [];
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) issues.push('$');
  if (graph?.schemaVersion !== 1) issues.push('$.schemaVersion');
  if (graph?.kind !== 'LaunchGraph') issues.push('$.kind');
  if (!/^graph-[a-f0-9]{24}$/.test(graph?.id || '')) issues.push('$.id');
  if (!/^sha256:[a-f0-9]{64}$/.test(graph?.fingerprint || '')) issues.push('$.fingerprint');
  if (typeof graph?.projectId !== 'string' || !graph.projectId) issues.push('$.projectId');
  if (expected.projectId && graph?.projectId !== expected.projectId) issues.push('$.projectId');
  if (typeof graph?.appId !== 'string' || !graph.appId) issues.push('$.appId');
  if (expected.appId && graph?.appId !== expected.appId) issues.push('$.appId');
  validateSourceRef(graph?.sourceRef, '$.sourceRef', issues);
  if (!Array.isArray(graph?.nodes)) issues.push('$.nodes');
  if (!graph?.summary || typeof graph.summary !== 'object') issues.push('$.summary');
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const ids = new Set();
  for (const [index, node] of nodes.entries()) {
    const prefix = `$.nodes[${index}]`;
    if (!node || typeof node !== 'object') {
      issues.push(prefix);
      continue;
    }
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) issues.push(`${prefix}.id`);
    ids.add(node.id);
    if (!Array.isArray(node.dependsOn) || new Set(node.dependsOn || []).size !== (node.dependsOn || []).length) {
      issues.push(`${prefix}.dependsOn`);
    }
    if (!LAUNCH_NODE_STATUSES.has(node.status)) issues.push(`${prefix}.status`);
    if (!LAUNCH_SIDE_EFFECTS.has(node.sideEffect)) issues.push(`${prefix}.sideEffect`);
  }
  for (const [index, node] of nodes.entries()) {
    for (const dependency of node.dependsOn || []) {
      if (!ids.has(dependency) || dependency === node.id) issues.push(`$.nodes[${index}].dependsOn`);
    }
  }
  if (issues.length === 0 && hasCycle(nodes)) issues.push('$.nodes(cycle)');
  throwValidationIssues('Launch Graph', issues);
  return graph;
}

export function sameSourceRef(left, right) {
  return left?.kind === right?.kind && left?.locator === right?.locator && left?.commit === right?.commit;
}

export function deploymentAppId(manifest) {
  return manifest?.app?.id || manifest?.intent?.app?.id || '';
}

function validateSourceRef(sourceRef, prefix, issues) {
  if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) {
    issues.push(prefix);
    return;
  }
  if (!['local-git', 'remote-git'].includes(sourceRef.kind)) issues.push(`${prefix}.kind`);
  if (typeof sourceRef.locator !== 'string' || !sourceRef.locator) issues.push(`${prefix}.locator`);
  if (!/^[a-f0-9]{40,64}$/i.test(sourceRef.commit || '')) issues.push(`${prefix}.commit`);
}

function hasCycle(nodes) {
  const dependencies = new Map(nodes.map((node) => [node.id, node.dependsOn || []]));
  const visiting = new Set();
  const visited = new Set();
  for (const id of dependencies.keys()) {
    if (visit(id)) return true;
  }
  return false;

  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
}

function throwValidationIssues(label, issues) {
  const unique = [...new Set(issues)];
  if (unique.length > 0) {
    throw operationError('VALIDATION_FAILED', `${label} is invalid at: ${unique.join(', ')}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
