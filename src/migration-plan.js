import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard, runGit } from './repository.js';
import { classifySqlMigration } from './sql-migration-classifier.js';
import { nowIso } from './utils.js';
import { createIsolatedWorkspace } from './workspace.js';

const PLAN_ID = /^migration-plan-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RAW_SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const PROVIDERS = new Set(['neon', 'supabase', 'railway', 'cloudflare']);
const CLASSIFICATIONS = new Set(['additive', 'reversible', 'destructive', 'unknown']);
const CLASSIFICATION_RANK = Object.freeze({ additive: 0, reversible: 1, destructive: 2, unknown: 3 });
const STATUSES = new Set(['ready', 'needs-approval', 'blocked']);
const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_TOTAL_SQL_BYTES = 8 * 1024 * 1024;

export function createDatabaseMigrationPlan(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'migration-plan-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const configuration = showLaunchConfiguration({
      home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
    }).configuration;
    assertDatabaseMigrationContext(graph, configuration);
    const spec = options.spec || readMigrationPlanSpecFile(options.specFile).spec;
    const normalizedSpec = validateAndNormalizeSpec(spec);
    const workspace = createIsolatedWorkspace(home, project, { purpose: 'migration-plan' });
    let totalBytes = 0;
    const migrations = normalizedSpec.migrations.map((migration, index) => {
      const up = inspectCommittedSql(workspace.paths.source, project.source.commit, migration.up);
      totalBytes += up.size;
      const down = migration.down ? inspectCommittedSql(workspace.paths.source, project.source.commit, migration.down) : null;
      totalBytes += down?.size || 0;
      if (totalBytes > MAX_TOTAL_SQL_BYTES) throw operationError('VALIDATION_FAILED', 'Migration SQL exceeds the 8 MiB plan limit.');
      const analysis = classifySqlMigration(up.sql, { dialect: normalizedSpec.dialect });
      const downAnalysis = down ? classifySqlMigration(down.sql, { dialect: normalizedSpec.dialect }) : null;
      const downPlanRequired = analysis.classification === 'reversible' && !down;
      const blockers = unique([...analysis.blockers, ...(downPlanRequired ? ['down-plan-required'] : [])]);
      return {
        id: `migration-${String(index + 1).padStart(3, '0')}-${up.sha256.slice(0, 12)}`,
        order: index + 1,
        up: sourceSummary(up),
        ...(down ? { down: sourceSummary(down) } : {}),
        classification: analysis.classification,
        transactionMode: analysis.transactionMode,
        statements: analysis.statements,
        ...(downAnalysis ? {
          downAnalysis: {
            classification: downAnalysis.classification,
            transactionMode: downAnalysis.transactionMode,
            statementCount: downAnalysis.statementCount,
            statements: downAnalysis.statements,
          },
        } : {}),
        blockers,
        warnings: unique([...analysis.warnings, ...(downAnalysis?.warnings || [])]),
      };
    });
    const requirements = planRequirements(migrations);
    const base = {
      schemaVersion: 1,
      kind: 'DatabaseMigrationPlan',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      configurationId: configuration.id,
      configurationFingerprint: configuration.fingerprint,
      provider: configuration.database.provider,
      dialect: normalizedSpec.dialect,
      sourceRef: { kind: project.source.kind, commit: project.source.commit },
      expectedSchemaVersion: normalizedSpec.expectedSchemaVersion,
      migrations,
      summary: planSummary(migrations),
      requirements,
      status: requirements.blockers.length > 0
        ? 'blocked'
        : (requirements.approvalRequired ? 'needs-approval' : 'ready'),
      createdAt: options.now || nowIso(),
    };
    const fingerprint = databaseMigrationPlanFingerprint(base);
    let plan = {
      ...base,
      id: `migration-plan-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateDatabaseMigrationPlan(plan, { project, graph, configuration });
    const directory = path.join(projectPath(home, project.id), 'migration-plans');
    const planFile = path.join(directory, `${plan.id}.json`);
    const currentFile = path.join(projectPath(home, project.id), 'migration-plan.json');
    let reused = false;
    if (fs.existsSync(planFile)) {
      const existing = readMigrationPlanFile(planFile, { project, graph, configuration });
      if (existing.fingerprint !== plan.fingerprint) throw operationError('CONFLICT', `Migration Plan ID collision: ${plan.id}`);
      plan = existing;
      reused = true;
    } else {
      writeJsonAtomic(planFile, plan);
    }
    writeJsonAtomic(currentFile, plan);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'database-migration-plan', operation: 'create', status: plan.status, home,
      projectId: project.id, plan, planFile, currentFile, reused, repositoryGuard,
      providerMutationsExecuted: 0, sqlStatementsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function showDatabaseMigrationPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
  }).configuration;
  const file = options.planId
    ? migrationPlanPath(home, project.id, options.planId)
    : path.join(projectPath(home, project.id), 'migration-plan.json');
  if (!fs.existsSync(file)) throw operationError('NOT_FOUND', `Database Migration Plan not found: ${file}`);
  const plan = readMigrationPlanFile(file, { project, graph, configuration });
  return { kind: 'database-migration-plan', operation: 'read', home, projectId: project.id, plan, planFile: file };
}

export function loadCommittedMigrationBundle(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const shown = showDatabaseMigrationPlan({
    home,
    projectId: project.id,
    graphId: options.graphId,
    configurationId: options.configurationId,
    planId: options.planId,
  });
  const plan = shown.plan;
  if (plan.status === 'blocked') {
    throw operationError('APPROVAL_REQUIRED', 'Blocked Database Migration Plan cannot be materialized for execution.');
  }
  const direction = options.direction || 'up';
  if (!['up', 'down'].includes(direction)) {
    throw operationError('VALIDATION_FAILED', 'Migration bundle direction must be up or down.');
  }
  const workspace = createIsolatedWorkspace(home, project, { purpose: `migration-${direction}` });
  const migrations = (direction === 'down' ? [...plan.migrations].reverse() : plan.migrations).map((migration) => {
    const expected = direction === 'up' ? migration.up : migration.down;
    if (!expected) {
      throw operationError('CAPABILITY_MISSING', `Migration has no committed Down SQL: ${migration.id}`);
    }
    const source = inspectCommittedSql(workspace.paths.source, project.source.commit, expected.path);
    assertSourceMatchesPlan(source, expected, migration.id, direction);
    const analysis = classifySqlMigration(source.sql, { dialect: plan.dialect });
    const plannedAnalysis = direction === 'up'
      ? {
          classification: migration.classification,
          transactionMode: migration.transactionMode,
          statementCount: migration.statements.length,
          statements: migration.statements,
        }
      : migration.downAnalysis;
    if (!plannedAnalysis || !sameAnalysis(analysis, plannedAnalysis)) {
      throw operationError(
        'ARTIFACT_INTEGRITY_FAILED',
        `Committed ${direction} SQL no longer matches Database Migration Plan analysis: ${migration.id}`
      );
    }
    return Object.freeze({
      id: migration.id,
      order: migration.order,
      direction,
      file: path.join(workspace.paths.source, ...expected.path.split('/')),
      path: expected.path,
      sha256: expected.sha256,
      blobId: expected.blobId,
      statementCount: plannedAnalysis.statementCount,
      transactionMode: plannedAnalysis.transactionMode,
    });
  });
  const repositoryGuard = completeSourceGuard(project.source, before);
  return Object.freeze({
    kind: 'committed-migration-bundle',
    projectId: project.id,
    graphId: plan.graphId,
    configurationId: plan.configurationId,
    migrationPlanId: plan.id,
    migrationPlanFingerprint: plan.fingerprint,
    sourceCommit: plan.sourceRef.commit,
    direction,
    migrations: Object.freeze(migrations),
    statementCount: migrations.reduce((sum, migration) => sum + migration.statementCount, 0),
    workspaceRoot: workspace.paths.root,
    repositoryGuard,
  });
}

export function validateDatabaseMigrationPlan(plan, expected = {}) {
  const issues = [];
  if (plan?.schemaVersion !== 1 || plan?.kind !== 'DatabaseMigrationPlan') issues.push('kind|schemaVersion');
  if (!PLAN_ID.test(plan?.id || '') || !SHA256.test(plan?.fingerprint || '')) issues.push('id|fingerprint');
  if (typeof plan?.projectId !== 'string' || !plan.projectId) issues.push('projectId');
  if (expected.project && plan?.projectId !== expected.project.id) issues.push('projectId');
  if (expected.graph && (plan?.graphId !== expected.graph.id || plan?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    plan?.configurationId !== expected.configuration.id ||
    plan?.configurationFingerprint !== expected.configuration.fingerprint ||
    plan?.provider !== expected.configuration.database.provider
  )) issues.push('configuration');
  if (!PROVIDERS.has(plan?.provider) || plan?.dialect !== 'postgresql') issues.push('provider|dialect');
  if (!COMMIT.test(plan?.sourceRef?.commit || '') || !['local-git', 'remote-git'].includes(plan?.sourceRef?.kind)) issues.push('sourceRef');
  if (expected.project && (
    plan.sourceRef.commit !== expected.project.source.commit || plan.sourceRef.kind !== expected.project.source.kind
  )) issues.push('sourceRef');
  if (!VERSION.test(plan?.expectedSchemaVersion || '')) issues.push('expectedSchemaVersion');
  if (!Array.isArray(plan?.migrations) || plan.migrations.length === 0 || plan.migrations.length > 100) issues.push('migrations');
  const ids = new Set();
  const paths = new Set();
  for (const [index, migration] of (plan?.migrations || []).entries()) {
    const prefix = `migrations[${index}]`;
    const migrationKeys = ['id', 'order', 'up', 'down', 'classification', 'transactionMode', 'statements', 'downAnalysis', 'blockers', 'warnings'];
    if (!isPlainObject(migration) || Object.keys(migration).some((key) => !migrationKeys.includes(key))) issues.push(prefix);
    if (!/^migration-[0-9]{3}-[a-f0-9]{12}$/.test(migration?.id || '') || ids.has(migration?.id) ||
      migration?.id !== `migration-${String(index + 1).padStart(3, '0')}-${String(migration?.up?.sha256 || '').slice(0, 12)}`) issues.push(`${prefix}.id`);
    ids.add(migration?.id);
    if (migration?.order !== index + 1 || !CLASSIFICATIONS.has(migration?.classification) ||
      !['transactional', 'non-transactional', 'mixed'].includes(migration?.transactionMode)) issues.push(`${prefix}.summary`);
    validateSourceSummary(migration?.up, `${prefix}.up`, paths, issues);
    if (migration?.down) validateSourceSummary(migration.down, `${prefix}.down`, paths, issues);
    if (!Array.isArray(migration?.statements) || migration.statements.length === 0 ||
      !Array.isArray(migration?.blockers) || !Array.isArray(migration?.warnings)) issues.push(`${prefix}.analysis`);
    for (const [statementIndex, statement] of (migration?.statements || []).entries()) {
      validateStatement(statement, `${prefix}.statements`, issues);
      if (statement?.index !== statementIndex + 1) issues.push(`${prefix}.statements.index`);
    }
    const derivedClassification = classificationForStatements(migration?.statements || []);
    const derivedTransactionMode = transactionModeForStatements(migration?.statements || []);
    const derivedBlockers = unique([
      ...(migration?.statements || []).flatMap((statement) => statement.blockers || []),
      ...(derivedTransactionMode === 'mixed' ? ['mixed-transaction-mode'] : []),
      ...(derivedClassification === 'reversible' && !migration?.down ? ['down-plan-required'] : []),
    ]);
    if (migration?.classification !== derivedClassification || migration?.transactionMode !== derivedTransactionMode ||
      stableStringify(migration?.blockers) !== stableStringify(derivedBlockers)) issues.push(`${prefix}.derived`);
    if (Boolean(migration?.down) !== Boolean(migration?.downAnalysis)) issues.push(`${prefix}.downAnalysis`);
    if (migration?.downAnalysis) validateDownAnalysis(migration.downAnalysis, `${prefix}.downAnalysis`, issues);
    const derivedWarnings = unique([
      ...(migration?.statements || []).flatMap((statement) => statement.warnings || []),
      ...(migration?.downAnalysis?.statements || []).flatMap((statement) => statement.warnings || []),
    ]);
    if (stableStringify(migration?.warnings) !== stableStringify(derivedWarnings)) issues.push(`${prefix}.warnings.derived`);
  }
  if (!isPlainObject(plan?.summary) || !isPlainObject(plan?.requirements) || !Array.isArray(plan?.requirements?.blockers)) issues.push('summary|requirements');
  if (!STATUSES.has(plan?.status) || !isDate(plan?.createdAt)) issues.push('status|createdAt');
  if (Array.isArray(plan?.migrations)) {
    const derivedSummary = planSummary(plan.migrations);
    const derivedRequirements = planRequirements(plan.migrations);
    const derivedStatus = derivedRequirements.blockers.length > 0
      ? 'blocked'
      : (derivedRequirements.approvalRequired ? 'needs-approval' : 'ready');
    if (stableStringify(plan.summary) !== stableStringify(derivedSummary)) issues.push('summary.derived');
    if (stableStringify(plan.requirements) !== stableStringify(derivedRequirements)) issues.push('requirements.derived');
    if (plan.status !== derivedStatus) issues.push('status.derived');
  }
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Database Migration Plan is invalid at: ${[...new Set(issues)].join(', ')}`);
  const actual = databaseMigrationPlanFingerprint(plan);
  if (plan.fingerprint !== actual || plan.id !== `migration-plan-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Migration Plan fingerprint mismatch: ${plan.id}`);
  }
  return plan;
}

