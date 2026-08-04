import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readExternalDeployment, validateDeploymentStateV2 } from './contracts-v2.js';
import { readCandidateVerificationEvidence } from './candidate-verification.js';
import { withControlLock } from './control-lock.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { nowIso } from './utils.js';
import { readProductVerificationEvidence, showProductVerificationPlan } from './product-verification.js';

const CHANGE_ID = /^dns-change-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/;
const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX']);
const CHANGE_SET_SCOPES = new Set(['production-cutover', 'provider-acceptance']);

export function createDnsChangeSet(options) {
  const home = resolveDeployHome(options.home);
  return withControlLock(home, `project:${options.projectId}`, 'dns-change-set-create', () => {
    const project = readProjectRecord(home, options.projectId);
    assertControlHomeSeparated(home, project.source);
    const before = captureSourceGuard(project.source);
    const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
    const configuration = showLaunchConfiguration({
      home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
    }).configuration;
    const deployment = readExternalDeployment(home, project.id);
    const scope = options.acceptanceOnly === true ? 'provider-acceptance' : 'production-cutover';
    const desired = scope === 'provider-acceptance'
      ? buildProviderAcceptanceRecords(configuration, deployment.state, graph)
      : buildDesiredRecords(home, project, configuration, deployment.state, graph);
    const base = {
      schemaVersion: 1,
      kind: 'DnsChangeSet',
      scope,
      projectId: project.id,
      graphId: graph.id,
      graphFingerprint: graph.fingerprint,
      configurationId: configuration.id,
      configurationFingerprint: configuration.fingerprint,
      zoneName: configuration.domain.apex,
      records: desired.records,
      sourceEvidence: desired.sourceEvidence,
      createdAt: options.now || nowIso(),
    };
    const fingerprint = dnsChangeSetFingerprint(base);
    let changeSet = {
      ...base,
      id: `dns-change-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      fingerprint,
    };
    validateDnsChangeSet(changeSet, { projectId: project.id, graph, configuration });
    const directory = path.join(projectPath(home, project.id), 'dns-change-sets');
    const changeSetFile = path.join(directory, `${changeSet.id}.json`);
    const currentFile = path.join(projectPath(home, project.id), 'dns-change-set.json');
    let reused = false;
    if (fs.existsSync(changeSetFile)) {
      const existing = readChangeSetFile(changeSetFile, { projectId: project.id, graph, configuration });
      if (existing.fingerprint !== changeSet.fingerprint) throw operationError('CONFLICT', `DNS ChangeSet ID collision: ${changeSet.id}`);
      changeSet = existing;
      reused = true;
    } else {
      writeJsonAtomic(changeSetFile, changeSet);
    }
    writeJsonAtomic(currentFile, changeSet);
    persistControlNodes(deployment, graph, configuration, changeSet, changeSetFile, base.createdAt);
    const repositoryGuard = completeSourceGuard(project.source, before);
    return {
      kind: 'dns-change-set', operation: 'create', status: 'succeeded', home,
      projectId: project.id, changeSet, changeSetFile, currentFile, reused, repositoryGuard,
      ...(scope === 'provider-acceptance' ? {
        acceptanceBoundary: {
          providers: ['cloudflare', 'resend'],
          isolatedDomain: configuration.email.domain,
          requiresExistingFreeQuota: true,
          allowsPaidPlanUpgrade: false,
          allowsDelete: false,
          allowsProductionCutover: false,
        },
        nextActions: [{
          kind: 'generate-cloudflare-resend-acceptance-plan',
          argv: [
            'agentmesh-deploy', 'adapter-plan', 'generate', project.id,
            '--graph', graph.id, '--launch-config', configuration.id,
            '--dns-change-set', changeSet.id,
            '--acceptance-provider', 'cloudflare', '--acceptance-provider', 'resend',
            '--home', home, '--json',
          ],
        }],
      } : {}),
      providerMutationsExecuted: 0, productRepositoryChanged: false,
    };
  });
}

export function showDnsChangeSet(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home, projectId: project.id, graphId: graph.id, configurationId: options.configurationId,
  }).configuration;
  const deployment = readExternalDeployment(home, project.id);
  const changeSetFile = options.changeSetId
    ? changeSetPath(home, project.id, options.changeSetId)
    : path.join(projectPath(home, project.id), 'dns-change-set.json');
  if (!fs.existsSync(changeSetFile)) throw operationError('NOT_FOUND', `DNS ChangeSet not found: ${changeSetFile}`);
  const changeSet = readChangeSetFile(changeSetFile, { projectId: project.id, graph, configuration });
  if (dnsChangeSetScope(changeSet) === 'provider-acceptance') {
    validateLinkedEmailEvidence(configuration, changeSet, deployment.state, graph);
  } else {
    validateLinkedCandidateEvidence(home, project, graph, configuration, changeSet, deployment.state);
  }
  return { kind: 'dns-change-set', operation: 'read', home, projectId: project.id, changeSet, changeSetFile };
}

export function validateDnsChangeSet(changeSet, expected = {}) {
  const issues = [];
  if (changeSet?.schemaVersion !== 1 || changeSet?.kind !== 'DnsChangeSet') issues.push('kind|schemaVersion');
  const scope = dnsChangeSetScope(changeSet);
  if (!CHANGE_SET_SCOPES.has(scope) || (changeSet?.scope !== undefined && changeSet.scope !== scope)) issues.push('scope');
  if (!CHANGE_ID.test(changeSet?.id || '') || !SHA256.test(changeSet?.fingerprint || '')) issues.push('id|fingerprint');
  if (!DOMAIN.test(changeSet?.zoneName || '')) issues.push('zoneName');
  if (expected.projectId && changeSet?.projectId !== expected.projectId) issues.push('projectId');
  if (expected.graph && (changeSet?.graphId !== expected.graph.id || changeSet?.graphFingerprint !== expected.graph.fingerprint)) issues.push('graph');
  if (expected.configuration && (
    changeSet?.configurationId !== expected.configuration.id ||
    changeSet?.configurationFingerprint !== expected.configuration.fingerprint ||
    changeSet?.zoneName !== expected.configuration.domain.apex
  )) issues.push('configuration');
  if (!Array.isArray(changeSet?.records) || changeSet.records.length === 0) issues.push('records');
  if (!Array.isArray(changeSet?.sourceEvidence) || changeSet.sourceEvidence.length < 1) issues.push('sourceEvidence');
  if ((changeSet?.sourceEvidence || []).some((item) => !item?.nodeId || !item?.resultRef ||
    (item.nodeId === 'candidate.verify' && !SHA256.test(item.fingerprint || '')))) issues.push('sourceEvidence.value');
  const ids = new Set();
  const recordSets = new Map();
  const webRecords = [];
  const emailRecords = [];
  for (const record of changeSet?.records || []) {
    if (!record || ids.has(record.id) || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(record.id || '')) issues.push('records.id');
    ids.add(record?.id);
    if (!RECORD_TYPES.has(record?.type) || !DNS_NAME.test(record?.name || '') || typeof record?.content !== 'string' || !record.content) issues.push('records.value');
    if (!Number.isInteger(record?.ttl) || record.ttl < 1 || typeof record?.proxied !== 'boolean') issues.push('records.options');
    if (!['create-only', 'replace-exact-record-set'].includes(record?.updatePolicy)) issues.push('records.updatePolicy');
    if (record?.type === 'MX' ? !Number.isInteger(record.priority) : record?.priority !== null) issues.push('records.priority');
    if (!['web', 'email'].includes(record?.purpose)) issues.push('records.purpose');
    if (record?.purpose === 'web') webRecords.push(record);
    if (record?.purpose === 'email') emailRecords.push(record);
    if (record?.name !== changeSet.zoneName && !record?.name?.endsWith(`.${changeSet.zoneName}`)) issues.push('records.zoneScope');
    if (record?.purpose === 'email' && expected.configuration &&
      !(record.name === expected.configuration.email.domain || record.name.endsWith(`.${expected.configuration.email.domain}`))) {
      issues.push('records.emailScope');
    }
    const key = `${record?.name}|${record?.type}`;
    const contents = recordSets.get(key) || new Set();
    contents.add(normalizedContent(record?.content, record?.type));
    recordSets.set(key, contents);
  }
  for (const contents of recordSets.values()) if (contents.size > 1) issues.push('records.conflict');
  const byName = new Map();
  for (const record of changeSet?.records || []) byName.set(record.name, [...(byName.get(record.name) || []), record.type]);
  for (const types of byName.values()) if (types.includes('CNAME') && types.some((type) => type !== 'CNAME')) issues.push('records.cnameConflict');
  if (scope === 'production-cutover') {
    if (webRecords.length !== 1 || webRecords[0]?.type !== 'CNAME' ||
      webRecords[0]?.updatePolicy !== 'replace-exact-record-set' || webRecords[0]?.proxied !== false) {
      issues.push('records.webPolicy');
    }
    if (expected.configuration && webRecords[0]?.name !== expected.configuration.domain.webHostname) issues.push('records.webHostname');
  } else if (webRecords.length !== 0 || emailRecords.length === 0) {
    issues.push('records.acceptancePolicy');
  }
  if (emailRecords.some((record) => record.updatePolicy !== 'create-only' || record.proxied !== false ||
    (record.type === 'MX' && record.name === changeSet.zoneName))) issues.push('records.emailPolicy');
  if (expected.configuration && (expected.configuration.email.provider ? emailRecords.length === 0 : emailRecords.length > 0)) {
    issues.push('records.emailPresence');
  }
  const evidenceNodes = new Set((changeSet?.sourceEvidence || []).map((item) => item.nodeId));
  if (evidenceNodes.size !== (changeSet?.sourceEvidence || []).length ||
    [...evidenceNodes].some((nodeId) => !['candidate.deploy', 'candidate.verify', 'email.domain.create'].includes(nodeId)) ||
    (scope === 'production-cutover' && (
      !evidenceNodes.has('candidate.deploy') || !evidenceNodes.has('candidate.verify') ||
      (expected.configuration && (expected.configuration.email.provider
        ? !evidenceNodes.has('email.domain.create')
        : evidenceNodes.has('email.domain.create')))
    )) ||
    (scope === 'provider-acceptance' && (
      evidenceNodes.size !== 1 || !evidenceNodes.has('email.domain.create')
    ))) {
    issues.push('sourceEvidence.nodes');
  }
  if (issues.length > 0) throw operationError('VALIDATION_FAILED', `DNS ChangeSet is invalid at: ${[...new Set(issues)].join(', ')}`);
  const actual = dnsChangeSetFingerprint(changeSet);
  if (changeSet.fingerprint !== actual) throw operationError('ARTIFACT_INTEGRITY_FAILED', `DNS ChangeSet fingerprint mismatch: ${changeSet.id}`);
  if (changeSet.id !== `dns-change-${actual.slice('sha256:'.length, 'sha256:'.length + 24)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `DNS ChangeSet ID mismatch: ${changeSet.id}`);
  }
  return changeSet;
}

export function dnsChangeSetScope(changeSet) {
  return changeSet?.scope || 'production-cutover';
}

export function dnsChangeSetFingerprint(changeSet) {
  const value = structuredClone(changeSet);
  delete value.id;
  delete value.fingerprint;
  delete value.createdAt;
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function buildDesiredRecords(home, project, configuration, state, graph) {
  const candidate = state.nodes?.['candidate.deploy'];
  const verification = state.nodes?.['candidate.verify'];
  if (candidate?.status !== 'succeeded' || !candidate.resultRef || candidate.graphId !== graph.id) {
    throw operationError('VERIFICATION_FAILED', 'Candidate deployment has not succeeded for the current LaunchGraph.');
  }
  if (verification?.status !== 'succeeded' || !verification.resultRef || verification.graphId !== graph.id) {
    throw operationError('VERIFICATION_FAILED', 'Candidate verification evidence is required before creating production DNS changes.');
  }
  const verifiedEvidence = readCandidateGateEvidence(home, project, graph, configuration, candidate, verification);
  const deploymentUrl = candidate.resultData?.deployment?.url;
  const target = hostname(deploymentUrl);
  if (!target) throw operationError('VALIDATION_FAILED', 'Candidate deployment result does not contain a valid HTTPS hostname.');
  const records = [{
    id: 'web-primary', purpose: 'web', type: 'CNAME', name: configuration.domain.webHostname,
    content: target, ttl: 1, proxied: false, priority: null,
    updatePolicy: 'replace-exact-record-set',
  }];
  const sourceEvidence = [
    { nodeId: 'candidate.deploy', resultRef: candidate.resultRef },
    { nodeId: 'candidate.verify', resultRef: verification.resultRef, fingerprint: verifiedEvidence.fingerprint },
  ];
  if (configuration.email.provider) {
    const email = state.nodes?.['email.domain.create'];
    if (email?.status !== 'succeeded' || !email.resultRef || email.graphId !== graph.id) {
      throw operationError('VERIFICATION_FAILED', 'Email domain DNS Intent is not available for the current LaunchGraph.');
    }
    const intents = email.resultData?.dnsIntent?.records;
    if (!Array.isArray(intents) || intents.length === 0) throw operationError('VALIDATION_FAILED', 'Email domain result does not contain DNS Intent records.');
    for (const [index, record] of intents.entries()) records.push(normalizeEmailRecord(record, index, configuration));
    sourceEvidence.push({ nodeId: 'email.domain.create', resultRef: email.resultRef });
  }
  return { records, sourceEvidence };
}

function buildProviderAcceptanceRecords(configuration, state, graph) {
  if (configuration.email.provider !== 'resend' || !configuration.email.domain) {
    throw operationError('VALIDATION_FAILED', 'Provider-acceptance DNS requires a configured Resend email domain.');
  }
  if (configuration.email.domain === configuration.domain.apex ||
      !configuration.email.domain.endsWith(`.${configuration.domain.apex}`)) {
    throw operationError('VALIDATION_FAILED', 'Provider-acceptance DNS requires an isolated email subdomain below the configured Zone.');
  }
  const email = state.nodes?.['email.domain.create'];
  const resource = state.resources?.['email.domain.create:resend-domain'];
  if (email?.status !== 'succeeded' || !email.resultRef || email.graphId !== graph.id ||
      resource?.provider !== 'resend' || !resource.providerId || resource.name !== configuration.email.domain) {
    throw operationError('VERIFICATION_FAILED', 'Current-Graph Resend Domain evidence and exact Provider ownership are required.');
  }
  const intents = email.resultData?.dnsIntent?.records;
  if (!Array.isArray(intents) || intents.length === 0) {
    throw operationError('VALIDATION_FAILED', 'Resend Domain evidence does not contain DNS Intent records.');
  }
  return {
    records: intents.map((record, index) => normalizeEmailRecord(record, index, configuration)),
    sourceEvidence: [{ nodeId: 'email.domain.create', resultRef: email.resultRef }],
  };
}

function validateLinkedEmailEvidence(configuration, changeSet, state, graph) {
  const email = state.nodes?.['email.domain.create'];
  const resource = state.resources?.['email.domain.create:resend-domain'];
  const emailLink = changeSet.sourceEvidence.find((item) => item.nodeId === 'email.domain.create');
  if (!email || email.status !== 'succeeded' || email.graphId !== graph.id || !emailLink ||
      emailLink.resultRef !== email.resultRef || resource?.provider !== 'resend' ||
      resource.providerId === undefined || resource.name !== configuration.email.domain) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Provider-acceptance DNS evidence no longer matches the current Resend Domain State.');
  }
  const expectedRecords = buildProviderAcceptanceRecords(configuration, state, graph).records;
  if (stableStringify(changeSet.records) !== stableStringify(expectedRecords)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Provider-acceptance DNS records no longer match the Resend DNS Intent.');
  }
}

function validateLinkedCandidateEvidence(home, project, graph, configuration, changeSet, state) {
  const candidate = state.nodes?.['candidate.deploy'];
  const verification = state.nodes?.['candidate.verify'];
  const link = changeSet.sourceEvidence.find((item) => item.nodeId === 'candidate.verify');
  const candidateLink = changeSet.sourceEvidence.find((item) => item.nodeId === 'candidate.deploy');
  const emailLink = changeSet.sourceEvidence.find((item) => item.nodeId === 'email.domain.create');
  if (!candidate || !verification || !link || !candidateLink || candidateLink.resultRef !== candidate.resultRef ||
    link.resultRef !== verification.resultRef) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS ChangeSet candidate evidence links do not match current Deployment State.');
  }
  if (configuration.email.provider) {
    const email = state.nodes?.['email.domain.create'];
    if (!email || !emailLink || emailLink.resultRef !== email.resultRef) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS ChangeSet email evidence link does not match current Deployment State.');
    }
  }
  const evidence = readCandidateGateEvidence(home, project, graph, configuration, candidate, verification);
  if (evidence.fingerprint !== link.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS ChangeSet candidate evidence fingerprint mismatch.');
  }
  const web = changeSet.records.find((record) => record.purpose === 'web');
  if (!web || normalizedContent(web.content, web.type) !== evidence.hostname) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'DNS ChangeSet web target does not match the verified candidate hostname.');
  }
}

