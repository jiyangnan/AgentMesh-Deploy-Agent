import path from 'node:path';

import {
  DEFAULT_DIFF_ARTIFACT,
  DEFAULT_HANDOFF_ARTIFACT,
  DEFAULT_REVIEW_ARTIFACT,
} from './approval-constants.js';
import { buildManagedFileDiff, writeManagedFileDiffArtifact } from './diff.js';
import { buildHandoff, writeHandoffArtifact } from './handoff.js';
import { buildReview, writeReviewArtifact } from './review.js';
import { nowIso } from './utils.js';

export function prepareHandoffArtifacts(root, manifest, validation, state, options = {}) {
  const generatedAt = nowIso();
  const invalid = validation?.status === 'invalid';
  const artifacts = {};

  if (invalid) {
    const { review, file: reviewFile } = writeReviewArtifact(
      root,
      buildReview(root, manifest, validation, null, options),
      DEFAULT_REVIEW_ARTIFACT
    );
    const { handoff, file: handoffFile } = writeHandoffArtifact(
      root,
      buildHandoff(manifest, validation, null, options),
      DEFAULT_HANDOFF_ARTIFACT
    );

    artifacts.review = describeArtifact('review', reviewFile, root, review);
    artifacts.diff = {
      id: 'diff',
      status: 'skipped',
      file: path.join(root, DEFAULT_DIFF_ARTIFACT),
      rootRelativeFile: DEFAULT_DIFF_ARTIFACT,
      reason: 'manifest-invalid',
    };
    artifacts.handoff = describeArtifact('handoff', handoffFile, root, handoff);

    return buildPreparePayload({
      generatedAt,
      validation,
      handoff,
      artifacts,
    });
  }

  const { report: diff, file: diffFile } = writeManagedFileDiffArtifact(
    root,
    buildManagedFileDiff(root, manifest, state, options),
    DEFAULT_DIFF_ARTIFACT
  );
  artifacts.diff = describeArtifact('diff', diffFile, root, diff);

  const { review, file: reviewFile } = writeReviewArtifact(
    root,
    buildReview(root, manifest, validation, state, options),
    DEFAULT_REVIEW_ARTIFACT
  );
  artifacts.review = describeArtifact('review', reviewFile, root, review);

  const { handoff, file: handoffFile } = writeHandoffArtifact(
    root,
    buildHandoff(manifest, validation, state, options),
    DEFAULT_HANDOFF_ARTIFACT
  );
  artifacts.handoff = describeArtifact('handoff', handoffFile, root, handoff);

  return buildPreparePayload({
    generatedAt,
    validation,
    handoff,
    artifacts,
  });
}

function buildPreparePayload({ generatedAt, validation, handoff, artifacts }) {
  return {
    version: 1,
    kind: 'handoff-preparation',
    generatedAt,
    appId: handoff.appId,
    target: handoff.target,
    status: validation?.status === 'invalid' ? 'blocked' : handoff.readinessStatus,
    validation,
    planFingerprint: handoff.plan?.fingerprint || '',
    artifacts,
    approvalArtifacts: handoff.approvalArtifacts,
    nextActions: handoff.nextActions || [],
    commandContracts: handoff.commandContracts || [],
    suggestedCommands: handoff.suggestedCommands || [],
    applyDecision: handoff.applyDecision || null,
    handoff,
  };
}

function describeArtifact(id, file, root, payload) {
  return {
    id,
    status: 'written',
    file,
    rootRelativeFile: path.relative(root, file) || path.basename(file),
    kind: payload.kind || artifactKind(id),
    writtenAt: payload.artifact?.writtenAt || '',
  };
}

function artifactKind(id) {
  if (id === 'review') return 'deployment-review';
  if (id === 'diff') return 'managed-file-diff';
  if (id === 'handoff') return 'deployment-handoff';
  return id;
}