export function readMigrationPlanSpecFile(file) {
  const resolved = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw operationError('NOT_FOUND', `Migration Plan spec not found: ${resolved}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SPEC_BYTES) {
    throw operationError('VALIDATION_FAILED', 'Migration Plan spec must be a regular non-symlink JSON file no larger than 1 MiB.');
  }
  let spec;
  try { spec = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `Migration Plan spec JSON is invalid: ${error.message}`); }
  return { spec, specFile: resolved };
}

export function databaseMigrationPlanFingerprint(plan) {
  const value = structuredClone(plan);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function validateAndNormalizeSpec(spec) {
  if (!isPlainObject(spec)) throw operationError('VALIDATION_FAILED', 'Migration Plan spec must be an object.');
  assertKeys(spec, ['dialect', 'expectedSchemaVersion', 'migrations'], '$');
  if ((spec.dialect || 'postgresql') !== 'postgresql' || !VERSION.test(spec.expectedSchemaVersion || '')) {
    throw operationError('VALIDATION_FAILED', 'Migration Plan requires dialect=postgresql and a safe expectedSchemaVersion.');
  }
  if (!Array.isArray(spec.migrations) || spec.migrations.length === 0 || spec.migrations.length > 100) {
    throw operationError('VALIDATION_FAILED', 'Migration Plan requires 1-100 ordered migration entries.');
  }
  const paths = new Set();
  const migrations = spec.migrations.map((entry, index) => {
    if (!isPlainObject(entry)) throw operationError('VALIDATION_FAILED', `Migration entry ${index} must be an object.`);
    assertKeys(entry, ['up', 'down'], `$.migrations[${index}]`);
    const up = normalizeRepositorySqlPath(entry.up, `$.migrations[${index}].up`);
    const down = entry.down ? normalizeRepositorySqlPath(entry.down, `$.migrations[${index}].down`) : '';
    for (const value of [up, down].filter(Boolean)) {
      if (paths.has(value)) throw operationError('VALIDATION_FAILED', `Migration SQL path is duplicated: ${value}`);
      paths.add(value);
    }
    return { up, ...(down ? { down } : {}) };
  });
  return { dialect: 'postgresql', expectedSchemaVersion: spec.expectedSchemaVersion, migrations };
}

function inspectCommittedSql(root, commit, relativePath) {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw operationError('PATH_BOUNDARY_VIOLATION', `Migration path escapes the locked checkout: ${relativePath}`);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch { throw operationError('NOT_FOUND', `Migration SQL is missing from the locked commit: ${relativePath}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
    throw operationError('VALIDATION_FAILED', `Migration SQL must be a regular non-symlink file no larger than 2 MiB: ${relativePath}`);
  }
  const tree = runGit(root, ['ls-tree', commit, '--', relativePath]).stdout.trim();
  const match = tree.match(/^100(?:644|755) blob ([a-f0-9]{40,64})\t(.+)$/);
  if (!match || match[2] !== relativePath) throw operationError('ARTIFACT_INTEGRITY_FAILED', `Migration SQL is not an exact regular blob in the locked commit: ${relativePath}`);
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) throw operationError('VALIDATION_FAILED', `Migration SQL is not UTF-8 text: ${relativePath}`);
  const sql = buffer.toString('utf8');
  if (Buffer.from(sql, 'utf8').compare(buffer) !== 0) throw operationError('VALIDATION_FAILED', `Migration SQL is not valid UTF-8: ${relativePath}`);
  return { path: relativePath, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), blobId: match[1], sql };
}

