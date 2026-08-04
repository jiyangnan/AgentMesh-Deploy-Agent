import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { operationError } from './errors.js';
import { projectPath, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { runGit } from './repository.js';
import { nowIso } from './utils.js';

export function createIsolatedWorkspace(home, project, { purpose = 'analyze' } = {}) {
  const targetHome = resolveDeployHome(home);
  const runId = `${purpose}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const root = path.join(targetHome, 'workspaces', project.id, runId);
  const source = path.join(root, 'source');
  const overlay = path.join(root, 'overlay');
  const artifacts = path.join(root, 'artifacts');

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  runGit(root, ['clone', '--no-checkout', '--no-hardlinks', '--', project.source.locator, source]);
  runGit(source, ['checkout', '--detach', project.source.commit]);
  const actualCommit = runGit(source, ['rev-parse', 'HEAD']).stdout.trim();
  if (actualCommit !== project.source.commit) {
    throw operationError('CONFLICT', `Workspace commit mismatch: expected ${project.source.commit}, found ${actualCommit}`);
  }

  fs.mkdirSync(overlay, { recursive: true, mode: 0o700 });
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const workspace = {
    version: 1,
    runId,
    purpose,
    projectId: project.id,
    createdAt: nowIso(),
    sourceRef: {
      kind: project.source.kind,
      locator: project.source.locator,
      commit: actualCommit,
    },
    paths: { root, source, overlay, artifacts },
    projectControlPath: projectPath(targetHome, project.id),
  };
  writeJsonAtomic(path.join(root, 'workspace.json'), workspace);
  return workspace;
}
