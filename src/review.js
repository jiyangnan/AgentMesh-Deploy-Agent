import path from 'node:path';

import { DEFAULT_REVIEW_ARTIFACT } from './approval-constants.js';
import { buildPlan } from './plan.js';
import { buildRunsReport } from './runs.js';
import { buildSecretsReport } from './secrets.js';
import { buildStatus } from './status.js';
import { nowIso, readJson, writeJson } from './utils.js';

const APPROVABLE_BLOCKING_REASONS = new Set(['policy-blocked']);

export function buildReview(root, manifest, validation, state, options = {}) {
  const status = buildStatus(manifest, validation, state, options);
  const invalid = validation?.status === 'invalid';
  const plan = invalid ? null : buildPlan(manifest, state);
  const secrets = invalid ? null : buildSecretsReport(root, manifest, plan, state);
  const runs = invalid ? null : buildRunsReport(root, state, options);
  const doctor = status.doctor || {};

  return {
    version: 1,
    kind: 'deployment-review',
    generatedAt: status.generatedAt,
    appId: status.appId,
    target: status.target,
    reviewStatus: status.readinessStatus,
    validation,
    planFingerprint: status.planFingerprint,
    readiness: {
      status: status.readinessStatus,
      pendingSteps: doctor.pendingSteps || 0,
      skippedSteps: doctor.skippedSteps || 0,
      verifyTarget: doctor.verifyTarget || '',
    },
    secretSummary: summarizeSecrets(secrets),
    runSummary: summarizeRuns(runs, state),
    managedFileDrift: doctor.managedFileDrift || [],
    blockingReasons: blockingReasons(doctor),
    nextActions: status.nextActions || [],
    commandContracts: status.commandContracts || [],
    suggestedCommands: status.suggestedCommands || [],
    applyDecision: status.applyDecision || null,
  };
}

export function writeReviewArtifact(root, review, outFile) {
  if (!outFile) return { review, file: '' };

  const file = path.isAbsolute(outFile) ? outFile : path.join(root, outFile);
  const rootRelativeFile = path.relative(root, file) || path.basename(file);
  const isDefaultReviewArtifact = rootRelativeFile === DEFAULT_REVIEW_ARTIFACT;
  const nextActions = isDefaultReviewArtifact
    ? omitDefaultReviewRefreshAction(review.nextActions || [])
    : review.nextActions;
  const applyDecision = isDefaultReviewArtifact
    ? omitDefaultReviewRefreshFromApplyDecision(review.applyDecision)
    : review.applyDecision;
  const payload = {
    ...review,
    nextActions,
    applyDecision,
    artifact: {
      file,
      rootRelativeFile,
      writtenAt: nowIso(),
    },
  };

  writeJson(file, payload);
  return { review: payload, file };
}

function omitDefaultReviewRefreshAction(actions) {
  return actions.flatMap((action) => {
    if (action.id !== 'refresh-approval-artifacts') return [action];

    const artifacts = (action.artifacts || []).filter((artifact) => artifact.id !== 'review');
    if (artifacts.length === 0) return [];

    return [{
      ...action,
      artifacts,
      commands: artifacts.map((artifact) => artifact.refreshCommand).filter(Boolean),
    }];
  });
}

function omitDefaultReviewRefreshFromApplyDecision(decision) {
  if (!decision) return decision;

  const dryRunBlockers = omitDefaultReviewRefreshBlockers(decision.dryRun?.blockers || []);
  const executeBlockers = omitDefaultReviewRefreshBlockers(decision.execute?.blockers || []);
  const requiredApprovals = decision.execute?.requiredApprovals || [];
  const dryRunStatus = dryRunBlockers.length > 0 ? 'blocked' : 'ready';
  const executeStatus = resolveAdjustedExecuteStatus({
    originalStatus: decision.execute?.status,
    blockers: executeBlockers,
    requiredApprovals,
    command: decision.execute?.command,
  });

  return {
    ...decision,
    dryRun: {
      ...(decision.dryRun || {}),
      status: dryRunStatus,
      blockers: dryRunBlockers,
    },
    execute: {
      ...(decision.execute || {}),
      status: executeStatus,
      blockers: executeBlockers,
    },
    recommendedNextAction: adjustedRecommendedNextAction({
      blockers: dryRunBlockers,
      requiredApprovals,
      dryRunStatus,
      executeStatus,
    }),
  };
}

function omitDefaultReviewRefreshBlockers(blockers) {
  return blockers.flatMap((blocker) => {
    if (blocker.id !== 'refresh-approval-artifacts') return [blocker];

    const artifacts = (blocker.artifacts || []).filter((artifact) => artifact.id !== 'review');
    if (artifacts.length === 0) return [];

    return [{
      ...blocker,
      artifacts,
    }];
  });
}

function resolveAdjustedExecuteStatus({ originalStatus, blockers, requiredApprovals, command }) {
  if (blockers.length > 0) return 'blocked';
  if (requiredApprovals.length > 0) return 'needs-approval';
  if (originalStatus === 'ready' || command?.length) return 'ready';
  return 'blocked';
}

function adjustedRecommendedNextAction({ blockers, requiredApprovals, dryRunStatus, executeStatus }) {
  if (blockers.length > 0) return blockers[0].id;
  if (requiredApprovals.includes('cost-mutations')) return 'authorize-cost-mutations';
  if (requiredApprovals.length > 0) return 'authorize-provider-mutations';
  if (executeStatus === 'ready') return 'run-apply';
  if (dryRunStatus === 'ready') return 'run-gated-dry-run';
  return 'inspect-status';
}