function sourceSummary(source) {
  return { path: source.path, size: source.size, sha256: source.sha256, blobId: source.blobId };
}

function assertSourceMatchesPlan(source, expected, migrationId, direction) {
  if (
    source.path !== expected.path || source.size !== expected.size ||
    source.sha256 !== expected.sha256 || source.blobId !== expected.blobId
  ) {
    throw operationError(
      'ARTIFACT_INTEGRITY_FAILED',
      `Committed ${direction} SQL identity differs from Database Migration Plan: ${migrationId}`
    );
  }
}

function sameAnalysis(actual, expected) {
  const normalized = {
    classification: actual.classification,
    transactionMode: actual.transactionMode,
    statementCount: actual.statementCount,
    statements: actual.statements,
  };
  return stableStringify(normalized) === stableStringify(expected);
}

function planRequirements(migrations) {
  const classifications = migrations.map((migration) => migration.classification);
  const blockers = unique(migrations.flatMap((migration) => migration.blockers));
  return {
    backupRequired: classifications.some((value) => ['destructive', 'unknown'].includes(value)),
    approvalRequired: classifications.some((value) => ['destructive', 'unknown'].includes(value)),
    manualReviewRequired: classifications.includes('unknown'),
    downPlanRequired: blockers.includes('down-plan-required'),
    blockers,
  };
}

