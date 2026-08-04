import { createAdapterExecutionPlan } from './adapter-execution-plan.js';
import { verifyArtifact } from './artifact.js';
import { listConnections } from './connection-service.js';
import { readExternalDeployment } from './contracts-v2.js';
import { dnsChangeSetScope, showDnsChangeSet } from './dns-change-set.js';
import { operationError } from './errors.js';
import { showLaunchConfiguration } from './launch-configuration.js';
import { showLaunchGraph } from './launch-service.js';
import { showDatabaseMigrationPlan } from './migration-plan.js';
import { showBackupEvidence } from './backup-evidence.js';
import { PROVIDER_ACCEPTANCE_CAPABILITIES } from './provider-acceptance-suite.js';
import { readProjectRecord, resolveDeployHome } from './project-store.js';

const TERMINAL_NODE_STATUSES = new Set(['succeeded', 'skipped', 'compensated']);
const ACCEPTANCE_PROVIDER_NODES = Object.freeze({
  cloudflare: Object.freeze(['dns.zone.ensure', 'production.dns.apply']),
  neon: Object.freeze(['database.provision', 'database.inspect', 'database.backup', 'database.migrate']),
  railway: Object.freeze(['runtime.provision', 'candidate.deploy']),
  resend: Object.freeze(['email.domain.create', 'email.domain.verify']),
  supabase: Object.freeze(['database.provision']),
  vercel: Object.freeze(['runtime.provision', 'candidate.deploy']),
});

export function generateAdapterExecutionPlan(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: options.graphId }).graph;
  const configuration = showLaunchConfiguration({
    home,
    projectId: project.id,
    graphId: graph.id,
    configurationId: options.configurationId,
  }).configuration;
  const deployment = readExternalDeployment(home, project.id);
  const connections = listConnections({ home, projectId: project.id }).connections;
  if (options.changeSetId && options.migrationPlanId) {
    throw operationError(
      'VALIDATION_FAILED',
      'DNS cutover and database migration stages require separate Adapter Execution Plans.'
    );
  }
  const dnsChangeSet = options.changeSetId ? showDnsChangeSet({
    home, projectId: project.id, graphId: graph.id,
    configurationId: configuration.id, changeSetId: options.changeSetId,
  }).changeSet : null;
  if (dnsChangeSet && dnsChangeSetScope(dnsChangeSet) === 'provider-acceptance') {
    const providers = [...new Set(options.acceptanceProviders || [])].sort();
    if (providers.length !== 2 || providers[0] !== 'cloudflare' || providers[1] !== 'resend') {
      throw operationError(
        'APPROVAL_REQUIRED',
        'Provider-acceptance DNS requires an explicit Cloudflare + Resend acceptance-scoped Adapter Plan.'
      );
    }
  }
  const migrationPlan = options.migrationPlanId ? showDatabaseMigrationPlan({
    home, projectId: project.id, graphId: graph.id,
    configurationId: configuration.id, planId: options.migrationPlanId,
  }).plan : null;
  const backupEvidence = options.backupEvidenceId ? showBackupEvidence({
    home, projectId: project.id, graphId: graph.id, evidenceId: options.backupEvidenceId,
  }).evidence : null;
  if (backupEvidence && (
    !migrationPlan || backupEvidence.migrationPlanId !== migrationPlan.id ||
    backupEvidence.migrationPlanFingerprint !== migrationPlan.fingerprint
  )) throw operationError('CONFLICT', 'Backup Evidence is bound to a different Database Migration Plan.');
  let compilation = compileAdapterActions({
    home, project, graph, configuration, manifest: deployment.manifest,
    state: deployment.state, connections, dnsChangeSet, migrationPlan, backupEvidence,
  });
  if (options.acceptanceProviders?.length > 0) {
    compilation = scopeAdapterCompilationForAcceptance({
      compilation,
      providers: options.acceptanceProviders,
      graph,
      state: deployment.state,
    });
  }
  if (compilation.actions.length === 0) {
    return {
      kind: 'adapter-plan-generation', operation: 'generate', status: 'blocked', home,
      projectId: project.id, graphId: graph.id,
      configuration: configurationRef(configuration), compilation,
      ...(dnsChangeSet ? { dnsChangeSet: changeSetRef(dnsChangeSet) } : {}),
      ...(migrationPlan ? { migrationPlan: migrationPlanRef(migrationPlan) } : {}),
      ...(backupEvidence ? { backupEvidence: backupEvidenceRef(backupEvidence) } : {}),
      providerMutationsExecuted: 0, productRepositoryChanged: false,
    };
  }
  const created = createAdapterExecutionPlan({
    home,
    projectId: project.id,
    graphId: graph.id,
    actions: compilation.actions,
    configuration,
    dnsChangeSet,
    migrationPlan,
    backupEvidence,
    now: options.now,
  });
  return {
    ...created,
    kind: 'adapter-plan-generation',
    operation: 'generate',
    status: compilation.deferredNodes.length > 0 ? 'partial' : 'succeeded',
    configuration: configurationRef(configuration),
    ...(dnsChangeSet ? { dnsChangeSet: changeSetRef(dnsChangeSet) } : {}),
    ...(migrationPlan ? { migrationPlan: migrationPlanRef(migrationPlan) } : {}),
    ...(backupEvidence ? { backupEvidence: backupEvidenceRef(backupEvidence) } : {}),
    compilation,
  };
}

