import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { readProjectAnalysis } from './analysis-contract.js';
import {
  artifactIndexPath,
  assertArtifactPath,
  assertFileIntegrity,
  copyFileAtomic,
  readArtifactIndex,
  sensitiveArtifactPaths,
  sha256File,
  withRepositoryGuard,
} from './artifact.js';
import { withControlLock } from './control-lock.js';
import { writeDeterministicTarGz } from './deterministic-archive.js';
import { detectProject } from './detect.js';
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

const MAX_FAILURE_TAIL = 4096;

export function buildRuntimeArtifact(options) {
  if (!options.execute) return planRuntimeArtifact(options);
  if (!options.yes) throw operationError('APPROVAL_REQUIRED', 'Runtime build execution requires --execute --yes.');
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'artifact-build', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    return withRepositoryGuard(project.source, (completeGuard) => executeBuild({ home, project, options, completeGuard }));
  });
}

export function planRuntimeArtifact(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  return withRepositoryGuard(project.source, (completeGuard) => {
    const analysis = readProjectAnalysis(project);
    const plan = buildRuntimeArtifactPlan(project, analysis.detection, options.artifactOutputDirs || []);
    return {
      kind: 'runtime-artifact-plan',
      status: plan.blockers.length > 0 ? 'blocked' : 'ready',
      mode: 'plan',
      home,
      projectId: project.id,
      plan,
      repositoryGuard: completeGuard(),
      providerMutationsExecuted: 0,
      productRepositoryChanged: false,
    };
  });
}

export function buildRuntimeArtifactPlan(project, detection, outputOverrides = []) {
  const install = installCommand(detection);
  const build = buildCommand(detection);
  const blockers = [];
  if (detection.runtimeType !== 'node') blockers.push('runtime-build-not-supported');
  if (!build) blockers.push('build-command-not-detected');
  if (install?.blocked) blockers.push(install.blocked);
  const outputs = outputOverrides.length > 0
    ? outputOverrides.map(normalizeOutputRoot)
    : inferredOutputRoots(detection);
  if (outputs.length === 0) blockers.push('build-output-not-detected');
  const commands = [install?.argv, build].filter(Boolean);
  const base = {
    version: 1,
    kind: 'RuntimeArtifactBuildPlan',
    projectId: project.id,
    sourceRef: {
      kind: project.source.kind,
      locator: project.source.locator,
      commit: project.source.commit,
    },
    runtime: {
      type: detection.runtimeType,
      packageManager: detection.packageManager,
      frameworks: [...(detection.frameworks || [])].sort(),
    },
    commands,
    outputRoots: [...new Set(outputs)].sort(),
    blockers: [...new Set(blockers)].sort(),
    executionPolicy: {
      requires: ['--execute', '--yes'],
      providerMutations: false,
      sourceRepositoryWrites: false,
      environment: 'minimal-no-credential-inheritance',
    },
  };
  return { ...base, fingerprint: fingerprintBuildPlan(base) };
}