function planSummary(migrations) {
  const counts = { additive: 0, reversible: 0, destructive: 0, unknown: 0 };
  let statementCount = 0;
  for (const migration of migrations) {
    counts[migration.classification] += 1;
    statementCount += migration.statements.length;
  }
  const classification = ['unknown', 'destructive', 'reversible', 'additive'].find((value) => counts[value] > 0);
  return { migrationCount: migrations.length, statementCount, classification, classificationCounts: counts };
}

function assertDatabaseMigrationContext(graph, configuration) {
  const node = graph.nodes.find((item) => item.id === 'database.migrate');
  if (!configuration.database.provider || !node || node.provider !== configuration.database.provider) {
    throw operationError('CAPABILITY_MISSING', 'Current Graph and Launch Configuration do not include a matching database migration node.');
  }
}

function validateSourceSummary(value, prefix, paths, issues) {
  if (!value || !isPlainObject(value) || Object.keys(value).some((key) => !['path', 'size', 'sha256', 'blobId'].includes(key)) ||
    !normalizeRepositorySqlPathSoft(value.path) || !RAW_SHA256.test(value.sha256 || '') ||
    !/^[a-f0-9]{40,64}$/.test(value.blobId || '') || !Number.isInteger(value.size) || value.size < 1 || value.size > 2 * 1024 * 1024 ||
    paths.has(value.path)) issues.push(prefix);
  paths.add(value?.path);
}