export function compileAdapterActions(context) {
  const { home, project, graph, configuration, manifest, connections, dnsChangeSet, migrationPlan, backupEvidence } = context;
  const actions = [];
  const compiledNodes = new Set();
  const deferredNodes = [];
  const controlNodes = [];
  const connectionByProvider = new Map(
    connections.filter((connection) => connection.status === 'ready').map((connection) => [connection.provider, connection.id])
  );
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const requireConnection = (provider, nodeId) => {
    const connectionId = connectionByProvider.get(provider);
    if (!connectionId) deferredNodes.push({ nodeId, reason: `缺少 ready ${provider} Connection。` });
    return connectionId || '';
  };

  if (dnsChangeSet) {
    return compileDnsCutover({ ...context, actions, compiledNodes, deferredNodes, controlNodes, connectionByProvider, nodeById, requireConnection });
  }
  if (migrationPlan) {
    if (backupEvidence) {
      return compileDatabaseMigrationApplyStage({
        ...context, actions, compiledNodes, deferredNodes, controlNodes,
        connectionByProvider, nodeById, requireConnection,
      });
    }
    return compileDatabaseMigrationStage({
      ...context, actions, compiledNodes, deferredNodes, controlNodes,
      connectionByProvider, nodeById, requireConnection,
    });
  }

  for (const node of graph.nodes) {
    if (['connections.verify', 'source.artifact', 'candidate.verify', 'dns.intent.merge', 'product.verify', 'handoff.write'].includes(node.id)) {
      controlNodes.push({ nodeId: node.id, reason: '由控制平面或验证服务执行，不生成供应商 Adapter 动作。' });
    }
  }

  const repositoryNode = nodeById.get('source.repository.verify');
  if (repositoryNode) {
    const connectionId = requireConnection('github', repositoryNode.id);
    if (connectionId && configuration.runtime.repository && configuration.runtime.sourceBranch) {
      actions.push({
        actionId: 'github-repository', nodeId: repositoryNode.id, provider: 'github', connectionId,
        mode: 'call', method: 'readRepositoryCommit',
        input: {
          repository: configuration.runtime.repository,
          branch: configuration.runtime.sourceBranch,
          commitSha: graphCommit(manifest),
        },
      });
      compiledNodes.add(repositoryNode.id);
    } else if (connectionId) {
      deferredNodes.push({ nodeId: repositoryNode.id, reason: '缺少 GitHub 仓库或锁定候选分支配置。' });
    }
  }

  const runtimeNode = nodeById.get('runtime.provision');
  if (runtimeNode) {
    const provider = configuration.runtime.provider;
    const connectionId = requireConnection(provider, runtimeNode.id);
    if (connectionId && provider === 'vercel') {
      actions.push({
        actionId: 'runtime-project', nodeId: runtimeNode.id, provider, connectionId,
        mode: 'call', method: 'ensureProject',
        input: {
          name: configuration.runtime.projectName,
          framework: configuration.runtime.framework,
          ...(configuration.runtime.buildCommand ? { buildCommand: configuration.runtime.buildCommand } : {}),
          ...(configuration.runtime.installCommand ? { installCommand: configuration.runtime.installCommand } : {}),
          ...(configuration.runtime.outputDirectory ? { outputDirectory: configuration.runtime.outputDirectory } : {}),
        },
      });
      compiledNodes.add(runtimeNode.id);
    } else if (connectionId && provider === 'railway') {
      actions.push(...railwayRuntimeActions(configuration, connectionId));
      compiledNodes.add(runtimeNode.id);
    } else if (connectionId) {
      deferredNodes.push({ nodeId: runtimeNode.id, reason: `${provider} 尚未接入 V2 Adapter Plan 编译器。` });
    }
  }

  const databaseNode = nodeById.get('database.provision');
  if (databaseNode) {
    const provider = configuration.database.provider;
    const connectionId = requireConnection(provider, databaseNode.id);
    if (connectionId && provider === 'neon') {
      actions.push(neonProjectAction(configuration, connectionId));
      compiledNodes.add(databaseNode.id);
    } else if (connectionId && provider === 'supabase') {
      actions.push(supabaseProjectAction(configuration, connectionId));
      compiledNodes.add(databaseNode.id);
    } else if (connectionId) {
      deferredNodes.push({ nodeId: databaseNode.id, reason: `${provider} 数据库尚未接入 V2 Adapter Plan 编译器。` });
    }
  }

  const emailNode = nodeById.get('email.domain.create');
  if (emailNode) {
    const provider = configuration.email.provider;
    const connectionId = requireConnection(provider, emailNode.id);
    if (connectionId && provider === 'resend') {
      actions.push({
        actionId: 'resend-domain', nodeId: emailNode.id, provider, connectionId,
        mode: 'call', method: 'ensureDomain',
        input: { name: configuration.email.domain, region: configuration.email.region, tls: configuration.email.tls },
      });
      compiledNodes.add(emailNode.id);
    } else if (connectionId) {
      deferredNodes.push({ nodeId: emailNode.id, reason: `${provider} 邮件域名尚未接入 V2 Adapter Plan 编译器。` });
    }
  }

  const candidateNode = nodeById.get('candidate.deploy');
  if (candidateNode) compileCandidate({
    home, project, graph, configuration, manifest, candidateNode, actions, compiledNodes, deferredNodes, connectionByProvider,
  });

  if (nodeById.has('domain.register')) {
    deferredNodes.push({
      nodeId: 'domain.register',
      reason: '域名购买保持独立人工审批和注册商阶段，不进入候选资源计划。',
    });
  }
  for (const nodeId of ['dns.zone.ensure', 'production.dns.apply']) {
    if (nodeById.has(nodeId)) deferredNodes.push({
      nodeId,
      reason: '必须先取得候选验证证据并创建 DNS ChangeSet，再使用 --dns-change-set 生成独立 DNS 阶段计划。',
    });
  }
  for (const nodeId of ['database.inspect', 'database.backup', 'database.migrate']) {
    if (nodeById.has(nodeId)) deferredNodes.push({
      nodeId,
      reason: '必须先创建 Database Migration Plan，再使用 --migration-plan 生成检查/备份阶段；迁移阶段还需绑定 Backup Evidence。',
    });
  }
  if (nodeById.has('email.domain.verify')) {
    deferredNodes.push({
      nodeId: 'email.domain.verify',
      reason: '必须等待统一 DNS Apply Evidence 后生成第二阶段验证计划。',
    });
  }

  return {
    status: deferredNodes.length > 0 ? 'partial' : 'ready',
    actions,
    compiledNodes: [...compiledNodes].sort(),
    deferredNodes: deduplicateDeferred(deferredNodes),
    controlNodes,
    summary: {
      actionCount: actions.length,
      compiledNodeCount: compiledNodes.size,
      deferredNodeCount: deduplicateDeferred(deferredNodes).length,
      controlNodeCount: controlNodes.length,
    },
  };
}

