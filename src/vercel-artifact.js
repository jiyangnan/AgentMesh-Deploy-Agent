import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  artifactIndexPath,
  assertFileIntegrity,
  copyFileAtomic,
  readArtifactIndex,
  sensitiveArtifactPaths,
  sha256File,
  verifyArtifact,
  withRepositoryGuard,
} from './artifact.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import {
  projectPath,
  readProjectRecord,
  resolveDeployHome,
  updateProjectRecord,
  writeJsonAtomic,
  writeProjectArtifact,
} from './project-store.js';
import { assertControlHomeSeparated, runGit } from './repository.js';
import { nowIso } from './utils.js';
import { createIsolatedWorkspace } from './workspace.js';

export function createVercelFileManifest(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'artifact-vercel', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    return withRepositoryGuard(project.source, (completeGuard) => {
      const workspace = createIsolatedWorkspace(home, project, { purpose: 'vercel-artifact' });
      runGit(workspace.paths.source, ['remote', 'remove', 'origin'], { allowFailure: true });
      const entries = readLockedTree(workspace.paths.source, project.source.commit);
      const blocked = sensitiveArtifactPaths(entries.map((entry) => entry.file));
      if (blocked.length > 0) {
        throw operationError(
          'SECRET_IN_ARTIFACT_SOURCE',
          `Vercel artifact source contains tracked sensitive files: ${blocked.join(', ')}`
        );
      }

      const artifactRoot = path.join(projectPath(home, project.id), 'artifacts');
      const blobRoot = path.join(artifactRoot, 'vercel-blobs');
      const manifestRoot = path.join(artifactRoot, 'vercel-manifests');
      fs.mkdirSync(blobRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(manifestRoot, { recursive: true, mode: 0o700 });

      const files = [];
      const blobsByDigest = new Map();
      for (const entry of entries) {
        const sourceFile = path.join(workspace.paths.source, ...entry.file.split('/'));
        const stat = fs.lstatSync(sourceFile);
        if (!stat.isFile() || !['100644', '100755'].includes(entry.mode)) {
          throw operationError('UNSUPPORTED', `Vercel artifact does not support Git mode ${entry.mode}: ${entry.file}`);
        }
        const contentDigest = sha256File(sourceFile);
        const sha = hashFile(sourceFile, 'sha1');
        const blobFile = path.join(blobRoot, contentDigest);
        if (fs.existsSync(blobFile)) assertFileIntegrity(blobFile, contentDigest, stat.size);
        else copyFileAtomic(sourceFile, blobFile);
        files.push({ file: entry.file, sha, size: stat.size, contentDigest });
        if (!blobsByDigest.has(contentDigest)) {
          blobsByDigest.set(contentDigest, {
            digest: contentDigest,
            size: stat.size,
            sha,
            file: blobFile,
          });
        }
      }

      const manifest = {
        version: 1,
        kind: 'vercel-file-manifest',
        projectId: project.id,
        sourceRef: {
          kind: project.source.kind,
          locator: project.source.locator,
          commit: project.source.commit,
        },
        files,
      };
      const workspaceManifest = path.join(workspace.paths.artifacts, 'vercel-file-manifest.json');
      fs.writeFileSync(workspaceManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const digest = sha256File(workspaceManifest);
      const size = fs.statSync(workspaceManifest).size;
      const artifactId = `sha256:${digest}`;
      const canonicalFile = path.join(manifestRoot, `${digest}.json`);
      if (fs.existsSync(canonicalFile)) assertFileIntegrity(canonicalFile, digest, size);
      else copyFileAtomic(workspaceManifest, canonicalFile);

      const index = readArtifactIndex(home, project.id);
      const digestMatch = index.artifacts.find((artifact) => artifact.id === artifactId);
      if (digestMatch && digestMatch.kind !== 'vercel-file-manifest') {
        throw operationError('CONFLICT', `Vercel artifact digest conflicts with existing artifact metadata: ${artifactId}`);
      }
      const artifact = digestMatch || {
        version: 1,
        id: artifactId,
        projectId: project.id,
        kind: 'vercel-file-manifest',
        format: 'json+content-addressed-blobs',
        sourceRef: manifest.sourceRef,
        digest: { algorithm: 'sha256', value: digest },
        size,
        totalFileBytes: files.reduce((total, file) => total + file.size, 0),
        file: canonicalFile,
        files,
        blobs: [...blobsByDigest.values()].sort((left, right) => left.digest.localeCompare(right.digest)),
        createdAt: nowIso(),
        createdByRun: workspace.runId,
      };

      if (digestMatch) {
        verifyArtifact({ home, projectId: project.id, artifactId });
      } else {
        writeJsonAtomic(path.join(artifactRoot, `${digest}.json`), artifact);
        writeJsonAtomic(artifactIndexPath(home, project.id), {
          ...index,
          artifacts: [...index.artifacts, artifact].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        });
      }

      const repositoryGuard = completeGuard();
      const createdAt = nowIso();
      const run = {
        version: 1,
        kind: 'vercel-artifact-run',
        runId: workspace.runId,
        projectId: project.id,
        createdAt,
        status: 'succeeded',
        reused: Boolean(digestMatch),
        artifact,
        workspace,
        repositoryGuard,
        providerMutationsExecuted: 0,
        productRepositoryChanged: false,
      };
      const runFile = writeProjectArtifact(home, project.id, path.join('runs', `${workspace.runId}.json`), run);
      withControlLock(home, 'registry', 'vercel-artifact-register', () => {
        const latest = readProjectRecord(home, project.id, { includeArchived: true });
        if (latest.status !== 'active' || latest.source.commit !== project.source.commit) {
          throw operationError('CONFLICT', `Project changed while Vercel artifact was being created: ${project.id}`);
        }
        updateProjectRecord(home, {
          ...latest,
          lastVercelArtifact: { id: artifact.id, commit: project.source.commit, createdAt, runId: workspace.runId, runFile },
          updatedAt: createdAt,
        });
      });

      return {
        kind: 'vercel-file-manifest-created',
        status: 'succeeded',
        home,
        reused: Boolean(digestMatch),
        artifact,
        workspace,
        repositoryGuard,
        runFile,
        providerMutationsExecuted: 0,
        productRepositoryChanged: false,
      };
    });
  });
}

function readLockedTree(root, commit) {
  const output = runGit(root, ['ls-tree', '-r', '-z', commit]).stdout;
  const entries = output.split('\0').filter(Boolean).map((record) => {
    const separator = record.indexOf('\t');
    if (separator < 0) throw operationError('VALIDATION_FAILED', 'Git tree entry is malformed.');
    const [mode, type] = record.slice(0, separator).split(' ');
    const file = record.slice(separator + 1);
    if (type !== 'blob') throw operationError('UNSUPPORTED', `Vercel artifact does not support Git object type ${type}: ${file}`);
    if (!isSafeRelativeFile(file)) throw operationError('PATH_BOUNDARY_VIOLATION', `Unsafe Vercel artifact path: ${file}`);
    return { mode, file };
  }).sort((left, right) => left.file.localeCompare(right.file));
  const folded = new Set();
  for (const entry of entries) {
    const key = entry.file.toLowerCase();
    if (folded.has(key)) throw operationError('CONFLICT', `Case-insensitive duplicate Vercel artifact path: ${entry.file}`);
    folded.add(key);
  }
  if (entries.length === 0) throw operationError('VALIDATION_FAILED', 'Locked Git commit has no files.');
  return entries;
}

function isSafeRelativeFile(value) {
  if (!value || value.startsWith('/') || value.includes('\\')) return false;
  return !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}
