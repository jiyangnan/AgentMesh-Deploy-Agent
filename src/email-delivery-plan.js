import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { listConnections } from './connection-service.js';
import { withControlLock } from './control-lock.js';
import { readExternalDeployment } from './contracts-v2.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { showProductVerificationPlan } from './product-verification.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';

const PLAN_ID = /^email-delivery-plan-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CONNECTION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const SECRET_REF = /^(?:env:\/\/[A-Z][A-Z0-9_]*|(?:keychain|op|secret):\/\/[A-Za-z0-9._/-]+)$/;
const PLAN_KEYS = [
  'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceCommit',
  'graphId', 'graphFingerprint', 'configurationId', 'configurationFingerprint',
  'verificationPlanId', 'verificationPlanFingerprint', 'emailCheckId',
  'emailDomain', 'provisioningConnection', 'sendingConnection', 'fromLocalPart',
  'recipientSecretRef', 'limits', 'createdAt',
];
const DOMAIN_KEYS = ['providerId', 'name', 'evidenceRef', 'evidenceFingerprint'];
const CONNECTION_KEYS = ['id', 'version', 'authMethod', 'scope', 'credentialRef'];

export function createEmailDeliveryPlan(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'email-delivery-plan-create', () => {
    const context = deriveEmailDeliveryContext({ ...options, home });
    const before = captureSourceGuard(context.project.source);
    const base = {
      schemaVersion: 1,
      kind: 'EmailDeliveryPlan',
      projectId: context.project.id,
      sourceCommit: context.project.source.commit,
      graphId: context.graph.id,
      graphFingerprint: context.graph.fingerprint,
      configurationId: context.configuration.id,
      configurationFingerprint: context.configuration.fingerprint,
      verificationPlanId: context.verificationPlan.id,
      verificationPlanFingerprint: context.verificationPlan.fingerprint,
      emailCheckId: context.emailCheck.id,
      emailDomain: context.emailDomain,
      provisioningConnection: connectionBinding(context.provisioningConnection, 'RESEND_API_KEY'),
      sendingConnection: connectionBinding(context.sendingConnection, 'RESEND_SENDING_API_KEY'),
      fromLocalPart: normalizeLocalPart(options.fromLocalPart),
      recipientSecretRef: context.recipientSecretRef,
      limits: { maxEmails: 1, maxRecipients: 1, timeoutSeconds: 86400, minimumPollSeconds: 30 },
      createdAt: options.now || nowIso(),
    };
    const fingerprint = emailDeliveryPlanFingerprint(base);
    let plan = {
      ...base,
      id: `email-delivery-plan-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateEmailDeliveryPlan(plan, context);
    const directory = emailDeliveryPlanDirectory(home, context.project.id);
    const planFile = path.join(directory, `${plan.id}.json`);
    const currentFile = path.join(projectPath(home, context.project.id), 'email-delivery-plan.json');
    let reused = false;
    if (fs.existsSync(planFile)) {
      const existing = readEmailDeliveryPlanFile(planFile, context);
      if (existing.fingerprint !== plan.fingerprint) {
        throw operationError('CONFLICT', `Email Delivery Plan ID collision: ${plan.id}`);
      }
      plan = existing;
      reused = true;
    } else {
      writeJsonAtomic(planFile, plan);
    }
    writeJsonAtomic(currentFile, plan);
    const repositoryGuard = completeSourceGuard(context.project.source, before);
    return {
      kind: 'email-delivery-plan', operation: 'create', status: 'succeeded', home,
      projectId: context.project.id, plan, planFile, currentFile, reused, repositoryGuard,
      networkRequestsExecuted: 0, providerMutationsExecuted: 0,
      secretValuesExposed: false, productRepositoryChanged: false,
    };
  });
}

export function showEmailDeliveryPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const planFile = emailDeliveryPlanPath(home, project.id, options.planId);
  if (!fs.existsSync(planFile)) throw operationError('NOT_FOUND', `Email Delivery Plan not found: ${options.planId}`);
  let shell;
  try { shell = JSON.parse(fs.readFileSync(planFile, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Plan JSON is invalid: ${safeMessage(error.message)}`); }
  const context = deriveEmailDeliveryContext({
    home,
    projectId: project.id,
    graphId: shell.graphId,
    configurationId: shell.configurationId,
    verificationPlanId: shell.verificationPlanId,
    provisioningConnectionId: shell.provisioningConnection?.id,
    sendingConnectionId: shell.sendingConnection?.id,
    fromLocalPart: shell.fromLocalPart,
  });
  const plan = readEmailDeliveryPlanFile(planFile, context);
  return {
    kind: 'email-delivery-plan', operation: 'read', status: 'succeeded', home,
    projectId: project.id, plan, planFile, networkRequestsExecuted: 0,
    providerMutationsExecuted: 0, secretValuesExposed: false, productRepositoryChanged: false,
  };
}

