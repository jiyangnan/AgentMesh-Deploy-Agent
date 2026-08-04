import { createHash } from 'node:crypto';

import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from '../provider-contract.js';
import { createProviderHttpTransport } from '../provider-http.js';
import { resolveConnectionSecretRefs } from '../secret-ref.js';

const PROVIDER = 'neon';
const API_BASE = 'https://console.neon.tech/api/v2/';
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,255}$/;
const POSTGRES_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const REGION_ID = /^[a-z0-9]+(?:-[a-z0-9]+){2,7}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const CONTROL_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const MIGRATION_PLAN_ID = /^migration-plan-[a-f0-9]{24}$/;
const BACKUP_EVIDENCE_ID = /^backup-evidence-[a-f0-9]{24}$/;
const SCHEMA_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const MIGRATION_CLASSIFICATIONS = new Set(['additive', 'reversible', 'destructive', 'unknown']);
const SECRET_DESTINATION = /^(?:keychain|op|secret):\/\/[A-Za-z0-9._/-]+$/;
const TOKEN_SCOPES = new Set(['personal', 'organization', 'project']);
const PRODUCTION_NAMES = new Set(['main', 'master', 'prod', 'production', 'live']);
const WAITING_OPERATION_STATES = new Set(['scheduling', 'running', 'cancelling']);
const SUCCESS_OPERATION_STATES = new Set(['finished', 'skipped']);
const TERMINAL_OPERATION_STATES = new Set(['failed', 'error', 'cancelled', 'canceled']);

export class NeonV2Adapter {
  #token;
  #tokenScope;
  #orgId;
  #scopedProjectId;
  #transport;
  #secretSink;
  #migrationExecutor;

  constructor(options = {}) {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('Neon API key is required.');
    if (!TOKEN_SCOPES.has(options.tokenScope || 'personal')) {
      throw new Error('Neon tokenScope must be personal, organization, or project.');
    }
    if (options.orgId && !SAFE_ID.test(options.orgId)) throw new Error('Neon orgId is invalid.');
    if (options.tokenScope === 'project' && !SAFE_ID.test(options.projectId || '')) {
      throw new Error('A Neon project-scoped key requires its verified projectId.');
    }
    this.#token = options.token;
    this.#tokenScope = options.tokenScope || 'personal';
    this.#orgId = options.orgId || '';
    this.#scopedProjectId = options.projectId || '';
    this.#transport = options.transport || createProviderHttpTransport(options.httpOptions);
    this.#secretSink = options.secretSink || null;
    this.#migrationExecutor = options.migrationExecutor || null;
  }