export function scopeAdapterCompilationForAcceptance({ compilation, providers, graph, state }) {
  const requestedProviders = normalizeAcceptanceProviders(providers);
  const actionsById = new Map(compilation.actions.map((action) => [action.actionId, action]));
  const selectedActionIds = new Set(
    compilation.actions
      .filter((action) => requestedProviders.includes(action.provider))
      .map((action) => action.actionId)
  );
  const dependencyActionIds = new Set();
  const queue = [...selectedActionIds];
  while (queue.length > 0) {
    const action = actionsById.get(queue.shift());
    for (const dependencyId of actionBindingDependencies(action)) {
      if (selectedActionIds.has(dependencyId)) continue;
      const dependency = actionsById.get(dependencyId);
      if (!dependency) {
        throw operationError(
          'VALIDATION_FAILED',
          `Acceptance-scoped Adapter action ${action.actionId} references a missing action: ${dependencyId}.`
        );
      }
      selectedActionIds.add(dependencyId);
      dependencyActionIds.add(dependencyId);
      queue.push(dependencyId);
    }
  }

  const actions = compilation.actions.filter((action) => selectedActionIds.has(action.actionId));
  const selectedNodeIds = new Set(actions.map((action) => action.nodeId));
  const relevantProviderNodeIds = new Set(
    requestedProviders.flatMap((provider) => ACCEPTANCE_PROVIDER_NODES[provider] || [])
  );
  const deferredNodes = compilation.deferredNodes.filter((item) =>
    relevantProviderNodeIds.has(item.nodeId) || selectedNodeIds.has(item.nodeId)
  );
  const graphById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const nodeId of selectedNodeIds) {
    const node = graphById.get(nodeId);
    const missing = (node?.dependsOn || []).filter((dependencyId) => {
      if (dependencyId === 'connections.verify' || selectedNodeIds.has(dependencyId)) return false;
      const dependency = graphById.get(dependencyId);
      const persisted = state?.nodes?.[dependencyId];
      return !TERMINAL_NODE_STATUSES.has(dependency?.status) &&
        !TERMINAL_NODE_STATUSES.has(persisted?.status);
    });
    if (missing.length > 0) {
      deferredNodes.push({
        nodeId,
        code: 'ACCEPTANCE_PREREQUISITE_INCOMPLETE',
        reason: `供应商专用验收仍依赖未完成节点：${missing.sort().join('、')}。`,
      });
    }
  }
  for (const provider of requestedProviders) {
    const hasAction = actions.some((action) => action.provider === provider);
    const hasDeferredNode = deferredNodes.some((item) => graphById.get(item.nodeId)?.provider === provider);
    if (!hasAction && !hasDeferredNode) {
      deferredNodes.push({
        nodeId: `acceptance.${provider}`,
        code: 'ACCEPTANCE_STAGE_NOT_AVAILABLE',
        reason: `当前 Adapter Plan 阶段没有 ${provider} 动作；请生成该供应商对应的候选、DNS 或数据库阶段计划。`,
      });
    }
  }
  const deferred = deduplicateDeferred(deferredNodes);
  const compiledNodes = [...selectedNodeIds].sort();
  const includedProviders = [...new Set(actions.map((action) => action.provider))].sort();
  return {
    ...compilation,
    status: deferred.length > 0 ? 'partial' : 'ready',
    actions,
    compiledNodes,
    deferredNodes: deferred,
    controlNodes: compilation.controlNodes.filter((item) => relevantProviderNodeIds.has(item.nodeId)),
    acceptanceScope: {
      requestedProviders,
      includedProviders,
      dependencyActionIds: [...dependencyActionIds].sort(),
      excludedActionCount: compilation.actions.length - actions.length,
    },
    summary: {
      actionCount: actions.length,
      compiledNodeCount: compiledNodes.length,
      deferredNodeCount: deferred.length,
      controlNodeCount: compilation.controlNodes.filter((item) => relevantProviderNodeIds.has(item.nodeId)).length,
    },
  };
}