function readCandidateGateEvidence(home, project, graph, configuration, candidate, verification) {
  const file = path.resolve(verification.resultRef);
  if (verification.resultData?.evidenceKind === 'ProductVerificationEvidence') {
    const root = path.join(projectPath(home, project.id), 'evidence', 'product-verification');
    assertEvidencePath(file, root);
    const plan = showProductVerificationPlan({
      home,
      projectId: project.id,
      graphId: graph.id,
      configurationId: configuration.id,
      planId: verification.resultData.planId,
    }).plan;
    if (verification.resultData.planFingerprint !== plan.fingerprint) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Candidate verification State does not match the Product Verification Plan.');
    }
    const evidence = readProductVerificationEvidence(file, { project, graph, configuration, plan });
    const target = hostname(candidate.resultData?.deployment?.url);
    if (evidence.phase !== 'candidate' || evidence.status !== 'passed' || evidence.target.hostname !== target ||
      evidence.fingerprint !== verification.resultData.fingerprint) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Product Verification Evidence does not authorize the current candidate target.');
    }
    return { ...evidence, hostname: evidence.target.hostname };
  }
  const root = path.join(projectPath(home, project.id), 'evidence', 'candidate');
  assertEvidencePath(file, root);
  return readCandidateVerificationEvidence(file, { project, graph, configuration, candidate });
}