export function assertEmailDeliveryPlanCurrent(options) {
  return showEmailDeliveryPlan(options);
}

export function validateEmailDeliveryPlan(plan, expected = {}) {
  const issues = [];
  exactKeys(plan, PLAN_KEYS, '$', issues);
  if (plan?.schemaVersion !== 1 || plan?.kind !== 'EmailDeliveryPlan' ||
    !PLAN_ID.test(plan?.id || '') || !SHA256.test(plan?.fingerprint || '')) issues.push('kind|id|fingerprint');
  if (!/^[0-9a-f]{40}$/i.test(plan?.sourceCommit || '') || !isDate(plan?.createdAt)) issues.push('sourceCommit|createdAt');
  if (!LOCAL_PART.test(plan?.fromLocalPart || '') || !SECRET_REF.test(plan?.recipientSecretRef || '')) issues.push('emailInput');
  exactKeys(plan?.emailDomain, DOMAIN_KEYS, 'emailDomain', issues);
  if (!plan?.emailDomain?.providerId || !isDomainName(plan?.emailDomain?.name) ||
    typeof plan?.emailDomain?.evidenceRef !== 'string' || !plan.emailDomain.evidenceRef ||
    !SHA256.test(plan?.emailDomain?.evidenceFingerprint || '')) issues.push('emailDomain');
  validateConnectionBinding(plan?.provisioningConnection, 'provisioning-key', 'RESEND_API_KEY', issues, 'provisioningConnection');
  validateConnectionBinding(plan?.sendingConnection, 'sending-key', 'RESEND_SENDING_API_KEY', issues, 'sendingConnection');
  if (plan?.provisioningConnection?.id === plan?.sendingConnection?.id) issues.push('connections(distinct)');
  exactKeys(plan?.limits, ['maxEmails', 'maxRecipients', 'timeoutSeconds', 'minimumPollSeconds'], 'limits', issues);
  if (plan?.limits?.maxEmails !== 1 || plan?.limits?.maxRecipients !== 1 ||
    plan?.limits?.timeoutSeconds !== 86400 || plan?.limits?.minimumPollSeconds !== 30) issues.push('limits(semantic)');
  if (expected.project && (plan?.projectId !== expected.project.id || plan?.sourceCommit !== expected.project.source.commit)) issues.push('project');
  if (expected.graph && (plan?.graphId !== expected.graph.id || plan?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    plan?.configurationId !== expected.configuration.id ||
    plan?.configurationFingerprint !== expected.configuration.fingerprint
  )) issues.push('configuration');
  if (expected.verificationPlan && (
    plan?.verificationPlanId !== expected.verificationPlan.id ||
    plan?.verificationPlanFingerprint !== expected.verificationPlan.fingerprint
  )) issues.push('verificationPlan');
  if (expected.emailCheck && (plan?.emailCheckId !== expected.emailCheck.id ||
    plan?.recipientSecretRef !== expected.recipientSecretRef)) issues.push('emailCheck');
  if (expected.emailDomain && stableStringify(plan?.emailDomain) !== stableStringify(expected.emailDomain)) issues.push('emailDomain(binding)');
  if (expected.provisioningConnection && stableStringify(plan?.provisioningConnection) !==
    stableStringify(connectionBinding(expected.provisioningConnection, 'RESEND_API_KEY'))) issues.push('provisioningConnection(binding)');
  if (expected.sendingConnection && stableStringify(plan?.sendingConnection) !==
    stableStringify(connectionBinding(expected.sendingConnection, 'RESEND_SENDING_API_KEY'))) issues.push('sendingConnection(binding)');
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `Email Delivery Plan is invalid at: ${[...new Set(issues)].join(', ')}`);
  const actual = emailDeliveryPlanFingerprint(plan);
  if (plan.fingerprint !== actual || plan.id !== `email-delivery-plan-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Plan fingerprint mismatch: ${plan.id}`);
  }
  return plan;
}