function normalizeAcceptanceProviders(values) {
  const providers = [...new Set((values || []).map((value) => String(value || '').toLowerCase()))].sort();
  if (providers.length === 0 || providers.some((provider) => !PROVIDER_ACCEPTANCE_CAPABILITIES[provider])) {
    throw operationError('VALIDATION_FAILED', 'Adapter Plan acceptance scope contains an unsupported provider.');
  }
  return providers;
}

function actionBindingDependencies(action) {
  return [...Object.values(action.inputBindings || {}), ...Object.values(action.pollInputBindings || {})]
    .map((binding) => binding.actionId);
}

function compileDatabaseMigrationApplyStage(context) {
  const {
    graph, configuration, migrationPlan, backupEvidence, actions, compiledNodes,
    deferredNodes, controlNodes, requireConnection,
  } = context;
  for (const node of graph.nodes) {
    if (node.id !== 'database.migrate') {
      controlNodes.push({ nodeId: node.id, reason: '该阶段只执行已绑定 Backup Evidence 的数据库迁移节点。' });
    }
  }
  if (migrationPlan.status === 'blocked') {
    deferredNodes.push({ nodeId: 'database.migrate', reason: 'Database Migration Plan 仍有阻断项。' });
    return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  }
  if (configuration.database.provider !== 'neon' || migrationPlan.provider !== 'neon' || backupEvidence.provider !== 'neon') {
    deferredNodes.push({ nodeId: 'database.migrate', reason: '当前 Migration Apply Contract 仅支持 Neon 注入式数据库执行器。' });
    return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  }
  const connectionId = requireConnection('neon', 'database.migrate');
  if (!connectionId) return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  const resource = backupEvidence.backup.resource;
  actions.push({
    actionId: 'neon-migration-apply', nodeId: 'database.migrate', provider: 'neon', connectionId,
    mode: 'plan-execute', planMethod: 'planMigration', executeMethod: 'executeMigration',
    input: {
      projectId: resource.attributes.projectId,
      branchId: resource.attributes.sourceBranchId,
      databaseName: configuration.database.databaseName,
      expectedSchemaVersion: migrationPlan.expectedSchemaVersion,
      baselineSchemaFingerprint: backupEvidence.schemaInspection.schemaFingerprint,
      classification: migrationPlan.summary.classification,
      migrationCount: migrationPlan.summary.migrationCount,
      statementCount: migrationPlan.summary.statementCount,
      migrationPlanId: migrationPlan.id,
      migrationPlanFingerprint: migrationPlan.fingerprint,
      backupEvidenceId: backupEvidence.id,
      backupEvidenceFingerprint: backupEvidence.fingerprint,
    },
  });
  compiledNodes.add('database.migrate');
  return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
}

function railwayRuntimeActions(configuration, connectionId) {
  return [{
    actionId: 'railway-project', nodeId: 'runtime.provision', provider: 'railway', connectionId,
    mode: 'call', method: 'ensureProject', input: {
      name: configuration.runtime.projectName,
      defaultEnvironmentName: configuration.runtime.environmentName,
    },
  }, {
    actionId: 'railway-environment', nodeId: 'runtime.provision', provider: 'railway', connectionId,
    mode: 'call', method: 'ensureEnvironment', input: { name: configuration.runtime.environmentName },
    inputBindings: { projectId: { actionId: 'railway-project', path: 'data.resource.providerId' } },
  }, {
    actionId: 'railway-service', nodeId: 'runtime.provision', provider: 'railway', connectionId,
    mode: 'call', method: 'ensureService', input: {
      name: configuration.runtime.serviceName,
      repository: configuration.runtime.repository,
      branch: configuration.runtime.sourceBranch,
    },
    inputBindings: {
      projectId: { actionId: 'railway-project', path: 'data.resource.providerId' },
      environmentId: { actionId: 'railway-environment', path: 'data.resource.providerId' },
    },
  }, {
    actionId: 'railway-domain', nodeId: 'runtime.provision', provider: 'railway', connectionId,
    mode: 'call', method: 'ensureServiceDomain', input: {},
    inputBindings: {
      projectId: { actionId: 'railway-project', path: 'data.resource.providerId' },
      environmentId: { actionId: 'railway-environment', path: 'data.resource.providerId' },
      serviceId: { actionId: 'railway-service', path: 'data.resource.providerId' },
    },
  }];
}