  async readProject(input) {
    const operation = 'neon.project.read';
    const invalid = validateProjectRead(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const response = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const resource = normalizeProject(response.data?.project || response.data, input, input.lifecycle || 'external');
    if (resource.error) return this.#failure(operation, input.appId, resource.error, input);
    return this.#success(operation, input.appId, {
      resource: resource.resource,
      observedAt: input.now || new Date().toISOString(),
    }, input);
  }

  planProject(input) {
    const operation = 'neon.project.plan';
    const invalid = validateProjectPlan(input, this.#tokenScope, this.#orgId);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    if (this.#tokenScope === 'project') {
      return this.#failure(operation, input.appId, capabilityError('A project-scoped Neon API key cannot create or enumerate projects.'), input);
    }
    const planFingerprint = projectPlanFingerprint(input, this.#tokenScope, this.#orgId);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      project: projectPlanSummary(input, this.#tokenScope, this.#orgId),
      destinationSecretRef: input.destinationSecretRef,
      planFingerprint,
      providerMutationsExecuted: 0,
      costMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve the Neon project cost and provider mutation after reviewing region and compute limits.'],
    });
  }

  async executeProject(input) {
    const operation = 'neon.project.create';
    const invalid = validateProjectPlan(input, this.#tokenScope, this.#orgId) || validateCostGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    if (this.#tokenScope === 'project') {
      return this.#failure(operation, input.appId, capabilityError('A project-scoped Neon API key cannot create projects.'), input);
    }
    const expectedPlan = projectPlanFingerprint(input, this.#tokenScope, this.#orgId);
    if (input.planFingerprint !== expectedPlan) {
      return this.#failure(operation, input.appId, conflictError('Neon Project plan fingerprint does not match the approved plan.'), input);
    }

    const sink = await this.#preflightSecretSink(operation, input);
    if (sink.result) return sink.result;

    const existing = await this.#findProjectByName(input.name);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.project) {
      const project = normalizeProject(existing.project, input, 'managed');
      if (project.error) return this.#failure(operation, input.appId, project.error, input);
      if (
        input.knownProviderId !== project.resource.providerId ||
        input.knownPlanFingerprint !== input.planFingerprint
      ) {
        return this.#failure(operation, input.appId, conflictError('An exact Neon Project already exists without matching recorded ownership and approved plan.'), input);
      }
      return this.#success(operation, input.appId, {
        resource: project.resource,
        created: false,
        adopted: true,
        changed: false,
        destinationSecretRef: input.destinationSecretRef,
        secretCaptured: sink.readiness.present === true,
        secretCaptureRequired: sink.readiness.present !== true,
        providerMutationsExecuted: 0,
        costMutationsExecuted: 0,
        idempotency: 'read-before-create',
      }, input, {
        nextActions: sink.readiness.present === true
          ? []
          : ['Run the separately approved Neon connection capture action; do not recreate the project.'],
      });
    }
    if (input.knownProviderId) {
      return this.#failure(operation, input.appId, conflictError('DeploymentState records a Neon Project that is absent from the exact provider listing.'), input);
    }
    if (sink.readiness.present === true) {
      return this.#failure(operation, input.appId, conflictError('The destination Secret Ref is occupied but no matching Neon Project state exists.'), input);
    }

    let response = await this.#requestSafe('POST', 'projects', {
      project: projectCreateRequest(input, this.#tokenScope, this.#orgId),
    });
    let suspendTimeoutAppliedByProviderDefault = false;
    if (isFixedDefaultSuspendTimeoutRejection(response, input)) {
      response = await this.#requestSafe('POST', 'projects', {
        project: projectCreateRequest(input, this.#tokenScope, this.#orgId, {
          omitFixedDefaultSuspendTimeout: true,
        }),
      });
      suspendTimeoutAppliedByProviderDefault = true;
    }
    if (!response.ok) {
      if (isUncertainMutation(response)) {
        const recovered = await this.#findProjectByName(input.name);
        if (recovered.project && !recovered.conflict) {
          const project = normalizeProject(recovered.project, input, 'managed');
          if (project.error) return this.#failure(operation, input.appId, project.error, input);
          return this.#success(operation, input.appId, {
            resource: project.resource,
            created: true,
            adopted: false,
            changed: true,
            recoveredAfterUncertainCreate: true,
            destinationSecretRef: input.destinationSecretRef,
            secretCaptured: false,
            secretCaptureRequired: true,
            providerMutationsExecuted: 1,
            costMutationsExecuted: 1,
            duplicateCreatePrevented: true,
          }, input, {
            nextActions: ['Run connection capture after recording the recovered Project ID; automatic Project Create replay is disabled.'],
          });
        }
        if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
        return this.#failure(operation, input.appId, reconciliationError('Neon Project Create may have committed, but exact provider state is inconclusive; automatic replay is disabled.'), input, {
          data: { providerMutationsExecuted: 1, costMutationsExecuted: 1, duplicateCreatePrevented: true },
        });
      }
      return this.#providerFailure(operation, input.appId, response, input);
    }

    const bundle = normalizeCreatedProject(response.data, input);
    if (bundle.error) return this.#failure(operation, input.appId, bundle.error, input, {
      data: {
        providerMutationsExecuted: 1,
        costMutationsExecuted: 1,
        ...(bundle.projectId ? { projectId: bundle.projectId } : {}),
      },
    });
    const capture = await this.#captureCreatedSecret(input, bundle.connectionUri, {
      providerId: bundle.resource.providerId,
      projectId: bundle.resource.providerId,
      branchId: bundle.branch.id,
      endpointId: bundle.endpoint.id,
      databaseName: input.databaseName,
      roleName: input.roleName,
      purpose: 'database-connection',
      planFingerprint: input.planFingerprint,
    });
    if (capture.error) {
      return this.#failure(operation, input.appId, capture.error, input, {
        data: {
          projectId: bundle.resource.providerId,
          branchId: bundle.branch.id,
          endpointId: bundle.endpoint.id,
          providerMutationsExecuted: 1,
          costMutationsExecuted: 1,
          secretCaptured: false,
        },
        nextActions: ['Record the Project ID and use the separately approved connection capture action; do not recreate the project.'],
      });
    }
    return this.#success(operation, input.appId, {
      resource: bundle.resource,
      branch: bundle.branch,
      endpoint: bundle.endpoint,
      operationIds: bundle.operationIds,
      created: true,
      adopted: false,
      changed: true,
      destinationSecretRef: input.destinationSecretRef,
      secretCaptured: true,
      secretValuesExposed: false,
      suspendTimeoutAppliedByProviderDefault,
      providerMutationsExecuted: 1,
      costMutationsExecuted: 1,
      idempotency: 'read-before-create',
    }, input, {
      status: bundle.operationIds.length > 0 ? 'waiting-external' : 'succeeded',
      warnings: suspendTimeoutAppliedByProviderDefault
        ? ['Neon applied its account-enforced 300-second default suspend interval.']
        : [],
      nextActions: bundle.operationIds.length > 0 ? ['Poll every Neon operation before using the database.'] : [],
    });
  }

  planConnectionCapture(input) {
    const operation = 'neon.connection.plan-capture';
    const invalid = validateConnectionCapture(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const planFingerprint = connectionCaptureFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      projectId: input.projectId,
      projectName: input.projectName,
      branchId: input.branchId || '',
      branchName: input.branchName,
      databaseName: input.databaseName,
      roleName: input.roleName,
      pooled: input.pooled !== false,
      destinationSecretRef: input.destinationSecretRef,
      planFingerprint,
      providerMutationsExecuted: 0,
      secretReadsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve reading one Neon connection URI directly into the exact Secret Sink destination.'],
    });
  }

  async executeConnectionCapture(input) {
    const operation = 'neon.connection.capture';
    const invalid = validateConnectionCapture(input) || validateSecretReadGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    if (input.planFingerprint !== connectionCaptureFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Neon connection capture fingerprint does not match the approved plan.'), input);
    }
    const sink = await this.#preflightSecretSink(operation, input);
    if (sink.result) return sink.result;
    if (sink.readiness.present === true) {
      if (input.knownPlanFingerprint === input.planFingerprint && input.knownProviderId === input.projectId) {
        return this.#success(operation, input.appId, {
          projectId: input.projectId,
          branchId: input.branchId || '',
          destinationSecretRef: input.destinationSecretRef,
          secretCaptured: true,
          adopted: true,
          providerMutationsExecuted: 0,
          secretReadsExecuted: 0,
          secretValuesExposed: false,
        }, input);
      }
      return this.#failure(operation, input.appId, conflictError('The destination Secret Ref is occupied without matching recorded Neon capture state.'), input);
    }

    const projectResponse = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}`);
    if (!projectResponse.ok) return this.#providerFailure(operation, input.appId, projectResponse, input);
    const project = normalizeProject(projectResponse.data?.project || projectResponse.data, {
      ...input,
      logicalId: input.logicalId || 'database.project',
      name: input.projectName,
    }, 'managed');
    if (project.error) return this.#failure(operation, input.appId, project.error, input);

    const branch = await this.#findBranchByName(input.projectId, input.branchName);
    if (branch.error) return this.#providerFailure(operation, input.appId, branch.error, input);
    if (branch.conflict) return this.#failure(operation, input.appId, branch.conflict, input);
    if (!branch.branch) return this.#failure(operation, input.appId, notFoundError('The approved Neon branch was not found.'), input);
    if (input.branchId && branch.branch.id !== input.branchId) {
      return this.#failure(operation, input.appId, conflictError('Neon branch identity differs from the approved capture plan.'), input);
    }
    const branchState = normalizeBranch(branch.branch);
    if (branchState.error) return this.#failure(operation, input.appId, branchState.error, input);
    if (branchState.branch.projectId && branchState.branch.projectId !== input.projectId) {
      return this.#failure(operation, input.appId, conflictError('Neon connection Branch belongs to a different Project ID.'), input);
    }

    const query = new URLSearchParams({
      branch_id: branchState.branch.id,
      database_name: input.databaseName,
      role_name: input.roleName,
      pooled: input.pooled === false ? 'false' : 'true',
    });
    if (input.endpointId) query.set('endpoint_id', input.endpointId);
    const response = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}/connection_uri?${query}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const uri = extractConnectionUri(response.data);
    if (!uri) return this.#failure(operation, input.appId, providerResponseError('Neon connection URI response is missing a valid PostgreSQL URI.'), input);
    const capture = await this.#captureCreatedSecret(input, uri, {
      providerId: input.projectId,
      projectId: input.projectId,
      branchId: branchState.branch.id,
      endpointId: input.endpointId || '',
      databaseName: input.databaseName,
      roleName: input.roleName,
      pooled: input.pooled !== false,
      purpose: 'database-connection',
      planFingerprint: input.planFingerprint,
    });
    if (capture.error) return this.#failure(operation, input.appId, capture.error, input, {
      data: {
        projectId: input.projectId,
        branchId: branchState.branch.id,
        destinationSecretRef: input.destinationSecretRef,
        secretCaptured: false,
        providerMutationsExecuted: 0,
        secretReadsExecuted: 1,
      },
    });
    return this.#success(operation, input.appId, {
      projectId: input.projectId,
      branchId: branchState.branch.id,
      destinationSecretRef: input.destinationSecretRef,
      secretCaptured: true,
      providerMutationsExecuted: 0,
      secretReadsExecuted: 1,
      secretValuesExposed: false,
    }, input);
  }

  async readBranch(input) {
    const operation = 'neon.branch.read';
    if (!input?.appId || !SAFE_ID.test(input.projectId || '') || !SAFE_ID.test(input.branchId || '')) {
      return this.#failure(operation, input?.appId || '', validationError('Neon Branch Read requires appId, projectId, and branchId.'), input || {});
    }
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const response = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const branch = normalizeBranch(response.data?.branch || response.data);
    if (branch.error) return this.#failure(operation, input.appId, branch.error, input);
    if (branch.branch.projectId && branch.branch.projectId !== input.projectId) {
      return this.#failure(operation, input.appId, conflictError('Neon Branch belongs to a different Project ID.'), input);
    }
    return this.#success(operation, input.appId, { branch: branch.branch }, input);
  }

  async readBranchByName(input) {
    const operation = 'neon.branch.read-by-name';
    if (!input?.appId || !SAFE_ID.test(input.projectId || '') || !SAFE_NAME.test(input.name || '')) {
      return this.#failure(operation, input?.appId || '', validationError('Neon Branch Read-by-Name requires appId, projectId, and an exact branch name.'), input || {});
    }
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const found = await this.#findBranchByName(input.projectId, input.name);
    if (found.error) return this.#providerFailure(operation, input.appId, found.error, input);
    if (found.conflict) return this.#failure(operation, input.appId, found.conflict, input);
    if (!found.branch) return this.#failure(operation, input.appId, notFoundError('The exact Neon Branch name was not found.'), input);
    const branch = normalizeBranch(found.branch);
    if (branch.error) return this.#failure(operation, input.appId, branch.error, input);
    if (branch.branch.projectId && branch.branch.projectId !== input.projectId) {
      return this.#failure(operation, input.appId, conflictError('Neon Branch belongs to a different Project ID.'), input);
    }
    return this.#success(operation, input.appId, { branch: branch.branch }, input);
  }

  async readBranchCatalog(input) {
    const operation = 'neon.branch.read-catalog';
    if (!input?.appId || !SAFE_ID.test(input.projectId || '') || !SAFE_ID.test(input.branchId || '')) {
      return this.#failure(operation, input?.appId || '', validationError('Neon Branch Catalog requires appId, projectId, and branchId.'), input || {});
    }
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const branchResponse = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}`);
    if (!branchResponse.ok) return this.#providerFailure(operation, input.appId, branchResponse, input);
    const branch = normalizeBranch(branchResponse.data?.branch || branchResponse.data);
    if (branch.error) return this.#failure(operation, input.appId, branch.error, input);
    if (branch.branch.id !== input.branchId || (branch.branch.projectId && branch.branch.projectId !== input.projectId)) {
      return this.#failure(operation, input.appId, conflictError('Neon Branch Catalog identity differs from the requested Project and Branch.'), input);
    }

    const databasesResponse = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}/databases`);
    if (!databasesResponse.ok) return this.#providerFailure(operation, input.appId, databasesResponse, input);
    const databases = normalizeDatabases(databasesResponse.data?.databases, input.branchId);
    if (databases.error) return this.#failure(operation, input.appId, databases.error, input);

    const rolesResponse = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}/roles`);
    if (!rolesResponse.ok) return this.#providerFailure(operation, input.appId, rolesResponse, input);
    const roles = normalizeRoles(rolesResponse.data?.roles, input.branchId);
    if (roles.error) return this.#failure(operation, input.appId, roles.error, input);

    const catalog = {
      projectId: input.projectId,
      branch: branch.branch,
      databases: databases.databases,
      roles: roles.roles,
    };
    return this.#success(operation, input.appId, {
      ...catalog,
      catalogFingerprint: sha256(stableStringify(catalog)),
      observedAt: input.now || new Date().toISOString(),
      schemaInspected: false,
      sqlExecuted: false,
      secretValuesExposed: false,
    }, input, {
      nextActions: ['Use a separate read-only database inspection node before planning migrations; this catalog is not schema evidence.'],
    });
  }

  async inspectSchema(input) {
    const operation = 'neon.schema.inspect';
    const invalid = validateSchemaInspect(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);

    const branchResponse = await this.#requestSafe(
      'GET',
      `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}`
    );
    if (!branchResponse.ok) return this.#providerFailure(operation, input.appId, branchResponse, input);
    const branch = normalizeBranch(branchResponse.data?.branch || branchResponse.data);
    if (branch.error) return this.#failure(operation, input.appId, branch.error, input);
    if (
      branch.branch.id !== input.branchId ||
      (branch.branch.projectId && branch.branch.projectId !== input.projectId)
    ) return this.#failure(operation, input.appId, conflictError('Neon Schema identity differs from the requested Project and Branch.'), input);

    const query = new URLSearchParams({ db_name: input.databaseName, format: 'json' });
    const response = await this.#requestSafe(
      'GET',
      `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}/schema?${query}`
    );
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const summary = summarizeSchemaJson(response.data?.json);
    if (summary.error) return this.#failure(operation, input.appId, summary.error, input);
    const attributes = {
      projectId: input.projectId,
      branchId: input.branchId,
      databaseName: input.databaseName,
      schemaFingerprint: summary.schemaFingerprint,
      tableCount: summary.tableCount,
      columnCount: summary.columnCount,
      constraintCount: summary.constraintCount,
      schemaVersionObserved: false,
    };
    return this.#success(operation, input.appId, {
      resource: {
        logicalId: input.logicalId,
        provider: PROVIDER,
        providerId: input.branchId,
        type: 'database.schema',
        name: input.databaseName,
        lifecycle: 'external',
        version: 1,
        attributes,
      },
      ...attributes,
      observedAt: input.now || new Date().toISOString(),
      schemaInspected: true,
      rawSchemaPersisted: false,
      sqlExecuted: false,
      providerMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      warnings: ['The Neon API does not expose the application migration-table version; only the structural Schema fingerprint was observed.'],
    });
  }

  async readSnapshotCatalog(input) {
    const operation = 'neon.snapshot.read-catalog';
    const invalid = validateSnapshotCatalogRead(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const listed = await this.#listSnapshots(input.projectId);
    if (listed.error) return this.#providerFailure(operation, input.appId, listed.error, input);
    const snapshots = input.branchId
      ? listed.snapshots.filter((snapshot) => snapshot.sourceBranchId === input.branchId)
      : listed.snapshots;
    const catalog = { projectId: input.projectId, branchId: input.branchId || '', snapshots };
    return this.#success(operation, input.appId, {
      ...catalog,
      catalogFingerprint: sha256(stableStringify(catalog)),
      observedAt: input.now || new Date().toISOString(),
      providerMutationsExecuted: 0,
      snapshotsReadable: true,
      restoreTested: false,
      secretValuesExposed: false,
    }, input, {
      nextActions: ['Bind the exact Snapshot ID to immutable Backup Evidence before database migration.'],
    });
  }

  async readSnapshot(input) {
    const operation = 'neon.snapshot.read';
    const invalid = validateSnapshotRead(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const listed = await this.#listSnapshots(input.projectId);
    if (listed.error) return this.#providerFailure(operation, input.appId, listed.error, input);
    const matches = listed.snapshots.filter((snapshot) => snapshot.id === input.snapshotId);
    if (matches.length !== 1) {
      const error = matches.length === 0
        ? notFoundError('The exact Neon Snapshot is absent from the provider listing.')
        : conflictError('Multiple Neon Snapshots unexpectedly share the requested Provider ID.');
      return this.#failure(operation, input.appId, error, input);
    }
    const snapshot = matches[0];
    if (snapshot.name !== input.name || snapshot.sourceBranchId !== input.branchId) {
      return this.#failure(operation, input.appId, conflictError('Neon Snapshot identity or source Branch differs from the approved backup.'), input);
    }
    return this.#success(operation, input.appId, {
      verifiedResource: snapshotResource(snapshot, input, 'managed'),
      snapshot,
      observedAt: input.now || new Date().toISOString(),
      backupVerified: true,
      snapshotsReadable: true,
      restoreTested: false,
      providerMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      nextActions: ['Persist immutable Backup Evidence before executing the Database Migration Plan.'],
    });
  }

  planSnapshot(input) {
    const operation = 'neon.snapshot.plan';
    const invalid = validateSnapshotPlan(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const planFingerprint = snapshotPlanFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      backupType: 'neon-snapshot',
      projectId: input.projectId,
      branchId: input.branchId,
      snapshotName: input.name,
      expiresAt: input.expiresAt || '',
      migrationPlanId: input.migrationPlanId,
      migrationPlanFingerprint: input.migrationPlanFingerprint,
      planFingerprint,
      rootBranchRequired: true,
      betaApi: true,
      providerMutationsExecuted: 0,
      costMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      warnings: ['Neon Snapshot is a Beta API and plan limits or storage charges may apply.'],
      nextActions: ['Approve one pre-migration Snapshot after reviewing retention, limits, and cost.'],
    });
  }

  async executeSnapshot(input) {
    const operation = 'neon.snapshot.create';
    const invalid = validateSnapshotPlan(input) || validateCostGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    if (input.planFingerprint !== snapshotPlanFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Neon Snapshot plan fingerprint does not match the approved plan.'), input);
    }

    const branchResponse = await this.#requestSafe(
      'GET',
      `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}`
    );
    if (!branchResponse.ok) return this.#providerFailure(operation, input.appId, branchResponse, input);
    const branch = normalizeBranch(branchResponse.data?.branch || branchResponse.data);
    if (branch.error) return this.#failure(operation, input.appId, branch.error, input);
    if (
      branch.branch.id !== input.branchId ||
      (branch.branch.projectId && branch.branch.projectId !== input.projectId)
    ) {
      return this.#failure(operation, input.appId, conflictError('Neon Snapshot Branch identity differs from the approved Project and Branch.'), input);
    }
    if (branch.branch.parentId) {
      return this.#failure(operation, input.appId, capabilityError('Neon Snapshots can only be created from a root Branch with no parent.'), input);
    }

    const existing = await this.#findSnapshotByName(input.projectId, input.name);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.snapshot) {
      if (
        input.knownProviderId !== existing.snapshot.id ||
        input.knownPlanFingerprint !== input.planFingerprint ||
        existing.snapshot.sourceBranchId !== input.branchId
      ) {
        return this.#failure(operation, input.appId, conflictError('An exact Neon Snapshot already exists without matching recorded ownership, source Branch, and approved plan.'), input);
      }
      return this.#success(operation, input.appId, {
        resource: snapshotResource(existing.snapshot, input, 'managed'),
        snapshot: existing.snapshot,
        created: false,
        adopted: true,
        changed: false,
        operationIds: [],
        providerMutationsExecuted: 0,
        costMutationsExecuted: 0,
        snapshotsReadable: true,
        duplicateCreatePrevented: true,
      }, input);
    }
    if (input.knownProviderId) {
      return this.#failure(operation, input.appId, conflictError('DeploymentState records a Neon Snapshot that is absent from the exact provider listing.'), input);
    }

    const query = new URLSearchParams({ name: input.name });
    if (input.expiresAt) query.set('expires_at', input.expiresAt);
    const response = await this.#requestSafe(
      'POST',
      `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.branchId)}/snapshot?${query}`
    );
    if (!response.ok) {
      if (isUncertainMutation(response)) {
        const recovered = await this.#findSnapshotByName(input.projectId, input.name);
        if (recovered.snapshot && !recovered.conflict && recovered.snapshot.sourceBranchId === input.branchId) {
          return this.#success(operation, input.appId, {
            resource: snapshotResource(recovered.snapshot, input, 'managed'),
            snapshot: recovered.snapshot,
            created: true,
            adopted: false,
            changed: true,
            operationIds: [],
            recoveredAfterUncertainCreate: true,
            reconciliationReadsExecuted: 1,
            providerMutationsExecuted: 1,
            costMutationsExecuted: 1,
            snapshotsReadable: true,
            duplicateCreatePrevented: true,
          }, input, {
            warnings: ['The create response was lost; one exact provider read recovered the unique Snapshot.'],
            nextActions: ['Create and verify Backup Evidence from the recovered Snapshot before migration.'],
          });
        }
        return this.#failure(operation, input.appId, reconciliationError(
          'Neon Snapshot Create may have committed, but one exact provider reconciliation read was inconclusive; automatic replay is disabled.'
        ), input, {
          data: {
            providerMutationsExecuted: 1,
            costMutationsExecuted: 1,
            reconciliationReadsExecuted: 1,
            duplicateCreatePrevented: true,
          },
        });
      }
      return this.#providerFailure(operation, input.appId, response, input);
    }

    const created = normalizeCreatedSnapshot(response.data, input);
    if (created.error) return this.#failure(operation, input.appId, created.error, input, {
      data: {
        providerMutationsExecuted: 1,
        costMutationsExecuted: 1,
        ...(created.snapshotId ? { snapshotId: created.snapshotId } : {}),
      },
    });
    return this.#success(operation, input.appId, {
      resource: snapshotResource(created.snapshot, input, 'managed'),
      snapshot: created.snapshot,
      operationIds: created.operationIds,
      created: true,
      adopted: false,
      changed: true,
      providerMutationsExecuted: 1,
      costMutationsExecuted: 1,
      snapshotsReadable: true,
      duplicateCreatePrevented: true,
    }, input, {
      status: created.operationIds.length > 0 ? 'waiting-external' : 'succeeded',
      warnings: ['Neon Snapshot is a Beta API.'],
      nextActions: created.operationIds.length > 0
        ? ['Poll the Neon Snapshot operation before creating Backup Evidence.']
        : ['Create and verify Backup Evidence before migration.'],
    });
  }

  planSnapshotRestore(input) {
    const operation = 'neon.snapshot.restore.plan';
    const invalid = validateSnapshotRestorePlan(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      projectId: input.projectId,
      snapshotId: input.snapshotId,
      sourceBranchId: input.sourceBranchId,
      targetBranchId: input.targetBranchId,
      restoreBranchName: input.name,
      rollbackPlanId: input.rollbackPlanId,
      rollbackPlanFingerprint: input.rollbackPlanFingerprint,
      backupEvidenceId: input.backupEvidenceId,
      backupEvidenceFingerprint: input.backupEvidenceFingerprint,
      finalizeRestore: true,
      betaApi: true,
      planFingerprint: snapshotRestorePlanFingerprint(input),
      providerMutationsExecuted: 0,
      costMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      warnings: ['Neon Snapshot Restore is a Beta API and immediately finalized restore replaces the target Branch.'],
      nextActions: ['Use a dedicated Rollback Approval and verify the exact Snapshot, target Branch, and baseline Schema.'],
    });
  }

  async executeSnapshotRestore(input) {
    const operation = 'neon.snapshot.restore';
    const invalid = validateSnapshotRestorePlan(input) || validateSnapshotRestoreGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    if (input.planFingerprint !== snapshotRestorePlanFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Neon Snapshot Restore fingerprint does not match the approved plan.'), input);
    }

    const listed = await this.#listSnapshots(input.projectId);
    if (listed.error) return this.#providerFailure(operation, input.appId, listed.error, input);
    const snapshots = listed.snapshots.filter((snapshot) => snapshot.id === input.snapshotId);
    if (snapshots.length !== 1 || snapshots[0].sourceBranchId !== input.sourceBranchId) {
      return this.#failure(
        operation,
        input.appId,
        conflictError('The exact Neon Snapshot or its approved source Branch no longer matches Backup Evidence.'),
        input
      );
    }
    const branchResponse = await this.#requestSafe(
      'GET',
      `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.targetBranchId)}`
    );
    if (!branchResponse.ok) return this.#providerFailure(operation, input.appId, branchResponse, input);
    const target = normalizeBranch(branchResponse.data?.branch || branchResponse.data);
    if (target.error) return this.#failure(operation, input.appId, target.error, input);
    if (target.branch.id !== input.targetBranchId ||
        (target.branch.projectId && target.branch.projectId !== input.projectId)) {
      return this.#failure(operation, input.appId, conflictError('Neon Snapshot Restore target Branch identity drifted.'), input);
    }

    const response = await this.#requestSafe(
      'POST',
      `projects/${encodeURIComponent(input.projectId)}/snapshots/${encodeURIComponent(input.snapshotId)}/restore`,
      { name: input.name, target_branch_id: input.targetBranchId, finalize_restore: true }
    );
    if (!response.ok) {
      if (isUncertainMutation(response)) {
        return this.#failure(operation, input.appId, reconciliationError(
          'Neon Snapshot Restore may have committed, but the non-idempotent POST response was uncertain; automatic replay is disabled.'
        ), input, {
          data: {
            snapshotId: input.snapshotId,
            targetBranchId: input.targetBranchId,
            providerMutationsExecuted: 1,
            costMutationsExecuted: 0,
            reconciliationReadsExecuted: 0,
            duplicateRestorePrevented: true,
          },
        });
      }
      return this.#providerFailure(operation, input.appId, response, input);
    }
    const restored = normalizeSnapshotRestore(response.data, input);
    if (restored.error) return this.#failure(operation, input.appId, restored.error, input, {
      data: {
        snapshotId: input.snapshotId,
        targetBranchId: input.targetBranchId,
        providerMutationsExecuted: 1,
        costMutationsExecuted: 0,
        duplicateRestorePrevented: true,
      },
    });
    return this.#success(operation, input.appId, {
      snapshotId: input.snapshotId,
      sourceBranchId: input.sourceBranchId,
      targetBranchId: input.targetBranchId,
      restoredBranch: restored.branch,
      operationIds: restored.operationIds,
      finalized: true,
      changed: true,
      providerMutationsExecuted: 1,
      costMutationsExecuted: 0,
      duplicateRestorePrevented: true,
      secretValuesExposed: false,
    }, input, {
      status: restored.operationIds.length > 0 ? 'waiting-external' : 'succeeded',
      warnings: ['The target Branch was replaced by a finalized Neon Snapshot Restore.'],
      nextActions: restored.operationIds.length > 0
        ? ['Poll every returned Neon operation; never repeat the restore POST.']
        : ['Verify the exact baseline Schema fingerprint and record rollback ownership.'],
    });
  }

  planMigration(input) {
    const operation = 'neon.migration.plan';
    const invalid = validateMigrationPlanInput(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      projectId: input.projectId,
      branchId: input.branchId,
      databaseName: input.databaseName,
      expectedSchemaVersion: input.expectedSchemaVersion,
      baselineSchemaFingerprint: input.baselineSchemaFingerprint,
      classification: input.classification,
      migrationCount: input.migrationCount,
      statementCount: input.statementCount,
      migrationPlanId: input.migrationPlanId,
      migrationPlanFingerprint: input.migrationPlanFingerprint,
      backupEvidenceId: input.backupEvidenceId,
      backupEvidenceFingerprint: input.backupEvidenceFingerprint,
      planFingerprint: migrationExecutionFingerprint(input),
      providerMutationsExecuted: 0,
      sqlStatementsExecuted: 0,
      rawSqlPersisted: false,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve the destructive database.migrate Graph node bound to this Backup Evidence.'],
    });
  }

  async executeMigration(input) {
    const operation = 'neon.migration.apply';
    const invalid = validateMigrationPlanInput(input) || validateMigrationGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    if (input.planFingerprint !== migrationExecutionFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Neon Migration execution fingerprint does not match the approved plan.'), input);
    }
    if (
      !this.#migrationExecutor || typeof this.#migrationExecutor.inspect !== 'function' ||
      typeof this.#migrationExecutor.apply !== 'function'
    ) return this.#failure(operation, input.appId, capabilityError('An injected Migration Executor is required; implicit database connections are disabled.'), input);

    const context = migrationExecutorContext(input);
    let before;
    try { before = normalizeMigrationInspection(await this.#migrationExecutor.inspect(context)); }
    catch { return this.#failure(operation, input.appId, providerUnavailableError('Migration baseline inspection failed before SQL execution.'), input); }
    if (before.error) return this.#failure(operation, input.appId, before.error, input);
    if (before.schemaVersion === input.expectedSchemaVersion) {
      if (
        before.migrationPlanFingerprint === input.migrationPlanFingerprint &&
        before.backupEvidenceFingerprint === input.backupEvidenceFingerprint
      ) return this.#success(operation, input.appId, migrationSuccessData(input, before, before, 0, true), input);
      return this.#failure(operation, input.appId, conflictError('Database already reports the target Schema version without matching immutable Ledger ownership.'), input);
    }
    if (before.schemaFingerprint !== input.baselineSchemaFingerprint) {
      return this.#failure(operation, input.appId, conflictError('Current Neon Schema fingerprint has drifted from the Backup Evidence baseline.'), input);
    }

    let applied;
    try {
      applied = await this.#migrationExecutor.apply(context);
    } catch {
      return this.#reconcileMigration(operation, input, before, true);
    }
    const appliedCount = Number.isInteger(applied?.sqlStatementsExecuted) ? applied.sqlStatementsExecuted : input.statementCount;
    if (appliedCount < 0 || appliedCount > input.statementCount) {
      return this.#failure(operation, input.appId, providerResponseError('Migration Executor returned an invalid SQL statement count.'), input, {
        data: { providerMutationsExecuted: 1, reconciliationRequired: true },
      });
    }
    let after;
    try { after = normalizeMigrationInspection(await this.#migrationExecutor.inspect(context)); }
    catch {
      return this.#failure(operation, input.appId, reconciliationError('Migration execution returned, but post-apply Schema verification failed; automatic replay is disabled.'), input, {
        data: { providerMutationsExecuted: 1, sqlStatementsExecuted: appliedCount, duplicateApplyPrevented: true },
      });
    }
    if (after.error) return this.#failure(operation, input.appId, reconciliationError('Post-apply Schema state is invalid; automatic replay is disabled.'), input, {
      data: { providerMutationsExecuted: 1, sqlStatementsExecuted: appliedCount, duplicateApplyPrevented: true },
    });
    if (after.schemaVersion !== input.expectedSchemaVersion ||
        after.migrationPlanFingerprint !== input.migrationPlanFingerprint ||
        after.backupEvidenceFingerprint !== input.backupEvidenceFingerprint) {
      return this.#failure(operation, input.appId, verificationError('Migration completed without reaching the expected Schema version.'), input, {
        data: { providerMutationsExecuted: 1, sqlStatementsExecuted: appliedCount, duplicateApplyPrevented: true },
      });
    }
    return this.#success(operation, input.appId, migrationSuccessData(input, before, after, appliedCount, false), input);
  }

  async #reconcileMigration(operation, input, before, uncertain) {
    let after;
    try { after = normalizeMigrationInspection(await this.#migrationExecutor.inspect(migrationExecutorContext(input))); }
    catch { after = { error: true }; }
    if (!after.error && after.schemaVersion === input.expectedSchemaVersion &&
        after.migrationPlanFingerprint === input.migrationPlanFingerprint &&
        after.backupEvidenceFingerprint === input.backupEvidenceFingerprint) {
      return this.#success(operation, input.appId, {
        ...migrationSuccessData(input, before, after, input.statementCount, false),
        recoveredAfterUncertainApply: true,
        reconciliationReadsExecuted: 1,
        duplicateApplyPrevented: true,
      }, input, { warnings: ['Migration response was uncertain; one read-only Schema version check recovered terminal success.'] });
    }
    return this.#failure(operation, input.appId, reconciliationError('Migration may have committed, but one Schema reconciliation read was inconclusive; automatic replay is disabled.'), input, {
      data: {
        providerMutationsExecuted: 1,
        sqlStatementsExecuted: uncertain ? null : 0,
        reconciliationReadsExecuted: 1,
        duplicateApplyPrevented: true,
      },
    });
  }

  planBranch(input) {
    const operation = 'neon.branch.plan';
    const invalid = validateBranchPlan(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const planFingerprint = branchPlanFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      projectId: input.projectId,
      branchName: input.name,
      parentBranchId: input.parentBranchId,
      endpoint: computeSummary(input),
      expiresAt: input.expiresAt || '',
      destinationSecretRef: input.destinationSecretRef,
      planFingerprint,
      providerMutationsExecuted: 0,
      costMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve the non-production Neon branch and endpoint cost after reviewing its parent and expiry.'],
    });
  }

  async executeBranch(input) {
    const operation = 'neon.branch.create';
    const invalid = validateBranchPlan(input) || validateCostGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    if (input.planFingerprint !== branchPlanFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Neon Branch plan fingerprint does not match the approved plan.'), input);
    }
    const sink = await this.#preflightSecretSink(operation, input);
    if (sink.result) return sink.result;

    const parentResponse = await this.#requestSafe('GET', `projects/${encodeURIComponent(input.projectId)}/branches/${encodeURIComponent(input.parentBranchId)}`);
    if (!parentResponse.ok) return this.#providerFailure(operation, input.appId, parentResponse, input);
    const parent = normalizeBranch(parentResponse.data?.branch || parentResponse.data);
    if (parent.error) return this.#failure(operation, input.appId, parent.error, input);
    if (parent.branch.id !== input.parentBranchId || (parent.branch.projectId && parent.branch.projectId !== input.projectId)) {
      return this.#failure(operation, input.appId, conflictError('Neon parent Branch belongs to a different Project or ID.'), input);
    }

    const existing = await this.#findBranchByName(input.projectId, input.name);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.branch) {
      const branch = normalizeBranch(existing.branch);
      if (branch.error) return this.#failure(operation, input.appId, branch.error, input);
      if (
        input.knownProviderId !== branch.branch.id ||
        input.knownPlanFingerprint !== input.planFingerprint ||
        branch.branch.parentId !== input.parentBranchId ||
        (branch.branch.projectId && branch.branch.projectId !== input.projectId)
      ) {
        return this.#failure(operation, input.appId, conflictError('An exact Neon Branch already exists without matching recorded ownership, parent, and approved plan.'), input);
      }
      return this.#success(operation, input.appId, {
        branch: branch.branch,
        created: false,
        adopted: true,
        destinationSecretRef: input.destinationSecretRef,
        secretCaptured: sink.readiness.present === true,
        secretCaptureRequired: sink.readiness.present !== true,
        providerMutationsExecuted: 0,
        costMutationsExecuted: 0,
      }, input, {
        nextActions: sink.readiness.present === true ? [] : ['Capture a connection URI separately; do not recreate the branch.'],
      });
    }
    if (input.knownProviderId) {
      return this.#failure(operation, input.appId, conflictError('DeploymentState records a Neon Branch that is absent from the exact provider listing.'), input);
    }
    if (sink.readiness.present === true) {
      return this.#failure(operation, input.appId, conflictError('The destination Secret Ref is occupied but no matching Neon Branch state exists.'), input);
    }

    const body = {
      branch: {
        name: input.name,
        parent_id: input.parentBranchId,
        protected: false,
        ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
      },
      endpoints: [{
        type: 'read_write',
        autoscaling_limit_min_cu: input.minCu,
        autoscaling_limit_max_cu: input.maxCu,
        suspend_timeout_seconds: input.suspendTimeoutSeconds,
      }],
    };
    const response = await this.#requestSafe('POST', `projects/${encodeURIComponent(input.projectId)}/branches`, body);
    if (!response.ok) {
      if (isUncertainMutation(response)) {
        const recovered = await this.#findBranchByName(input.projectId, input.name);
        if (recovered.branch && !recovered.conflict) {
          const branch = normalizeBranch(recovered.branch);
          if (branch.error) return this.#failure(operation, input.appId, branch.error, input);
          if (branch.branch.parentId !== input.parentBranchId || (branch.branch.projectId && branch.branch.projectId !== input.projectId)) {
            return this.#failure(operation, input.appId, conflictError('Recovered Neon Branch has a different parent.'), input);
          }
          return this.#success(operation, input.appId, {
            branch: branch.branch,
            created: true,
            recoveredAfterUncertainCreate: true,
            destinationSecretRef: input.destinationSecretRef,
            secretCaptured: false,
            secretCaptureRequired: true,
            providerMutationsExecuted: 1,
            costMutationsExecuted: 1,
            duplicateCreatePrevented: true,
          }, input, {
            nextActions: ['Record the recovered Branch ID and capture its connection URI separately; automatic Create replay is disabled.'],
          });
        }
        if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
        return this.#failure(operation, input.appId, reconciliationError('Neon Branch Create may have committed, but exact provider state is inconclusive; automatic replay is disabled.'), input, {
          data: { providerMutationsExecuted: 1, costMutationsExecuted: 1, duplicateCreatePrevented: true },
        });
      }
      return this.#providerFailure(operation, input.appId, response, input);
    }

    const bundle = normalizeCreatedBranch(response.data, input);
    if (bundle.error) return this.#failure(operation, input.appId, bundle.error, input, {
      data: {
        providerMutationsExecuted: 1,
        costMutationsExecuted: 1,
        ...(bundle.branchId ? { branchId: bundle.branchId } : {}),
      },
    });
    const capture = await this.#captureCreatedSecret(input, bundle.connectionUri, {
      providerId: bundle.branch.id,
      projectId: input.projectId,
      branchId: bundle.branch.id,
      endpointId: bundle.endpoint.id,
      purpose: 'candidate-database-connection',
      planFingerprint: input.planFingerprint,
    });
    if (capture.error) return this.#failure(operation, input.appId, capture.error, input, {
      data: {
        branchId: bundle.branch.id,
        endpointId: bundle.endpoint.id,
        providerMutationsExecuted: 1,
        costMutationsExecuted: 1,
        secretCaptured: false,
      },
      nextActions: ['Record the Branch ID and use connection capture; do not recreate the branch.'],
    });
    return this.#success(operation, input.appId, {
      branch: bundle.branch,
      endpoint: bundle.endpoint,
      operationIds: bundle.operationIds,
      created: true,
      adopted: false,
      destinationSecretRef: input.destinationSecretRef,
      secretCaptured: true,
      secretValuesExposed: false,
      providerMutationsExecuted: 1,
      costMutationsExecuted: 1,
    }, input, {
      status: bundle.operationIds.length > 0 ? 'waiting-external' : 'succeeded',
      nextActions: bundle.operationIds.length > 0 ? ['Poll every Neon operation before using the branch.'] : [],
    });
  }

  async pollOperation(input) {
    const operation = 'neon.operation.poll';
    const operationIds = Array.isArray(input?.operationIds)
      ? input.operationIds
      : (input?.operationId ? [input.operationId] : []);
    if (!input?.appId || !SAFE_ID.test(input.projectId || '') || operationIds.length === 0 ||
        operationIds.length > 50 || operationIds.some((id) => !SAFE_ID.test(id || '')) ||
        new Set(operationIds).size !== operationIds.length) {
      return this.#failure(
        operation,
        input?.appId || '',
        validationError('Neon Operation Poll requires appId, projectId, and one to 50 unique operation IDs.'),
        input || {}
      );
    }
    const scopeError = this.#assertProjectScope(input.projectId);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const operations = [];
    for (const operationId of operationIds) {
      const response = await this.#requestSafe(
        'GET',
        `projects/${encodeURIComponent(input.projectId)}/operations/${encodeURIComponent(operationId)}`
      );
      if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
      const state = normalizeOperation(response.data?.operation || response.data);
      if (state.error) return this.#failure(operation, input.appId, state.error, input);
      if (state.operation.id !== operationId) {
        return this.#failure(
          operation,
          input.appId,
          providerResponseError('Neon Operation Poll returned a different operation ID.'),
          input
        );
      }
      operations.push(state.operation);
    }
    const data = {
      operation: operations[0],
      operations,
      operationIds: [...operationIds],
    };
    const failed = operations.find((item) => TERMINAL_OPERATION_STATES.has(item.status));
    if (failed) {
      return this.#failure(operation, input.appId, {
        code: 'PROVIDER_OPERATION_FAILED',
        message: `Neon operation reached terminal state ${failed.status}.`,
        retryable: false,
        provider: PROVIDER,
        resourceId: failed.id,
      }, input, { status: 'failed-terminal', data });
    }
    const unknown = operations.find((item) =>
      !SUCCESS_OPERATION_STATES.has(item.status) && !WAITING_OPERATION_STATES.has(item.status)
    );
    if (unknown) {
      return this.#failure(
        operation,
        input.appId,
        providerResponseError(`Neon returned unknown operation status ${unknown.status}.`),
        input
      );
    }
    if (operations.some((item) => WAITING_OPERATION_STATES.has(item.status))) {
      return this.#success(operation, input.appId, data, input, {
        status: 'waiting-external',
        nextActions: ['Poll every Neon operation again after nextPollAt.'],
      });
    }
    return this.#success(operation, input.appId, data, input);
  }

  updateProject(input) {
    return this.#mutationDisabled('neon.project.update', input, 'Project settings can change cost, availability, or production connectivity');
  }

  updateBranch(input) {
    return this.#mutationDisabled('neon.branch.update', input, 'Branch settings can change cost, protection, expiry, or connectivity');
  }

  deleteProject(input) {
    return this.#mutationDisabled('neon.project.delete', input, 'Project deletion cascades through branches, endpoints, roles, databases, and data');
  }

  deleteBranch(input) {
    return this.#mutationDisabled('neon.branch.delete', input, 'Branch deletion removes branch data and breaks active connections');
  }

  updateSnapshot(input) {
    return this.#mutationDisabled('neon.snapshot.update', input, 'Snapshot retention and identity changes require a separate lifecycle policy');
  }

  deleteSnapshot(input) {
    return this.#mutationDisabled('neon.snapshot.delete', input, 'Snapshot deletion removes the pre-migration recovery point');
  }

  async #findProjectByName(name) {
    const listed = await this.#listProjects(name);
    if (listed.error) return { error: listed.error };
    const matches = listed.projects.filter((project) => project?.name === name);
    if (matches.length > 1) return { conflict: conflictError('Multiple exact Neon Projects match the requested name.') };
    return { project: matches[0] || null };
  }

  async #listProjects(search) {
    const projects = [];
    let cursor = '';
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '400', search });
      if (cursor) query.set('cursor', cursor);
      if (this.#tokenScope === 'personal' && this.#orgId) query.set('org_id', this.#orgId);
      const response = await this.#requestSafe('GET', `projects?${query}`);
      if (!response.ok) return { error: response };
      if (!Array.isArray(response.data?.projects)) return { error: invalidProviderResponse('Neon Project list response is missing projects.') };
      if (Array.isArray(response.data.unavailable_project_ids) && response.data.unavailable_project_ids.length > 0) {
        return { error: incompleteProviderState('Neon Project listing is incomplete because one or more projects were unavailable.') };
      }
      projects.push(...response.data.projects);
      const next = String(response.data?.pagination?.cursor || '');
      if (!next) return { projects };
      if (next === cursor || next.length > 1024) return { error: invalidProviderResponse('Neon Project pagination cursor is invalid.') };
      cursor = next;
    }
    return { error: invalidProviderResponse('Neon Project pagination exceeded the safety bound.') };
  }

  async #findBranchByName(projectId, name) {
    const branches = [];
    let cursor = '';
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '1000', search: name, include_deleted: 'false' });
      if (cursor) query.set('cursor', cursor);
      const response = await this.#requestSafe('GET', `projects/${encodeURIComponent(projectId)}/branches?${query}`);
      if (!response.ok) return { error: response };
      if (!Array.isArray(response.data?.branches)) return { error: invalidProviderResponse('Neon Branch list response is missing branches.') };
      branches.push(...response.data.branches);
      const next = String(response.data?.pagination?.next || response.data?.pagination?.cursor || '');
      if (!next) break;
      if (next === cursor || next.length > 1024) return { error: invalidProviderResponse('Neon Branch pagination cursor is invalid.') };
      cursor = next;
    }
    const matches = branches.filter((branch) => branch?.name === name && branch?.deleted_at == null);
    if (matches.length > 1) return { conflict: conflictError('Multiple exact Neon Branches match the requested name.') };
    return { branch: matches[0] || null };
  }

  async #listSnapshots(projectId) {
    const response = await this.#requestSafe('GET', `projects/${encodeURIComponent(projectId)}/snapshots`);
    if (!response.ok) return { error: response };
    const normalized = normalizeSnapshots(response.data?.snapshots);
    if (normalized.error) return { error: invalidProviderResponse(normalized.error.message) };
    return { snapshots: normalized.snapshots };
  }

  async #findSnapshotByName(projectId, name) {
    const listed = await this.#listSnapshots(projectId);
    if (listed.error) return { error: listed.error };
    const matches = listed.snapshots.filter((snapshot) => snapshot.name === name);
    if (matches.length > 1) return { conflict: conflictError('Multiple exact Neon Snapshots match the requested name.') };
    return { snapshot: matches[0] || null };
  }

  async #preflightSecretSink(operation, input) {
    if (!this.#secretSink || typeof this.#secretSink.check !== 'function' || typeof this.#secretSink.store !== 'function') {
      return { result: this.#failure(operation, input.appId, capabilityError('A writable Secret Sink is required before Neon provider access.'), input) };
    }
    try {
      const readiness = await this.#secretSink.check(input.destinationSecretRef);
      if (!readiness || readiness.ref !== input.destinationSecretRef || readiness.writable !== true) {
        throw new Error('Secret Sink did not confirm the exact writable destination.');
      }
      return { readiness };
    } catch {
      return { result: this.#failure(operation, input.appId, capabilityError('The exact destination Secret Sink is not writable; no Neon API call was made.'), input) };
    }
  }

  async #captureCreatedSecret(input, connectionUri, metadata) {
    if (!isPostgresUri(connectionUri)) {
      return { error: {
        code: 'SECRET_CAPTURE_REQUIRED',
        message: 'Neon created the resource without a usable connection URI in the response.',
        retryable: false,
        provider: PROVIDER,
        resourceId: metadata.providerId,
      } };
    }
    try {
      const receipt = await this.#secretSink.store(input.destinationSecretRef, connectionUri, metadata);
      if (!receipt || receipt.ref !== input.destinationSecretRef) throw new Error('Secret Sink did not confirm the exact destination.');
      return { captured: true };
    } catch {
      return { error: {
        code: 'SECRET_CAPTURE_FAILED',
        message: 'Neon created or returned the connection, but the Secret Sink did not confirm durable capture.',
        retryable: false,
        provider: PROVIDER,
        resourceId: metadata.providerId,
      } };
    }
  }

  async #requestSafe(method, path, body) {
    try {
      const response = await this.#transport.request({
        method,
        url: new URL(path, API_BASE).toString(),
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });
      return sanitizeResponse(response, this.#token, method !== 'GET');
    } catch (error) {
      return {
        ok: false,
        status: 503,
        message: sanitizeText(error.message, this.#token),
        data: {},
        uncertain: method !== 'GET',
      };
    }
  }

  #providerFailure(operation, appId, response, input) {
    const error = response.code === 'PROVIDER_RESPONSE_INVALID' || response.code === 'PROVIDER_STATE_INCOMPLETE'
      ? {
          code: response.code,
          message: response.message,
          retryable: response.code === 'PROVIDER_STATE_INCOMPLETE',
          provider: PROVIDER,
        }
      : response.status === 423
        ? {
            code: 'PROVIDER_UNAVAILABLE',
            message: response.message || 'Neon resource is temporarily locked.',
            retryable: true,
            provider: PROVIDER,
            details: { status: 423, retryAfter: response.retryAfter },
          }
        : mapProviderError(PROVIDER, response);
    return this.#failure(operation, appId, error, input);
  }

  #assertProjectScope(projectId) {
    if (this.#tokenScope === 'project' && projectId !== this.#scopedProjectId) {
      return capabilityError('The Neon project-scoped API key does not authorize the requested Project ID.');
    }
    return null;
  }

  #mutationDisabled(operation, input, reason) {
    return this.#failure(operation, input?.appId || '', {
      code: 'UNSUPPORTED',
      message: `Neon mutation is disabled: ${reason}.`,
      retryable: false,
      provider: PROVIDER,
    }, input || {});
  }

  #success(operation, appId, data, input, options = {}) {
    return validateActionResult(actionSuccess(operation, appId, data, {
      requestId: input.requestId,
      status: options.status,
      warnings: options.warnings,
      nextActions: options.nextActions,
    }), { operation, appId });
  }

  #failure(operation, appId, error, input, options = {}) {
    return validateActionResult(actionFailure(operation, appId, error, {
      requestId: input?.requestId,
      status: options.status,
      data: options.data,
      warnings: options.warnings,
      nextActions: options.nextActions,
    }), { operation, appId });
  }
}