function validateStatement(value, prefix, issues) {
  const keys = ['index', 'sha256', 'classification', 'operation', 'objectType', 'objectName', 'transactionSafe', 'blockers', 'warnings'];
  if (!isPlainObject(value) || Object.keys(value).some((key) => !keys.includes(key)) ||
    !Number.isInteger(value?.index) || value.index < 1 || !RAW_SHA256.test(value?.sha256 || '') ||
    !CLASSIFICATIONS.has(value?.classification) || typeof value?.operation !== 'string' ||
    typeof value?.objectType !== 'string' || typeof value?.objectName !== 'string' ||
    typeof value?.transactionSafe !== 'boolean' || !Array.isArray(value?.blockers) || !Array.isArray(value?.warnings)) issues.push(prefix);
}

function validateDownAnalysis(value, prefix, issues) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !['classification', 'transactionMode', 'statementCount', 'statements'].includes(key)) ||
    !Array.isArray(value.statements) || value.statementCount !== value.statements.length) issues.push(prefix);
  for (const [index, statement] of (value?.statements || []).entries()) {
    validateStatement(statement, `${prefix}.statements`, issues);
    if (statement?.index !== index + 1) issues.push(`${prefix}.statements.index`);
  }
  if (value?.classification !== classificationForStatements(value?.statements || []) ||
    value?.transactionMode !== transactionModeForStatements(value?.statements || [])) issues.push(`${prefix}.derived`);
}

