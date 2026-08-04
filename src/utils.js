import fs from 'node:fs';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function pathExists(filePath) {
  return fs.existsSync(filePath);
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonIfExists(filePath) {
  if (!pathExists(filePath)) return undefined;
  return readJson(filePath);
}

export function readTextIfExists(filePath) {
  if (!pathExists(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

export function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'agentmesh-app';
}

export function parseEnvKeys(content) {
  const keys = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (match) keys.push(match[1]);
  }
  return Array.from(new Set(keys)).sort();
}

export function quoteShell(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function formatCommand(command) {
  if (Array.isArray(command)) return command.map(quoteShell).join(' ');
  return String(command);
}

export function relativeFrom(root, target) {
  const relative = path.relative(root, target);
  return relative || '.';
}