export function createNeonV2AdapterFromConnection(connection, options = {}) {
  if (connection?.provider !== PROVIDER || connection.status !== 'ready') {
    throw new Error('A verified Neon ProviderConnection with status ready is required.');
  }
  const values = resolveConnectionSecretRefs(connection, {
    env: options.env,
    purpose: 'Neon adapter',
  });
  if (!values.NEON_API_KEY) throw new Error('Neon provisioning requires NEON_API_KEY.');
  const parsedScope = parseConnectionScope(options.tokenScope || connection.scope || 'personal');
  return new NeonV2Adapter({
    token: values.NEON_API_KEY,
    tokenScope: parsedScope.tokenScope,
    orgId: options.orgId || parsedScope.orgId,
    projectId: options.projectId || parsedScope.projectId || connection.identity?.projectId,
    transport: options.transport,
    httpOptions: options.httpOptions,
    secretSink: options.secretSink,
    migrationExecutor: options.migrationExecutor,
  });
}

function validateProjectRead(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '')) {
    return validationError('Neon Project Read requires appId, logicalId, and projectId.');
  }
  return null;
}

function validateProjectPlan(input, tokenScope, configuredOrgId) {
  if (
    !input?.appId || !input.logicalId || !SAFE_NAME.test(input.name || '') ||
    !REGION_ID.test(input.regionId || '') || !Number.isInteger(input.pgVersion) ||
    input.pgVersion < 14 || input.pgVersion > 18 || !SAFE_NAME.test(input.branchName || '') ||
    !POSTGRES_NAME.test(input.databaseName || '') || !POSTGRES_NAME.test(input.roleName || '') ||
    !SECRET_DESTINATION.test(input.destinationSecretRef || '')
  ) return validationError('Neon Project plan requires valid identity, region, PostgreSQL version, root branch, database, role, and Secret Sink destination.');
  const compute = validateCompute(input);
  if (compute) return compute;
  if (tokenScope === 'personal' && input.orgId && configuredOrgId && input.orgId !== configuredOrgId) {
    return conflictError('Neon Project organization differs from the verified connection scope.');
  }
  if (input.orgId && !SAFE_ID.test(input.orgId)) return validationError('Neon Project orgId is invalid.');
  return null;
}