function classificationForStatements(statements) {
  return statements.reduce((current, statement) =>
    CLASSIFICATION_RANK[statement?.classification] > CLASSIFICATION_RANK[current]
      ? statement.classification
      : current, 'additive');
}

function transactionModeForStatements(statements) {
  const values = new Set(statements.map((statement) => statement?.transactionSafe ? 'transactional' : 'non-transactional'));
  return values.size > 1 ? 'mixed' : ([...values][0] || 'transactional');
}

function normalizeRepositorySqlPath(value, field) {
  const text = String(value || '');
  if (!normalizeRepositorySqlPathSoft(text)) throw operationError('PATH_BOUNDARY_VIOLATION', `${field} must be a safe repository-relative .sql path.`);
  return text;
}

function normalizeRepositorySqlPathSoft(value) {
  const text = String(value || '');
  return text.length > 0 && text.length <= 512 && !text.includes('\\') && !text.includes('\0') &&
    !path.posix.isAbsolute(text) && path.posix.normalize(text) === text && !text.startsWith('../') &&
    !text.split('/').includes('..') && text.toLowerCase().endsWith('.sql');
}

function migrationPlanPath(home, projectId, planId) {
  if (!PLAN_ID.test(planId || '')) throw operationError('VALIDATION_FAILED', 'Database Migration Plan ID is invalid.');
  return path.join(projectPath(home, projectId), 'migration-plans', `${planId}.json`);
}

function readMigrationPlanFile(file, expected) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Database Migration Plan JSON is invalid: ${error.message}`); }
  return validateDatabaseMigrationPlan(plan, expected);
}

function assertKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw operationError('VALIDATION_FAILED', `${field} contains unsupported fields: ${unknown.join(', ')}`);
}

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
