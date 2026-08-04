import {
  buildApprovalArtifactNextActions,
  inspectApprovalArtifacts,
} from './approval-artifacts.js';
import { buildApplyDecision } from './apply-decision.js';
import { inspectPlanReadiness } from './doctor.js';
import { commandContracts, invalidManifestPlan, suggestedCommands } from './handoff.js';
import { buildPlan } from './plan.js';
import { summarizeDeployState } from './state.js';
import { nowIso } from './utils.js';

export function buildStatus(manifest, validation, state, options = {}) {
  const invalid = validation?.status === 'invalid';
  const plan = invalid ? invalidManifestPlan(manifest) : buildPlan(manifest, state);
  const stateSummary = invalid ? null : summarizeDeployState(state);
  const approvalArtifacts = invalid
    ? null
    : inspectApprovalArtifacts(options.root, manifest, state, plan, options);
  const doctor = inspectPlanReadiness(plan, {
    ...options,
    manifest,
    state,
    manifestIssues: validation?.issues || [],
  });
  const nextActions = [
    ...(doctor.nextActions || []),
    ...buildApprovalArtifactNextActions(approvalArtifacts),
  ];
  const commands = suggestedCommands(options.root, doctor, stateSummary);
  const applyDecision = buildApplyDecision({
    doctor,
    approvalArtifacts,
    suggestedCommands: commands,
  });

  return {
    version: 1,
    generatedAt: nowIso(),
    appId: plan.appId,
    target: plan.target,
    readinessStatus: doctor.status,
    validation,
    planFingerprint: plan.fingerprint || '',
    planSummary: plan.summary || {
      total: 0,
      pending: 0,
      skipped: 0,
    },
    state: stateSummary,
    approvalArtifacts,
    doctor,
    nextActions,
    commandContracts: commandContracts(stateSummary),
    suggestedCommands: commands,
    applyDecision,
  };
}