function assertEvidencePath(file, root) {
  if (!(file === root || file.startsWith(`${root}${path.sep}`))) {
    throw operationError('PATH_BOUNDARY_VIOLATION', 'Candidate verification evidence is outside this project control workspace.');
  }
}

function persistControlNodes(deployment, graph, configuration, changeSet, changeSetFile, now) {
  const nodes = { ...deployment.state.nodes };
  if (configuration.domain.registrationMode === 'adopt-existing') {
    nodes['domain.register'] = {
      ...(nodes['domain.register'] || {}), status: 'succeeded', graphId: graph.id,
      resultRef: `launch-configuration://${configuration.id}`, resultData: {
        mode: 'adopt-existing', domain: configuration.domain.apex,
      }, updatedAt: now,
    };
  }
  nodes['dns.intent.merge'] = {
    ...(nodes['dns.intent.merge'] || {}), status: 'succeeded', graphId: graph.id,
    resultRef: changeSetFile,
    resultData: { changeSetId: changeSet.id, fingerprint: changeSet.fingerprint, recordCount: changeSet.records.length },
    updatedAt: now,
  };
  const next = {
    ...deployment.state, revision: deployment.state.revision + 1, updatedAt: now, nodes,
  };
  validateDeploymentStateV2(next, deployment.state.projectId, deployment.manifest);
  writeJsonAtomic(deployment.stateFile, next);
}