function compileDnsCutover(context) {
  const {
    graph, configuration, state, dnsChangeSet, actions, compiledNodes, deferredNodes,
    controlNodes, nodeById, requireConnection,
  } = context;
  for (const node of graph.nodes) {
    if (['connections.verify', 'source.artifact', 'candidate.verify', 'dns.intent.merge', 'product.verify', 'handoff.write'].includes(node.id)) {
      controlNodes.push({ nodeId: node.id, reason: '由控制平面或验证服务执行，不生成供应商 Adapter 动作。' });
    }
  }
  const zoneNode = nodeById.get('dns.zone.ensure');
  const dnsNode = nodeById.get('production.dns.apply');
  const cloudflareConnectionId = requireConnection('cloudflare', zoneNode?.id || dnsNode?.id || 'production.dns.apply');
  if (zoneNode && cloudflareConnectionId) {
    actions.push({
      actionId: 'cloudflare-zone', nodeId: zoneNode.id, provider: 'cloudflare', connectionId: cloudflareConnectionId,
      mode: 'call', method: 'ensureZone', input: { name: dnsChangeSet.zoneName },
    });
    compiledNodes.add(zoneNode.id);
  }
  if (dnsNode && cloudflareConnectionId && zoneNode) {
    actions.push({
      actionId: 'cloudflare-dns-change-set', nodeId: dnsNode.id, provider: 'cloudflare', connectionId: cloudflareConnectionId,
      mode: 'plan-execute', planMethod: 'planDnsChangeSet', executeMethod: 'executeDnsChangeSet',
      input: { changeSet: dnsChangeSet },
      inputBindings: { zoneId: { actionId: 'cloudflare-zone', path: 'data.resource.providerId' } },
    });
    compiledNodes.add(dnsNode.id);
  }
  const verifyNode = nodeById.get('email.domain.verify');
  if (verifyNode && configuration.email.provider === 'resend') {
    const connectionId = requireConnection('resend', verifyNode.id);
    const domainId = state?.resources?.['email.domain.create:resend-domain']?.providerId;
    if (!domainId) {
      deferredNodes.push({ nodeId: verifyNode.id, reason: '缺少已持久化的 Resend Domain Provider ID。' });
    } else if (connectionId) {
      actions.push({
        actionId: 'resend-domain-verify', nodeId: verifyNode.id, provider: 'resend', connectionId,
        mode: 'plan-execute', planMethod: 'planVerification', executeMethod: 'executeVerification', pollMethod: 'pollDomain',
        input: {
          domainId, domainName: configuration.email.domain,
          dnsAppliedFingerprint: dnsChangeSet.fingerprint.slice('sha256:'.length),
        },
        pollInput: { domainId, domainName: configuration.email.domain },
      });
      compiledNodes.add(verifyNode.id);
    }
  }
  for (const nodeId of ['domain.register', 'database.inspect', 'database.backup', 'database.migrate']) {
    if (nodeById.has(nodeId) && state?.nodes?.[nodeId]?.status !== 'succeeded') {
      deferredNodes.push({ nodeId, reason: '该高风险节点仍需要独立执行器与审批。' });
    }
  }
  return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
}

