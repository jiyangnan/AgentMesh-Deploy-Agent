import { createHash } from 'node:crypto';

import { operationError } from './errors.js';

const CLASSIFICATION_RANK = Object.freeze({ additive: 0, reversible: 1, destructive: 2, unknown: 3 });
const MAX_SQL_BYTES = 2 * 1024 * 1024;

export function classifySqlMigration(sql, options = {}) {
  if (typeof sql !== 'string' || Buffer.byteLength(sql) > MAX_SQL_BYTES) {
    throw operationError('VALIDATION_FAILED', 'Migration SQL must be UTF-8 text no larger than 2 MiB per file.');
  }
  const rawStatements = splitSqlStatements(sql);
  if (rawStatements.length === 0) throw operationError('VALIDATION_FAILED', 'Migration SQL contains no executable statements.');
  const statements = rawStatements.map((statement, index) => classifyStatement(statement, index + 1));
  const classifications = statements.map((statement) => statement.classification);
  const classification = classifications.reduce((current, value) =>
    CLASSIFICATION_RANK[value] > CLASSIFICATION_RANK[current] ? value : current, 'additive');
  const transactionModes = new Set(statements.map((statement) => statement.transactionSafe ? 'transactional' : 'non-transactional'));
  const transactionMode = transactionModes.size > 1 ? 'mixed' : [...transactionModes][0];
  const blockers = unique(statements.flatMap((statement) => statement.blockers));
  if (transactionMode === 'mixed') blockers.push('mixed-transaction-mode');
  return {
    dialect: options.dialect || 'postgresql',
    classification,
    transactionMode,
    statementCount: statements.length,
    statements,
    blockers: unique(blockers),
    warnings: unique(statements.flatMap((statement) => statement.warnings)),
  };
}

export function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let index = 0;
  let state = 'normal';
  let blockDepth = 0;
  let dollarTag = '';
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1] || '';
    if (state === 'normal') {
      if (current === "'") state = 'single';
      else if (current === '"') state = 'double';
      else if (current === '-' && next === '-') { state = 'line-comment'; index += 1; }
      else if (current === '/' && next === '*') { state = 'block-comment'; blockDepth = 1; index += 1; }
      else if (current === '$') {
        const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
        if (match) { state = 'dollar'; dollarTag = match[0]; index += dollarTag.length - 1; }
      } else if (current === ';') {
        pushStatement(statements, sql.slice(start, index));
        start = index + 1;
      }
    } else if (state === 'single') {
      if (current === "'" && next === "'") index += 1;
      else if (current === "'") state = 'normal';
    } else if (state === 'double') {
      if (current === '"' && next === '"') index += 1;
      else if (current === '"') state = 'normal';
    } else if (state === 'line-comment') {
      if (current === '\n') state = 'normal';
    } else if (state === 'block-comment') {
      if (current === '/' && next === '*') { blockDepth += 1; index += 1; }
      else if (current === '*' && next === '/') {
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) state = 'normal';
      }
    } else if (state === 'dollar' && sql.startsWith(dollarTag, index)) {
      index += dollarTag.length - 1;
      state = 'normal';
      dollarTag = '';
    }
    index += 1;
  }
  if (state !== 'normal' && state !== 'line-comment') {
    throw operationError('VALIDATION_FAILED', `Migration SQL has an unterminated ${state} section.`);
  }
  pushStatement(statements, sql.slice(start));
  return statements;
}