export function assertRequiredReview(root, plan, reviewFile) {
  if (!reviewFile) return null;

  const file = path.isAbsolute(reviewFile) ? reviewFile : path.join(root, reviewFile);
  const review = readRequiredReview(file);

  if (review.kind !== 'deployment-review') {
    throw new Error('Required review artifact must be a deployment-review packet.');
  }
  if (review.appId !== plan.appId) {
    throw new Error(
      `Review appId mismatch. Expected ${plan.appId || '(none)'}, artifact has ${review.appId || '(none)'}.`
    );
  }

  assertReviewTarget(plan.target || {}, review.target || {});

  if (review.planFingerprint !== plan.fingerprint) {
    throw new Error(
      `Review plan fingerprint mismatch. Expected ${review.planFingerprint || '(none)'}, current ${plan.fingerprint || '(none)'}. Re-run agentmesh-deploy review and re-approve the updated plan before apply.`
    );
  }
  if (review.validation?.status !== 'valid') {
    throw new Error(
      `Required review artifact validation status must be valid, got ${review.validation?.status || '(missing)'}.`
    );
  }

  assertReviewReadiness(review);

  return {
    file,
    review,
  };
}

function summarizeSecrets(secrets) {
  if (!secrets) return null;
  return {
    total: secrets.secrets.length,
    shellEnv: secrets.shellEnv.length,
    managedEnv: secrets.managedEnv.length,
    state: secrets.state?.length || 0,
    missingShellEnv: secrets.missingShellEnv,
    missingManagedEnv: secrets.missingManagedEnv.map((item) => ({
      key: item.key,
      file: item.file,
      generated: Boolean(item.generated),
      consumers: item.consumers || [],
    })),
    missingState: secrets.missingState || [],
    consumers: summarizeSecretConsumers(secrets.secrets),
  };
}

function summarizeSecretConsumers(secrets) {
  const consumers = new Map();
  for (const secret of secrets) {
    const current = consumers.get(secret.consumer) || { consumer: secret.consumer, total: 0, missing: 0 };
    current.total += 1;
    if (!secret.present) current.missing += 1;
    consumers.set(secret.consumer, current);
  }
  return Array.from(consumers.values()).sort((a, b) => a.consumer.localeCompare(b.consumer));
}

function summarizeRuns(runs, state) {
  if (!runs) return null;
  const latest = runs.runs[0] || null;
  return {
    total: Array.isArray(state?.runs) ? state.runs.length : 0,
    latest: latest
      ? {
          id: latest.id,
          command: latest.command || '',
          mode: latest.mode || '',
          status: latest.status || '',
          createdAt: latest.createdAt || '',
          file: latest.file || '',
          failedStep: latest.failedStep || null,
          resultCounts: latest.resultCounts || null,
        }
      : null,
  };
}

function blockingReasons(doctor) {
  const reasons = [];
  if ((doctor.manifestIssues || []).some((issue) => issue.severity === 'error')) {
    reasons.push('manifest-errors');
  }
  if (doctor.missingTools?.length) reasons.push('missing-tools');
  if (doctor.missingEnv?.length) reasons.push('missing-env');
  if (doctor.trackedSensitiveFiles?.length) reasons.push('tracked-sensitive-files');
  if (doctor.missingGitIdentity?.length) reasons.push('missing-git-identity');
  if (doctor.deploymentLock?.status === 'active') reasons.push('active-deployment-lock');
  if ((doctor.providerAuthChecks || []).some((check) => check.status === 'failed')) {
    reasons.push('provider-auth-failed');
  }
  if (doctor.policyBlocked?.length) reasons.push('policy-blocked');
  if (doctor.unsupportedActions?.length) reasons.push('unsupported-actions');
  return reasons;
}

function readRequiredReview(file) {
  try {
    return readJson(file);
  } catch (error) {
    throw new Error(
      `Required review artifact could not be read: ${file}. Run agentmesh-deploy review --json --out <file> first. ${error.message}`
    );
  }
}

function assertReviewTarget(expected, actual) {
  for (const field of ['provider', 'type', 'environment']) {
    const expectedValue = expected?.[field] || '';
    const actualValue = actual?.[field] || '';
    if (expectedValue !== actualValue) {
      throw new Error(
        `Review target ${field} mismatch. Expected ${expectedValue || '(none)'}, artifact has ${actualValue || '(none)'}.`
      );
    }
  }
}

function assertReviewReadiness(review) {
  const reasons = Array.isArray(review.blockingReasons) ? review.blockingReasons : [];
  const disallowedReasons = reasons.filter((reason) => !APPROVABLE_BLOCKING_REASONS.has(reason));
  if (disallowedReasons.length > 0) {
    throw new Error(
      `Required review artifact still has blocking reasons: ${disallowedReasons.join(', ')}. Regenerate review after fixing them.`
    );
  }

  if (review.reviewStatus === 'ready') return;

  const policyOnlyBlocked =
    review.reviewStatus === 'blocked' &&
    reasons.length > 0 &&
    reasons.every((reason) => APPROVABLE_BLOCKING_REASONS.has(reason));
  if (policyOnlyBlocked) return;

  throw new Error(
    `Required review artifact must be ready or blocked only by explicit policy approval, got ${review.reviewStatus || '(missing)'}.`
  );
}
