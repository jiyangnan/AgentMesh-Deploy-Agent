import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { operationError } from './errors.js';

const REGISTRY_VERSION = 1;
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

export function resolveDeployHome(explicitHome = '', env = process.env) {
  return path.resolve(explicitHome || env.AGENTMESH_DEPLOY_HOME || path.join(os.homedir(), '.agentmesh-deploy'));
}

export function registryPath(home) {
  return path.join(resolveDeployHome(home), 'registry.json');
}

export function projectPath(home, projectId) {
  return path.join(resolveDeployHome(home), 'projects', assertProjectId(projectId));
}

export function projectFilePath(home, projectId) {
  return path.join(projectPath(home, projectId), 'project.json');
}

export function assertProjectId(projectId) {
  const value = String(projectId || '');
  if (!PROJECT_ID_PATTERN.test(value)) {
    throw operationError('VALIDATION_FAILED', 'Project id must use 1-63 lowercase letters, numbers, or hyphens.');
  }
  return value;
}

export function readRegistry(home) {
  const file = registryPath(home);
  if (!fs.existsSync(file)) {
    return { version: REGISTRY_VERSION, projects: [] };
  }
  const registry = readJson(file);
  if (registry.version !== REGISTRY_VERSION || !Array.isArray(registry.projects)) {
    throw operationError('VALIDATION_FAILED', `Unsupported or invalid project registry: ${file}`);
  }
  return registry;
}

export function listProjectRecords(home, { includeArchived = false } = {}) {
  return readRegistry(home).projects
    .filter((project) => includeArchived || project.status !== 'archived')
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function readProjectRecord(home, projectId, { includeArchived = false } = {}) {
  const id = assertProjectId(projectId);
  const summary = readRegistry(home).projects.find((project) => project.id === id);
  if (!summary || (!includeArchived && summary.status === 'archived')) {
    throw operationError('NOT_FOUND', `Project not found: ${id}`);
  }
  const file = projectFilePath(home, id);
  if (!fs.existsSync(file)) {
    throw operationError('VALIDATION_FAILED', `Project registry entry has no project file: ${file}`);
  }
  const project = readJson(file);
  if (project.id !== id) {
    throw operationError('VALIDATION_FAILED', `Project file id mismatch: expected ${id}, found ${project.id || '(missing)'}`);
  }
  return project;
}

export function createProjectRecord(home, project) {
  const targetHome = resolveDeployHome(home);
  const id = assertProjectId(project.id);
  const registry = readRegistry(targetHome);
  if (registry.projects.some((item) => item.id === id)) {
    throw operationError('ALREADY_EXISTS', `Project already exists: ${id}`);
  }

  ensureProjectDirectories(targetHome, id);
  writeJsonAtomic(projectFilePath(targetHome, id), project);
  const nextRegistry = {
    ...registry,
    projects: [...registry.projects, projectSummary(project)].sort((left, right) => left.id.localeCompare(right.id)),
  };
  writeJsonAtomic(registryPath(targetHome), nextRegistry);
  return project;
}

export function updateProjectRecord(home, project) {
  const targetHome = resolveDeployHome(home);
  const id = assertProjectId(project.id);
  const registry = readRegistry(targetHome);
  const index = registry.projects.findIndex((item) => item.id === id);
  if (index === -1) {
    throw operationError('NOT_FOUND', `Project not found: ${id}`);
  }

  ensureProjectDirectories(targetHome, id);
  writeJsonAtomic(projectFilePath(targetHome, id), project);
  const projects = [...registry.projects];
  projects[index] = projectSummary(project);
  writeJsonAtomic(registryPath(targetHome), { ...registry, projects });
  return project;
}

export function writeProjectArtifact(home, projectId, relativePath, value) {
  const root = projectPath(home, projectId);
  const target = path.resolve(root, relativePath);
  if (!isPathWithin(root, target)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', `Project artifact path escapes the project directory: ${relativePath}`);
  }
  writeJsonAtomic(target, value);
  return target;
}

export function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeFileAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, value, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function ensureProjectDirectories(home, projectId) {
  const root = projectPath(home, projectId);
  const directories = [
    root,
    path.join(root, 'approvals'),
    path.join(root, 'evidence'),
    path.join(root, 'runs'),
    path.join(root, 'reviews'),
    path.join(root, 'diffs'),
    path.join(root, 'handoffs'),
    path.join(root, 'artifacts'),
    path.join(root, 'graphs'),
    path.join(root, 'recipes'),
  ];
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    source: {
      kind: project.source.kind,
      locator: project.source.locator,
      commit: project.source.commit,
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastAnalyzedAt: project.lastAnalysis?.createdAt || '',
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
