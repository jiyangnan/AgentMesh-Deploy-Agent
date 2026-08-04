import { createHash } from 'node:crypto';

import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from '../provider-contract.js';
import { createProviderHttpTransport } from '../provider-http.js';
import { resolveConnectionSecretRefs } from '../secret-ref.js';

const PROVIDER = 'supabase';
const API_BASE = 'https://api.supabase.com/';
const PROJECT_REF = /^[a-z]{20}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,255}$/;
const ORG_SLUG = /^[A-Za-z0-9_-]{1,160}$/;
const KEY_NAME = /^[a-z_][a-z0-9_]{3,63}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const PASSWORD_SOURCE = /^(?:env:\/\/[A-Z][A-Z0-9_]*|(?:keychain|op|secret):\/\/[A-Za-z0-9._/-]+)$/;
const SECRET_DESTINATION = /^(?:keychain|op|secret):\/\/[A-Za-z0-9._/-]+$/;
const REGION_TYPES = new Set(['specific', 'smartGroup']);
const ORGANIZATION_PLANS = new Set(['free', 'pro', 'team', 'enterprise', 'platform']);
const INSTANCE_SIZES = new Set([
  'default-smallest', 'nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge',
  '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge', '24xlarge_optimized_memory',
  '24xlarge_optimized_cpu', '24xlarge_high_memory', '48xlarge', '48xlarge_optimized_memory',
  '48xlarge_optimized_cpu', '48xlarge_high_memory',
]);
const SERVICE_NAMES = new Set(['auth', 'db', 'db_postgres_user', 'pooler', 'realtime', 'rest', 'storage', 'pg_bouncer']);
const WAITING_PROJECT_STATES = new Set(['INACTIVE', 'COMING_UP', 'RESTORING', 'UPGRADING', 'RESTARTING', 'RESIZING']);
const TERMINAL_PROJECT_STATES = new Set([
  'INIT_FAILED', 'REMOVED', 'RESTORE_FAILED', 'PAUSE_FAILED', 'GOING_DOWN', 'PAUSING',
]);

export class SupabaseV2Adapter {
  #token;
  #transport;
  #secretSource;
  #secretSink;

  constructor(options = {}) {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('Supabase Management API access token is required.');
    this.#token = options.token;
    this.#transport = options.transport || createProviderHttpTransport(options.httpOptions);
    this.#secretSource = options.secretSource || null;
    this.#secretSink = options.secretSink || null;
  }