function compileDatabaseMigrationStage(context) {
  const {
    graph, configuration, state, migrationPlan, actions, compiledNodes, deferredNodes,
    controlNodes, nodeById, requireConnection,
  } = context;
  for (const node of graph.nodes) {
    if (['connections.verify', 'source.artifact', 'candidate.verify', 'dns.intent.merge', 'product.verify', 'handoff.write'].includes(node.id)) {
      controlNodes.push({ nodeId: node.id, reason: '由控制平面或验证服务执行，不生成数据库 Adapter 动作。' });
    }
  }
  if (migrationPlan.status === 'blocked') {
    deferredNodes.push({ nodeId: 'database.inspect', reason: 'Database Migration Plan 仍有阻断项，禁止生成数据库执行动作。' });
    deferredNodes.push({ nodeId: 'database.backup', reason: '必须先修复 Database Migration Plan 阻断项。' });
    deferredNodes.push({ nodeId: 'database.migrate', reason: '必须先修复 Database Migration Plan 阻断项。' });
    return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  }
  const provider = configuration.database.provider;
  if (provider !== migrationPlan.provider) {
    deferredNodes.push({ nodeId: 'database.inspect', reason: 'Migration Plan 与 Launch Configuration 的数据库供应商不一致。' });
    return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  }
  if (provider !== 'neon') {
    deferredNodes.push(...databaseProviderDeferrals(provider));
    return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  }
  const connectionId = requireConnection('neon', 'database.inspect');
  const projectResource = uniqueStateResource(state, 'database.provision', 'neon', 'database.project');
  if (!projectResource.resource) {
    deferredNodes.push({
      nodeId: 'database.inspect',
      reason: projectResource.reason || '缺少已持久化并核验的 Neon Project Provider ID。',
    });
    deferredNodes.push({ nodeId: 'database.backup', reason: '必须先完成 database.provision 并持久化 Neon Project。' });
    deferredNodes.push({ nodeId: 'database.migrate', reason: '必须先完成 Schema Inspection 与 Backup。' });
    return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  }
  if (!connectionId) {
    deferredNodes.push({ nodeId: 'database.backup', reason: '缺少 ready neon Connection。' });
    deferredNodes.push({ nodeId: 'database.migrate', reason: '缺少 ready neon Connection。' });
    return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
  }
  const binding = {
    migrationPlanId: migrationPlan.id,
    migrationPlanFingerprint: migrationPlan.fingerprint,
  };
  actions.push({
    actionId: 'neon-root-branch', nodeId: 'database.inspect', provider: 'neon', connectionId,
    mode: 'call', method: 'readBranchByName',
    input: { projectId: projectResource.resource.providerId, name: configuration.database.branchName, ...binding },
  }, {
    actionId: 'neon-schema-inspect', nodeId: 'database.inspect', provider: 'neon', connectionId,
    mode: 'call', method: 'inspectSchema',
    input: { projectId: projectResource.resource.providerId, databaseName: configuration.database.databaseName, ...binding },
    inputBindings: { branchId: { actionId: 'neon-root-branch', path: 'data.branch.id' } },
  });
  compiledNodes.add('database.inspect');

  const backupResource = uniqueStateResource(state, 'database.backup', 'neon', 'database.backup');
  const snapshotName = `agentmesh-pre-${migrationPlan.id.slice(-12)}`;
  const known = backupResource.resource &&
    backupResource.resource.attributes?.migrationPlanFingerprint === migrationPlan.fingerprint
      ? {
        knownProviderId: backupResource.resource.providerId,
        knownPlanFingerprint: backupResource.resource.attributes?.snapshotPlanFingerprint || '',
      }
    : {};
  actions.push({
    actionId: 'neon-pre-migration-snapshot', nodeId: 'database.backup', provider: 'neon', connectionId,
    mode: 'plan-execute', planMethod: 'planSnapshot', executeMethod: 'executeSnapshot', pollMethod: 'pollOperation',
    input: {
      projectId: projectResource.resource.providerId,
      name: snapshotName,
      ...binding,
      ...(known.knownProviderId && known.knownPlanFingerprint ? known : {}),
    },
    inputBindings: { branchId: { actionId: 'neon-root-branch', path: 'data.branch.id' } },
    pollInput: { projectId: projectResource.resource.providerId },
    pollInputBindings: { operationIds: { actionId: 'neon-pre-migration-snapshot', path: 'data.operationIds' } },
  }, {
    actionId: 'neon-snapshot-verify', nodeId: 'database.backup', provider: 'neon', connectionId,
    mode: 'call', method: 'readSnapshot',
    input: { projectId: projectResource.resource.providerId, name: snapshotName, ...binding },
    inputBindings: {
      branchId: { actionId: 'neon-root-branch', path: 'data.branch.id' },
      snapshotId: { actionId: 'neon-pre-migration-snapshot', path: 'data.resource.providerId' },
    },
  });
  compiledNodes.add('database.backup');
  deferredNodes.push({
    nodeId: 'database.migrate',
    reason: '必须先把 Snapshot Verify Receipt 固化为 Backup Evidence，再生成 Migration Apply 计划。',
  });
  return compilationResult(actions, compiledNodes, deferredNodes, controlNodes);
}

function neonProjectAction(configuration, connectionId) {
  const database = configuration.database;
  return {
    actionId: 'neon-project', nodeId: 'database.provision', provider: 'neon', connectionId,
    mode: 'plan-execute', planMethod: 'planProject', executeMethod: 'executeProject', pollMethod: 'pollOperation',
    input: {
      name: database.name, regionId: database.regionId, pgVersion: database.pgVersion,
      branchName: database.branchName, databaseName: database.databaseName, roleName: database.roleName,
      minCu: database.minCu, maxCu: database.maxCu, suspendTimeoutSeconds: database.suspendTimeoutSeconds,
      destinationSecretRef: database.connectionSecretRef,
      ...(database.orgId ? { orgId: database.orgId } : {}),
    },
    pollInputBindings: {
      projectId: { actionId: 'neon-project', path: 'data.resource.providerId' },
      operationIds: { actionId: 'neon-project', path: 'data.operationIds' },
    },
  };
}