function executeBuild({ home, project, options, completeGuard }) {
  const analysis = readProjectAnalysis(project);
  const plan = buildRuntimeArtifactPlan(project, analysis.detection, options.artifactOutputDirs || []);
  assertBuildReady(plan);
  const index = readArtifactIndex(home, project.id);
  const reusable = !options.force
    ? index.artifacts.find((artifact) => artifact.kind === 'runtime-build' && artifact.buildPlanFingerprint === plan.fingerprint)
    : null;
  if (reusable) {
    assertArtifactPath(home, project.id, reusable.file);
    assertFileIntegrity(reusable.file, reusable.digest.value, reusable.size);
    const repositoryGuard = completeGuard();
    return recordBuildSuccess({ home, project, plan, artifact: reusable, workspace: null, commandResults: [], repositoryGuard, reused: true });
  }

  const workspace = createIsolatedWorkspace(home, project, { purpose: 'runtime-build' });
  const commandResults = [];
  let actualPlan = plan;
  try {
    runGit(workspace.paths.source, ['remote', 'remove', 'origin'], { allowFailure: true });
    const trackedFiles = runGit(workspace.paths.source, ['ls-tree', '-r', '--name-only', project.source.commit])
      .stdout.split(/\r?\n/).filter(Boolean);
    const blockedFiles = sensitiveArtifactPaths(trackedFiles);
    if (blockedFiles.length > 0) {
      throw operationError('SECRET_IN_ARTIFACT_SOURCE', `Runtime build source contains tracked sensitive files: ${blockedFiles.join(', ')}`);
    }
    const actualDetection = detectProject(workspace.paths.source);
    actualPlan = buildRuntimeArtifactPlan(project, actualDetection, options.artifactOutputDirs || []);
    if (actualPlan.fingerprint !== plan.fingerprint) {
      throw operationError('CONFLICT', `Runtime build plan differs from the saved analysis. Re-run: agentmesh-deploy analyze ${project.id}`);
    }
    assertBuildReady(actualPlan);
    const env = minimalBuildEnvironment(workspace.paths.root);
    for (const argv of actualPlan.commands) {
      try {
        commandResults.push(runBuildCommand(workspace.paths.source, argv, env));
      } catch (error) {
        if (error.commandSummary) commandResults.push(error.commandSummary);
        throw error;
      }
    }
    const outputRoots = actualPlan.outputRoots.filter((relative) => {
      const absolute = path.join(workspace.paths.source, relative);
      return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory();
    });
    if (outputRoots.length === 0) {
      throw operationError('BUILD_OUTPUT_MISSING', `Build completed but none of the expected output directories exist: ${actualPlan.outputRoots.join(', ')}`);
    }
    if ((options.artifactOutputDirs || []).length > 0 && outputRoots.length !== actualPlan.outputRoots.length) {
      const missing = actualPlan.outputRoots.filter((relative) => !outputRoots.includes(relative));
      throw operationError('BUILD_OUTPUT_MISSING', `Required runtime output directories are missing: ${missing.join(', ')}`);
    }

    const workspaceArchive = path.join(workspace.paths.artifacts, `${project.id}-${project.source.commit.slice(0, 12)}-runtime.tar.gz`);
    const archive = writeDeterministicTarGz(workspace.paths.source, outputRoots, workspaceArchive);
    const digest = sha256File(workspaceArchive);
    const stat = fs.statSync(workspaceArchive);
    const artifactId = `sha256:${digest}`;
    const artifactDirectory = path.join(projectPath(home, project.id), 'artifacts');
    const canonicalFile = path.join(artifactDirectory, `${digest}.tar.gz`);
    fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(canonicalFile)) assertFileIntegrity(canonicalFile, digest, stat.size);
    else copyFileAtomic(workspaceArchive, canonicalFile);
    fs.chmodSync(workspaceArchive, 0o444);

    const currentIndex = readArtifactIndex(home, project.id);
    const digestMatch = currentIndex.artifacts.find((artifact) => artifact.id === artifactId);
    if (digestMatch && digestMatch.kind !== 'runtime-build') {
      throw operationError('CONFLICT', `Runtime artifact digest conflicts with existing artifact metadata: ${artifactId}`);
    }
    const artifact = digestMatch || {
      version: 1,
      id: artifactId,
      projectId: project.id,
      kind: 'runtime-build',
      format: 'tar.gz',
      sourceRef: actualPlan.sourceRef,
      buildPlanFingerprint: actualPlan.fingerprint,
      runtime: actualPlan.runtime,
      outputRoots,
      archiveEntries: archive.entries,
      digest: { algorithm: 'sha256', value: digest },
      size: stat.size,
      file: canonicalFile,
      createdAt: nowIso(),
      createdByRun: workspace.runId,
    };
    if (!digestMatch) {
      writeJsonAtomic(path.join(artifactDirectory, `${digest}.json`), artifact);
      writeJsonAtomic(artifactIndexPath(home, project.id), {
        ...currentIndex,
        artifacts: [...currentIndex.artifacts, artifact].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      });
    }
    const repositoryGuard = completeGuard();
    return recordBuildSuccess({ home, project, plan: actualPlan, artifact, workspace, commandResults, repositoryGuard, reused: Boolean(digestMatch) });
  } catch (error) {
    const repositoryGuard = completeGuard();
    const runId = workspace.runId;
    const runFile = writeProjectArtifact(home, project.id, path.join('runs', `${runId}.json`), {
      version: 1,
      kind: 'runtime-artifact-run',
      runId,
      projectId: project.id,
      createdAt: nowIso(),
      mode: 'execute',
      status: 'failed',
      plan,
      workspace,
      commandResults,
      repositoryGuard,
      error: { code: error.code || 'BUILD_FAILED', message: redactFailure(error.message) },
    });
    throw operationError(error.code || 'BUILD_FAILED', `${redactFailure(error.message)} Build evidence: ${runFile}`);
  }
}