export function emailDeliveryPlanFingerprint(plan) {
  return fingerprintWithout(plan, ['id', 'fingerprint', 'createdAt']);
}

function deriveEmailDeliveryContext(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
  }).configuration;
  if (configuration.email?.provider !== 'resend' || !isDomainName(configuration.email?.domain || '')) {
    throw operationError('CONFLICT', 'Email Delivery Plan requires a Resend Launch Configuration.');
  }
  const verificationPlan = showProductVerificationPlan({
    home, projectId: project.id, graphId: graph.id, configurationId: configuration.id,
    planId: options.verificationPlanId,
  }).plan;
  const emailChecks = verificationPlan.checks.filter((check) =>
    check.id === 'production.email.delivery' && check.capability === 'email-delivery' && check.required
  );
  if (emailChecks.length !== 1 || emailChecks[0].secretRefs.length !== 1 || !SECRET_REF.test(emailChecks[0].secretRefs[0])) {
    throw operationError('CONFLICT', 'Product Verification Plan must contain one required production email delivery check and recipient Secret Ref.');
  }
  const deployment = readExternalDeployment(home, project.id);
  const domainNode = deployment.state.nodes?.['email.domain.verify'];
  if (domainNode?.status !== 'succeeded' || domainNode.graphId !== graph.id || !domainNode.resultRef) {
    throw operationError('VERIFICATION_FAILED', 'Current Graph Resend domain verification must succeed before planning test email delivery.');
  }
  const resources = Object.values(deployment.state.resources || {}).filter((resource) =>
    resource?.provider === 'resend' && resource?.type === 'email.domain' && resource?.name === configuration.email.domain
  );
  if (resources.length !== 1 || !resources[0].providerId) {
    throw operationError('CONFLICT', 'Exactly one current Resend email domain resource is required.');
  }
  const evidence = evidenceBinding(home, project.id, domainNode.resultRef);
  const connections = listConnections({ home, projectId: project.id }).connections;
  const provisioningConnection = requireConnection(connections, options.provisioningConnectionId, 'provisioning-key', 'RESEND_API_KEY');
  const sendingConnection = requireConnection(connections, options.sendingConnectionId, 'sending-key', 'RESEND_SENDING_API_KEY');
  if (provisioningConnection.id === sendingConnection.id) {
    throw operationError('CONFLICT', 'Provisioning and Sending Access Connections must be distinct.');
  }
  return {
    home, project, graph, configuration, verificationPlan, emailCheck: emailChecks[0],
    recipientSecretRef: emailChecks[0].secretRefs[0],
    emailDomain: {
      providerId: resources[0].providerId,
      name: configuration.email.domain,
      evidenceRef: evidence.ref,
      evidenceFingerprint: evidence.fingerprint,
    },
    provisioningConnection, sendingConnection,
  };
}