function supabaseProjectAction(configuration, connectionId) {
  const database = configuration.database;
  return {
    actionId: 'supabase-project', nodeId: 'database.provision', provider: 'supabase', connectionId,
    mode: 'plan-execute', planMethod: 'planProject', executeMethod: 'executeProject', pollMethod: 'pollProject',
    input: {
      name: database.name, organizationSlug: database.organizationSlug,
      regionType: database.regionType, regionCode: database.regionCode, instanceSize: database.instanceSize,
      databasePasswordRef: database.passwordSecretRef,
      connectionDestinationSecretRef: database.connectionSecretRef,
    },
    pollInput: {
      projectName: database.name,
      organizationSlug: database.organizationSlug,
      requiredServices: ['auth', 'db', 'pooler', 'rest', 'storage'],
    },
    pollInputBindings: { projectRef: { actionId: 'supabase-project', path: 'data.resource.providerId' } },
  };
}

function compileCandidate(context) {
  const {
    home, project, graph, configuration, manifest, candidateNode, actions,
    compiledNodes, deferredNodes, connectionByProvider,
  } = context;
  const provider = configuration.runtime.provider;
  const connectionId = connectionByProvider.get(provider);
  if (!connectionId) {
    deferredNodes.push({ nodeId: candidateNode.id, reason: `缺少 ready ${provider} Connection。` });
    return;
  }
  if (provider === 'vercel') {
    const artifactId = project.lastVercelArtifact?.id;
    if (!artifactId) {
      deferredNodes.push({ nodeId: candidateNode.id, reason: '缺少当前 Commit 的 Vercel 文件 Artifact。' });
      return;
    }
    let artifact;
    try { artifact = verifyArtifact({ home, projectId: project.id, artifactId }).artifact; }
    catch (error) {
      deferredNodes.push({ nodeId: candidateNode.id, reason: `Vercel Artifact 不可用：${error.code || 'VALIDATION_FAILED'}。` });
      return;
    }
    if (artifact.sourceRef.commit !== graphCommit(manifest)) {
      deferredNodes.push({ nodeId: candidateNode.id, reason: 'Vercel Artifact Commit 与 Manifest 不一致。' });
      return;
    }
    actions.push({
      actionId: 'candidate-deployment', nodeId: candidateNode.id, provider, connectionId,
      mode: 'plan-execute', planMethod: 'planCandidateDeployment', executeMethod: 'executeCandidateDeployment',
      pollMethod: 'pollDeployment',
      input: {
        name: configuration.runtime.projectName,
        artifact,
        projectSettings: {
          framework: configuration.runtime.framework,
          ...(configuration.runtime.buildCommand ? { buildCommand: configuration.runtime.buildCommand } : {}),
          ...(configuration.runtime.installCommand ? { installCommand: configuration.runtime.installCommand } : {}),
          ...(configuration.runtime.outputDirectory ? { outputDirectory: configuration.runtime.outputDirectory } : {}),
        },
      },
      inputBindings: { projectId: { actionId: 'runtime-project', path: 'data.resource.providerId' } },
      pollInputBindings: { deploymentId: { actionId: 'candidate-deployment', path: 'data.deployment.id' } },
    });
    compiledNodes.add(candidateNode.id);
    return;
  }
  if (provider === 'railway') {
    if (graph.nodes.some((node) => node.id === 'source.repository.verify') &&
        !compiledNodes.has('source.repository.verify')) {
      deferredNodes.push({ nodeId: candidateNode.id, reason: 'GitHub 仓库与锁定候选分支尚未进入只读验证计划。' });
      return;
    }
    actions.push({
      actionId: 'railway-candidate', nodeId: candidateNode.id, provider, connectionId,
      mode: 'plan-execute', planMethod: 'planCandidateDeployment', executeMethod: 'executeCandidateDeployment',
      pollMethod: 'pollDeployment',
      input: {
        environmentName: configuration.runtime.environmentName,
        environmentClass: 'candidate', serviceName: configuration.runtime.serviceName,
        repository: configuration.runtime.repository,
        branch: configuration.runtime.sourceBranch,
        commitSha: graphCommit(manifest),
      },
      inputBindings: {
        projectId: { actionId: 'railway-project', path: 'data.resource.providerId' },
        environmentId: { actionId: 'railway-environment', path: 'data.resource.providerId' },
        serviceId: { actionId: 'railway-service', path: 'data.resource.providerId' },
        connectedRepositoryVerified: { actionId: 'railway-service', path: 'data.sourceConnected' },
        sourceConnectionCreated: { actionId: 'railway-service', path: 'data.created' },
        publicUrl: { actionId: 'railway-domain', path: 'data.url' },
      },
      pollInput: {
        repository: configuration.runtime.repository,
        commitSha: graphCommit(manifest),
      },
      pollInputBindings: {
        projectId: { actionId: 'railway-project', path: 'data.resource.providerId' },
        environmentId: { actionId: 'railway-environment', path: 'data.resource.providerId' },
        serviceId: { actionId: 'railway-service', path: 'data.resource.providerId' },
        publicUrl: { actionId: 'railway-domain', path: 'data.url' },
      },
    });
    compiledNodes.add(candidateNode.id);
    return;
  }
  deferredNodes.push({ nodeId: candidateNode.id, reason: `${provider} 候选部署尚未接入 V2 Adapter Plan 编译器。` });
}