function classifyStatement(statement, index) {
  const tokens = lexicalTokens(statement);
  const upper = tokens.map((token) => token.toUpperCase());
  const blockers = [];
  const warnings = [];
  let classification = 'unknown';
  let operation = 'unknown';
  let objectType = '';
  let objectName = '';
  let transactionSafe = true;

  if (containsSecretBearingSql(statement, upper)) blockers.push('secret-bearing-sql');
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'END'].includes(upper[0])) blockers.push('explicit-transaction-control');
  if (upper.includes('CONCURRENTLY') || upper[0] === 'VACUUM' ||
    (upper[0] === 'REINDEX' && upper.includes('CONCURRENTLY'))) transactionSafe = false;

  if (upper[0] === 'CREATE' && upper[1] === 'TABLE') {
    ({ objectType, objectName } = objectIdentity('table', tokens, 2));
    classification = 'additive'; operation = 'create-table';
  } else if (upper[0] === 'CREATE' && ['INDEX', 'UNIQUE'].includes(upper[1])) {
    const indexToken = upper[1] === 'UNIQUE' ? 3 : 2;
    ({ objectType, objectName } = objectIdentity('index', tokens, indexToken));
    classification = 'additive'; operation = upper.includes('CONCURRENTLY') ? 'create-index-concurrently' : 'create-index';
  } else if (upper[0] === 'CREATE' && ['TYPE', 'SEQUENCE', 'VIEW'].includes(upper[1]) && upper[1] !== 'OR') {
    ({ objectType, objectName } = objectIdentity(upper[1].toLowerCase(), tokens, 2));
    classification = 'additive'; operation = `create-${upper[1].toLowerCase()}`;
  } else if (upper[0] === 'COMMENT' && upper[1] === 'ON') {
    classification = 'additive'; operation = 'comment'; objectType = String(tokens[2] || '').toLowerCase();
  } else if (upper[0] === 'ALTER' && upper[1] === 'TABLE') {
    ({ objectType, objectName } = objectIdentity('table', tokens, 2));
    if (upper.includes('DROP')) { classification = 'destructive'; operation = 'alter-table-drop'; }
    else if (upper.includes('TYPE') || sequenceIncludes(upper, ['SET', 'DATA', 'TYPE'])) {
      classification = 'destructive'; operation = 'alter-column-type';
    } else if (upper.includes('RENAME')) { classification = 'reversible'; operation = 'rename'; }
    else if (sequenceIncludes(upper, ['ADD', 'COLUMN'])) {
      classification = 'additive'; operation = 'add-column';
      if (upper.includes('NOT') && upper.includes('NULL')) warnings.push('add-not-null-column');
    } else if (sequenceIncludes(upper, ['ADD', 'CONSTRAINT'])) {
      classification = 'reversible'; operation = 'add-constraint'; warnings.push('constraint-validation-lock');
    } else if (upper.includes('ALTER') && upper.includes('COLUMN')) {
      classification = 'reversible'; operation = 'alter-column';
    }
  } else if (upper[0] === 'DROP' || ['TRUNCATE', 'DELETE', 'UPDATE', 'MERGE'].includes(upper[0])) {
    classification = 'destructive'; operation = upper[0].toLowerCase(); objectType = String(tokens[1] || '').toLowerCase();
  } else if (upper[0] === 'ALTER' && upper[1] === 'TYPE' && upper.includes('ADD') && upper.includes('VALUE')) {
    classification = 'unknown'; operation = 'alter-enum-add-value'; transactionSafe = false; warnings.push('irreversible-enum-change');
  } else if (upper[0] === 'INSERT' || upper[0] === 'COPY') {
    classification = 'unknown'; operation = 'data-write'; warnings.push('data-write-requires-manual-review');
  } else if (['GRANT', 'REVOKE'].includes(upper[0]) ||
    (['CREATE', 'ALTER', 'DROP'].includes(upper[0]) && ['ROLE', 'USER'].includes(upper[1]))) {
    classification = 'unknown'; operation = 'security-change'; warnings.push('database-security-change');
  } else if (upper[0] === 'CREATE' && upper[1] === 'EXTENSION') {
    classification = 'unknown'; operation = 'create-extension'; warnings.push('provider-capability-required');
  } else if (upper.length > 0) {
    warnings.push('unsupported-statement-requires-manual-review');
  }

  if (classification === 'unknown') warnings.push('unknown-migration-class');
  return {
    index,
    sha256: createHash('sha256').update(statement).digest('hex'),
    classification,
    operation,
    objectType: safeIdentifier(objectType),
    objectName: safeIdentifier(objectName),
    transactionSafe,
    blockers: unique(blockers),
    warnings: unique(warnings),
  };
}

function lexicalTokens(statement) {
  const sanitized = maskSqlLiteralsAndComments(statement);
  return sanitized.match(/[A-Za-z_][A-Za-z0-9_$]*|[0-9]+|[(),.=*+-]/g) || [];
}

function maskSqlLiteralsAndComments(sql) {
  return sql
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ? ')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ? ')
    .replace(/"(?:""|[^"])*"/g, ' identifier ');
}

function containsSecretBearingSql(statement, upper) {
  return /postgres(?:ql)?:\/\//i.test(statement) ||
    upper.includes('PASSWORD') || upper.includes('ENCRYPTED') ||
    (upper.includes('SET') && upper.some((token) => /TOKEN|SECRET|API_KEY/.test(token)));
}

function objectIdentity(type, tokens, index) {
  let cursor = index;
  while (['IF', 'NOT', 'EXISTS', 'CONCURRENTLY', 'ONLY'].includes(String(tokens[cursor] || '').toUpperCase())) cursor += 1;
  return { objectType: type, objectName: tokens[cursor] || '' };
}

function sequenceIncludes(tokens, sequence) {
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) return true;
  }
  return false;
}

function safeIdentifier(value) {
  const text = String(value || '').toLowerCase();
  return /^[a-z_][a-z0-9_$]{0,62}$/.test(text) ? text : '';
}

function pushStatement(statements, value) {
  const normalized = String(value || '').trim();
  if (normalized && !/^(?:--[^\n\r]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/\s*)+$/.test(normalized)) statements.push(normalized);
}

function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }
