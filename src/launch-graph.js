import { createHash } from 'node:crypto';

import { buildPlan } from './plan.js';
import { validateLaunchGraph } from './contracts-v2.js';

const TERMINAL_DEPENDENCY_STATUSES = new Set(['succeeded', 'skipped', 'compensated']);

export function buildLaunchGraph(project, manifest, state, { createdAt, artifact = null }) {
  if (manifest.recipeRef) return buildNativeLaunchGraph(project, manifest, state, { createdAt, artifact });
  const legacyState = toLegacyCompatibilityState(state);
  const sourcePlan = buildPlan(manifest.intent, legacyState);
  const nodes = [];

  for (const step of sourcePlan.steps) {
    const previous = nodes.at(-1);
    const dependsOn = previous ? [previous.id] : [];
    const persistedNode = state.nodes?.[step.id];
    const actionTypes = [...new Set((step.actions || []).map((action) => action.type || 'unknown'))].sort();
    const effect = classifySideEffect(step.actions || []);
    const requiresReverification = Boolean(
      persistedNode?.verificationStatus === 'stale' ||
      state.resources?.[step.resource?.id]?.verificationStatus === 'stale' ||
      (step.status === 'skipped' && state.migration?.source === 'legacy-sidecar-import')
    );
    let status;
    if (persistedNode?.status === 'succeeded') {
      status = 'succeeded';
    } else if (step.status === 'skipped' && !requiresReverification) {
      status = 'skipped';
    } else if ((step.actions || []).some((action) => action.sideEffect === 'unknown')) {
      status = 'blocked';
    } else {
      const dependenciesReady = dependsOn.every((id) => {
        const dependency = nodes.find((node) => node.id === id);
        return TERMINAL_DEPENDENCY_STATUSES.has(dependency?.status);
      });
      status = dependenciesReady ? 'ready' : 'planned';
    }

    nodes.push({
      id: step.id,
      title: step.title,
      operation: operationForStep(step),
      resourceType: step.resource?.type || step.kind || 'operation',
      provider: step.provider || manifest.intent.target?.provider || '',
      dependsOn,
      sideEffect: effect.sideEffect,
      approval: effect.approval,
      status,
      retryPolicy: effect.sideEffect === 'read-only' ? 'none' : 'provider-default',
      rollbackNodeId: null,
      evidence: [`node.${step.id}.result`],
      sourceStep: {
        kind: step.kind,
        originalStatus: step.status,
        reason: step.reason || '',
        actionTypes,
      },
      requiresReverification,
    });
  }

  const base = {
    schemaVersion: 1,
    kind: 'LaunchGraph',
    projectId: project.id,
    appId: manifest.intent.app.id,
    createdAt,
    sourceRef: {
      kind: project.source.kind,
      locator: project.source.locator,
      commit: project.source.commit,
    },
    sourcePlanFingerprint: sourcePlan.fingerprint,
    nodes,
    summary: summarizeNodes(nodes),
    migration: manifest.migration
      ? {
          source: manifest.migration.source,
          importId: manifest.migration.importId,
        }
      : {},
  };
  const fingerprint = fingerprintLaunchGraph(base);
  const graph = {
    ...base,
    id: `graph-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    fingerprint,
  };
  validateLaunchGraph(graph, { projectId: project.id, appId: manifest.intent.app.id });
  return graph;
}

function buildNativeLaunchGraph(project, manifest, state, { createdAt, artifact = null }) {
  const nodes = [];
  const add = (definition) => {
    const { blocked = false, succeeded = false, ...nodeDefinition } = definition;
    const persisted = state.nodes?.[definition.id];
    const dependenciesReady = definition.dependsOn.every((id) => {
      const dependency = nodes.find((node) => node.id === id);
      return TERMINAL_DEPENDENCY_STATUSES.has(dependency?.status);
    });
    const status = persisted?.status === 'succeeded' || succeeded
      ? 'succeeded'
      : (blocked ? 'blocked' : (dependenciesReady ? 'ready' : 'planned'));
    nodes.push({
      ...nodeDefinition,
      status,
      retryPolicy: definition.sideEffect === 'read-only' ? 'none' : 'provider-default',
      rollbackNodeId: definition.rollbackNodeId || null,
      evidence: definition.evidence || [`node.${definition.id}.result`],
      sourceStep: {
        kind: 'native-v2',
        originalStatus: 'planned',
        reason: '',
        actionTypes: [],
        ...(definition.sourceStep || {}),
      },
      requiresReverification: false,
    });
  };
  const providers = manifest.providers || {};
  const requirements = manifest.requirements || {};
  const missingConnections = (manifest.requiredConnections || []).filter((item) => item.status !== 'ready');
  add({
    id: 'connections.verify', title: '验证供应商连接与最小权限', operation: 'verify',
    resourceType: 'provider.connections', provider: '', dependsOn: [], sideEffect: 'read-only', approval: null,
    blocked: missingConnections.length > 0,
  });
  add({
    id: 'source.artifact', title: '创建锁定 Commit 的不可变发布产物', operation: 'build',
    resourceType: 'source.artifact', provider: '', dependsOn: [], sideEffect: 'local-control-write', approval: null,
    succeeded: Boolean(artifact),
    evidence: artifact ? [`artifact.${artifact.id}`] : ['node.source.artifact.result'],
    sourceStep: artifact ? {
      originalStatus: 'succeeded',
      reason: `${artifact.kind}:${artifact.id}`,
      actionTypes: ['artifact-integrity-verified'],
    } : {},
  });
  const requiresRepositoryVerification = providers.runtime === 'railway' && providers.delivery === 'github';
  if (requiresRepositoryVerification) {
    add({
      id: 'source.repository.verify', title: '验证 GitHub 候选分支锁定到发布 Commit', operation: 'verify',
      resourceType: 'source.repository', provider: providers.delivery,
      dependsOn: ['connections.verify', 'source.artifact'], sideEffect: 'read-only', approval: null,
    });
  }
  if (requirements.domain) {
    add({
      id: 'domain.register', title: '购买或接管产品域名', operation: 'ensure',
      resourceType: 'domain.registration', provider: providers.registrar, dependsOn: ['connections.verify'],
      sideEffect: 'cost-mutation', approval: 'domain-and-budget',
    });
    add({
      id: 'dns.zone.ensure', title: '创建或接管 DNS Zone', operation: 'ensure',
      resourceType: 'dns.zone', provider: providers.dns, dependsOn: ['domain.register'],
      sideEffect: 'provider-mutation', approval: 'provider-mutation',
    });
  }
  add({
    id: 'runtime.provision', title: '创建或接管运行环境', operation: 'ensure',
    resourceType: 'runtime.project', provider: providers.runtime,
    dependsOn: ['connections.verify', ...(requiresRepositoryVerification ? ['source.repository.verify'] : [])],
    sideEffect: 'cost-mutation', approval: 'platform-and-budget',
  });
  if (requirements.database) {
    add({
      id: 'database.provision', title: '创建或接管数据库', operation: 'ensure',
      resourceType: 'database.project', provider: providers.database, dependsOn: ['connections.verify'],
      sideEffect: 'cost-mutation', approval: 'platform-and-budget',
    });
  }
  if (requirements.email) {
    add({
      id: 'email.domain.create', title: '创建 Resend 发信子域名', operation: 'ensure',
      resourceType: 'email.domain', provider: providers.email, dependsOn: ['connections.verify'],
      sideEffect: 'provider-mutation', approval: 'provider-mutation',
    });
  }
  add({
    id: 'candidate.deploy', title: '部署候选版本到临时地址', operation: 'deploy',
    resourceType: 'runtime.deployment', provider: providers.runtime,
    dependsOn: [
      'source.artifact',
      ...(requiresRepositoryVerification ? ['source.repository.verify'] : []),
      'runtime.provision',
    ], sideEffect: 'provider-mutation', approval: 'provider-mutation',
  });
  if (requirements.database) {
    add({
      id: 'database.inspect', title: '只读检查数据库 Schema 与迁移基线', operation: 'inspect',
      resourceType: 'database.schema', provider: providers.database,
      dependsOn: ['database.provision'], sideEffect: 'read-only', approval: null,
    });
    add({
      id: 'database.backup', title: '创建并验证迁移前数据库恢复点', operation: 'backup',
      resourceType: 'database.backup', provider: providers.database,
      dependsOn: ['database.inspect', 'candidate.deploy'], sideEffect: 'cost-mutation', approval: 'database-backup',
    });
    add({
      id: 'database.migrate', title: '执行受控数据库迁移', operation: 'migrate',
      resourceType: 'database.schema', provider: providers.database,
      dependsOn: ['database.inspect', 'database.backup', 'candidate.deploy'], sideEffect: 'destructive', approval: 'database-migration',
    });
  }
  add({
    id: 'candidate.verify', title: '验证候选版本、数据库和认证入口', operation: 'verify',
    resourceType: 'verification.candidate', provider: providers.runtime,
    dependsOn: ['candidate.deploy', ...(requirements.database ? ['database.migrate'] : [])],
    sideEffect: 'read-only', approval: null,
  });
  const dnsDependencies = ['candidate.verify', ...(requirements.email ? ['email.domain.create'] : [])];
  add({
    id: 'dns.intent.merge', title: '合并 Web 与邮件 DNS Intent', operation: 'plan',
    resourceType: 'dns.intent', provider: providers.dns, dependsOn: dnsDependencies,
    sideEffect: 'read-only', approval: null,
  });
  add({
    id: 'production.dns.apply', title: '切换生产 DNS 到已验证候选版本', operation: 'update',
    resourceType: 'dns.records', provider: providers.dns,
    dependsOn: ['dns.intent.merge', ...(requirements.domain ? ['dns.zone.ensure'] : [])],
    sideEffect: 'provider-mutation', approval: 'production-dns',
  });
  if (requirements.email) {
    add({
      id: 'email.domain.verify', title: '等待 Resend 域名验证', operation: 'verify',
      resourceType: 'email.domain', provider: providers.email, dependsOn: ['production.dns.apply'],
      sideEffect: 'provider-mutation', approval: 'provider-mutation',
    });
  }
  add({
    id: 'product.verify', title: '执行 HTTPS、认证、数据库和邮件联合验收', operation: 'verify',
    resourceType: 'verification.product', provider: '',
    dependsOn: ['production.dns.apply', ...(requirements.email ? ['email.domain.verify'] : [])],
    sideEffect: 'read-only', approval: null,
  });
  add({
    id: 'handoff.write', title: '写入发布证据、状态与交接记录', operation: 'record',
    resourceType: 'control.handoff', provider: '', dependsOn: ['product.verify'],
    sideEffect: 'local-control-write', approval: null,
  });
  const base = {
    schemaVersion: 1,
    kind: 'LaunchGraph',
    projectId: project.id,
    appId: manifest.app.id,
    createdAt,
    sourceRef: manifest.sourceRef,
    sourcePlanFingerprint: manifest.recipeRef.fingerprint,
    nodes,
    summary: summarizeNodes(nodes),
    migration: {},
  };
  const fingerprint = fingerprintLaunchGraph(base);
  const graph = { ...base, id: `graph-${fingerprint.slice(7, 31)}`, fingerprint };
  validateLaunchGraph(graph, { projectId: project.id, appId: manifest.app.id });
  return graph;
}

export function fingerprintLaunchGraph(graph) {
  return `sha256:${createHash('sha256').update(stableStringify(graphFingerprintPayload(graph))).digest('hex')}`;
}

export function assertLaunchGraphIntegrity(graph, expected = {}) {
  validateLaunchGraph(graph, expected);
  const actual = fingerprintLaunchGraph(graph);
  if (actual !== graph.fingerprint) {
    throw new Error(`Launch Graph fingerprint mismatch. Expected ${graph.fingerprint}, calculated ${actual}.`);
  }
  const expectedId = `graph-${actual.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (graph.id !== expectedId) {
    throw new Error(`Launch Graph id does not match its fingerprint: ${graph.id}`);
  }
  return graph;
}

function toLegacyCompatibilityState(state) {
  const observedFact = (key) => state.facts?.[key]?.observed || {};
  const resources = Object.fromEntries(
    Object.entries(state.resources || {}).map(([id, fact]) => [id, fact.observed || {}])
  );
  return {
    version: 1,
    appId: state.appId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedSteps: Object.entries(state.nodes || {})
      .filter(([, node]) => node.status === 'succeeded')
      .map(([id]) => id),
    resources,
    infrastructure: observedFact('infrastructure'),
    domain: observedFact('domain'),
    dns: observedFact('dns'),
    deploymentUrl: observedFact('deployment').url || '',
    github: observedFact('github'),
    runs: [],
  };
}

function operationForStep(step) {
  return {
    check: 'verify',
    command: 'execute',
    resource: 'ensure',
    file: 'render-overlay',
    deploy: 'deploy',
    secret: 'sync',
    vcs: 'ensure',
    verify: 'verify',
  }[step.kind] || 'execute';
}

function classifySideEffect(actions) {
  if (actions.some((action) => action.sideEffect === 'provider-delete')) {
    return { sideEffect: 'destructive', approval: 'destructive-change' };
  }
  if (actions.some((action) => action.requiresCostApproval === true)) {
    return { sideEffect: 'cost-mutation', approval: 'platform-and-budget' };
  }
  if (actions.some((action) => ['provider-mutation', 'vcs-mutation', 'unknown'].includes(action.sideEffect))) {
    return { sideEffect: 'provider-mutation', approval: 'provider-mutation' };
  }
  if (actions.some((action) => ['filesystem', 'local'].includes(action.sideEffect))) {
    return { sideEffect: 'local-control-write', approval: null };
  }
  return { sideEffect: 'read-only', approval: null };
}

function summarizeNodes(nodes) {
  const summary = { total: nodes.length };
  for (const node of nodes) summary[node.status] = (summary[node.status] || 0) + 1;
  summary.requiresApproval = nodes.filter((node) => node.approval).length;
  summary.requiresReverification = nodes.filter((node) => node.requiresReverification).length;
  return summary;
}

function graphFingerprintPayload(graph) {
  const next = structuredClone(graph);
  delete next.id;
  delete next.fingerprint;
  delete next.createdAt;
  return next;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