function recordBuildSuccess({ home, project, plan, artifact, workspace, commandResults, repositoryGuard, reused }) {
  const createdAt = nowIso();
  const runId = workspace?.runId || `runtime-build-reuse-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const run = {
    version: 1,
    kind: 'runtime-artifact-run',
    runId,
    projectId: project.id,
    createdAt,
    mode: 'execute',
    status: 'succeeded',
    reused,
    plan,
    artifact,
    workspace,
    commandResults,
    repositoryGuard,
  };
  const runFile = writeProjectArtifact(home, project.id, path.join('runs', `${runId}.json`), run);
  withControlLock(home, 'registry', 'runtime-artifact-register', () => {
    const latest = readProjectRecord(home, project.id, { includeArchived: true });
    if (latest.status !== 'active' || latest.source.commit !== project.source.commit || latest.source.locator !== project.source.locator) {
      throw operationError('CONFLICT', `Project changed while runtime artifact was built: ${project.id}`);
    }
    updateProjectRecord(home, {
      ...latest,
      lastRuntimeArtifact: {
        id: artifact.id,
        buildPlanFingerprint: plan.fingerprint,
        commit: artifact.sourceRef.commit,
        createdAt,
        runId,
        runFile,
      },
      updatedAt: createdAt,
    });
  });
  return {
    kind: 'runtime-artifact-built',
    status: 'succeeded',
    mode: 'execute',
    home,
    reused,
    artifact,
    plan,
    workspace,
    commandResults,
    repositoryGuard,
    runFile,
    providerMutationsExecuted: 0,
    productRepositoryChanged: false,
  };
}

function installCommand(detection) {
  if (detection.runtimeType !== 'node') return null;
  if ((detection.dependencyCount || 0) + (detection.devDependencyCount || 0) === 0) return null;
  const manager = detection.packageManager;
  if (manager === 'npm') return detection.files?.packageLock ? { argv: ['npm', 'ci'] } : { blocked: 'package-lock-required' };
  if (manager === 'pnpm') return detection.files?.pnpmLock ? { argv: ['pnpm', 'install', '--frozen-lockfile'] } : { blocked: 'pnpm-lock-required' };
  if (manager === 'yarn') return detection.files?.yarnLock ? { argv: ['yarn', 'install', '--frozen-lockfile'] } : { blocked: 'yarn-lock-required' };
  if (manager === 'bun') return detection.files?.bunLock ? { argv: ['bun', 'install', '--frozen-lockfile'] } : { blocked: 'bun-lock-required' };
  return { blocked: 'supported-package-manager-required' };
}

function buildCommand(detection) {
  if (detection.runtimeType !== 'node' || !detection.scripts?.build) return null;
  if (detection.packageManager === 'yarn') return ['yarn', 'build'];
  if (detection.packageManager === 'bun') return ['bun', 'run', 'build'];
  if (detection.packageManager === 'pnpm') return ['pnpm', 'run', 'build'];
  return ['npm', 'run', 'build'];
}

function inferredOutputRoots(detection) {
  const frameworks = new Set(detection.frameworks || []);
  if (frameworks.has('next')) return ['.next', 'public'];
  if (frameworks.has('tanstack-start')) return ['.output', 'dist', 'public'];
  if (frameworks.has('vite')) return ['dist'];
  if (frameworks.has('cloudflare-workers')) return ['dist'];
  return ['dist', 'build', 'out'];
}

function assertBuildReady(plan) {
  if (plan.blockers.length === 0) return;
  throw operationError('BUILD_NOT_READY', `Runtime artifact build is blocked: ${plan.blockers.join(', ')}`);
}

function runBuildCommand(cwd, argv, env) {
  const startedAt = nowIso();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const summary = {
    argv,
    startedAt,
    completedAt: nowIso(),
    status: result.status ?? 1,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  };
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || tail(stderr || stdout, MAX_FAILURE_TAIL) || `exit ${result.status}`;
    summary.failureTail = redactFailure(detail);
    throw Object.assign(operationError('BUILD_COMMAND_FAILED', `Build command failed (${argv.join(' ')}): ${summary.failureTail}`), { commandSummary: summary });
  }
  return summary;
}

function minimalBuildEnvironment(workspaceRoot) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'COMSPEC', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const home = path.join(workspaceRoot, 'build-home');
  const temporary = path.join(workspaceRoot, 'tmp');
  const cache = path.join(workspaceRoot, 'cache');
  for (const directory of [home, temporary, cache]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: cache,
    npm_config_cache: path.join(cache, 'npm'),
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function normalizeOutputRoot(value) {
  const input = String(value || '').trim();
  const normalized = path.normalize(input).replace(/^\.([/\\])/, '').replace(/[\\/]+$/, '');
  if (!normalized || normalized === '.' || path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
    throw operationError('VALIDATION_FAILED', `--artifact-output must be a safe relative directory: ${value}`);
  }
  return normalized;
}

function fingerprintBuildPlan(plan) {
  const value = structuredClone(plan);
  delete value.fingerprint;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function tail(value, size) {
  return String(value || '').slice(-size);
}

function redactFailure(value) {
  return String(value || '')
    .replace(/((?:token|secret|password|credential|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp|github_pat|sk_live|sk_test|re)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}
