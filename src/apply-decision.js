const HARD_BLOCKER_ACTIONS = new Set([
  'fix-manifest',
  'install-missing-tools',
  'set-missing-env',
  'untrack-sensitive-files',
  'configure-git-identity',
  'wait-for-deployment-lock',
  'authenticate-provider',
  'review-provider-deletes',
  'implement-adapter-support',
]);

const NON_BLOCKING_ACTIONS = new Set([
  'recover-state',
]);

export function buildApplyDecision({ doctor = {}, approvalArtifacts = null, suggestedCommands = [] } = {}) {
  const approvalBlockers = approvalArtifactBlockers(approvalArtifacts);
  const actionBlockers = nextActionBlockers(doctor.nextActions || [], approvalArtifacts);
  const blockers = dedupeBlockers([...approvalBlockers, ...actionBlockers]);
  const nonBlockingActions = summarizeNonBlockingActions(doctor.nextActions || [], approvalArtifacts);
  const dryRunCommand = findSuggestedCommand(suggestedCommands, 'dry-run-apply');
  const executeCommand = findSuggestedCommand(suggestedCommands, 'execute-apply');
  const authorizedCommand = findSuggestedCommand(suggestedCommands, 'authorized-apply-after-fixes');
  const authorizationActions = (doctor.nextActions || []).filter((action) =>
    ['authorize-provider-mutations', 'authorize-cost-mutations'].includes(action.id)
  );
  const requiredApprovals = approvalNames(authorizationActions);
  const dryRunStatus = blockers.length > 0 ? 'blocked' : 'ready';
  const executeStatus = resolveExecuteStatus({
    blockers,
    authorizationActions,
    doctorStatus: doctor.status,
  });

  return {
    version: 1,
    kind: 'gated-apply-decision',
    dryRun: {
      status: dryRunStatus,
      command: dryRunCommand,
      blockers,
    },
    execute: {
      status: executeStatus,
      command: executeCommand || authorizedCommand,
      requiredApprovals,
      blockers,
    },
    nonBlockingActions,
    recommendedNextAction: recommendedNextAction({
      blockers,
      requiredApprovals,
      dryRunStatus,
      executeStatus,
    }),
  };
}

function approvalArtifactBlockers(approvalArtifacts) {
  if (!approvalArtifacts) return [];

  const stale = ['review', 'diff']
    .map((id) => ({ id, artifact: approvalArtifacts[id] }))
    .filter(({ artifact }) => artifact && artifact.current !== true);

  if (stale.length === 0) return [];

  return [{
    id: 'refresh-approval-artifacts',
    kind: 'approval-artifacts',
    title: 'Refresh required review and diff artifacts before gated apply.',
    artifacts: stale.map(({ id, artifact }) => ({
      id,
      status: artifact.status,
      file: artifact.rootRelativeFile,
      refreshCommand: artifact.refreshCommand,
      ...(artifact.error ? { error: artifact.error } : {}),
    })),
  }];
}

function nextActionBlockers(actions, approvalArtifacts) {
  return actions
    .filter((action) => isBlockingAction(action, approvalArtifacts))
    .map(summarizeAction);
}

function isBlockingAction(action, approvalArtifacts) {
  if (!action?.id) return false;
  if (action.id === 'authorize-provider-mutations') return false;
  if (action.id === 'authorize-cost-mutations') return false;
  if (action.id === 'review-managed-files') {
    return approvalArtifacts?.diff?.current !== true;
  }
  if (NON_BLOCKING_ACTIONS.has(action.id)) return false;
  return HARD_BLOCKER_ACTIONS.has(action.id);
}

function summarizeNonBlockingActions(actions, approvalArtifacts) {
  return actions
    .filter((action) => {
      if (!action?.id) return false;
      if (action.id === 'authorize-provider-mutations') return true;
      if (action.id === 'authorize-cost-mutations') return true;
      if (action.id === 'review-managed-files' && approvalArtifacts?.diff?.current === true) return true;
      return NON_BLOCKING_ACTIONS.has(action.id);
    })
    .map((action) => ({
      ...summarizeAction(action),
      ...(action.id === 'review-managed-files'
        ? { reason: 'covered-by-current-diff-artifact' }
        : {}),
    }));
}

function summarizeAction(action) {
  return {
    id: action.id,
    kind: action.kind || '',
    title: action.title || '',
    ...(action.flags ? { flags: action.flags } : {}),
    ...(action.env ? { env: action.env } : {}),
    ...(action.tools ? { tools: action.tools } : {}),
    ...(action.files ? { files: action.files } : {}),
    ...(action.providers ? { providers: action.providers } : {}),
    ...(action.stepIds ? { stepIds: action.stepIds } : {}),
    ...(action.config ? { config: action.config } : {}),
    ...(action.issues ? { issues: action.issues } : {}),
  };
}

function findSuggestedCommand(commands, id) {
  const command = (commands || []).find((entry) => entry.id === id);
  return command?.argv || null;
}

function resolveExecuteStatus({ blockers, authorizationActions, doctorStatus }) {
  if (blockers.length > 0) return 'blocked';
  if ((authorizationActions || []).length > 0) return 'needs-approval';
  if (doctorStatus === 'ready') return 'ready';
  return 'blocked';
}

function recommendedNextAction({ blockers, requiredApprovals, dryRunStatus, executeStatus }) {
  if (blockers.length > 0) return blockers[0].id;
  if (requiredApprovals.includes('cost-mutations')) return 'authorize-cost-mutations';
  if (requiredApprovals.length > 0) return 'authorize-provider-mutations';
  if (executeStatus === 'ready') return 'run-apply';
  if (dryRunStatus === 'ready') return 'run-gated-dry-run';
  return 'inspect-status';
}

function approvalNames(actions) {
  const names = [];
  if ((actions || []).some((action) => action.id === 'authorize-provider-mutations')) {
    names.push('provider-mutations');
  }
  if ((actions || []).some((action) => action.id === 'authorize-cost-mutations')) {
    names.push('cost-mutations');
  }
  return names;
}

function dedupeBlockers(blockers) {
  const seen = new Set();
  const result = [];
  for (const blocker of blockers) {
    if (!blocker?.id) continue;
    if (seen.has(blocker.id)) continue;
    seen.add(blocker.id);
    result.push(blocker);
  }
  return result;
}
