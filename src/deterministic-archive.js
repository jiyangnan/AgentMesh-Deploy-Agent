import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { operationError } from './errors.js';

const BLOCK_SIZE = 512;
const ZERO_BLOCKS = Buffer.alloc(BLOCK_SIZE * 2);
const GZIP_HELPER = fileURLToPath(new URL('./gzip-helper.js', import.meta.url));

export function writeDeterministicTarGz(sourceRoot, relativeRoots, outputFile) {
  const root = fs.realpathSync(sourceRoot);
  const roots = normalizeRoots(relativeRoots);
  const entries = collectEntries(root, roots);
  const temporaryTar = `${outputFile}.${process.pid}.${randomUUID()}.tar`;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  let descriptor;
  let completed = false;
  try {
    descriptor = fs.openSync(temporaryTar, 'wx', 0o600);
    for (const entry of entries) writeEntry(descriptor, entry);
    fs.writeSync(descriptor, ZERO_BLOCKS);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const result = spawnSync(process.execPath, [GZIP_HELPER, temporaryTar, outputFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalArchiveEnvironment(),
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`;
      throw operationError('ARTIFACT_ARCHIVE_FAILED', `Unable to gzip runtime artifact: ${detail}`);
    }
    fs.chmodSync(outputFile, 0o600);
    completed = true;
    return { entries: entries.length, roots };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryTar)) fs.unlinkSync(temporaryTar);
    if (!completed && fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  }
}

function collectEntries(root, roots) {
  const entries = [];
  for (const relativeRoot of roots) walk(path.join(root, relativeRoot), relativeRoot);
  return entries.sort((left, right) => left.name.localeCompare(right.name));

  function walk(absolute, relative) {
    assertWithin(root, absolute, relative);
    const stat = fs.lstatSync(absolute);
    const name = toPosix(relative);
    if (stat.isDirectory()) {
      entries.push({ absolute, name: `${name}/`, stat, type: 'directory', link: '' });
      for (const child of fs.readdirSync(absolute).sort()) {
        walk(path.join(absolute, child), path.join(relative, child));
      }
      return;
    }
    if (stat.isFile()) {
      entries.push({ absolute, name, stat, type: 'file', link: '' });
      return;
    }
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(absolute);
      if (path.isAbsolute(link)) {
        throw operationError('ARTIFACT_PATH_UNSAFE', `Runtime artifact contains an absolute symlink: ${name}`);
      }
      const target = path.resolve(path.dirname(absolute), link);
      assertWithin(root, target, `${name} -> ${link}`);
      entries.push({ absolute, name, stat, type: 'symlink', link: toPosix(link) });
      return;
    }
    throw operationError('ARTIFACT_PATH_UNSAFE', `Runtime artifact contains an unsupported file type: ${name}`);
  }
}

function writeEntry(descriptor, entry) {
  const header = createHeader(entry);
  fs.writeSync(descriptor, header);
  if (entry.type !== 'file') return;
  const input = fs.openSync(entry.absolute, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(input, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        fs.writeSync(descriptor, buffer, 0, bytesRead);
        total += bytesRead;
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(input);
  }
  if (total !== entry.stat.size) {
    throw operationError('ARTIFACT_ARCHIVE_FAILED', `Runtime output changed while archiving: ${entry.name}`);
  }
  const padding = (BLOCK_SIZE - (total % BLOCK_SIZE)) % BLOCK_SIZE;
  if (padding) fs.writeSync(descriptor, Buffer.alloc(padding));
}

function createHeader(entry) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitTarPath(entry.name);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, normalizedMode(entry));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === 'file' ? entry.stat.size : 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === 'file' ? 0x30 : (entry.type === 'directory' ? 0x35 : 0x32);
  writeText(header, 157, 100, entry.link);
  writeText(header, 257, 6, 'ustar\0');
  writeText(header, 263, 2, '00');
  writeText(header, 345, 155, prefix);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeText(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' };
  const directory = value.endsWith('/');
  const raw = directory ? value.slice(0, -1) : value;
  const indexes = [...raw.matchAll(/\//g)].map((match) => match.index).reverse();
  for (const index of indexes) {
    const prefix = raw.slice(0, index);
    const name = `${raw.slice(index + 1)}${directory ? '/' : ''}`;
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw operationError('ARTIFACT_PATH_UNSAFE', `Runtime artifact path is too long for portable tar: ${value}`);
}

function writeText(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length > length) throw operationError('ARTIFACT_PATH_UNSAFE', `Tar field exceeds ${length} bytes.`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const text = Number(value).toString(8).padStart(length - 1, '0');
  if (text.length >= length) throw operationError('ARTIFACT_ARCHIVE_FAILED', `Tar numeric field exceeds ${length} bytes.`);
  writeText(buffer, offset, length - 1, text);
  buffer[offset + length - 1] = 0;
}

function normalizedMode(entry) {
  if (entry.type === 'directory' || entry.type === 'symlink') return entry.type === 'directory' ? 0o755 : 0o777;
  return (entry.stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
}

function normalizeRoots(values) {
  const roots = [...new Set((values || []).map((value) => normalizeRelativePath(value)))].sort();
  if (roots.length === 0) throw operationError('BUILD_OUTPUT_MISSING', 'No runtime output directory was selected.');
  return roots;
}

function normalizeRelativePath(value) {
  const normalized = path.normalize(String(value || '').trim()).replace(/^\.([/\\])/, '').replace(/[\\/]+$/, '');
  if (!normalized || normalized === '.' || path.isAbsolute(normalized) || normalized.split(path.sep).includes('..')) {
    throw operationError('VALIDATION_FAILED', `Runtime artifact output must be a safe relative directory: ${value}`);
  }
  return normalized;
}

function assertWithin(root, target, label) {
  const relative = path.relative(root, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw operationError('ARTIFACT_PATH_UNSAFE', `Runtime artifact path escapes the isolated source: ${label}`);
  }
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, '/');
}

function minimalArchiveEnvironment() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