  async readOrganization(input) {
    const operation = 'supabase.organization.read';
    if (!input?.appId || !ORG_SLUG.test(input.organizationSlug || '')) {
      return this.#failure(operation, input?.appId || '', validationError('Supabase Organization Read requires appId and organizationSlug.'), input || {});
    }
    const organizationRead = await this.#readOrganizationExact(input.organizationSlug);
    if (organizationRead.response) return this.#providerFailure(operation, input.appId, organizationRead.response, input);
    if (organizationRead.error) return this.#failure(operation, input.appId, organizationRead.error, input);
    return this.#success(operation, input.appId, {
      organization: organizationRead.organization,
      observedAt: input.now || new Date().toISOString(),
    }, input);
  }

  async readProject(input) {
    const operation = 'supabase.project.read';
    const invalid = validateProjectRead(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const response = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(input.projectRef)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const project = normalizeProject(response.data, input, input.lifecycle || 'external');
    if (project.error) return this.#failure(operation, input.appId, project.error, input);
    return this.#success(operation, input.appId, {
      resource: project.resource,
      observedAt: input.now || new Date().toISOString(),
    }, input);
  }

  planProject(input) {
    const operation = 'supabase.project.plan';
    const invalid = validateProjectPlan(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const planFingerprint = projectPlanFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      project: projectPlanSummary(input),
      databasePasswordRef: input.databasePasswordRef,
      connectionDestinationSecretRef: input.connectionDestinationSecretRef,
      planFingerprint,
      providerMutationsExecuted: 0,
      costMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve the Supabase organization, live region availability, instance size, and project cost.'],
    });
  }

  async executeProject(input) {
    const operation = 'supabase.project.create';
    const invalid = validateProjectPlan(input) || validateCostGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    if (input.planFingerprint !== projectPlanFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Supabase Project plan fingerprint does not match the approved plan.'), input);
    }
    const prerequisites = await this.#preflightProjectSecrets(operation, input);
    if (prerequisites.result) return prerequisites.result;

    const organizationRead = await this.#readOrganizationExact(input.organizationSlug);
    if (organizationRead.response) return this.#providerFailure(operation, input.appId, organizationRead.response, input);
    if (organizationRead.error) return this.#failure(operation, input.appId, organizationRead.error, input);
    const organization = { organization: organizationRead.organization };

    const region = await this.#verifyRegion(input);
    if (region.error) return this.#providerFailure(operation, input.appId, region.error, input);

    const existing = await this.#findProjectByName(input.organizationSlug, input.name);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.project) {
      const project = normalizeProject(existing.project, input, 'managed');
      if (project.error) return this.#failure(operation, input.appId, project.error, input);
      if (
        input.knownProviderId !== project.resource.providerId ||
        input.knownPlanFingerprint !== input.planFingerprint
      ) {
        return this.#failure(operation, input.appId, conflictError('An exact Supabase Project exists without matching recorded ownership and approved plan.'), input);
      }
      return this.#success(operation, input.appId, {
        resource: project.resource,
        organization: organization.organization,
        created: false,
        adopted: true,
        changed: false,
        databasePasswordRef: input.databasePasswordRef,
        connectionDestinationSecretRef: input.connectionDestinationSecretRef,
        connectionCaptured: prerequisites.destination.present === true,
        connectionCaptureRequired: prerequisites.destination.present !== true,
        providerMutationsExecuted: 0,
        costMutationsExecuted: 0,
        idempotency: 'read-before-create',
      }, input, {
        status: project.resource.attributes.status === 'ACTIVE_HEALTHY' ? 'succeeded' : 'waiting-external',
        nextActions: prerequisites.destination.present === true
          ? []
          : ['Poll service health, then run the approved Supabase connection capture action.'],
      });
    }
    if (input.knownProviderId) {
      return this.#failure(operation, input.appId, conflictError('DeploymentState records a Supabase Project absent from the exact organization listing.'), input);
    }
    if (prerequisites.destination.present === true) {
      return this.#failure(operation, input.appId, conflictError('The connection Secret Ref is occupied but no matching Supabase Project state exists.'), input);
    }

    const body = {
      name: input.name,
      organization_slug: input.organizationSlug,
      db_pass: prerequisites.password,
      region_selection: { type: input.regionType, code: input.regionCode },
      high_availability: false,
      ...(input.instanceSize === 'default-smallest' ? {} : { desired_instance_size: input.instanceSize }),
    };
    const response = await this.#requestSafe('POST', 'v1/projects', body, [prerequisites.password]);
    clearSecretBody(body);
    if (!response.ok) {
      if (isUncertainMutation(response)) {
        const recovered = await this.#findProjectByName(input.organizationSlug, input.name);
        if (recovered.project && !recovered.conflict) {
          const project = normalizeProject(recovered.project, input, 'managed');
          if (project.error) return this.#failure(operation, input.appId, project.error, input);
          return this.#success(operation, input.appId, {
            resource: project.resource,
            organization: organization.organization,
            created: true,
            adopted: false,
            changed: true,
            recoveredAfterUncertainCreate: true,
            connectionCaptured: false,
            connectionCaptureRequired: true,
            providerMutationsExecuted: 1,
            costMutationsExecuted: 1,
            duplicateCreatePrevented: true,
          }, input, {
            status: 'waiting-external',
            nextActions: ['Record the recovered Project Ref, poll health, and capture the connection; automatic Create replay is disabled.'],
          });
        }
        if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
        return this.#failure(operation, input.appId, reconciliationError('Supabase Project Create may have committed, but exact organization state is inconclusive; automatic replay is disabled.'), input, {
          data: { providerMutationsExecuted: 1, costMutationsExecuted: 1, duplicateCreatePrevented: true },
        });
      }
      return this.#providerFailure(operation, input.appId, response, input);
    }
    const project = normalizeProject(response.data, input, 'managed');
    if (project.error) return this.#failure(operation, input.appId, project.error, input, {
      data: { providerMutationsExecuted: 1, costMutationsExecuted: 1 },
    });
    return this.#success(operation, input.appId, {
      resource: project.resource,
      organization: organization.organization,
      created: true,
      adopted: false,
      changed: true,
      databasePasswordRef: input.databasePasswordRef,
      connectionDestinationSecretRef: input.connectionDestinationSecretRef,
      connectionCaptured: false,
      connectionCaptureRequired: true,
      providerMutationsExecuted: 1,
      costMutationsExecuted: 1,
      idempotency: 'read-before-create',
    }, input, {
      status: 'waiting-external',
      nextActions: ['Poll the Supabase Project and required service health before connection capture.'],
    });
  }

  async pollProject(input) {
    const operation = 'supabase.project.poll';
    const invalid = validatePoll(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const response = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(input.projectRef)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const project = normalizeProject(response.data, input, 'managed');
    if (project.error) return this.#failure(operation, input.appId, project.error, input);
    const status = project.resource.attributes.status;
    if (WAITING_PROJECT_STATES.has(status)) {
      return this.#success(operation, input.appId, { resource: project.resource }, input, {
        status: 'waiting-external',
        nextActions: ['Poll the Supabase Project again after nextPollAt.'],
      });
    }
    if (TERMINAL_PROJECT_STATES.has(status)) {
      return this.#projectTerminalFailure(operation, input, project.resource, status);
    }
    if (!['ACTIVE_HEALTHY', 'ACTIVE_UNHEALTHY'].includes(status)) {
      return this.#failure(operation, input.appId, providerResponseError(`Supabase returned unknown Project status ${status}.`), input);
    }

    const services = normalizeRequiredServices(input.requiredServices);
    const query = new URLSearchParams({ timeout_ms: String(input.timeoutMs || 2000) });
    for (const service of services) query.append('services', service);
    const healthResponse = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(input.projectRef)}/health?${query}`);
    if (!healthResponse.ok) return this.#providerFailure(operation, input.appId, healthResponse, input);
    const health = normalizeHealth(healthResponse.data, services);
    if (health.error) return this.#failure(operation, input.appId, health.error, input);
    if (health.services.some((service) => service.status === 'COMING_UP')) {
      return this.#success(operation, input.appId, { resource: project.resource, services: health.services }, input, {
        status: 'waiting-external',
        nextActions: ['Poll required Supabase services again after nextPollAt.'],
      });
    }
    if (status !== 'ACTIVE_HEALTHY' || health.services.some((service) => service.status !== 'ACTIVE_HEALTHY')) {
      return this.#failure(operation, input.appId, {
        code: 'PROVIDER_OPERATION_FAILED',
        message: 'Supabase Project or one of its required services is unhealthy.',
        retryable: false,
        provider: PROVIDER,
        resourceId: input.projectRef,
      }, input, { status: 'failed-terminal', data: { resource: project.resource, services: health.services } });
    }
    return this.#success(operation, input.appId, {
      resource: project.resource,
      services: health.services,
      verifiedAt: input.now || new Date().toISOString(),
    }, input);
  }

  planConnectionCapture(input) {
    const operation = 'supabase.connection.plan-capture';
    const invalid = validateConnectionCapture(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const planFingerprint = connectionCaptureFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      projectRef: input.projectRef,
      projectName: input.projectName,
      organizationSlug: input.organizationSlug,
      databasePasswordRef: input.databasePasswordRef,
      destinationSecretRef: input.destinationSecretRef,
      planFingerprint,
      providerMutationsExecuted: 0,
      secretReadsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve reading the database password Secret Ref and writing one connection URI to the exact destination.'],
    });
  }

  async executeConnectionCapture(input) {
    const operation = 'supabase.connection.capture';
    const invalid = validateConnectionCapture(input) || validateSecretReadGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    if (input.planFingerprint !== connectionCaptureFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Supabase connection capture fingerprint does not match the approved plan.'), input);
    }
    const sink = await this.#preflightSink(operation, input, input.destinationSecretRef);
    if (sink.result) return sink.result;
    if (sink.readiness.present === true) {
      if (input.knownProviderId === input.projectRef && input.knownPlanFingerprint === input.planFingerprint) {
        return this.#success(operation, input.appId, {
          projectRef: input.projectRef,
          destinationSecretRef: input.destinationSecretRef,
          connectionCaptured: true,
          adopted: true,
          providerMutationsExecuted: 0,
          secretReadsExecuted: 0,
          secretValuesExposed: false,
        }, input);
      }
      return this.#failure(operation, input.appId, conflictError('The connection destination is occupied without matching recorded Supabase capture state.'), input);
    }
    const password = await this.#readDatabasePassword(operation, input);
    if (password.result) return password.result;
    const response = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(input.projectRef)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const project = normalizeProject(response.data, {
      ...input,
      logicalId: input.logicalId || 'database.project',
      name: input.projectName,
    }, 'managed');
    if (project.error) return this.#failure(operation, input.appId, project.error, input);
    if (project.resource.attributes.status !== 'ACTIVE_HEALTHY') {
      return this.#failure(operation, input.appId, {
        code: 'VERIFICATION_FAILED',
        message: 'Supabase connection capture requires an ACTIVE_HEALTHY Project.',
        retryable: false,
        provider: PROVIDER,
        resourceId: input.projectRef,
      }, input);
    }
    const host = response.data?.database?.host;
    if (!isHostname(host)) return this.#failure(operation, input.appId, providerResponseError('Supabase Project response is missing a valid database host.'), input);
    const uri = `postgresql://postgres:${encodeURIComponent(password.password)}@${host}:5432/postgres?sslmode=require`;
    const capture = await this.#storeSecret(input.destinationSecretRef, uri, {
      provider: PROVIDER,
      providerId: input.projectRef,
      projectRef: input.projectRef,
      purpose: 'database-connection',
      planFingerprint: input.planFingerprint,
    });
    if (capture.error) return this.#failure(operation, input.appId, capture.error, input, {
      data: {
        projectRef: input.projectRef,
        destinationSecretRef: input.destinationSecretRef,
        connectionCaptured: false,
        providerMutationsExecuted: 0,
        secretReadsExecuted: 1,
      },
    });
    return this.#success(operation, input.appId, {
      projectRef: input.projectRef,
      destinationSecretRef: input.destinationSecretRef,
      connectionCaptured: true,
      providerMutationsExecuted: 0,
      secretReadsExecuted: 1,
      secretValuesExposed: false,
    }, input);
  }

  planRuntimeCredentials(input) {
    const operation = 'supabase.runtime-credentials.plan';
    const invalid = validateRuntimeCredentials(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const planFingerprint = runtimeCredentialsFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      projectRef: input.projectRef,
      projectName: input.projectName,
      organizationSlug: input.organizationSlug,
      keyName: input.keyName,
      destinationSecretRef: input.destinationSecretRef,
      keyTypes: ['publishable', 'secret'],
      planFingerprint,
      providerMutationsExecuted: 0,
      secretReadsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve ensuring publishable/secret API keys and atomically capturing the runtime credential bundle.'],
    });
  }

  async executeRuntimeCredentials(input) {
    const operation = 'supabase.runtime-credentials.ensure';
    const invalid = validateRuntimeCredentials(input) || validateRuntimeCredentialGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    if (input.planFingerprint !== runtimeCredentialsFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Supabase runtime credential fingerprint does not match the approved plan.'), input);
    }
    const sink = await this.#preflightSink(operation, input, input.destinationSecretRef);
    if (sink.result) return sink.result;
    if (sink.readiness.present === true) {
      if (input.knownProviderId === input.projectRef && input.knownPlanFingerprint === input.planFingerprint) {
        return this.#success(operation, input.appId, {
          projectRef: input.projectRef,
          destinationSecretRef: input.destinationSecretRef,
          credentialBundleCaptured: true,
          adopted: true,
          providerMutationsExecuted: 0,
          secretReadsExecuted: 0,
          secretValuesExposed: false,
        }, input);
      }
      return this.#failure(operation, input.appId, conflictError('The runtime credential destination is occupied without matching Supabase capture state.'), input);
    }
    const projectResponse = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(input.projectRef)}`);
    if (!projectResponse.ok) return this.#providerFailure(operation, input.appId, projectResponse, input);
    const project = normalizeProject(projectResponse.data, {
      ...input,
      logicalId: input.logicalId || 'database.project',
      name: input.projectName,
    }, 'managed');
    if (project.error) return this.#failure(operation, input.appId, project.error, input);
    if (project.resource.attributes.status !== 'ACTIVE_HEALTHY') {
      return this.#failure(operation, input.appId, {
        code: 'VERIFICATION_FAILED',
        message: 'Supabase runtime credential capture requires an ACTIVE_HEALTHY Project.',
        retryable: false,
        provider: PROVIDER,
        resourceId: input.projectRef,
      }, input);
    }

    let listed = await this.#listApiKeys(input.projectRef, true);
    if (listed.error) return this.#providerFailure(operation, input.appId, listed.error, input);
    let providerMutationsExecuted = 0;
    for (const type of ['publishable', 'secret']) {
      const selected = selectApiKey(listed.keys, type, input.keyName);
      if (selected.conflict) return this.#failure(operation, input.appId, selected.conflict, input);
      if (selected.key) continue;
      const body = {
        type,
        name: input.keyName,
        ...(type === 'secret' ? { secret_jwt_template: { role: 'service_role' } } : {}),
      };
      const created = await this.#requestSafe('POST', `v1/projects/${encodeURIComponent(input.projectRef)}/api-keys?reveal=true`, body);
      if (!created.ok) {
        if (isUncertainMutation(created)) {
          const recovered = await this.#listApiKeys(input.projectRef, true);
          if (recovered.error) return this.#providerFailure(operation, input.appId, recovered.error, input);
          const match = selectApiKey(recovered.keys, type, input.keyName);
          if (match.key && !match.conflict) {
            listed = recovered;
            providerMutationsExecuted += 1;
            continue;
          }
          if (match.conflict) return this.#failure(operation, input.appId, match.conflict, input);
          return this.#failure(operation, input.appId, reconciliationError(`Supabase ${type} API Key Create may have committed, but exact key state is inconclusive; automatic replay is disabled.`), input, {
            data: { providerMutationsExecuted: providerMutationsExecuted + 1, duplicateCreatePrevented: true },
          });
        }
        return this.#providerFailure(operation, input.appId, created, input);
      }
      providerMutationsExecuted += 1;
      listed = await this.#listApiKeys(input.projectRef, true);
      if (listed.error) return this.#providerFailure(operation, input.appId, listed.error, input);
      const confirmed = selectApiKey(listed.keys, type, input.keyName);
      if (confirmed.conflict) return this.#failure(operation, input.appId, confirmed.conflict, input);
      if (!confirmed.key) {
        return this.#failure(operation, input.appId, reconciliationError(`Supabase accepted ${type} API Key Create, but the exact key is not yet observable; creating another key is disabled until reconciliation.`), input, {
          data: { providerMutationsExecuted, duplicateCreatePrevented: true },
        });
      }
    }

    const publishable = selectApiKey(listed.keys, 'publishable', input.keyName);
    const secret = selectApiKey(listed.keys, 'secret', input.keyName);
    if (publishable.conflict) return this.#failure(operation, input.appId, publishable.conflict, input);
    if (secret.conflict) return this.#failure(operation, input.appId, secret.conflict, input);
    if (!publishable.key || !secret.key || !isApiKeyValue(publishable.key.apiKey) || !isApiKeyValue(secret.key.apiKey)) {
      return this.#failure(operation, input.appId, {
        code: 'SECRET_CAPTURE_REQUIRED',
        message: 'Supabase runtime API keys exist but their revealed values are unavailable or invalid.',
        retryable: false,
        provider: PROVIDER,
        resourceId: input.projectRef,
      }, input, {
        data: { projectRef: input.projectRef, providerMutationsExecuted, credentialBundleCaptured: false },
      });
    }
    const bundle = JSON.stringify({
      SUPABASE_URL: `https://${input.projectRef}.supabase.co`,
      SUPABASE_PUBLISHABLE_KEY: publishable.key.apiKey,
      SUPABASE_SECRET_KEY: secret.key.apiKey,
    });
    const capture = await this.#storeSecret(input.destinationSecretRef, bundle, {
      provider: PROVIDER,
      providerId: input.projectRef,
      projectRef: input.projectRef,
      purpose: 'runtime-credential-bundle',
      keyName: input.keyName,
      keyIds: [publishable.key.id, secret.key.id].filter(Boolean).sort(),
      planFingerprint: input.planFingerprint,
    });
    if (capture.error) return this.#failure(operation, input.appId, capture.error, input, {
      data: {
        projectRef: input.projectRef,
        destinationSecretRef: input.destinationSecretRef,
        credentialBundleCaptured: false,
        providerMutationsExecuted,
        secretReadsExecuted: 1,
      },
      nextActions: ['Re-run the same approved capture after restoring the Secret Sink; API Key values remain recoverable through reveal=true.'],
    });
    return this.#success(operation, input.appId, {
      projectRef: input.projectRef,
      keyMetadata: [safeApiKeyMetadata(publishable.key), safeApiKeyMetadata(secret.key)],
      destinationSecretRef: input.destinationSecretRef,
      credentialBundleCaptured: true,
      providerMutationsExecuted,
      secretReadsExecuted: 1,
      secretValuesExposed: false,
    }, input);
  }

  async readProjectCatalog(input) {
    const operation = 'supabase.project.read-catalog';
    const invalid = validatePoll(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const projectResponse = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(input.projectRef)}`);
    if (!projectResponse.ok) return this.#providerFailure(operation, input.appId, projectResponse, input);
    const project = normalizeProject(projectResponse.data, input, 'managed');
    if (project.error) return this.#failure(operation, input.appId, project.error, input);
    const services = normalizeRequiredServices(input.requiredServices);
    const query = new URLSearchParams({ timeout_ms: String(input.timeoutMs || 2000) });
    for (const service of services) query.append('services', service);
    const healthResponse = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(input.projectRef)}/health?${query}`);
    if (!healthResponse.ok) return this.#providerFailure(operation, input.appId, healthResponse, input);
    const health = normalizeHealth(healthResponse.data, services);
    if (health.error) return this.#failure(operation, input.appId, health.error, input);
    const apiKeys = await this.#listApiKeys(input.projectRef, false);
    if (apiKeys.error) return this.#providerFailure(operation, input.appId, apiKeys.error, input);
    const keyMetadata = apiKeys.keys.map(safeApiKeyMetadata).sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`));
    const catalog = { resource: project.resource, services: health.services, keyMetadata };
    return this.#success(operation, input.appId, {
      ...catalog,
      catalogFingerprint: sha256(stableStringify(catalog)),
      observedAt: input.now || new Date().toISOString(),
      schemaInspected: false,
      sqlExecuted: false,
      authConfigurationInspected: false,
      secretValuesExposed: false,
    }, input, {
      nextActions: ['Use separate read-only schema, Auth, Storage, and backup evidence before any migration plan.'],
    });
  }

  createOrganization(input) {
    return this.#mutationDisabled('supabase.organization.create', input, 'Organization creation changes billing ownership and remains a human bootstrap action');
  }

  updateProject(input) {
    return this.#mutationDisabled('supabase.project.update', input, 'Project updates can change name, compute, availability, or production behavior');
  }

  deleteProject(input) {
    return this.#mutationDisabled('supabase.project.delete', input, 'Project deletion removes database, Auth, Storage, Functions, keys, and user data');
  }

  mutateBranch(input) {
    return this.#mutationDisabled('supabase.branch.mutate', input, 'Branch create, push, merge, reset, and delete require a separate data-change design');
  }

  applyMigration(input) {
    return this.#mutationDisabled('supabase.migration.apply', input, 'Migration execution requires schema diff, backup evidence, classification, and a separate approval');
  }

  async #verifyRegion(input) {
    const query = new URLSearchParams({ organization_slug: input.organizationSlug });
    if (input.instanceSize !== 'default-smallest') query.set('desired_instance_size', input.instanceSize);
    const response = await this.#requestSafe('GET', `v1/projects/available-regions?${query}`);
    if (!response.ok) return { error: response };
    const group = input.regionType === 'smartGroup' ? response.data?.all?.smartGroup : response.data?.all?.specific;
    if (!Array.isArray(group)) return { error: invalidProviderResponse('Supabase available-regions response is missing the requested region class.') };
    const matches = group.filter((item) => item?.type === input.regionType && item?.code === input.regionCode);
    if (matches.length !== 1) return { error: invalidProviderResponse('Supabase approved region is not uniquely available for the organization and instance size.') };
    if (input.regionType === 'specific' && matches[0].status && matches[0].status !== 'capacity') {
      return { error: { ok: false, status: 422, code: 'CAPABILITY_MISSING', message: 'Supabase selected region currently has no confirmed capacity.', data: {} } };
    }
    return { region: { type: input.regionType, code: input.regionCode } };
  }

  async #findProjectByName(organizationSlug, name) {
    const projects = [];
    let offset = 0;
    let complete = false;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ offset: String(offset), limit: '100', search: name, sort: 'name_asc' });
      const response = await this.#requestSafe('GET', `v1/organizations/${encodeURIComponent(organizationSlug)}/projects?${query}`);
      if (!response.ok) return { error: response };
      if (!Array.isArray(response.data?.projects)) return { error: invalidProviderResponse('Supabase organization Project list response is missing projects.') };
      const pagination = response.data?.pagination;
      if (!pagination || !Number.isInteger(pagination.count) || !Number.isInteger(pagination.limit) || !Number.isInteger(pagination.offset)) {
        return { error: invalidProviderResponse('Supabase organization Project pagination is invalid.') };
      }
      projects.push(...response.data.projects.map((project) => ({ ...project, organization_slug: organizationSlug })));
      const nextOffset = pagination.offset + response.data.projects.length;
      if (nextOffset >= pagination.count) {
        complete = true;
        break;
      }
      if (response.data.projects.length === 0 || nextOffset <= offset) return { error: invalidProviderResponse('Supabase organization Project pagination did not advance.') };
      offset = nextOffset;
    }
    if (!complete) return { error: invalidProviderResponse('Supabase organization Project pagination exceeded the safety bound.') };
    const matches = projects.filter((project) => project?.name === name && project?.is_branch !== true);
    if (matches.length > 1) return { conflict: conflictError('Multiple exact Supabase Projects match the requested name in one organization.') };
    return { project: matches[0] || null };
  }

  async #readOrganizationExact(organizationSlug) {
    const detail = await this.#requestSafe('GET', `v1/organizations/${encodeURIComponent(organizationSlug)}`);
    if (!detail.ok) return { response: detail };
    const direct = normalizeOrganization(detail.data, organizationSlug);
    if (!direct.needsListBinding) return direct;

    const listing = await this.#requestSafe('GET', 'v1/organizations');
    if (!listing.ok) return { response: listing };
    return normalizeOrganization(detail.data, organizationSlug, listing.data);
  }

  async #listApiKeys(projectRef, reveal) {
    const response = await this.#requestSafe('GET', `v1/projects/${encodeURIComponent(projectRef)}/api-keys?reveal=${reveal ? 'true' : 'false'}`);
    if (!response.ok) return { error: response };
    if (!Array.isArray(response.data)) return { error: invalidProviderResponse('Supabase API Key response is not an array.') };
    const keys = [];
    for (const item of response.data) {
      const key = normalizeApiKey(item, reveal);
      if (key.error) return { error: invalidProviderResponse(key.error.message) };
      keys.push(key.key);
    }
    return { keys };
  }

  async #preflightProjectSecrets(operation, input) {
    const sink = await this.#preflightSink(operation, input, input.connectionDestinationSecretRef);
    if (sink.result) return sink;
    const password = await this.#readDatabasePassword(operation, input);
    if (password.result) return password;
    return { destination: sink.readiness, password: password.password };
  }

  async #readDatabasePassword(operation, input) {
    if (!this.#secretSource || typeof this.#secretSource.read !== 'function') {
      return { result: this.#failure(operation, input.appId, capabilityError('A Secret Source is required to read the Supabase database password.'), input) };
    }
    try {
      const receipt = await this.#secretSource.read(input.databasePasswordRef);
      if (!receipt || receipt.ref !== input.databasePasswordRef || !isStrongDatabasePassword(receipt.value)) {
        throw new Error('Secret Source did not return the exact strong database password.');
      }
      return { password: receipt.value };
    } catch {
      return { result: this.#failure(operation, input.appId, capabilityError('The exact Supabase database password Secret Ref is unavailable or fails the strength contract; no provider call was made.'), input) };
    }
  }

  async #preflightSink(operation, input, ref) {
    if (!this.#secretSink || typeof this.#secretSink.check !== 'function' || typeof this.#secretSink.store !== 'function') {
      return { result: this.#failure(operation, input.appId, capabilityError('A writable Secret Sink is required before Supabase provider access.'), input) };
    }
    try {
      const readiness = await this.#secretSink.check(ref);
      if (!readiness || readiness.ref !== ref || readiness.writable !== true) throw new Error('Secret Sink did not confirm the exact destination.');
      return { readiness };
    } catch {
      return { result: this.#failure(operation, input.appId, capabilityError('The exact Supabase Secret Sink destination is not writable; no provider call was made.'), input) };
    }
  }

  async #storeSecret(ref, value, metadata) {
    try {
      const receipt = await this.#secretSink.store(ref, value, metadata);
      if (!receipt || receipt.ref !== ref) throw new Error('Secret Sink did not confirm the exact destination.');
      return { captured: true };
    } catch {
      return { error: {
        code: 'SECRET_CAPTURE_FAILED',
        message: 'Supabase secret material was available, but the Secret Sink did not confirm durable capture.',
        retryable: false,
        provider: PROVIDER,
        resourceId: metadata.providerId,
      } };
    }
  }

  async #requestSafe(method, path, body, secretValues = []) {
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
      return sanitizeResponse(response, this.#token, method !== 'GET', secretValues);
    } catch (error) {
      return {
        ok: false,
        status: 503,
        message: sanitizeText(error.message, this.#token, secretValues),
        data: {},
        uncertain: method !== 'GET',
      };
    }
  }

  #providerFailure(operation, appId, response, input) {
    const error = response.code === 'PROVIDER_RESPONSE_INVALID'
      ? providerResponseError(response.message)
      : mapProviderError(PROVIDER, response);
    return this.#failure(operation, appId, error, input);
  }

  #projectTerminalFailure(operation, input, resource, status) {
    return this.#failure(operation, input.appId, {
      code: 'PROVIDER_OPERATION_FAILED',
      message: `Supabase Project reached terminal state ${status}.`,
      retryable: false,
      provider: PROVIDER,
      resourceId: resource.providerId,
    }, input, { status: 'failed-terminal', data: { resource } });
  }

  #mutationDisabled(operation, input, reason) {
    return this.#failure(operation, input?.appId || '', {
      code: 'UNSUPPORTED',
      message: `Supabase mutation is disabled: ${reason}.`,
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

export function createSupabaseV2AdapterFromConnection(connection, options = {}) {
  if (connection?.provider !== PROVIDER || connection.status !== 'ready') {
    throw new Error('A verified Supabase ProviderConnection with status ready is required.');
  }
  const authRefs = Object.fromEntries(Object.entries(connection.secretRefs || {})
    .filter(([name]) => ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_OAUTH_ACCESS_TOKEN'].includes(name)));
  const values = resolveConnectionSecretRefs({ ...connection, secretRefs: authRefs }, {
    env: options.env,
    purpose: 'Supabase adapter',
  });
  const token = values.SUPABASE_ACCESS_TOKEN || values.SUPABASE_OAUTH_ACCESS_TOKEN;
  if (!token) throw new Error('Supabase provisioning requires a PAT or OAuth access token.');
  return new SupabaseV2Adapter({
    token,
    transport: options.transport,
    httpOptions: options.httpOptions,
    secretSource: options.secretSource || createEnvSecretSource(options.env || process.env),
    secretSink: options.secretSink,
  });
}

function validateProjectRead(input) {
  if (!input?.appId || !input.logicalId || !PROJECT_REF.test(input.projectRef || '')) {
    return validationError('Supabase Project Read requires appId, logicalId, and a 20-letter Project Ref.');
  }
  return null;
}

function validateProjectPlan(input) {
  if (
    !input?.appId || !input.logicalId || !SAFE_NAME.test(input.name || '') ||
    !ORG_SLUG.test(input.organizationSlug || '') || !REGION_TYPES.has(input.regionType) ||
    !isRegionCode(input.regionType, input.regionCode) || !INSTANCE_SIZES.has(input.instanceSize) ||
    !PASSWORD_SOURCE.test(input.databasePasswordRef || '') ||
    !SECRET_DESTINATION.test(input.connectionDestinationSecretRef || '')
  ) return validationError('Supabase Project plan requires valid identity, organization, live region selection, instance size, password Secret Ref, and connection destination.');
  if (input.databasePasswordRef === input.connectionDestinationSecretRef) {
    return validationError('Supabase database password and connection URI must use different Secret Refs.');
  }
  return null;
}

function validatePoll(input) {
  if (
    !input?.appId || !PROJECT_REF.test(input.projectRef || '') ||
    (input.projectName && !SAFE_NAME.test(input.projectName)) ||
    (input.organizationSlug && !ORG_SLUG.test(input.organizationSlug)) ||
    !validRequiredServices(input.requiredServices) ||
    (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 10000))
  ) return validationError('Supabase Project Poll/Catalog requires exact project identity, valid service names, and timeout up to 10000ms.');
  return null;
}

function validateConnectionCapture(input) {
  if (
    !input?.appId || !PROJECT_REF.test(input.projectRef || '') || !SAFE_NAME.test(input.projectName || '') ||
    !ORG_SLUG.test(input.organizationSlug || '') || !PASSWORD_SOURCE.test(input.databasePasswordRef || '') ||
    !SECRET_DESTINATION.test(input.destinationSecretRef || '') || input.databasePasswordRef === input.destinationSecretRef
  ) return validationError('Supabase connection capture requires exact Project identity and separate password source/connection destination Secret Refs.');
  return null;
}

function validateRuntimeCredentials(input) {
  if (
    !input?.appId || !PROJECT_REF.test(input.projectRef || '') || !SAFE_NAME.test(input.projectName || '') ||
    !ORG_SLUG.test(input.organizationSlug || '') || !KEY_NAME.test(input.keyName || '') ||
    !SECRET_DESTINATION.test(input.destinationSecretRef || '')
  ) return validationError('Supabase runtime credentials require exact Project identity, API Key name, and bundle destination Secret Ref.');
  return null;
}

function validateCostGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    input.allowCostMutations !== true || !SHA256.test(input.planFingerprint || '') ||
    !SHA256.test(input.approvalFingerprint || '')
  ) return approvalError('Supabase Project creation requires execute, yes, provider-mutation, cost-mutation, plan, and approval gates.');
  return null;
}

function validateSecretReadGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowSecretRead !== true ||
    !SHA256.test(input.planFingerprint || '') || !SHA256.test(input.approvalFingerprint || '')
  ) return approvalError('Supabase connection capture requires execute, yes, secret-read, plan, and approval gates.');
  return null;
}

function validateRuntimeCredentialGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    input.allowSecretRead !== true || !SHA256.test(input.planFingerprint || '') ||
    !SHA256.test(input.approvalFingerprint || '')
  ) return approvalError('Supabase runtime credential ensure requires execute, yes, provider-mutation, secret-read, plan, and approval gates.');
  return null;
}

function normalizeOrganization(data, expectedSlug, organizationList) {
  const responseSlug = typeof data?.slug === 'string' ? data.slug : '';
  if (!responseSlug && organizationList === undefined) return { needsListBinding: true };

  let listed = null;
  if (!responseSlug) {
    if (!Array.isArray(organizationList)) {
      return { error: providerResponseError('Supabase Organization listing is not an array.') };
    }
    const matches = organizationList.filter((entry) => entry?.slug === expectedSlug);
    if (matches.length !== 1) {
      return { error: conflictError('Supabase Organization listing does not contain exactly one approved slug.') };
    }
    listed = matches[0];
  }

  const organization = {
    id: typeof data?.id === 'string' && SAFE_ID.test(data.id) ? data.id : '',
    slug: responseSlug || String(listed?.slug || ''),
    name: String(data?.name || ''),
    plan: typeof data?.plan === 'string' ? data.plan : '',
  };
  if (
    !organization.id || !ORG_SLUG.test(organization.slug) || organization.slug !== expectedSlug ||
    !isSafeOrganizationName(organization.name) || !ORGANIZATION_PLANS.has(organization.plan) ||
    (listed && (
      listed.id !== organization.id || listed.name !== organization.name ||
      !SAFE_ID.test(String(listed.id || '')) || !isSafeOrganizationName(String(listed.name || ''))
    ))
  ) {
    return { error: conflictError('Supabase Organization response differs from the approved slug or has invalid identity.') };
  }
  return { organization };
}

function isSafeOrganizationName(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeProject(data, input, lifecycle) {
  const source = data && typeof data === 'object' ? data : {};
  const ref = String(source.ref || '');
  const name = String(source.name || '');
  const organizationSlug = String(source.organization_slug || input.organizationSlug || '');
  const status = String(source.status || '').toUpperCase();
  if (!PROJECT_REF.test(ref) || !SAFE_NAME.test(name) || !ORG_SLUG.test(organizationSlug) || !status) {
    return { error: providerResponseError('Supabase Project response has invalid identity or status.') };
  }
  if (input.projectRef && ref !== input.projectRef) return { error: conflictError('Supabase Project Ref differs from the approved identity.') };
  if ((input.name || input.projectName) && name !== (input.name || input.projectName)) return { error: conflictError('Supabase Project name differs from the approved identity.') };
  if (input.organizationSlug && organizationSlug !== input.organizationSlug) return { error: conflictError('Supabase Project organization differs from the approved identity.') };
  if (input.regionType === 'specific' && source.region && source.region !== input.regionCode) {
    return { error: conflictError('Supabase Project region differs from the approved specific region.') };
  }
  return {
    resource: {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: ref,
      type: 'database.project',
      name,
      lifecycle,
      version: 1,
      attributes: {
        organizationSlug,
        region: typeof source.region === 'string' ? source.region : '',
        status,
        createdAt: typeof source.created_at === 'string' ? source.created_at : (typeof source.inserted_at === 'string' ? source.inserted_at : ''),
        database: {
          version: typeof source.database?.version === 'string' ? source.database.version : '',
          postgresEngine: typeof source.database?.postgres_engine === 'string' ? source.database.postgres_engine : '',
          releaseChannel: typeof source.database?.release_channel === 'string' ? source.database.release_channel : '',
        },
      },
    },
  };
}

function normalizeHealth(data, requiredServices) {
  if (!Array.isArray(data)) return { error: providerResponseError('Supabase service health response is not an array.') };
  const services = [];
  const names = new Set();
  for (const item of data) {
    const name = String(item?.name || '');
    const status = String(item?.status || '').toUpperCase();
    if (!SERVICE_NAMES.has(name) || !['COMING_UP', 'ACTIVE_HEALTHY', 'UNHEALTHY'].includes(status) || names.has(name)) {
      return { error: providerResponseError('Supabase service health response contains invalid or duplicate services.') };
    }
    names.add(name);
    services.push({ name, status });
  }
  if (requiredServices.some((name) => !names.has(name))) return { error: providerResponseError('Supabase service health response omitted a required service.') };
  services.sort((left, right) => left.name.localeCompare(right.name));
  return { services };
}

function normalizeApiKey(data, reveal) {
  const type = String(data?.type || '');
  const name = String(data?.name || '');
  const id = data?.id == null ? '' : String(data.id);
  if (!['legacy', 'publishable', 'secret'].includes(type) || !name || (id && !SAFE_ID.test(id))) {
    return { error: providerResponseError('Supabase API Key response has invalid metadata.') };
  }
  const apiKey = reveal && typeof data?.api_key === 'string' ? data.api_key : '';
  return {
    key: {
      id,
      type,
      name,
      apiKey,
      insertedAt: typeof data?.inserted_at === 'string' ? data.inserted_at : '',
      updatedAt: typeof data?.updated_at === 'string' ? data.updated_at : '',
    },
  };
}

function selectApiKey(keys, type, name) {
  const matches = keys.filter((key) => key.type === type && key.name === name);
  if (matches.length > 1) return { conflict: conflictError(`Multiple exact Supabase ${type} API Keys match the requested name.`) };
  return { key: matches[0] || null };
}

function safeApiKeyMetadata(key) {
  return {
    ...(key.id ? { id: key.id } : {}),
    type: key.type,
    name: key.name,
    insertedAt: key.insertedAt,
    updatedAt: key.updatedAt,
  };
}

function projectPlanSummary(input) {
  return {
    name: input.name,
    organizationSlug: input.organizationSlug,
    regionSelection: { type: input.regionType, code: input.regionCode },
    instanceSize: input.instanceSize,
    highAvailability: false,
  };
}

function projectPlanFingerprint(input) {
  return sha256(JSON.stringify({
    project: projectPlanSummary(input),
    databasePasswordRef: input.databasePasswordRef,
    connectionDestinationSecretRef: input.connectionDestinationSecretRef,
  }));
}

function connectionCaptureFingerprint(input) {
  return sha256(JSON.stringify({
    projectRef: input.projectRef,
    projectName: input.projectName,
    organizationSlug: input.organizationSlug,
    databasePasswordRef: input.databasePasswordRef,
    destinationSecretRef: input.destinationSecretRef,
  }));
}

function runtimeCredentialsFingerprint(input) {
  return sha256(JSON.stringify({
    projectRef: input.projectRef,
    projectName: input.projectName,
    organizationSlug: input.organizationSlug,
    keyName: input.keyName,
    destinationSecretRef: input.destinationSecretRef,
    keyTypes: ['publishable', 'secret'],
  }));
}

function validRequiredServices(value) {
  return value === undefined || (
    Array.isArray(value) && value.length > 0 && value.every((service) => SERVICE_NAMES.has(service)) &&
    new Set(value).size === value.length
  );
}

function normalizeRequiredServices(value) {
  return [...(value || ['auth', 'db', 'pooler', 'rest', 'storage'])].sort();
}

function isRegionCode(type, code) {
  if (type === 'smartGroup') return ['americas', 'emea', 'apac'].includes(code);
  return typeof code === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(code);
}

function isStrongDatabasePassword(value) {
  return typeof value === 'string' && value.length >= 24 && value.length <= 128 &&
    !/[\s\u0000-\u001f\u007f]/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

function isHostname(value) {
  return typeof value === 'string' && value.length <= 253 && value.split('.').length >= 2 &&
    value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function isApiKeyValue(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function sanitizeResponse(response, token, mutation, secretValues = []) {
  return {
    ok: response.ok === true,
    status: Number(response.status || 0),
    code: response.code,
    message: sanitizeText(response.message || '', token, secretValues),
    retryAfter: response.retryAfter,
    resourceId: response.resourceId,
    uncertain: response.uncertain === true || (mutation && Number(response.status || 0) >= 500),
    data: response.ok && response.data && typeof response.data === 'object' ? response.data : {},
  };
}

function sanitizeText(value, token, secretValues = []) {
  let text = String(value || '')
    .replace(/Authorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]')
    .replace(/(?:sbp_|sb_publishable_|sb_secret_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
  if (token) text = text.split(token).join('[redacted]');
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}

function isUncertainMutation(response) {
  return response.uncertain === true || [409, 429].includes(response.status) || response.status >= 500;
}

function clearSecretBody(body) {
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'db_pass')) body.db_pass = '[cleared]';
}

function createEnvSecretSource(env) {
  return {
    async read(ref) {
      if (!ref.startsWith('env://')) throw new Error('Only env Secret Refs are available without an injected Secret Source.');
      const name = ref.slice('env://'.length);
      if (!env[name]) throw new Error('Environment Secret Ref is missing.');
      return { ref, value: env[name] };
    },
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function invalidProviderResponse(message) {
  return { ok: false, status: 422, code: 'PROVIDER_RESPONSE_INVALID', message, data: {} };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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
