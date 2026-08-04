import path from 'node:path';

import {
  DEFAULT_DIFF_ARTIFACT,
  DEFAULT_REVIEW_ARTIFACT,
} from './approval-constants.js';
import { assertRequiredDiff } from './diff.js';
import { assertRequiredReview } from './review.js';
import { pathExists } from './utils.js';

export {
  DEFAULT_DIFF_ARTIFACT,
  DEFAULT_REVIEW_ARTIFACT,
} from './approval-constants.js';

export function inspectApprovalArtifacts(root, manifest, state, plan, options = {}) {
  const resolvedRoot = root || options.root || process.cwd();
  const target = root || options.root || '.';
  return {
    review: inspectReviewArtifact(resolvedRoot, plan, target),
    diff: inspectDiffArtifact(resolvedRoot, manifest, state, plan, target, options),
  };
}

export function buildApprovalArtifactNextActions(artifacts) {
  if (!artifacts) return [];

  const staleArtifacts = ['review', 'diff']
    .map((id) => ({ id, artifact: artifacts[id] }))
    .filter(({ artifact }) => artifact && artifact.current !== true);

  if (staleArtifacts.length === 0) return [];

  return [
    {
      id: 'refresh-approval-artifacts',
      kind: 'approval-artifacts',
      title: 'Refresh required review and diff artifacts before apply.',
      artifacts: staleArtifacts.map(({ id, artifact }) => ({
        id,
        status: artifact.status,
        file: artifact.rootRelativeFile,
        refreshCommand: artifact.refreshCommand,
        ...(artifact.error ? { error: artifact.error } : {}),
      })),
      commands: staleArtifacts.map(({ artifact }) => artifact.refreshCommand),
    },
  ];
}

function inspectReviewArtifact(root, plan, target) {
  const file = path.join(root, DEFAULT_REVIEW_ARTIFACT);
  const base = artifactBase(root, file, DEFAULT_REVIEW_ARTIFACT, [
    'agentmesh-deploy',
    'review',
    target,
    '--json',
    '--out',
    DEFAULT_REVIEW_ARTIFACT,
  ]);

  if (!pathExists(file)) {
    return { ...base, status: 'missing', current: false };
  }

  try {
    assertRequiredReview(root, plan, DEFAULT_REVIEW_ARTIFACT);
    return { ...base, status: 'current', current: true };
  } catch (error) {
    return {
      ...base,
      status: classifyReviewArtifactError(error),
      current: false,
      error: error.message,
    };
  }
}

function inspectDiffArtifact(root, manifest, state, plan, target, options) {
  const file = path.join(root, DEFAULT_DIFF_ARTIFACT);
  const base = artifactBase(root, file, DEFAULT_DIFF_ARTIFACT, [
    'agentmesh-deploy',
    'diff',
    target,
    '--json',
    '--out',
    DEFAULT_DIFF_ARTIFACT,
  ]);

  if (!pathExists(file)) {
    return { ...base, status: 'missing', current: false };
  }

  try {
    assertRequiredDiff(root, manifest, state, plan, DEFAULT_DIFF_ARTIFACT, options);
    return { ...base, status: 'current', current: true };
  } catch (error) {
    return {
      ...base,
      status: classifyDiffArtifactError(error),
      current: false,
      error: error.message,
    };
  }
}

function artifactBase(root, file, rootRelativeFile, refreshCommand) {
  return {
    file,
    rootRelativeFile: path.relative(root, file) || rootRelativeFile,
    refreshCommand,
  };
}

function classifyReviewArtifactError(error) {
  const message = String(error?.message || '');
  if (message.includes('could not be read') || message.includes('must be a deployment-review')) {
    return 'invalid';
  }
  if (message.includes('blocking reasons') || message.includes('must be ready')) {
    return 'blocked';
  }
  return 'stale';
}

function classifyDiffArtifactError(error) {
  const message = String(error?.message || '');
  if (message.includes('could not be read') || message.includes('must be a managed-file-diff')) {
    return 'invalid';
  }
  return 'stale';
}