function validateConnectionCapture(input) {
  if (
    !input?.appId || !SAFE_ID.test(input.projectId || '') || !SAFE_NAME.test(input.projectName || '') ||
    (input.branchId && !SAFE_ID.test(input.branchId)) || !SAFE_NAME.test(input.branchName || '') ||
    (input.endpointId && !SAFE_ID.test(input.endpointId)) || !POSTGRES_NAME.test(input.databaseName || '') ||
    !POSTGRES_NAME.test(input.roleName || '') || !SECRET_DESTINATION.test(input.destinationSecretRef || '')
  ) return validationError('Neon connection capture requires exact Project/Branch/Database/Role identity and a Secret Sink destination.');
  return null;
}

function validateBranchPlan(input) {
  if (
    !input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') ||
    !SAFE_NAME.test(input.name || '') || !SAFE_ID.test(input.parentBranchId || '') ||
    !SECRET_DESTINATION.test(input.destinationSecretRef || '')
  ) return validationError('Neon Branch plan requires appId, logicalId, project, branch name, parent, compute settings, and Secret Sink destination.');
  if (PRODUCTION_NAMES.has(input.name.toLowerCase())) return validationError('Neon Branch creation is limited to non-production candidate branches.');
  if (input.expiresAt && !isFutureIsoTimestamp(input.expiresAt)) return validationError('Neon Branch expiresAt must be a valid future ISO timestamp.');
  return validateCompute(input);
}

