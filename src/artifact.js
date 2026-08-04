import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { withControlLock } from "./control-lock.js";
import { operationError } from "./errors.js";
import {
  projectPath,
  readProjectRecord,
  resolveDeployHome,
  updateProjectRecord,
  writeJsonAtomic,
  writeProjectArtifact,
} from "./project-store.js";
import {
  assertControlHomeSeparated,
  captureSourceGuard,
  completeSourceGuard,
  runGit,
} from "./repository.js";
import { sensitiveTrackedFiles } from "./tooling.js";
import { nowIso } from "./utils.js";
import { createIsolatedWorkspace } from "./workspace.js";

const ARTIFACT_INDEX_VERSION = 1;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function createArtifact(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(
    home,
    `project:${options.projectId}`,
    "artifact-create",
    () => {
      const project = readProjectRecord(home, options.projectId);
      assertControlHomeSeparated(home, project.source);
      return withRepositoryGuard(project.source, (completeGuard) => {
        const workspace = createIsolatedWorkspace(home, project, {
          purpose: "artifact",
        });
        const trackedFiles = runGit(workspace.paths.source, [
          "ls-tree",
          "-r",
          "--name-only",
          project.source.commit,
        ])
          .stdout.split(/\r?\n/)
          .filter(Boolean);
        const blockedFiles = sensitiveArtifactPaths(trackedFiles);
        if (blockedFiles.length > 0) {
          throw operationError(
            "SECRET_IN_ARTIFACT_SOURCE",
            `Artifact source contains tracked sensitive files: ${blockedFiles.join(", ")}`,
          );
        }

        const workspaceArchive = path.join(
          workspace.paths.artifacts,
          `${project.id}-${project.source.commit.slice(0, 12)}.tar.gz`,
        );
        runGit(workspace.paths.source, [
          "archive",
          "--format=tar.gz",
          "-o",
          workspaceArchive,
          project.source.commit,
        ]);
        const repositoryGuard = completeGuard();
        const digest = sha256File(workspaceArchive);
        const stat = fs.statSync(workspaceArchive);
        const artifactId = `sha256:${digest}`;
        const artifactDirectory = path.join(
          projectPath(home, project.id),
          "artifacts",
        );
        const canonicalFile = path.join(artifactDirectory, `${digest}.tar.gz`);
        fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });

        let reused = false;
        if (fs.existsSync(canonicalFile)) {
          reused = true;
          assertFileIntegrity(canonicalFile, digest, stat.size);
        } else {
          copyFileAtomic(workspaceArchive, canonicalFile);
        }
        fs.chmodSync(workspaceArchive, 0o444);

        const index = readArtifactIndex(home, project.id);
        const existing = index.artifacts.find(
          (artifact) => artifact.id === artifactId,
        );
        const artifact = existing || {
          version: 1,
          id: artifactId,
          projectId: project.id,
          kind: "source-archive",
          format: "tar.gz",
          sourceRef: {
            kind: project.source.kind,
            locator: project.source.locator,
            commit: project.source.commit,
          },
          digest: {
            algorithm: "sha256",
            value: digest,
          },
          size: stat.size,
          file: canonicalFile,
          createdAt: nowIso(),
          createdByRun: workspace.runId,
        };
        if (existing) {
          assertArtifactMatches(
            existing,
            project,
            digest,
            stat.size,
            canonicalFile,
          );
        } else {
          writeJsonAtomic(
            path.join(artifactDirectory, `${digest}.json`),
            artifact,
          );
          writeJsonAtomic(artifactIndexPath(home, project.id), {
            ...index,
            artifacts: [...index.artifacts, artifact].sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            ),
          });
        }

        const createdAt = nowIso();
        const run = {
          version: 1,
          kind: "artifact-run",
          runId: workspace.runId,
          projectId: project.id,
          createdAt,
          status: "succeeded",
          reused,
          artifact,
          workspace,
          repositoryGuard,
        };
        const runFile = writeProjectArtifact(
          home,
          project.id,
          path.join("runs", `${workspace.runId}.json`),
          run,
        );
        withControlLock(home, "registry", "artifact-register", () => {
          const latest = readProjectRecord(home, project.id, {
            includeArchived: true,
          });
          if (latest.status !== "active") {
            throw operationError(
              "CONFLICT",
              `Project was archived while artifact creation was running: ${project.id}`,
            );
          }
          if (
            latest.source.locator !== project.source.locator ||
            latest.source.commit !== project.source.commit
          ) {
            throw operationError(
              "CONFLICT",
              `Project source changed while artifact creation was running: ${project.id}`,
            );
          }
          updateProjectRecord(home, {
            ...latest,
            lastArtifact: {
              id: artifact.id,
              commit: artifact.sourceRef.commit,
              createdAt,
              runId: workspace.runId,
              runFile,
            },
            updatedAt: createdAt,
          });
        });

        return {
          kind: "artifact-created",
          status: "succeeded",
          home,
          reused,
          artifact,
          workspace,
          repositoryGuard,
          runFile,
        };
      });
    },
  );
}

