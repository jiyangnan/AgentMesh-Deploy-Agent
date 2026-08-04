import path from 'node:path';

import { buildPlan } from './plan.js';
import { renderManagedFile, redactManagedFileContent } from './renderers.js';
import { nowIso, pathExists, readJson, readTextIfExists, writeJson } from './utils.js';

export function buildManagedFileDiff(root, manifest, state, options = {}) {
  const plan = buildPlan(manifest, state);
  const renderContext = {};
  const files = plan.steps
    .flatMap((step) => step.actions || [])
    .filter((action) => action.type === 'file')
    .map((action) => diffManagedFile(root, action, manifest, state, renderContext, options));

  return {
    version: 1,
    kind: 'managed-file-diff',
    generatedAt: nowIso(),
    appId: plan.appId,
    target: plan.target,
    planFingerprint: plan.fingerprint || '',
    summary: summarizeFiles(files),
    files,
  };
}

export function writeManagedFileDiffArtifact(root, report, outFile) {
  if (!outFile) return { report, file: '' };

  const file = path.isAbsolute(outFile) ? outFile : path.join(root, outFile);
  const payload = {
    ...report,
    artifact: {
      file,
      rootRelativeFile: path.relative(root, file) || path.basename(file),
      writtenAt: nowIso(),
    },
  };

  writeJson(file, payload);
  return { report: payload, file };
}

export function assertRequiredDiff(root, manifest, state, plan, diffFile, options = {}) {
  if (!diffFile) return null;

  const file = path.isAbsolute(diffFile) ? diffFile : path.join(root, diffFile);
  const diff = readRequiredDiff(file);

  if (diff.kind !== 'managed-file-diff') {
    throw new Error('Required diff artifact must be a managed-file-diff packet.');
  }
  if (diff.appId !== plan.appId) {
    throw new Error(
      `Diff appId mismatch. Expected ${plan.appId || '(none)'}, artifact has ${diff.appId || '(none)'}.`
    );
  }

  assertDiffTarget(plan.target || {}, diff.target || {});

  if (diff.planFingerprint !== plan.fingerprint) {
    throw new Error(
      `Diff plan fingerprint mismatch. Expected ${diff.planFingerprint || '(none)'}, current ${plan.fingerprint || '(none)'}. Re-run agentmesh-deploy diff --json --out <file> before apply.`
    );
  }

  const current = buildManagedFileDiff(root, manifest, state, {
    ...options,
    unsafeRevealSecrets: false,
  });
  if (stableDiffPayload(diff) !== stableDiffPayload(current)) {
    throw new Error(
      'Required diff artifact does not match current managed file changes. Re-run agentmesh-deploy diff --json --out <file> before apply.'
    );
  }

  return {
    file,
    diff,
  };
}

export function unifiedDiff(filePath, currentContent, expectedContent) {
  if (currentContent === expectedContent) return '';

  const currentLines = splitLines(currentContent);
  const expectedLines = splitLines(expectedContent);
  const operations = diffLineOperations(currentLines, expectedLines);
  const lines = [
    `--- ${filePath} (current)`,
    `+++ ${filePath} (expected)`,
    `@@ -1,${currentLines.length} +1,${expectedLines.length} @@`,
  ];

  for (const operation of operations) {
    lines.push(`${operation.prefix}${operation.line}`);
  }

  return `${lines.join('\n')}\n`;
}

function diffManagedFile(root, action, manifest, state, renderContext, options) {
  const file = path.join(root, action.path);
  const exists = pathExists(file);
  const current = exists ? readTextIfExists(file) : '';
  const expected = renderManagedFile(root, action, manifest, state, renderContext);
  const status = !exists ? 'missing' : current === expected ? 'current' : 'stale';
  const revealSecrets = options.unsafeRevealSecrets === true;
  const currentRedaction = redactManagedFileContent(action.path, current, { revealSecrets });
  const expectedRedaction = redactManagedFileContent(action.path, expected, { revealSecrets });
  const valueOnlySecretChange =
    current !== expected &&
    currentRedaction.redacted &&
    expectedRedaction.redacted &&
    currentRedaction.content === expectedRedaction.content;

  return {
    path: action.path,
    status,
    exists,
    sensitive: expectedRedaction.sensitive,
    redacted: expectedRedaction.redacted,
    valueOnlySecretChange,
    diff: valueOnlySecretChange
      ? ''
      : unifiedDiff(action.path, currentRedaction.content, expectedRedaction.content),
    ...(expectedRedaction.redacted
      ? {
          redactionNote: valueOnlySecretChange
            ? 'Only redacted secret values differ. Use --unsafe-reveal-secrets only for a local manual audit.'
            : 'Secret-bearing values are redacted.',
        }
      : {}),
  };
}

