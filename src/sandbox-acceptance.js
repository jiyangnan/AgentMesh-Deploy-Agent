import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { listAdapterActionReceipts } from './adapter-graph-executor.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { readLaunchRun } from './launch-run.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { showSandboxPreflight } from './sandbox-preflight.js';
import { showSandboxProfile } from './sandbox-profile.js';

const REPORT_ID = /^sandbox-acceptance-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_ACTION_STATUSES = new Set(['succeeded', 'ready', 'skipped']);

export function createSandboxAcceptanceReport(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'sandbox-acceptance-report', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const plan = showAdapterExecutionPlan({
      home, projectId: project.id, graphId: graph.id, planId: options.planId,
    }).plan;
    const profile = showSandboxProfile({
      home, projectId: project.id, graphId: graph.id, planId: plan.id,
      profileId: options.profileId,
    }).profile;
    const run = readLaunchRun(home, project.id, options.runId);
    assertRunBinding(run, graph, plan, profile);
    const preflight = run.sandboxPreflightId
      ? showSandboxPreflight({
          home, projectId: project.id, graphId: graph.id, planId: plan.id,
          profileId: profile.id, evidenceId: run.sandboxPreflightId, now: run.updatedAt,
        }).evidence
      : null;
    const journalReceipts = listAdapterActionReceipts(home, project.id, run.id, plan);
    const evidenceReceipts = resolveTerminalActionEvidence({
      home, projectId: project.id, plan, run, journalReceipts,
    });
    const derived = deriveAcceptanceFacts({
      plan, profile, run, preflight, evidenceReceipts, journalReceipts,
    });
    const base = {
      schemaVersion: 1,
      kind: 'SandboxAcceptanceReport',
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      adapterPlanId: plan.id,
      adapterPlanFingerprint: plan.fingerprint,
      sandboxProfileId: profile.id,
      sandboxProfileFingerprint: profile.fingerprint,
      sandboxPreflightId: run.sandboxPreflightId || '',
      sandboxPreflightFingerprint: run.sandboxPreflightFingerprint || '',
      runId: run.id,
      runRevision: run.revision,
      runFingerprint: run.fingerprint,
      accountEnvironment: profile.accountEnvironment || 'unspecified',
      accountEnvironmentBasis: profile.accountEnvironment === 'test' ? 'user-declared' : 'none',
      transportProvenance: run.transportProvenance || 'unrecorded',
      providers: profile.providers,
      checks: derived.checks,
      providerResults: derived.providerResults,
      providerMutationsExecuted: run.providerMutationsExecuted || 0,
      receiptCount: evidenceReceipts.length,
      status: derived.checks.every((check) => check.status === 'passed') ? 'passed' : 'not-qualified',
      createdAt: run.updatedAt,
    };
    const fingerprint = sandboxAcceptanceFingerprint(base);
    let report = {
      ...base,
      id: `sandbox-acceptance-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateSandboxAcceptanceReport(report, { base });
    const directory = path.join(projectPath(home, project.id), 'sandbox-acceptance');
    const reportFile = path.join(directory, `${report.id}.json`);
    let reused = false;
    if (options.persist === false) {
      if (!fs.existsSync(reportFile)) {
        throw operationError('NOT_FOUND', `Sandbox Acceptance Report evidence is missing: ${report.id}`);
      }
      const existing = readReport(reportFile);
      validateSandboxAcceptanceReport(existing, { base });
      report = existing;
      reused = true;
    } else if (fs.existsSync(reportFile)) {
      const existing = readReport(reportFile);
      if (existing.fingerprint !== report.fingerprint) {
        throw operationError('CONFLICT', `Sandbox Acceptance Report ID collision: ${report.id}`);
      }
      validateSandboxAcceptanceReport(existing, { base });
      report = existing;
      reused = true;
    } else {
      writeJsonAtomic(reportFile, report);
    }
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'sandbox-acceptance-report', operation: 'create', status: report.status,
      home, projectId: project.id, report, reportFile, reused, repositoryGuard,
      networkRequestsExecuted: 0, providerMutationsExecuted: 0,
      secretValuesExposed: false, productRepositoryChanged: false,
    };
  });
}

export function validateSandboxAcceptanceReport(report, expected = {}) {
  const issues = [];
  exactKeys(report, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'graphId', 'graphFingerprint',
    'adapterPlanId', 'adapterPlanFingerprint', 'sandboxProfileId', 'sandboxProfileFingerprint',
    'sandboxPreflightId', 'sandboxPreflightFingerprint', 'runId', 'runRevision', 'runFingerprint',
    'accountEnvironment', 'accountEnvironmentBasis', 'transportProvenance', 'providers', 'checks',
    'providerResults', 'providerMutationsExecuted', 'receiptCount', 'status', 'createdAt',
  ], '$', issues);
  if (report?.schemaVersion !== 1 || report?.kind !== 'SandboxAcceptanceReport') issues.push('kind|schemaVersion');
  if (!REPORT_ID.test(report?.id || '') || !SHA256.test(report?.fingerprint || '')) issues.push('id|fingerprint');
  for (const key of [
    'graphFingerprint', 'adapterPlanFingerprint', 'sandboxProfileFingerprint', 'runFingerprint',
  ]) {
    if (!SHA256.test(report?.[key] || '')) issues.push(key);
  }
  if (report?.sandboxPreflightId && !/^sandbox-preflight-[a-f0-9]{24}$/.test(report.sandboxPreflightId)) {
    issues.push('sandboxPreflightId');
  }
  if (report?.sandboxPreflightFingerprint && !SHA256.test(report.sandboxPreflightFingerprint)) {
    issues.push('sandboxPreflightFingerprint');
  }
  if ((report?.sandboxPreflightId === '') !== (report?.sandboxPreflightFingerprint === '')) {
    issues.push('sandboxPreflightBinding');
  }
  if (!['test', 'unspecified'].includes(report?.accountEnvironment)) issues.push('accountEnvironment');
  if (!['user-declared', 'none'].includes(report?.accountEnvironmentBasis)) issues.push('accountEnvironmentBasis');
  if ((report?.accountEnvironment === 'test') !== (report?.accountEnvironmentBasis === 'user-declared')) {
    issues.push('accountEnvironment|basis');
  }
  if (!['native-cli-fixed-host', 'injected-test', 'unrecorded'].includes(report?.transportProvenance)) {
    issues.push('transportProvenance');
  }
  if (!['passed', 'not-qualified'].includes(report?.status)) issues.push('status');
  if (!Number.isInteger(report?.runRevision) || report.runRevision < 1) issues.push('runRevision');
  if (!Number.isInteger(report?.providerMutationsExecuted) || report.providerMutationsExecuted < 0) {
    issues.push('providerMutationsExecuted');
  }
  if (!Number.isInteger(report?.receiptCount) || report.receiptCount < 0) issues.push('receiptCount');
  if (!isDate(report?.createdAt)) issues.push('createdAt');
  validateProviders(report?.providers, issues);
  validateChecks(report?.checks, issues);
  validateProviderResults(report?.providerResults, report?.providers, issues);
  const expectedStatus = report?.checks?.every((check) => check.status === 'passed') ? 'passed' : 'not-qualified';
  if (report?.status !== expectedStatus) issues.push('status|checks');
  if (expected.base) {
    for (const [key, value] of Object.entries(expected.base)) {
      if (stableStringify(report?.[key]) !== stableStringify(value)) issues.push(`derived.${key}`);
    }
  }
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `Sandbox Acceptance Report is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const fingerprint = sandboxAcceptanceFingerprint(report);
  if (report.fingerprint !== fingerprint || report.id !== `sandbox-acceptance-${fingerprint.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Acceptance Report fingerprint mismatch: ${report.id}`);
  }
  return report;
}