export function listArtifacts(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const index = readArtifactIndex(home, project.id);
  return {
    kind: "artifact-list",
    projectId: project.id,
    home,
    count: index.artifacts.length,
    artifacts: index.artifacts,
  };
}

export function showArtifact(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  return {
    kind: "artifact",
    projectId: project.id,
    home,
    artifact: findArtifact(home, project.id, options.artifactId),
  };
}

export function verifyArtifact(options) {
  const report = showArtifact(options);
  const artifact = report.artifact;
  assertArtifactPath(report.home, report.projectId, artifact.file);
  if (!fs.existsSync(artifact.file)) {
    throw operationError(
      "ARTIFACT_INTEGRITY_FAILED",
      `Artifact file is missing: ${artifact.id}`,
    );
  }
  assertFileIntegrity(artifact.file, artifact.digest.value, artifact.size);
  if (artifact.kind === 'vercel-file-manifest') {
    assertVercelFileManifestIntegrity(report.home, report.projectId, artifact);
  }
  return {
    ...report,
    kind: "artifact-verification",
    status: "valid",
    verifiedAt: nowIso(),
  };
}

function assertVercelFileManifestIntegrity(home, projectId, artifact) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(artifact.file, 'utf8'));
  } catch (error) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Vercel manifest JSON is invalid: ${error.message}`);
  }
  if (
    manifest.version !== 1 || manifest.kind !== 'vercel-file-manifest' ||
    manifest.projectId !== projectId || manifest.sourceRef?.commit !== artifact.sourceRef?.commit ||
    JSON.stringify(manifest.files) !== JSON.stringify(artifact.files) || !Array.isArray(artifact.blobs)
  ) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Vercel manifest metadata does not match artifact ${artifact.id}`);
  }
  const blobs = new Map(artifact.blobs.map((blob) => [blob.digest, blob]));
  for (const file of artifact.files) {
    const blob = blobs.get(file.contentDigest);
    if (
      !blob || blob.digest !== file.contentDigest || blob.size !== file.size || blob.sha !== file.sha ||
      path.basename(blob.file) !== blob.digest
    ) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `Vercel blob metadata is invalid for ${file.file}`);
    }
    assertArtifactPath(home, projectId, blob.file);
    if (!fs.existsSync(blob.file)) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `Vercel artifact blob is missing for ${file.file}`);
    }
    assertFileIntegrity(blob.file, blob.digest, blob.size);
    if (hashFile(blob.file, 'sha1') !== file.sha) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `Vercel SHA-1 integrity check failed for ${file.file}`);
    }
  }
}