function summarizeFiles(files) {
  const summary = {
    total: files.length,
    current: 0,
    stale: 0,
    missing: 0,
    changed: 0,
    sensitive: 0,
    redacted: 0,
    valueOnlySecretChanges: 0,
  };

  for (const file of files) {
    summary[file.status] = (summary[file.status] || 0) + 1;
    if (file.status !== 'current') summary.changed += 1;
    if (file.sensitive) summary.sensitive += 1;
    if (file.redacted) summary.redacted += 1;
    if (file.valueOnlySecretChange) summary.valueOnlySecretChanges += 1;
  }

  return summary;
}

function readRequiredDiff(file) {
  try {
    return readJson(file);
  } catch (error) {
    throw new Error(
      `Required diff artifact could not be read: ${file}. Run agentmesh-deploy diff --json --out <file> first. ${error.message}`
    );
  }
}

function assertDiffTarget(expected, actual) {
  for (const field of ['provider', 'type', 'environment']) {
    const expectedValue = expected?.[field] || '';
    const actualValue = actual?.[field] || '';
    if (expectedValue !== actualValue) {
      throw new Error(
        `Diff target ${field} mismatch. Expected ${expectedValue || '(none)'}, artifact has ${actualValue || '(none)'}.`
      );
    }
  }
}

function stableDiffPayload(report) {
  return JSON.stringify({
    version: report.version,
    kind: report.kind,
    appId: report.appId,
    target: stableTarget(report.target || {}),
    planFingerprint: report.planFingerprint || '',
    summary: stableSummary(report.summary || {}),
    files: (report.files || []).map((file) => ({
      path: file.path,
      status: file.status,
      exists: Boolean(file.exists),
      sensitive: Boolean(file.sensitive),
      redacted: Boolean(file.redacted),
      valueOnlySecretChange: Boolean(file.valueOnlySecretChange),
      diff: file.diff || '',
      redactionNote: file.redactionNote || '',
    })),
  });
}

function stableTarget(target) {
  return {
    provider: target.provider || '',
    type: target.type || '',
    environment: target.environment || '',
  };
}

function stableSummary(summary) {
  return {
    total: Number(summary.total || 0),
    current: Number(summary.current || 0),
    stale: Number(summary.stale || 0),
    missing: Number(summary.missing || 0),
    changed: Number(summary.changed || 0),
    sensitive: Number(summary.sensitive || 0),
    redacted: Number(summary.redacted || 0),
    valueOnlySecretChanges: Number(summary.valueOnlySecretChanges || 0),
  };
}

function splitLines(content) {
  const value = String(content || '');
  if (!value) return [];
  return value.replace(/\n$/, '').split(/\r?\n/);
}

function diffLineOperations(currentLines, expectedLines) {
  const table = Array.from({ length: currentLines.length + 1 }, () =>
    Array(expectedLines.length + 1).fill(0)
  );

  for (let i = currentLines.length - 1; i >= 0; i -= 1) {
    for (let j = expectedLines.length - 1; j >= 0; j -= 1) {
      table[i][j] = currentLines[i] === expectedLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  while (i < currentLines.length || j < expectedLines.length) {
    if (i < currentLines.length && j < expectedLines.length && currentLines[i] === expectedLines[j]) {
      operations.push({ prefix: ' ', line: currentLines[i] });
      i += 1;
      j += 1;
    } else if (j < expectedLines.length && (i === currentLines.length || table[i][j + 1] >= table[i + 1][j])) {
      operations.push({ prefix: '+', line: expectedLines[j] });
      j += 1;
    } else {
      operations.push({ prefix: '-', line: currentLines[i] });
      i += 1;
    }
  }

  return operations;
}