function validateSnapshotCatalogRead(input) {
  if (
    !input?.appId || !SAFE_ID.test(input.projectId || '') ||
    (input.branchId && !SAFE_ID.test(input.branchId))
  ) return validationError('Neon Snapshot Catalog requires appId, projectId, and an optional valid branchId.');
  return null;
}

function validateSchemaInspect(input) {
  if (
    !input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') ||
    !SAFE_ID.test(input.branchId || '') || !POSTGRES_NAME.test(input.databaseName || '')
  ) return validationError('Neon Schema inspection requires appId, logicalId, projectId, branchId, and databaseName.');
  return null;
}

function validateSnapshotRead(input) {
  const planError = validateSnapshotPlan(input);
  if (planError) return planError;
  if (!SAFE_ID.test(input.snapshotId || '')) {
    return validationError('Neon Snapshot Read requires an exact Snapshot Provider ID.');
  }
  return null;
}

function validateSnapshotPlan(input) {
  if (
    !input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') ||
    !SAFE_ID.test(input.branchId || '') || !SAFE_NAME.test(input.name || '') ||
    !MIGRATION_PLAN_ID.test(input.migrationPlanId || '') ||
    !CONTROL_FINGERPRINT.test(input.migrationPlanFingerprint || '')
  ) {
    return validationError('Neon Snapshot plan requires exact Project/Branch identity, a safe Snapshot name, and an immutable Database Migration Plan binding.');
  }
  if (input.expiresAt && !isFutureIsoTimestamp(input.expiresAt)) {
    return validationError('Neon Snapshot expiresAt must be a valid future ISO timestamp.');
  }
  return null;
}