export function currentDeployArtifact(home, projectId, commit, options = {}) {
  const supportedKinds = options.provider === 'vercel'
    ? new Set(['vercel-file-manifest'])
    : new Set(['source-archive', 'runtime-build']);
  const candidates = readArtifactIndex(home, projectId).artifacts
    .filter((artifact) => artifact.sourceRef?.commit === commit && supportedKinds.has(artifact.kind))
    .sort((left, right) => {
      if (options.provider === 'vercel') return right.createdAt.localeCompare(left.createdAt);
      const kindOrder = Number(right.kind === 'runtime-build') - Number(left.kind === 'runtime-build');
      return kindOrder || right.createdAt.localeCompare(left.createdAt);
    });
  const artifact = candidates[0];
  if (!artifact) return null;
  if (
    artifact.projectId !== projectId ||
    !supportedKinds.has(artifact.kind) ||
    artifact.digest?.algorithm !== 'sha256' ||
    !DIGEST_PATTERN.test(artifact.digest?.value || '') ||
    artifact.id !== `sha256:${artifact.digest.value}` ||
    !Number.isInteger(artifact.size) || artifact.size < 0 ||
    typeof artifact.file !== 'string'
  ) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Current deployment artifact metadata is invalid: ${artifact.id || '(missing id)'}`);
  }
  verifyArtifact({ home, projectId, artifactId: artifact.id });
  return artifact;
}

export function artifactIndexPath(home, projectId) {
  return path.join(projectPath(home, projectId), "artifacts", "index.json");
}

export function readArtifactIndex(home, projectId) {
  const file = artifactIndexPath(home, projectId);
  if (!fs.existsSync(file))
    return { version: ARTIFACT_INDEX_VERSION, artifacts: [] };
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    index.version !== ARTIFACT_INDEX_VERSION ||
    !Array.isArray(index.artifacts)
  ) {
    throw operationError(
      "VALIDATION_FAILED",
      `Invalid artifact index: ${file}`,
    );
  }
  return index;
}

function findArtifact(home, projectId, artifactId) {
  const normalized = normalizeArtifactId(artifactId);
  const artifact = readArtifactIndex(home, projectId).artifacts.find(
    (item) => item.id === normalized,
  );
  if (!artifact)
    throw operationError("NOT_FOUND", `Artifact not found: ${normalized}`);
  return artifact;
}

function normalizeArtifactId(value) {
  const input = String(value || "")
    .trim()
    .toLowerCase();
  const digest = input.startsWith("sha256:")
    ? input.slice("sha256:".length)
    : input;
  if (!DIGEST_PATTERN.test(digest)) {
    throw operationError(
      "VALIDATION_FAILED",
      "Artifact id must be sha256:<64 lowercase hex characters>.",
    );
  }
  return `sha256:${digest}`;
}

export function sensitiveArtifactPaths(files) {
  const blocked = sensitiveTrackedFiles(files);
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/").toLowerCase();
    if (
      /(^|\/)(?:id_rsa|id_ed25519|credentials\.json)$/.test(normalized) ||
      /\.(?:pem|p12|pfx|key)$/.test(normalized)
    ) {
      blocked.push(file);
    }
  }
  return Array.from(new Set(blocked)).sort();
}

function assertArtifactMatches(artifact, project, digest, size, canonicalFile) {
  if (
    artifact.projectId !== project.id ||
    artifact.sourceRef?.commit !== project.source.commit ||
    artifact.digest?.value !== digest ||
    artifact.size !== size ||
    path.resolve(artifact.file) !== path.resolve(canonicalFile)
  ) {
    throw operationError(
      "CONFLICT",
      `Artifact metadata conflicts with existing digest: sha256:${digest}`,
    );
  }
}

export function assertArtifactPath(home, projectId, file) {
  const root = path.join(projectPath(home, projectId), "artifacts");
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw operationError(
      "PATH_BOUNDARY_VIOLATION",
      `Artifact path escapes project storage: ${file}`,
    );
  }
}

export function assertFileIntegrity(file, expectedDigest, expectedSize) {
  const stat = fs.statSync(file);
  const actualDigest = sha256File(file);
  if (stat.size !== expectedSize || actualDigest !== expectedDigest) {
    throw operationError(
      "ARTIFACT_INTEGRITY_FAILED",
      `Artifact integrity check failed: sha256:${expectedDigest}`,
    );
  }
}

export function copyFileAtomic(source, target) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, 0o444);
    const descriptor = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function sha256File(file) {
  return hashFile(file, "sha256");
}

function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  const descriptor = fs.openSync(file, "r");
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
  return hash.digest("hex");
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function withRepositoryGuard(source, fn) {
  const before = captureSourceGuard(source);
  let completed = false;
  let report;
  const complete = () => {
    if (completed) return report;
    completed = true;
    report = completeSourceGuard(source, before);
    return report;
  };
  try {
    return fn(complete);
  } finally {
    complete();
  }
}