function graphCommit(manifest) { return manifest.sourceRef.commit; }
function configurationRef(configuration) {
  return { id: configuration.id, fingerprint: configuration.fingerprint };
}
function changeSetRef(changeSet) { return { id: changeSet.id, fingerprint: changeSet.fingerprint }; }
function migrationPlanRef(plan) { return { id: plan.id, fingerprint: plan.fingerprint, status: plan.status }; }
function backupEvidenceRef(evidence) { return { id: evidence.id, fingerprint: evidence.fingerprint, status: evidence.status }; }
function databaseProviderDeferrals(provider) {
  if (provider === 'supabase') return [{
    nodeId: 'database.inspect',
    code: 'SUPABASE_DATABASE_CONNECTION_REQUIRED',
    reason: 'Supabase Management API 不提供可作为迁移基线的完整 Schema 摘要；需要受控数据库只读连接。',
  }, {
    nodeId: 'database.backup',
    code: 'SUPABASE_LOGICAL_BACKUP_REQUIRED',
    reason: 'Supabase 可列出计划备份/PITR，但没有即时物理 Snapshot Create API；迁移前需通过受控 supabase db dump/pg_dump 生成加密逻辑备份。',
  }, {
    nodeId: 'database.migrate',
    code: 'SUPABASE_MIGRATION_EXECUTOR_REQUIRED',
    reason: '必须先取得 Schema Evidence 与即时逻辑 Backup Evidence，才允许启用 Supabase Migration Apply。',
  }];
  if (provider === 'railway') return [{
    nodeId: 'database.inspect',
    code: 'RAILWAY_DATABASE_CONNECTION_REQUIRED',
    reason: 'Railway Project API 不读取 PostgreSQL Schema；需要解析服务 Secret Ref 后建立受控只读数据库连接。',
  }, {
    nodeId: 'database.backup',
    code: 'RAILWAY_VOLUME_INSTANCE_REQUIRED',
    reason: 'Railway Public API 只能为明确的 Volume Instance 创建备份；必须先解析数据库 Service/Environment/Volume Instance，且校验手动备份容量限制。',
  }, {
    nodeId: 'database.migrate',
    code: 'RAILWAY_MIGRATION_EXECUTOR_REQUIRED',
    reason: '必须先完成 Volume Backup Evidence 和受控数据库连接，才允许 Railway Migration Apply。',
  }];
  if (provider === 'cloudflare') return [{
    nodeId: 'database.inspect', code: 'D1_SCHEMA_INSPECTION_REQUIRED',
    reason: 'Cloudflare D1 需要独立的只读 Schema Inspection 与迁移历史契约。',
  }, {
    nodeId: 'database.backup', code: 'D1_BOOKMARK_BACKUP_REQUIRED',
    reason: 'Cloudflare D1 必须绑定 Time Travel/Bookmark 恢复点证据，不能复用 PostgreSQL 备份契约。',
  }, {
    nodeId: 'database.migrate', code: 'D1_MIGRATION_EXECUTOR_REQUIRED',
    reason: 'Cloudflare D1 Migration Apply 尚未通过独立方言与恢复验收。',
  }];
  return [{ nodeId: 'database.inspect', code: 'DATABASE_PROVIDER_UNSUPPORTED', reason: `${provider} 尚未实现安全的 Schema Inspection Adapter。` },
    { nodeId: 'database.backup', code: 'DATABASE_PROVIDER_UNSUPPORTED', reason: `${provider} 尚未实现迁移前即时备份 Adapter。` },
    { nodeId: 'database.migrate', code: 'DATABASE_PROVIDER_UNSUPPORTED', reason: `${provider} Migration Apply 仍保持禁用。` }];
}
function uniqueStateResource(state, nodeId, provider, type) {
  const matches = Object.entries(state?.resources || {})
    .filter(([key, resource]) => key.startsWith(`${nodeId}:`) && resource?.provider === provider &&
      resource?.type === type && resource?.verificationStatus === 'current')
    .map(([, resource]) => resource);
  if (matches.length === 1) return { resource: matches[0] };
  if (matches.length > 1) return { resource: null, reason: `${nodeId} 存在多个候选供应商资源，必须人工对账。` };
  return { resource: null, reason: `${nodeId} 尚无已持久化的 ${provider} ${type} 资源。` };
}
function deduplicateDeferred(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.nodeId)) return false;
    seen.add(item.nodeId);
    return true;
  });
}

function compilationResult(actions, compiledNodes, deferredNodes, controlNodes) {
  const deferred = deduplicateDeferred(deferredNodes);
  return {
    status: deferred.length > 0 ? 'partial' : 'ready', actions,
    compiledNodes: [...compiledNodes].sort(), deferredNodes: deferred, controlNodes,
    summary: {
      actionCount: actions.length, compiledNodeCount: compiledNodes.size,
      deferredNodeCount: deferred.length, controlNodeCount: controlNodes.length,
    },
  };
}
