import path from 'node:path';

import { approvalGateFlags } from './approval-constants.js';
import {
  buildApprovalArtifactNextActions,
  inspectApprovalArtifacts,
} from './approval-artifacts.js';
import { buildApplyDecision } from './apply-decision.js';
import { inspectPlanReadiness } from './doctor.js';
import { buildPlan } from './plan.js';
import { summarizeDeployState } from './state.js';
import { nowIso, writeJson } from './utils.js';

export function buildHandoff(manifest, validation, state, options = {}) {
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
    state: stateSummary,
    approvalArtifacts,
    plan,
    doctor,
    nextActions,
    commandContracts: commandContracts(stateSummary),
    suggestedCommands: commands,
    applyDecision,
  };
}

export function invalidManifestPlan(manifest) {
  return {
    version: 1,
    id: 'invalid-manifest',
    appId: manifest?.app?.id || '(invalid manifest)',
    target: manifest?.target || {},
    steps: [],
    summary: {
      total: 0,
      pending: 0,
      skipped: 0,
    },
    fingerprint: '',
  };
}

export function writeHandoffArtifact(root, handoff, outFile) {
  if (!outFile) return { handoff, file: '' };

  const file = path.isAbsolute(outFile) ? outFile : path.join(root, outFile);
  const payload = {
    ...handoff,
    artifact: {
      file,
      rootRelativeFile: path.relative(root, file) || path.basename(file),
      writtenAt: nowIso(),
    },
  };

  writeJson(file, payload);
  return { handoff: payload, file };
}

export function suggestedCommands(root, doctor, stateSummary = null) {
  const target = root || '.';
  const commands = [
    {
      id: 'schema',
      argv: ['agentmesh-deploy', 'schema'],
    },
    {
      id: 'onboard',
      argv: ['agentmesh-deploy', 'onboard', target, '--json'],
    },
    {
      id: 'validate',
      argv: ['agentmesh-deploy', 'validate', target, '--json'],
    },
    {
      id: 'status',
      argv: ['agentmesh-deploy', 'status', target, '--json'],
    },
    {
      id: 'prepare',
      argv: ['agentmesh-deploy', 'prepare', target, '--json'],
    },
    {
      id: 'review',
      argv: ['agentmesh-deploy', 'review', target, '--json'],
    },
    {
      id: 'doctor',
      argv: ['agentmesh-deploy', 'doctor', target, '--json'],
    },
    {
      id: 'doctor-auth-probe',
      argv: ['agentmesh-deploy', 'doctor', target, '--json', '--probe-auth'],
    },
  ];

  if (stateSummary) {
    const evidenceIndex = commands.findIndex((command) => command.id === 'prepare') + 1;
    commands.splice(
      evidenceIndex,
      0,
      {
        id: 'review-artifact',
        argv: [
          'agentmesh-deploy',
          'review',
          target,
          '--json',
          '--out',
          '.agentmesh-deploy/reviews/latest.json',
        ],
      },
      {
        id: 'diff',
        argv: ['agentmesh-deploy', 'diff', target, '--json'],
      },
      {
        id: 'diff-artifact',
        argv: [
          'agentmesh-deploy',
          'diff',
          target,
          '--json',
          '--out',
          '.agentmesh-deploy/diffs/latest.json',
        ],
      },
      {
        id: 'secrets',
        argv: ['agentmesh-deploy', 'secrets', target, '--json'],
      },
      {
        id: 'runs',
        argv: ['agentmesh-deploy', 'runs', target, '--json'],
      }
    );
  }

  if (stateSummary?.lastRun) {
    commands.push({
      id: 'latest-run',
      argv: ['agentmesh-deploy', 'runs', target, '--json', '--latest'],
    });
  }

  const blockingSetup = new Set(['fix-manifest', 'wait-for-deployment-lock']);
  if ((doctor.nextActions || []).some((action) => blockingSetup.has(action.id))) {
    return commands;
  }

  commands.push({
    id: 'dry-run-apply',
    argv: [
      'agentmesh-deploy',
      'apply',
      target,
      '--json',
      ...approvalWorkflowFlags(stateSummary),
      ...(doctor.planFingerprint ? ['--expect-plan', doctor.planFingerprint] : []),
    ],
  });

  const runApply = (doctor.nextActions || []).find((action) => action.id === 'run-apply');
  if (runApply?.flags?.length) {
    commands.push({
      id: 'execute-apply',
      argv: [
        'agentmesh-deploy',
        'apply',
        target,
        ...withApprovalWorkflowFlags(runApply.flags, stateSummary),
      ],
    });
  }

  const authorizationFlags = mergedAuthorizationFlags(doctor.nextActions || []);
  if (authorizationFlags.length && !runApply) {
    commands.push({
      id: 'authorized-apply-after-fixes',
      argv: [
        'agentmesh-deploy',
        'apply',
        target,
        ...withApprovalWorkflowFlags(authorizationFlags, stateSummary),
      ],
    });
  }

  return commands;
}

function mergedAuthorizationFlags(actions) {
  const authorizationActions = (actions || []).filter((action) =>
    ['authorize-provider-mutations', 'authorize-cost-mutations'].includes(action.id)
  );
  const seen = [];
  for (const action of authorizationActions) {
    for (const flag of action.flags || []) {
      if (!seen.includes(flag)) seen.push(flag);
    }
  }
  if (seen.length === 0) return [];

  const flags = ['--execute', '--yes'];
  if (seen.includes('--allow-provider-mutations')) flags.push('--allow-provider-mutations');
  if (seen.includes('--allow-cost-mutations')) flags.push('--allow-cost-mutations');
  const expectPlanIndex = seen.indexOf('--expect-plan');
  if (expectPlanIndex >= 0 && seen[expectPlanIndex + 1]) {
    flags.push('--expect-plan', seen[expectPlanIndex + 1]);
  }
  return flags;
}

export function commandContracts(stateSummary = null) {
  const commands = ['schema', 'onboard', 'validate', 'status', 'prepare', 'review', 'doctor'];
  if (stateSummary) {
    commands.push('diff', 'secrets', 'runs', 'handoff', 'apply');
  }
  return commands.map((command) => ({
    id: `${command}-contract`,
    command,
    argv: ['agentmesh-deploy', 'help', command, '--json'],
  }));
}

function approvalWorkflowFlags(stateSummary) {
  return stateSummary ? approvalGateFlags() : [];
}

function withApprovalWorkflowFlags(flags, stateSummary) {
  if (!stateSummary) return [...flags];

  const cleaned = removeApprovalGateFlags(flags);
  const expectPlanIndex = cleaned.indexOf('--expect-plan');
  if (expectPlanIndex === -1) {
    return [...cleaned, ...approvalGateFlags()];
  }

  return [
    ...cleaned.slice(0, expectPlanIndex),
    ...approvalGateFlags(),
    ...cleaned.slice(expectPlanIndex),
  ];
}

function removeApprovalGateFlags(flags) {
  const cleaned = [];
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === '--require-review' || flags[index] === '--require-diff') {
      index += 1;
      continue;
    }
    cleaned.push(flags[index]);
  }
  return cleaned;
}