function validateSnapshotRestorePlan(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') ||
      !SAFE_ID.test(input.snapshotId || '') || !SAFE_ID.test(input.sourceBranchId || '') ||
      !SAFE_ID.test(input.targetBranchId || '') || !SAFE_NAME.test(input.name || '') ||
      !SAFE_ID.test(input.rollbackPlanId || '') || !CONTROL_FINGERPRINT.test(input.rollbackPlanFingerprint || '') ||
      !BACKUP_EVIDENCE_ID.test(input.backupEvidenceId || '') ||
      !CONTROL_FINGERPRINT.test(input.backupEvidenceFingerprint || '')) {
    return validationError('Neon Snapshot Restore requires exact Snapshot, source/target Branch, Rollback Plan, and Backup Evidence identity.');
  }
  if (PRODUCTION_NAMES.has(input.name.toLowerCase())) {
    return validationError('Neon Snapshot Restore requires a dedicated non-production restore Branch name.');
  }
  return null;
}

function validateSnapshotRestoreGates(input) {
  if (input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
      input.allowDatabaseRestore !== true || !SHA256.test(input.planFingerprint || '') ||
      !SHA256.test(input.approvalFingerprint || '')) {
    return approvalError('Neon Snapshot Restore requires execute, yes, provider-mutation, database-restore, plan, and approval gates.');
  }
  return null;
}

function validateMigrationPlanInput(input) {
  if (
    !input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') ||
    !SAFE_ID.test(input.branchId || '') || !POSTGRES_NAME.test(input.databaseName || '') ||
    !SCHEMA_VERSION.test(input.expectedSchemaVersion || '') ||
    !CONTROL_FINGERPRINT.test(input.baselineSchemaFingerprint || '') ||
    !MIGRATION_CLASSIFICATIONS.has(input.classification) ||
    !Number.isInteger(input.migrationCount) || input.migrationCount < 1 || input.migrationCount > 100 ||
    !Number.isInteger(input.statementCount) || input.statementCount < 1 || input.statementCount > 10000 ||
    !MIGRATION_PLAN_ID.test(input.migrationPlanId || '') ||
    !CONTROL_FINGERPRINT.test(input.migrationPlanFingerprint || '') ||
    !BACKUP_EVIDENCE_ID.test(input.backupEvidenceId || '') ||
    !CONTROL_FINGERPRINT.test(input.backupEvidenceFingerprint || '')
  ) return validationError('Neon Migration requires exact database identity, Schema baseline, Migration Plan, Backup Evidence, risk class, and bounded counts.');
  return null;
}

function validateMigrationGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    input.allowDatabaseMigration !== true || !SHA256.test(input.planFingerprint || '') ||
    !SHA256.test(input.approvalFingerprint || '')
  ) return approvalError('Neon Migration requires execute, yes, provider-mutation, database-migration, plan, and approval gates.');
  return null;
}

function validateCompute(input) {
  if (
    typeof input.minCu !== 'number' || !Number.isFinite(input.minCu) || input.minCu <= 0 ||
    typeof input.maxCu !== 'number' || !Number.isFinite(input.maxCu) || input.maxCu < input.minCu ||
    !Number.isInteger(input.suspendTimeoutSeconds) || input.suspendTimeoutSeconds < 0 || input.suspendTimeoutSeconds > 604800
  ) return validationError('Neon compute settings require positive min/max CU and suspend timeout between 0 and 604800 seconds.');
  return null;
}

function validateCostGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    input.allowCostMutations !== true || !SHA256.test(input.planFingerprint || '') ||
    !SHA256.test(input.approvalFingerprint || '')
  ) return approvalError('Neon creation requires execute, yes, provider-mutation, cost-mutation, plan, and approval gates.');
  return null;
}

function validateSecretReadGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowSecretRead !== true ||
    !SHA256.test(input.planFingerprint || '') || !SHA256.test(input.approvalFingerprint || '')
  ) return approvalError('Neon connection capture requires execute, yes, secret-read, plan, and approval gates.');
  return null;
}

function projectPlanSummary(input, tokenScope, configuredOrgId) {
  return {
    name: input.name,
    regionId: input.regionId,
    pgVersion: input.pgVersion,
    branchName: input.branchName,
    databaseName: input.databaseName,
    roleName: input.roleName,
    tokenScope,
    orgId: tokenScope === 'personal' ? (input.orgId || configuredOrgId || '') : '',
    endpoint: computeSummary(input),
  };
}

function projectCreateRequest(input, tokenScope, configuredOrgId, options = {}) {
  const orgId = input.orgId || configuredOrgId || '';
  return {
    name: input.name,
    region_id: input.regionId,
    pg_version: input.pgVersion,
    branch: {
      name: input.branchName,
      role_name: input.roleName,
      database_name: input.databaseName,
    },
    default_endpoint_settings: {
      autoscaling_limit_min_cu: input.minCu,
      autoscaling_limit_max_cu: input.maxCu,
      ...(options.omitFixedDefaultSuspendTimeout === true
        ? {}
        : { suspend_timeout_seconds: input.suspendTimeoutSeconds }),
    },
    ...(tokenScope === 'personal' && orgId ? { org_id: orgId } : {}),
  };
}

function computeSummary(input) {
  return {
    type: 'read_write',
    minCu: input.minCu,
    maxCu: input.maxCu,
    suspendTimeoutSeconds: input.suspendTimeoutSeconds,
  };
}

function normalizeProject(data, input, lifecycle) {
  const source = data && typeof data === 'object' ? data : {};
  const id = String(source.id || '');
  const name = String(source.name || '');
  if (!SAFE_ID.test(id) || !SAFE_NAME.test(name)) return { error: providerResponseError('Neon Project response has invalid identity.') };
  if (input.projectId && id !== input.projectId) return { error: conflictError('Neon Project ID differs from the approved identity.') };
  if (input.name && name !== input.name) return { error: conflictError('Neon Project name differs from the approved identity.') };
  return {
    resource: {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: id,
      type: 'database.project',
      name,
      lifecycle,
      version: 1,
      attributes: pickScalars(source, [
        'org_id', 'region_id', 'pg_version', 'created_at', 'updated_at', 'current_state',
        'history_retention_seconds', 'default_endpoint_settings',
      ]),
    },
  };
}