export function sandboxAcceptanceFingerprint(report) {
  const value = structuredClone(report);
  delete value.id;
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function assertRunBinding(run, graph, plan, profile) {
  if (run.providerMode !== 'sandbox') throw operationError('CONFLICT', 'Acceptance reporting requires a Sandbox LaunchRun.');
  if (run.graphId !== graph.id || run.graphFingerprint !== graph.fingerprint) {
    throw operationError('CONFLICT', 'Sandbox Run is bound to a different LaunchGraph.');
  }
  if (run.adapterPlanId !== plan.id || run.adapterPlanFingerprint !== plan.fingerprint) {
    throw operationError('CONFLICT', 'Sandbox Run is bound to a different Adapter Execution Plan.');
  }
  if (run.sandboxProfileId !== profile.id || run.sandboxProfileFingerprint !== profile.fingerprint) {
    throw operationError('CONFLICT', 'Sandbox Run is bound to a different Sandbox Execution Profile.');
  }
}

function resolveTerminalActionEvidence({ home, projectId, plan, run, journalReceipts }) {
  const evidenceByAction = latestTerminalReceipts(journalReceipts);
  const actionsByNode = new Map();
  for (const action of plan.actions) {
    actionsByNode.set(action.nodeId, [...(actionsByNode.get(action.nodeId) || []), action]);
  }
  const receiptsByRun = new Map([[run.id, journalReceipts]]);
  for (const [nodeId, actions] of actionsByNode) {
    if (actions.every((action) => evidenceByAction.has(action.actionId))) continue;
    const state = run.nodeStates?.[nodeId];
    if (!['succeeded', 'skipped'].includes(state?.status) || !state.resultRef) continue;
    const reference = parseAdapterReceiptReference(home, projectId, state.resultRef, plan);
    if (!reference || reference.action.nodeId !== nodeId) continue;
    if (!receiptsByRun.has(reference.runId)) {
      receiptsByRun.set(
        reference.runId,
        listAdapterActionReceipts(home, projectId, reference.runId, plan)
      );
    }
    const referencedReceipts = receiptsByRun.get(reference.runId);
    const referencedFile = referencedReceipts.find((receipt) =>
      path.resolve(receipt.file) === reference.file
    );
    if (
      !referencedFile || referencedFile.actionId !== reference.action.actionId ||
      referencedFile.result?.ok !== true || !TERMINAL_ACTION_STATUSES.has(referencedFile.result.status)
    ) continue;
    const terminalByAction = latestTerminalReceipts(
      referencedReceipts.filter((receipt) => receipt.nodeId === nodeId)
    );
    for (const action of actions) {
      if (!evidenceByAction.has(action.actionId) && terminalByAction.has(action.actionId)) {
        evidenceByAction.set(action.actionId, terminalByAction.get(action.actionId));
      }
    }
  }
  return plan.actions.flatMap((action) => {
    const receipt = evidenceByAction.get(action.actionId);
    return receipt ? [receipt] : [];
  });
}

function parseAdapterReceiptReference(home, projectId, resultRef, plan) {
  const root = path.resolve(projectPath(home, projectId), 'adapter-runs');
  const file = path.resolve(resultRef);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  if (
    parts.length !== 4 || !/^launch-[a-f0-9-]+$/.test(parts[0]) ||
    parts[1] !== 'actions' || !/^\d{6}-receipt\.json$/.test(parts[3])
  ) return null;
  const action = plan.actions.find((item) => item.actionId === parts[2]);
  return action ? { runId: parts[0], action, file } : null;
}

function latestTerminalReceipts(receipts) {
  const latest = new Map();
  for (const receipt of receipts) latest.set(receipt.actionId, receipt);
  for (const [actionId, receipt] of latest) {
    const result = receipt.result;
    if (result?.ok !== true || !TERMINAL_ACTION_STATUSES.has(result.status)) latest.delete(actionId);
  }
  return latest;
}

function deriveAcceptanceFacts({ plan, profile, run, preflight, evidenceReceipts, journalReceipts }) {
  const byAction = new Map();
  for (const receipt of evidenceReceipts) byAction.set(receipt.actionId, receipt);
  const terminalActions = plan.actions.filter((action) => {
    const result = byAction.get(action.actionId)?.result;
    return result?.ok === true && TERMINAL_ACTION_STATUSES.has(result.status);
  });
  const receiptProviders = new Set(evidenceReceipts.map((receipt) => receipt.provider));
  const receiptMutationCount = journalReceipts.reduce((sum, receipt) => sum + receipt.mutationCount, 0);
  const planNodeIds = [...new Set(plan.actions.map((action) => action.nodeId))];
  const scopedNodesSucceeded = planNodeIds.every((nodeId) =>
    ['succeeded', 'skipped'].includes(run.nodeStates?.[nodeId]?.status)
  );
  const checks = [
    check(
      'ACCOUNT_ENVIRONMENT_DECLARED_TEST',
      profile.accountEnvironment === 'test',
      'Sandbox Profile declares a test account environment.',
      'Sandbox Profile must be recreated with --account-environment test.'
    ),
    check(
      'NATIVE_CLI_FIXED_HOST_TRANSPORT',
      run.transportProvenance === 'native-cli-fixed-host',
      'Run used the native CLI fixed-host HTTPS transport path.',
      'Injected or unrecorded transport runs cannot qualify as real provider acceptance.'
    ),
    check(
      'SANDBOX_RUN_SCOPED_NODES_SUCCEEDED',
      scopedNodesSucceeded,
      'Every Adapter Plan node reached a terminal success state.',
      'One or more Adapter Plan nodes did not reach a terminal success state.'
    ),
    check(
      'PREFLIGHT_BOUND',
      Boolean(preflight && preflight.status === 'ready' &&
        run.sandboxPreflightFingerprint === preflight.fingerprint),
      'Run is bound to immutable ready Preflight Evidence.',
      'Run has no matching ready Preflight Evidence.'
    ),
    check(
      'ACTION_RECEIPT_COVERAGE',
      terminalActions.length === plan.actions.length,
      'Every Adapter action has an integrity-checked terminal Receipt.',
      `Terminal Receipt coverage is ${terminalActions.length}/${plan.actions.length}.`
    ),
    check(
      'PROVIDER_COVERAGE',
      profile.providers.every((provider) => receiptProviders.has(provider)),
      'Every Profile provider appears in integrity-checked Receipts.',
      'One or more Profile providers have no Receipt evidence.'
    ),
    check(
      'PROVIDER_MUTATION_EXERCISED',
      (run.providerMutationsExecuted || 0) > 0,
      'The run exercised at least one provider mutation.',
      'A read-only or adopted-only run is insufficient for provider mutation acceptance.'
    ),
    check(
      'MUTATION_COUNT_RECONCILED',
      receiptMutationCount === (run.providerMutationsExecuted || 0),
      'Run mutation count equals the sum of integrity-checked Receipts.',
      'Run mutation count does not match its Receipt journal.'
    ),
    check(
      'MUTATION_BUDGET_RESPECTED',
      (run.providerMutationsExecuted || 0) <= profile.maxProviderMutations,
      'Provider mutations stayed within the immutable Sandbox budget.',
      'Provider mutation count exceeded the Sandbox budget.'
    ),
  ];
  const providerResults = profile.providers.map((provider) => {
    const actions = plan.actions.filter((action) => action.provider === provider);
    const providerReceipts = evidenceReceipts.filter((receipt) => receipt.provider === provider);
    const providerJournalReceipts = journalReceipts.filter((receipt) => receipt.provider === provider);
    const latest = new Map();
    for (const receipt of providerReceipts) latest.set(receipt.actionId, receipt);
    const terminalActionCount = actions.filter((action) => {
      const result = latest.get(action.actionId)?.result;
      return result?.ok === true && TERMINAL_ACTION_STATUSES.has(result.status);
    }).length;
    return {
      provider,
      actionCount: actions.length,
      terminalActionCount,
      receiptCount: providerReceipts.length,
      mutationCount: providerJournalReceipts.reduce((sum, receipt) => sum + receipt.mutationCount, 0),
      status: terminalActionCount === actions.length && actions.length > 0 ? 'passed' : 'failed',
    };
  });
  return { checks, providerResults };
}

function check(code, passed, passedMessage, failedMessage) {
  return { code, status: passed ? 'passed' : 'failed', message: passed ? passedMessage : failedMessage };
}

function readReport(file) {
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Sandbox Acceptance Report JSON is invalid: ${error.message}`); }
  return validateSandboxAcceptanceReport(report);
}

function validateProviders(providers, issues) {
  if (!Array.isArray(providers) || providers.length === 0 ||
      providers.some((provider) => typeof provider !== 'string' || !provider) ||
      new Set(providers).size !== providers.length) issues.push('providers');
}

function validateChecks(checks, issues) {
  if (!Array.isArray(checks) || checks.length === 0) {
    issues.push('checks');
    return;
  }
  const codes = new Set();
  for (const item of checks) {
    exactKeys(item, ['code', 'status', 'message'], '$.checks[]', issues);
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(item?.code || '') || codes.has(item.code)) issues.push('checks.code');
    if (!['passed', 'failed'].includes(item?.status)) issues.push('checks.status');
    if (typeof item?.message !== 'string' || !item.message) issues.push('checks.message');
    codes.add(item?.code);
  }
}

function validateProviderResults(results, providers, issues) {
  if (!Array.isArray(results)) {
    issues.push('providerResults');
    return;
  }
  for (const result of results) {
    exactKeys(result, [
      'provider', 'actionCount', 'terminalActionCount', 'receiptCount', 'mutationCount', 'status',
    ], '$.providerResults[]', issues);
    if (typeof result?.provider !== 'string' || !result.provider) issues.push('providerResults.provider');
    for (const key of ['actionCount', 'terminalActionCount', 'receiptCount', 'mutationCount']) {
      if (!Number.isInteger(result?.[key]) || result[key] < 0) issues.push(`providerResults.${key}`);
    }
    if (!['passed', 'failed'].includes(result?.status)) issues.push('providerResults.status');
  }
  if (stableStringify(results.map((item) => item.provider)) !== stableStringify(providers)) {
    issues.push('providerResults.coverage');
  }
}

function exactKeys(value, allowed, location, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(location);
    return;
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extras.length > 0) issues.push(`${location}.unsupported(${extras.join('|')})`);
  if (missing.length > 0) issues.push(`${location}.missing(${missing.join('|')})`);
}

function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