function requireConnection(connections, id, authMethod, credentialName) {
  if (!CONNECTION_ID.test(id || '')) throw operationError('VALIDATION_FAILED', `Email Delivery ${authMethod} Connection ID is invalid.`);
  const matches = connections.filter((connection) => connection.id === id && connection.status !== 'archived');
  if (matches.length !== 1) throw operationError('NOT_FOUND', `Email Delivery Connection not found: ${id}`);
  const connection = matches[0];
  if (connection.provider !== 'resend' || connection.status !== 'ready' || connection.authMethod !== authMethod ||
    typeof connection.secretRefs?.[credentialName] !== 'string' || Object.keys(connection.secretRefs).length !== 1) {
    throw operationError('CAPABILITY_MISSING', `Connection ${id} must be a ready Resend ${authMethod} Connection with only ${credentialName}.`);
  }
  return connection;
}

function connectionBinding(connection, credentialName) {
  return {
    id: connection.id,
    version: connection.version,
    authMethod: connection.authMethod,
    scope: connection.scope,
    credentialRef: connection.secretRefs[credentialName],
  };
}

function validateConnectionBinding(value, authMethod, credentialName, issues, label) {
  exactKeys(value, CONNECTION_KEYS, label, issues);
  if (!CONNECTION_ID.test(value?.id || '') || !Number.isInteger(value?.version) || value.version < 1 ||
    value?.authMethod !== authMethod || typeof value?.scope !== 'string' || !value.scope ||
    !SECRET_REF.test(value?.credentialRef || '')) issues.push(label);
  if (credentialName === 'RESEND_API_KEY' && value?.authMethod !== 'provisioning-key') issues.push(`${label}.credential`);
  if (credentialName === 'RESEND_SENDING_API_KEY' && value?.authMethod !== 'sending-key') issues.push(`${label}.credential`);
}

function evidenceBinding(home, projectId, input) {
  const ref = path.resolve(String(input || ''));
  const root = path.resolve(projectPath(home, projectId));
  if (ref !== root && !ref.startsWith(`${root}${path.sep}`)) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Resend domain Evidence must be inside the external project control directory.');
  }
  let stat;
  try { stat = fs.lstatSync(ref); }
  catch { throw operationError('NOT_FOUND', `Resend domain Evidence not found: ${ref}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4 * 1024 * 1024) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Resend domain Evidence must be a bounded regular file.');
  }
  return {
    ref,
    fingerprint: `sha256:${createHash('sha256').update(fs.readFileSync(ref)).digest('hex')}`,
  };
}

function readEmailDeliveryPlanFile(file, expected) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Plan JSON is invalid: ${safeMessage(error.message)}`); }
  try { return validateEmailDeliveryPlan(plan, expected); }
  catch (error) {
    if (error?.code === 'VALIDATION_FAILED') {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `Email Delivery Plan failed integrity validation: ${safeMessage(error.message)}`);
    }
    throw error;
  }
}

function emailDeliveryPlanDirectory(home, projectId) {
  return path.join(projectPath(home, projectId), 'email-delivery-plans');
}

function emailDeliveryPlanPath(home, projectId, planId) {
  if (!PLAN_ID.test(planId || '')) throw operationError('VALIDATION_FAILED', 'Email Delivery Plan ID is invalid.');
  return path.join(emailDeliveryPlanDirectory(home, projectId), `${planId}.json`);
}

function normalizeLocalPart(value) {
  const localPart = String(value || 'verification').trim().toLowerCase();
  if (!LOCAL_PART.test(localPart)) throw operationError('VALIDATION_FAILED', 'Email sender local part is invalid.');
  return localPart;
}

function fingerprintWithout(value, excluded) {
  const copy = structuredClone(value);
  for (const key of excluded) delete copy[key];
  return `sha256:${createHash('sha256').update(stableStringify(copy)).digest('hex')}`;
}

function exactKeys(value, keys, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push(label); return; }
  if (stableStringify(Object.keys(value).sort()) !== stableStringify([...keys].sort())) issues.push(`${label}(fields)`);
}

function isDomainName(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function safeMessage(value) { return String(value || 'email delivery plan error').replace(/https?:\/\/\S+/gi, '[url]').slice(0, 256); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