function normalizeCreatedProject(data, input) {
  const projectId = SAFE_ID.test(data?.project?.id || '') ? data.project.id : '';
  const project = normalizeProject(data?.project, input, 'managed');
  if (project.error) return { error: project.error, projectId };
  const branch = normalizeBranch(data?.branch);
  if (branch.error || branch.branch.name !== input.branchName) {
    return { error: branch.error || conflictError('Neon created a different root branch.'), projectId };
  }
  const endpoint = normalizeEndpoint(Array.isArray(data?.endpoints) ? data.endpoints[0] : null, branch.branch.id);
  if (endpoint.error) return { error: endpoint.error, projectId };
  if (!endpointMatchesCompute(endpoint.endpoint, input)) {
    return { error: conflictError('Neon created the default endpoint with compute settings that differ from the approved plan.'), projectId };
  }
  const operations = normalizeOperationIds(data?.operations);
  if (operations.error) return { error: operations.error, projectId };
  return {
    resource: project.resource,
    branch: branch.branch,
    endpoint: endpoint.endpoint,
    operationIds: operations.operationIds,
    connectionUri: extractConnectionUri(data),
  };
}

function normalizeCreatedBranch(data, input) {
  const branchId = SAFE_ID.test(data?.branch?.id || '') ? data.branch.id : '';
  const branch = normalizeBranch(data?.branch);
  if (branch.error) return { error: branch.error, branchId };
  if (branch.branch.name !== input.name || branch.branch.parentId !== input.parentBranchId) {
    return { error: conflictError('Neon created a Branch with different identity or parent.'), branchId };
  }
  const endpoint = normalizeEndpoint(Array.isArray(data?.endpoints) ? data.endpoints[0] : null, branch.branch.id);
  if (endpoint.error) return { error: endpoint.error, branchId };
  const operations = normalizeOperationIds(data?.operations);
  if (operations.error) return { error: operations.error, branchId };
  return {
    branch: branch.branch,
    endpoint: endpoint.endpoint,
    operationIds: operations.operationIds,
    connectionUri: extractConnectionUri(data),
  };
}

function normalizeCreatedSnapshot(data, input) {
  const snapshotId = SAFE_ID.test(data?.snapshot?.id || '') ? data.snapshot.id : '';
  const normalized = normalizeSnapshot(data?.snapshot);
  if (normalized.error) return { error: normalized.error, snapshotId };
  if (normalized.snapshot.name !== input.name || normalized.snapshot.sourceBranchId !== input.branchId) {
    return { error: conflictError('Neon created a Snapshot with a different name or source Branch.'), snapshotId };
  }
  const operations = normalizeOptionalOperationIds(data?.operations);
  if (operations.error) return { error: operations.error, snapshotId };
  return { snapshot: normalized.snapshot, operationIds: operations.operationIds };
}

function normalizeSnapshotRestore(data, input) {
  const branch = normalizeBranch(data?.branch);
  if (branch.error) return { error: branch.error };
  if (branch.branch.name !== input.name ||
      (branch.branch.projectId && branch.branch.projectId !== input.projectId)) {
    return { error: conflictError('Neon restored a Branch with an unexpected name or Project identity.') };
  }
  const operations = normalizeOptionalOperationIds(data?.operations);
  if (operations.error) return { error: operations.error };
  return { branch: branch.branch, operationIds: operations.operationIds };
}

function normalizeBranch(data) {
  const source = data && typeof data === 'object' ? data : {};
  const branch = {
    id: String(source.id || ''),
    projectId: String(source.project_id || ''),
    name: String(source.name || ''),
    parentId: String(source.parent_id || ''),
    protected: source.protected === true,
    currentState: typeof source.current_state === 'string' ? source.current_state : '',
    createdAt: typeof source.created_at === 'string' ? source.created_at : '',
    updatedAt: typeof source.updated_at === 'string' ? source.updated_at : '',
    expiresAt: typeof source.expires_at === 'string' ? source.expires_at : '',
  };
  if (!SAFE_ID.test(branch.id) || !SAFE_NAME.test(branch.name)) return { error: providerResponseError('Neon Branch response has invalid identity.') };
  return { branch };
}

function normalizeEndpoint(data, expectedBranchId) {
  const source = data && typeof data === 'object' ? data : {};
  const providerSuspendTimeoutSeconds = Number.isInteger(source.suspend_timeout_seconds)
    ? source.suspend_timeout_seconds
    : null;
  const endpoint = {
    id: String(source.id || ''),
    branchId: String(source.branch_id || ''),
    type: String(source.type || ''),
    currentState: typeof source.current_state === 'string' ? source.current_state : '',
    minCu: typeof source.autoscaling_limit_min_cu === 'number' ? source.autoscaling_limit_min_cu : null,
    maxCu: typeof source.autoscaling_limit_max_cu === 'number' ? source.autoscaling_limit_max_cu : null,
    suspendTimeoutSeconds: providerSuspendTimeoutSeconds === 0 ? 300 : providerSuspendTimeoutSeconds,
    suspendTimeoutMode: providerSuspendTimeoutSeconds === 0 ? 'provider-default' : 'explicit',
  };
  if (!SAFE_ID.test(endpoint.id) || endpoint.branchId !== expectedBranchId || endpoint.type !== 'read_write') {
    return { error: providerResponseError('Neon Endpoint response has invalid identity or type.') };
  }
  return { endpoint };
}

function endpointMatchesCompute(endpoint, input) {
  return endpoint.minCu === input.minCu &&
    endpoint.maxCu === input.maxCu &&
    endpoint.suspendTimeoutSeconds === input.suspendTimeoutSeconds;
}

function normalizeOperation(data) {
  const source = data && typeof data === 'object' ? data : {};
  const operation = {
    id: String(source.id || ''),
    projectId: String(source.project_id || ''),
    branchId: String(source.branch_id || ''),
    endpointId: String(source.endpoint_id || ''),
    action: typeof source.action === 'string' ? source.action : '',
    status: String(source.status || '').toLowerCase(),
    createdAt: typeof source.created_at === 'string' ? source.created_at : '',
    updatedAt: typeof source.updated_at === 'string' ? source.updated_at : '',
  };
  if (!SAFE_ID.test(operation.id) || !operation.status) return { error: providerResponseError('Neon Operation response has invalid identity or status.') };
  return { operation };
}

function normalizeOperationIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: providerResponseError('Neon creation response is missing asynchronous operations.') };
  }
  const ids = value.map((operation) => String(operation?.id || ''));
  if (ids.some((id) => !SAFE_ID.test(id)) || new Set(ids).size !== ids.length) {
    return { error: providerResponseError('Neon creation response contains invalid or duplicate Operation IDs.') };
  }
  return { operationIds: ids.sort() };
}

function normalizeOptionalOperationIds(value) {
  if (!Array.isArray(value)) {
    return { error: providerResponseError('Neon Snapshot response is missing the operations array.') };
  }
  const ids = value.map((operation) => String(operation?.id || ''));
  if (ids.some((id) => !SAFE_ID.test(id)) || new Set(ids).size !== ids.length || ids.length > 50) {
    return { error: providerResponseError('Neon Snapshot response contains invalid, duplicate, or too many Operation IDs.') };
  }
  return { operationIds: ids.sort() };
}

function normalizeSnapshots(value) {
  if (!Array.isArray(value)) return { error: providerResponseError('Neon Snapshot list response is missing snapshots.') };
  const snapshots = [];
  const ids = new Set();
  for (const item of value) {
    const normalized = normalizeSnapshot(item);
    if (normalized.error) return normalized;
    if (ids.has(normalized.snapshot.id)) {
      return { error: providerResponseError('Neon Snapshot list contains duplicate Snapshot IDs.') };
    }
    ids.add(normalized.snapshot.id);
    snapshots.push(normalized.snapshot);
  }
  snapshots.sort((left, right) => left.id.localeCompare(right.id));
  return { snapshots };
}

function summarizeSchemaJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tables)) {
    return { error: providerResponseError('Neon Schema JSON response is missing the tables array.') };
  }
  let serialized;
  try { serialized = stableStringify(value); }
  catch { return { error: providerResponseError('Neon Schema JSON response cannot be canonicalized safely.') }; }
  if (serialized.length > 8 * 1024 * 1024 || value.tables.length > 10000) {
    return { error: providerResponseError('Neon Schema JSON response exceeds the inspection safety bound.') };
  }
  let columnCount = 0;
  let constraintCount = 0;
  for (const table of value.tables) {
    if (!table || typeof table !== 'object' || Array.isArray(table) || !Array.isArray(table.columns)) {
      return { error: providerResponseError('Neon Schema JSON contains an invalid table definition.') };
    }
    columnCount += table.columns.length;
    constraintCount += Array.isArray(table.constraints) ? table.constraints.length : 0;
    if (columnCount > 100000 || constraintCount > 100000) {
      return { error: providerResponseError('Neon Schema JSON exceeds the column or constraint safety bound.') };
    }
  }
  return {
    schemaFingerprint: `sha256:${sha256(serialized)}`,
    tableCount: value.tables.length,
    columnCount,
    constraintCount,
  };
}

function normalizeSnapshot(data) {
  const source = data && typeof data === 'object' ? data : {};
  const snapshot = {
    id: String(source.id || ''),
    name: String(source.name || ''),
    sourceBranchId: String(source.source_branch_id || ''),
    createdAt: typeof source.created_at === 'string' ? source.created_at : '',
    expiresAt: typeof source.expires_at === 'string' ? source.expires_at : '',
    lsn: typeof source.lsn === 'string' ? source.lsn : '',
    timestamp: typeof source.timestamp === 'string' ? source.timestamp : '',
    manual: source.manual === true,
    fullSizeBytes: Number.isSafeInteger(source.full_size) && source.full_size >= 0 ? source.full_size : null,
    diffSizeBytes: Number.isSafeInteger(source.diff_size) && source.diff_size >= 0 ? source.diff_size : null,
  };
  if (
    !SAFE_ID.test(snapshot.id) || !SAFE_NAME.test(snapshot.name) ||
    !SAFE_ID.test(snapshot.sourceBranchId) || !snapshot.createdAt || !Number.isFinite(Date.parse(snapshot.createdAt)) ||
    (snapshot.expiresAt && !Number.isFinite(Date.parse(snapshot.expiresAt))) ||
    (source.full_size !== undefined && snapshot.fullSizeBytes === null) ||
    (source.diff_size !== undefined && snapshot.diffSizeBytes === null)
  ) return { error: providerResponseError('Neon Snapshot response has invalid identity, source Branch, timestamp, or size metadata.') };
  return { snapshot };
}