function normalizeEmailRecord(record, index, configuration) {
  const type = String(record?.type || '').toUpperCase();
  const name = String(record?.fqdn || record?.name || '').toLowerCase().replace(/\.$/, '');
  const content = String(record?.value || record?.content || '').replace(/\.$/, '');
  if (!RECORD_TYPES.has(type) || !DNS_NAME.test(name) || !content ||
    !(name === configuration.email.domain || name.endsWith(`.${configuration.email.domain}`))) {
    throw operationError('VALIDATION_FAILED', `Resend DNS Intent is invalid or outside the approved email domain at index ${index}.`);
  }
  return {
    id: `email-${String(index + 1).padStart(2, '0')}`, purpose: 'email', type, name, content,
    ttl: Number.isInteger(record.ttl) ? record.ttl : 1, proxied: false,
    priority: type === 'MX' ? Number(record.priority) : null, updatePolicy: 'create-only',
  };
}

function hostname(value) {
  try {
    const url = new URL(String(value).startsWith('http') ? value : `https://${value}`);
    return url.protocol === 'https:' && DOMAIN.test(url.hostname) ? url.hostname : '';
  } catch { return ''; }
}

function normalizedContent(value, type) {
  const text = String(value || '').trim();
  return ['CNAME', 'MX'].includes(type) ? text.replace(/\.$/, '').toLowerCase() : text;
}
function readChangeSetFile(file, expected) {
  let changeSet;
  try { changeSet = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('VALIDATION_FAILED', `DNS ChangeSet JSON is invalid: ${error.message}`); }
  return validateDnsChangeSet(changeSet, expected);
}
function changeSetPath(home, projectId, changeSetId) {
  if (!CHANGE_ID.test(changeSetId || '')) throw operationError('VALIDATION_FAILED', 'DNS ChangeSet ID is invalid.');
  return path.join(projectPath(home, projectId), 'dns-change-sets', `${changeSetId}.json`);
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