function snapshotResource(snapshot, input, lifecycle) {
  return {
    logicalId: input.logicalId,
    provider: PROVIDER,
    providerId: snapshot.id,
    type: 'database.backup',
    name: snapshot.name,
    lifecycle,
    version: 1,
    attributes: {
      projectId: input.projectId,
      sourceBranchId: snapshot.sourceBranchId,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
      manual: snapshot.manual,
      fullSizeBytes: snapshot.fullSizeBytes,
      diffSizeBytes: snapshot.diffSizeBytes,
      migrationPlanId: input.migrationPlanId,
      migrationPlanFingerprint: input.migrationPlanFingerprint,
      snapshotPlanFingerprint: input.planFingerprint || '',
      restoreTested: false,
    },
  };
}

function normalizeDatabases(value, expectedBranchId) {
  if (!Array.isArray(value)) return { error: providerResponseError('Neon Database list response is missing databases.') };
  const databases = [];
  const names = new Set();
  for (const item of value) {
    const name = String(item?.name || '');
    const branchId = String(item?.branch_id || '');
    const id = String(item?.id || '');
    if (!POSTGRES_NAME.test(name) || branchId !== expectedBranchId || (id && !SAFE_ID.test(id)) || names.has(name)) {
      return { error: providerResponseError('Neon Database list contains invalid, duplicate, or cross-branch metadata.') };
    }
    names.add(name);
    databases.push({
      ...(id ? { id } : {}),
      name,
      createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    });
  }
  databases.sort((left, right) => left.name.localeCompare(right.name));
  return { databases };
}

function normalizeRoles(value, expectedBranchId) {
  if (!Array.isArray(value)) return { error: providerResponseError('Neon Role list response is missing roles.') };
  const roles = [];
  const names = new Set();
  for (const item of value) {
    const name = String(item?.name || '');
    const branchId = String(item?.branch_id || '');
    if (!POSTGRES_NAME.test(name) || branchId !== expectedBranchId || names.has(name)) {
      return { error: providerResponseError('Neon Role list contains invalid, duplicate, or cross-branch metadata.') };
    }
    names.add(name);
    roles.push({
      name,
      protected: item.protected === true,
      createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    });
  }
  roles.sort((left, right) => left.name.localeCompare(right.name));
  return { roles };
}

function extractConnectionUri(data) {
  const candidates = [
    data?.uri,
    data?.connection_uri,
    ...(Array.isArray(data?.connection_uris)
      ? data.connection_uris.flatMap((item) => [item?.connection_uri, item?.uri])
      : []),
  ];
  return candidates.find(isPostgresUri) || '';
}

function isPostgresUri(value) {
  return typeof value === 'string' && /^postgres(?:ql)?:\/\/[^\s]+$/i.test(value);
}

function projectPlanFingerprint(input, tokenScope, configuredOrgId) {
  return sha256(JSON.stringify(projectPlanSummary(input, tokenScope, configuredOrgId)));
}

function connectionCaptureFingerprint(input) {
  return sha256(JSON.stringify({
    projectId: input.projectId,
    projectName: input.projectName,
    branchId: input.branchId || '',
    branchName: input.branchName,
    endpointId: input.endpointId || '',
    databaseName: input.databaseName,
    roleName: input.roleName,
    pooled: input.pooled !== false,
    destinationSecretRef: input.destinationSecretRef,
  }));
}

function branchPlanFingerprint(input) {
  return sha256(JSON.stringify({
    projectId: input.projectId,
    name: input.name,
    parentBranchId: input.parentBranchId,
    endpoint: computeSummary(input),
    expiresAt: input.expiresAt || '',
    destinationSecretRef: input.destinationSecretRef,
  }));
}

function snapshotPlanFingerprint(input) {
  return sha256(stableStringify({
    projectId: input.projectId,
    branchId: input.branchId,
    name: input.name,
    expiresAt: input.expiresAt || '',
    migrationPlanId: input.migrationPlanId,
    migrationPlanFingerprint: input.migrationPlanFingerprint,
  }));
}

function snapshotRestorePlanFingerprint(input) {
  return sha256(stableStringify({
    projectId: input.projectId,
    snapshotId: input.snapshotId,
    sourceBranchId: input.sourceBranchId,
    targetBranchId: input.targetBranchId,
    name: input.name,
    rollbackPlanId: input.rollbackPlanId,
    rollbackPlanFingerprint: input.rollbackPlanFingerprint,
    backupEvidenceId: input.backupEvidenceId,
    backupEvidenceFingerprint: input.backupEvidenceFingerprint,
    finalizeRestore: true,
  }));
}

function migrationExecutionFingerprint(input) {
  return sha256(stableStringify({
    projectId: input.projectId,
    branchId: input.branchId,
    databaseName: input.databaseName,
    expectedSchemaVersion: input.expectedSchemaVersion,
    baselineSchemaFingerprint: input.baselineSchemaFingerprint,
    classification: input.classification,
    migrationCount: input.migrationCount,
    statementCount: input.statementCount,
    migrationPlanId: input.migrationPlanId,
    migrationPlanFingerprint: input.migrationPlanFingerprint,
    backupEvidenceId: input.backupEvidenceId,
    backupEvidenceFingerprint: input.backupEvidenceFingerprint,
  }));
}

function migrationExecutorContext(input) {
  return {
    projectId: input.projectId,
    branchId: input.branchId,
    databaseName: input.databaseName,
    expectedSchemaVersion: input.expectedSchemaVersion,
    baselineSchemaFingerprint: input.baselineSchemaFingerprint,
    classification: input.classification,
    migrationCount: input.migrationCount,
    statementCount: input.statementCount,
    migrationPlanId: input.migrationPlanId,
    migrationPlanFingerprint: input.migrationPlanFingerprint,
    backupEvidenceId: input.backupEvidenceId,
    backupEvidenceFingerprint: input.backupEvidenceFingerprint,
  };
}

function normalizeMigrationInspection(value) {
  const schemaVersion = String(value?.schemaVersion || '');
  const schemaFingerprint = String(value?.schemaFingerprint || '');
  const migrationPlanFingerprint = String(value?.migrationPlanFingerprint || '');
  const backupEvidenceFingerprint = String(value?.backupEvidenceFingerprint || '');
  if (!SCHEMA_VERSION.test(schemaVersion) || !CONTROL_FINGERPRINT.test(schemaFingerprint) ||
      (migrationPlanFingerprint && !CONTROL_FINGERPRINT.test(migrationPlanFingerprint)) ||
      (backupEvidenceFingerprint && !CONTROL_FINGERPRINT.test(backupEvidenceFingerprint)) ||
      Boolean(migrationPlanFingerprint) !== Boolean(backupEvidenceFingerprint)) {
    return { error: providerResponseError('Migration Executor returned invalid Schema version or fingerprint evidence.') };
  }
  return { schemaVersion, schemaFingerprint, migrationPlanFingerprint, backupEvidenceFingerprint };
}

function migrationSuccessData(input, before, after, sqlStatementsExecuted, adopted) {
  return {
    resource: {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: input.branchId,
      type: 'database.schema',
      name: input.databaseName,
      lifecycle: 'managed',
      version: 1,
      attributes: {
        projectId: input.projectId,
        branchId: input.branchId,
        schemaVersionBefore: before.schemaVersion,
        schemaVersionAfter: after.schemaVersion,
        schemaFingerprintBefore: before.schemaFingerprint,
        schemaFingerprintAfter: after.schemaFingerprint,
        migrationPlanId: input.migrationPlanId,
        migrationPlanFingerprint: input.migrationPlanFingerprint,
        backupEvidenceId: input.backupEvidenceId,
        backupEvidenceFingerprint: input.backupEvidenceFingerprint,
      },
    },
    applied: !adopted,
    adopted,
    schemaVersionVerified: true,
    providerMutationsExecuted: adopted ? 0 : 1,
    sqlStatementsExecuted,
    rawSqlPersisted: false,
    secretValuesExposed: false,
  };
}

function parseConnectionScope(value) {
  const scope = String(value || 'personal');
  if (scope === 'personal' || scope === 'organization') return { tokenScope: scope, orgId: '', projectId: '' };
  if (scope.startsWith('organization:') && SAFE_ID.test(scope.slice('organization:'.length))) {
    return { tokenScope: 'personal', orgId: scope.slice('organization:'.length), projectId: '' };
  }
  if (scope.startsWith('project:') && SAFE_ID.test(scope.slice('project:'.length))) {
    return { tokenScope: 'project', orgId: '', projectId: scope.slice('project:'.length) };
  }
  throw new Error('Neon connection scope must be personal, organization, organization:<org-id>, or project:<project-id>.');
}

function sanitizeResponse(response, token, mutation) {
  return {
    ok: response.ok === true,
    status: Number(response.status || 0),
    code: response.code,
    message: sanitizeText(response.message || '', token),
    retryAfter: response.retryAfter,
    resourceId: response.resourceId,
    uncertain: response.uncertain === true || (mutation && Number(response.status || 0) >= 500),
    data: response.ok && response.data && typeof response.data === 'object' ? response.data : {},
  };
}

function sanitizeText(value, token) {
  let text = String(value || '')
    .replace(/Authorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]');
  if (token) text = text.split(token).join('[redacted]');
  return text;
}

function isUncertainMutation(response) {
  return response.uncertain === true || [409, 423, 429].includes(response.status) || response.status >= 500;
}

function isFixedDefaultSuspendTimeoutRejection(response, input) {
  return response.ok !== true &&
    response.status === 412 &&
    input.suspendTimeoutSeconds === 300 &&
    response.message.toLowerCase().includes('modifying the suspend interval is not permitted on this account');
}

function invalidProviderResponse(message) {
  return { ok: false, status: 422, code: 'PROVIDER_RESPONSE_INVALID', message, data: {} };
}

function incompleteProviderState(message) {
  return { ok: false, status: 503, code: 'PROVIDER_STATE_INCOMPLETE', message, data: {} };
}

function pickScalars(value, keys) {
  return Object.fromEntries(keys
    .filter((key) => value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))
    .map((key) => [key, value[key]]));
}

function isFutureIsoTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function validationError(message) {
  return { code: 'VALIDATION_FAILED', message, retryable: false, provider: PROVIDER };
}

function providerResponseError(message) {
  return { code: 'PROVIDER_RESPONSE_INVALID', message, retryable: false, provider: PROVIDER };
}

function conflictError(message) {
  return { code: 'CONFLICT', message, retryable: false, provider: PROVIDER };
}

function capabilityError(message) {
  return { code: 'CAPABILITY_MISSING', message, retryable: false, provider: PROVIDER };
}

function approvalError(message) {
  return { code: 'APPROVAL_REQUIRED', message, retryable: false, provider: PROVIDER };
}

function reconciliationError(message) {
  return { code: 'RECONCILIATION_REQUIRED', message, retryable: false, provider: PROVIDER };
}

function providerUnavailableError(message) {
  return { code: 'PROVIDER_UNAVAILABLE', message, retryable: true, provider: PROVIDER };
}

function verificationError(message) {
  return { code: 'VERIFICATION_FAILED', message, retryable: false, provider: PROVIDER };
}

function notFoundError(message) {
  return { code: 'NOT_FOUND', message, retryable: false, provider: PROVIDER };
}
