import { createHash } from 'node:crypto';

import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from '../provider-contract.js';
import { createProviderHttpTransport } from '../provider-http.js';
import { resolveConnectionSecretRefs } from '../secret-ref.js';

const PROVIDER = 'railway';
const API_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRET_REF = /^env:\/\/[A-Z][A-Z0-9_]*$/;
const PRODUCTION_NAMES = new Set(['prod', 'production', 'live']);
const WAITING_DEPLOYMENT_STATES = new Set([
  'BUILDING', 'DEPLOYING', 'INITIALIZING', 'WAITING', 'QUEUED', 'REMOVING',
]);
const TERMINAL_DEPLOYMENT_STATES = new Set([
  'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED', 'CANCELED', 'CANCELLED',
]);

const QUERIES = Object.freeze({
  projectTokenScope: `query projectTokenScope {
  projectToken { projectId environmentId }
}`,
  projects: `query agentmeshProjects($workspaceId: String) {
  projects(workspaceId: $workspaceId) {
    edges { node { id name description createdAt updatedAt } }
  }
}`,
  project: `query agentmeshProject($id: String!) {
  project(id: $id) {
    id name description createdAt updatedAt
    services { edges { node { id name icon } } }
    environments { edges { node { id name } } }
  }
}`,
  projectCreate: `mutation agentmeshProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) { id name }
}`,
  environments: `query agentmeshEnvironments($projectId: String!) {
  environments(projectId: $projectId, isEphemeral: false) {
    edges { node { id name createdAt } }
  }
}`,
  environmentCreate: `mutation agentmeshEnvironmentCreate($input: EnvironmentCreateInput!) {
  environmentCreate(input: $input) { id name }
}`,
  environment: `query agentmeshEnvironment($id: String!) {
  environment(id: $id) { id name createdAt }
}`,
  serviceCreate: `mutation agentmeshServiceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) { id name }
}`,
  serviceInstance: `query agentmeshServiceInstance($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    id serviceName source { repo image } latestDeployment { id status createdAt }
    service {
      id name
      repoTriggers {
        edges { node { id branch environmentId projectId provider repository serviceId } }
      }
    }
  }
}`,
  domains: `query agentmeshDomains($environmentId: String!, $projectId: String!, $serviceId: String!) {
  domains(environmentId: $environmentId, projectId: $projectId, serviceId: $serviceId) {
    serviceDomains { id domain suffix environmentId serviceId targetPort syncStatus createdAt updatedAt }
  }
}`,
  serviceDomainCreate: `mutation agentmeshServiceDomainCreate($environmentId: String!, $serviceId: String!) {
  serviceDomainCreate(input: { environmentId: $environmentId, serviceId: $serviceId }) {
    id domain suffix environmentId serviceId targetPort syncStatus createdAt updatedAt
  }
}`,
  deployments: `query agentmeshDeployments($input: DeploymentListInput!, $first: Int) {
  deployments(input: $input, first: $first) {
    edges { node { id status createdAt url staticUrl meta } }
  }
}`,
  deployment: `query agentmeshDeployment($id: String!) {
  deployment(id: $id) { id status createdAt url staticUrl meta }
}`,
  deployCommit: `mutation agentmeshDeployCommit($serviceId: String!, $environmentId: String!, $commitSha: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
}`,
  variablesUpsert: `mutation agentmeshVariablesUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`,
});

export class RailwayV2Adapter {
  #token;
  #tokenType;
  #scope;
  #transport;

  constructor(options = {}) {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('Railway token is required.');
    if (!['api', 'project'].includes(options.tokenType)) throw new Error('Railway tokenType must be api or project.');
    this.#token = options.token;
    this.#tokenType = options.tokenType;
    this.#scope = normalizeScope(options.scope || {});
    this.#transport = options.transport || createProviderHttpTransport(options.httpOptions);
  }

  async readProjectTokenScope(input) {
    const operation = 'railway.token.read-scope';
    if (!input?.appId) return this.#failure(operation, input?.appId || '', validationError('appId is required.'), input || {});
    if (this.#tokenType !== 'project') {
      return this.#failure(operation, input.appId, capabilityError('Project token scope is only available for a Railway Project Token.'), input);
    }
    const response = await this.#graphql('projectTokenScope', QUERIES.projectTokenScope, {}, false);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const scope = normalizeScope(response.data?.projectToken || {});
    if (!scope.projectId || !scope.environmentId) {
      return this.#failure(operation, input.appId, providerResponseError('Railway projectToken response is missing projectId or environmentId.'), input);
    }
    if (this.#scope.projectId && !sameScope(this.#scope, scope)) {
      return this.#failure(operation, input.appId, conflictError('Railway Project Token scope differs from the verified connection scope.'), input);
    }
    return this.#success(operation, input.appId, { scope }, input);
  }

  async readProject(input) {
    const operation = 'railway.project.read';
    const invalid = validateProjectRead(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const access = this.#requireApiToken(operation, input);
    if (access) return access;
    const response = await this.#graphql('agentmeshProject', QUERIES.project, { id: input.projectId }, false);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const normalized = normalizeProject(response.data?.project, input, input.lifecycle || 'external');
    if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
    return this.#success(operation, input.appId, {
      resource: normalized.resource,
      observedAt: input.now || new Date().toISOString(),
    }, input);
  }

  async ensureProject(input) {
    const operation = 'railway.project.ensure';
    const invalid = validateProjectEnsure(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const access = this.#requireApiToken(operation, input);
    if (access) return access;

    const existing = await this.#findProjectByName(input);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.project) return this.#projectResult(operation, input, existing.project, false);

    const createInput = { name: input.name };
    if (input.workspaceId) createInput.workspaceId = input.workspaceId;
    if (input.description) createInput.description = input.description;
    if (input.defaultEnvironmentName) createInput.defaultEnvironmentName = input.defaultEnvironmentName;
    const created = await this.#graphql('agentmeshProjectCreate', QUERIES.projectCreate, { input: createInput }, true);
    if (created.ok) return this.#projectResult(operation, input, created.data?.projectCreate, true);

    if (isUncertainMutation(created)) {
      const recovered = await this.#findProjectByName(input);
      if (recovered.project && !recovered.conflict) {
        return this.#projectResult(operation, input, recovered.project, true, true);
      }
      if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
    }
    return this.#providerFailure(operation, input.appId, created, input);
  }

  async ensureEnvironment(input) {
    const operation = 'railway.environment.ensure';
    const invalid = validateEnvironmentEnsure(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const access = this.#requireApiToken(operation, input);
    if (access) return access;

    const existing = await this.#findEnvironmentByName(input);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.environment) return this.#environmentResult(operation, input, existing.environment, false);

    const created = await this.#graphql('agentmeshEnvironmentCreate', QUERIES.environmentCreate, {
      input: {
        projectId: input.projectId,
        name: input.name,
        skipInitialDeploys: true,
        stageInitialChanges: true,
      },
    }, true);
    if (created.ok) return this.#environmentResult(operation, input, created.data?.environmentCreate, true);

    if (isUncertainMutation(created)) {
      const recovered = await this.#findEnvironmentByName(input);
      if (recovered.environment && !recovered.conflict) {
        return this.#environmentResult(operation, input, recovered.environment, true, true);
      }
      if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
    }
    return this.#providerFailure(operation, input.appId, created, input);
  }

  async ensureService(input) {
    const operation = 'railway.service.ensure';
    const invalid = validateServiceEnsure(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const access = this.#requireApiToken(operation, input);
    if (access) return access;

    const existing = await this.#findServiceByName(input);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.service) return this.#serviceResult(operation, input, existing.service, false);

    const created = await this.#graphql('agentmeshServiceCreate', QUERIES.serviceCreate, {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        name: input.name,
        source: { repo: input.repository },
        branch: input.branch,
      },
    }, true);
    if (created.ok) return this.#serviceResult(operation, input, created.data?.serviceCreate, true);

    if (isUncertainMutation(created)) {
      const recovered = await this.#findServiceByName(input);
      if (recovered.service && !recovered.conflict) {
        return this.#serviceResult(operation, input, recovered.service, true, true);
      }
      if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
    }
    return this.#providerFailure(operation, input.appId, created, input);
  }

  async ensureServiceDomain(input) {
    const operation = 'railway.service-domain.ensure';
    const invalid = validateServiceDomainEnsure(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#validateScopedOperation(input);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);

    const existing = await this.#findServiceDomain(input);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.domain) return this.#serviceDomainResult(operation, input, existing.domain, false);

    const created = await this.#graphql('agentmeshServiceDomainCreate', QUERIES.serviceDomainCreate, {
      environmentId: input.environmentId,
      serviceId: input.serviceId,
    }, true);
    if (created.ok) {
      const result = this.#serviceDomainResult(operation, input, created.data?.serviceDomainCreate, true);
      if (result.ok) return result;
    } else if (!isUncertainMutation(created)) {
      return this.#providerFailure(operation, input.appId, created, input);
    }

    const recovered = await this.#findServiceDomain(input);
    if (recovered.domain && !recovered.conflict) {
      return this.#serviceDomainResult(operation, input, recovered.domain, true, true);
    }
    if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input, {
      data: { providerMutationsExecuted: 1, duplicateCreatePrevented: true },
    });
    return this.#failure(operation, input.appId, {
      code: 'RECONCILIATION_REQUIRED',
      message: 'Railway may have created the Service Domain, but no unique matching domain was observable; automatic retry is disabled.',
      retryable: false,
      provider: PROVIDER,
    }, input, {
      data: { providerMutationsExecuted: 1, duplicateCreatePrevented: true },
      nextActions: ['Inspect Railway Service networking and record the generated domain before any retry.'],
    });
  }

  planVariables(input) {
    const operation = 'railway.variables.plan';
    const invalid = validateVariablePlan(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#validateScopedOperation(input);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const variables = Object.entries(input.secretRefs).sort(([left], [right]) => left.localeCompare(right));
    const planFingerprint = sha256(JSON.stringify({
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      secretRefs: Object.fromEntries(variables),
      replace: false,
      skipDeploys: true,
    }));
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      variables: variables.map(([name, ref]) => ({ name, source: ref.split('://')[0] })),
      replace: false,
      skipDeploys: true,
      planFingerprint,
      providerMutationsExecuted: 0,
      providerVariableReadExecuted: false,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve the immutable variable plan before resolving Secret Refs at execution time.'],
    });
  }

  async executeVariablePlan(input) {
    const operation = 'railway.variables.upsert';
    const invalid = validateVariablePlan(input) || validateVariableExecutionGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const scopeError = this.#validateScopedOperation(input);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    const expectedPlan = this.planVariables(input);
    if (!expectedPlan.ok || expectedPlan.data.planFingerprint !== input.planFingerprint) {
      return this.#failure(operation, input.appId, conflictError('Railway variable plan fingerprint does not match the approved plan.'), input);
    }

    let values;
    try {
      values = resolveRuntimeSecretRefs(input.secretRefs, input.env || process.env);
    } catch (error) {
      return this.#failure(operation, input.appId, credentialError(error.message), input);
    }
    const response = await this.#graphql('agentmeshVariablesUpsert', QUERIES.variablesUpsert, {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        variables: values,
        replace: false,
        skipDeploys: true,
      },
    }, true);
    if (!response.ok) {
      const mapped = mapProviderError(PROVIDER, sanitizeResponse(response, this.#token));
      if (response.uncertain) {
        mapped.code = 'PROVIDER_UNAVAILABLE';
        mapped.retryable = true;
        mapped.message = 'Railway variable Upsert response was uncertain; replaying the same immutable plan is safe.';
      }
      return this.#failure(operation, input.appId, mapped, input, {
        data: {
          variableNames: Object.keys(input.secretRefs).sort(),
          replace: false,
          skipDeploys: true,
          safeToRetrySamePlan: response.uncertain === true,
          providerVariableReadExecuted: false,
          secretValuesExposed: false,
        },
      });
    }
    return this.#success(operation, input.appId, {
      variableNames: Object.keys(input.secretRefs).sort(),
      replace: false,
      skipDeploys: true,
      providerMutationsExecuted: 1,
      providerVariableReadExecuted: false,
      secretValuesExposed: false,
    }, input);
  }

  planCandidateDeployment(input) {
    const operation = 'railway.deployment.plan-candidate';
    const invalid = validateCandidate(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const scopeError = this.#validateScopedOperation(input);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      environmentClass: 'candidate',
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      repository: input.repository,
      branch: input.branch,
      commitSha: input.commitSha,
      connectedRepositoryVerified: true,
      sourceConnectionCreated: input.sourceConnectionCreated,
      planFingerprint: candidatePlanFingerprint(input),
      providerMutationsExecuted: 0,
      productionEnvironmentRejected: true,
    }, input, {
      status: 'planned',
      nextActions: ['Approve the locked commit candidate deployment before provider execution.'],
    });
  }

  async executeCandidateDeployment(input) {
    const operation = 'railway.deployment.create-candidate';
    const invalid = validateCandidate(input) || validateCandidateExecutionGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const scopeError = this.#validateScopedOperation(input);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    if (input.planFingerprint !== candidatePlanFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Railway candidate plan fingerprint does not match the approved plan.'), input);
    }

    const environment = await this.#graphql('agentmeshEnvironment', QUERIES.environment, {
      id: input.environmentId,
    }, false);
    if (!environment.ok) return this.#providerFailure(operation, input.appId, environment, input);
    const observedEnvironment = environment.data?.environment;
    if (
      observedEnvironment?.id !== input.environmentId || observedEnvironment.name !== input.environmentName ||
      PRODUCTION_NAMES.has(String(observedEnvironment.name || '').toLowerCase())
    ) {
      return this.#failure(operation, input.appId, {
        code: 'PRODUCTION_TARGET_VIOLATION',
        message: 'Railway provider state does not confirm the approved non-production candidate environment.',
        retryable: false,
        provider: PROVIDER,
      }, input);
    }

    const instance = await this.#graphql('agentmeshServiceInstance', QUERIES.serviceInstance, {
      serviceId: input.serviceId,
      environmentId: input.environmentId,
    }, false);
    if (!instance.ok) return this.#providerFailure(operation, input.appId, instance, input);
    const observedInstance = instance.data?.serviceInstance;
    if (!observedInstance?.id || observedInstance.serviceName !== input.serviceName) {
      return this.#failure(operation, input.appId, conflictError('Railway service instance identity does not match the approved candidate plan.'), input);
    }
    const sourceConflict = validateObservedServiceSource(observedInstance, input);
    if (sourceConflict) return this.#failure(operation, input.appId, sourceConflict, input);

    const prior = await this.#findDeploymentByCommit(input);
    if (prior.error) return this.#providerFailure(operation, input.appId, prior.error, input);
    if (prior.conflict) return this.#failure(operation, input.appId, prior.conflict, input);
    if (prior.deployment) return this.#deploymentResult(operation, input, prior.deployment, {
      created: false,
      adopted: true,
      recoveredAfterUncertainCreate: false,
      providerMutationsExecuted: 0,
    });

    if (input.sourceConnectionCreated === true) {
      return this.#success(operation, input.appId, {
        deployment: { id: '', status: 'WAITING', commitSha: input.commitSha.toLowerCase() },
        created: true,
        adopted: false,
        recoveredAfterUncertainCreate: false,
        providerMutationsExecuted: 0,
      }, input, {
        status: 'waiting-external',
        nextActions: ['Poll for the initial source-connected deployment by the locked Commit before any explicit deploy mutation.'],
      });
    }

    const created = await this.#graphql('agentmeshDeployCommit', QUERIES.deployCommit, {
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      commitSha: input.commitSha,
    }, true);
    if (created.ok) {
      const deploymentId = created.data?.serviceInstanceDeployV2;
      if (!SAFE_ID.test(deploymentId || '')) {
        return this.#failure(operation, input.appId, providerResponseError('Railway deployment mutation did not return a valid deployment ID.'), input);
      }
      return this.#success(operation, input.appId, {
        deployment: {
          id: deploymentId,
          status: 'QUEUED',
          ...(normalizeRailwayCandidateUrl(input.publicUrl) ? { url: normalizeRailwayCandidateUrl(input.publicUrl) } : {}),
        },
        created: true,
        adopted: false,
        recoveredAfterUncertainCreate: false,
        providerMutationsExecuted: 1,
      }, input, {
        status: 'waiting-external',
        nextActions: ['Poll the Railway candidate deployment by its returned deployment ID.'],
      });
    }

    if (isUncertainMutation(created)) {
      const recovered = await this.#findDeploymentByCommit(input);
      if (recovered.deployment && !recovered.conflict) {
        return this.#deploymentResult(operation, input, recovered.deployment, {
          created: true,
          adopted: false,
          recoveredAfterUncertainCreate: true,
          providerMutationsExecuted: 1,
        });
      }
      if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
      return this.#failure(operation, input.appId, {
        code: 'RECONCILIATION_REQUIRED',
        message: 'Railway may have accepted the deployment, but no unique commit match was observable; automatic retry is disabled.',
        retryable: false,
        provider: PROVIDER,
      }, input, {
        data: { providerMutationsExecuted: 1, duplicateCreatePrevented: true },
        nextActions: ['Inspect Railway deployment history and record the deployment ID before any retry.'],
      });
    }
    return this.#providerFailure(operation, input.appId, created, input);
  }

  async pollDeployment(input) {
    const operation = 'railway.deployment.poll';
    if (!input?.appId) {
      return this.#failure(operation, input?.appId || '', validationError('appId is required.'), input || {});
    }
    const scopeError = this.#validateScopedOperation(input);
    if (scopeError) return this.#failure(operation, input.appId, scopeError, input);
    if (!input.deploymentId) {
      if (!SAFE_ID.test(input.projectId || '') || !SAFE_ID.test(input.environmentId || '') ||
          !SAFE_ID.test(input.serviceId || '') || !GIT_COMMIT.test(input.commitSha || '')) {
        return this.#failure(
          operation,
          input.appId,
          validationError('Commit-based deployment Poll requires projectId, environmentId, serviceId, and commitSha.'),
          input
        );
      }
      const observed = await this.#findDeploymentByCommit(input);
      if (observed.error) return this.#providerFailure(operation, input.appId, observed.error, input);
      if (observed.conflict) return this.#failure(operation, input.appId, observed.conflict, input);
      if (!observed.deployment) {
        return this.#success(operation, input.appId, {
          deployment: { id: '', status: 'WAITING', commitSha: input.commitSha.toLowerCase() },
          providerMutationsExecuted: 0,
        }, input, {
          status: 'waiting-external',
          nextActions: ['Poll for the Railway deployment matching the locked Commit again after nextPollAt.'],
        });
      }
      return this.#deploymentResult(operation, input, observed.deployment, { providerMutationsExecuted: 0 });
    }
    if (!SAFE_ID.test(input.deploymentId)) {
      return this.#failure(operation, input.appId, validationError('deploymentId is invalid.'), input);
    }
    const response = await this.#graphql('agentmeshDeployment', QUERIES.deployment, { id: input.deploymentId }, false);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const deployment = normalizeDeployment(response.data?.deployment);
    if (!deployment.id || !deployment.status) {
      return this.#failure(operation, input.appId, providerResponseError('Railway deployment response is missing id or status.'), input);
    }
    return this.#deploymentResult(operation, input, deployment, {});
  }

  deleteProject(input) {
    return this.#deleteDisabled('railway.project.delete', input, 'project and all nested services, environments, deployments, and settings');
  }

  deleteEnvironment(input) {
    return this.#deleteDisabled('railway.environment.delete', input, 'environment and all of its deployments');
  }

  deleteService(input) {
    return this.#deleteDisabled('railway.service.delete', input, 'service and all of its deployments');
  }

  deleteServiceDomain(input) {
    return this.#deleteDisabled('railway.service-domain.delete', input, 'public Service Domain');
  }

  deleteVariable(input) {
    return this.#deleteDisabled('railway.variable.delete', input, 'variable without a non-secret metadata-only read contract');
  }

  async #findProjectByName(input) {
    const response = await this.#graphql('agentmeshProjects', QUERIES.projects, {
      workspaceId: input.workspaceId || null,
    }, false);
    if (!response.ok) return { error: response };
    return exactMatch(edges(response.data?.projects), input.name, 'Railway projects');
  }

  async #findEnvironmentByName(input) {
    const response = await this.#graphql('agentmeshEnvironments', QUERIES.environments, {
      projectId: input.projectId,
    }, false);
    if (!response.ok) return { error: response };
    const match = exactMatch(edges(response.data?.environments), input.name, 'Railway environments');
    return { error: match.error, conflict: match.conflict, environment: match.project };
  }

  async #findServiceByName(input) {
    const response = await this.#graphql('agentmeshProject', QUERIES.project, { id: input.projectId }, false);
    if (!response.ok) return { error: response };
    if (response.data?.project?.id !== input.projectId) {
      return { conflict: conflictError('Railway returned a different project while resolving the service.') };
    }
    const match = exactMatch(edges(response.data.project.services), input.name, 'Railway services');
    return { error: match.error, conflict: match.conflict, service: match.project };
  }

  async #findServiceDomain(input) {
    const response = await this.#graphql('agentmeshDomains', QUERIES.domains, {
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
    }, false);
    if (!response.ok) return { error: response };
    const domains = response.data?.domains?.serviceDomains;
    if (!Array.isArray(domains)) {
      return { error: invalidProviderResponse('Railway domains response is missing serviceDomains.') };
    }
    const normalized = domains.map((domain) => normalizeServiceDomain(domain, input));
    const invalid = normalized.find((item) => item.error);
    if (invalid) return { error: invalidProviderResponse(invalid.error.message) };
    if (normalized.length > 1) {
      return { conflict: conflictError('Multiple Railway Service Domains match the approved service and environment.') };
    }
    return { domain: normalized[0]?.domain || null };
  }

  async #findDeploymentByCommit(input) {
    const response = await this.#graphql('agentmeshDeployments', QUERIES.deployments, {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
      },
      first: 20,
    }, false);
    if (!response.ok) return { error: response };
    const matches = edges(response.data?.deployments)
      .map(normalizeDeployment)
      .filter((deployment) => deployment.commitSha === input.commitSha.toLowerCase());
    if (matches.length > 1) {
      return { conflict: conflictError('Multiple Railway deployments match the approved immutable commit.') };
    }
    return { deployment: matches[0] || null };
  }

  #projectResult(operation, input, data, created, recoveredAfterUncertainCreate = false) {
    const lifecycle = created ? 'managed' : (input.knownProviderId ? 'managed' : 'adopted');
    const normalized = normalizeProject(data, input, lifecycle);
    if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
    const conflict = knownIdentityConflict(input.knownProviderId, normalized.resource.providerId, 'project');
    if (conflict) return this.#failure(operation, input.appId, conflict, input);
    return this.#success(operation, input.appId, {
      resource: normalized.resource,
      created,
      adopted: !created && !input.knownProviderId,
      changed: created,
      recoveredAfterUncertainCreate,
      idempotency: 'read-before-create',
    }, input);
  }

  #environmentResult(operation, input, data, created, recoveredAfterUncertainCreate = false) {
    const normalized = normalizeEnvironment(data, input, created ? 'managed' : (input.knownProviderId ? 'managed' : 'adopted'));
    if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
    const conflict = knownIdentityConflict(input.knownProviderId, normalized.resource.providerId, 'environment');
    if (conflict) return this.#failure(operation, input.appId, conflict, input);
    return this.#success(operation, input.appId, {
      resource: normalized.resource,
      created,
      adopted: !created && !input.knownProviderId,
      changed: created,
      recoveredAfterUncertainCreate,
      idempotency: 'read-before-create',
      initialDeploysSkipped: true,
    }, input);
  }

  async #serviceResult(operation, input, data, created, recoveredAfterUncertainCreate = false) {
    const normalized = normalizeService(data, input, created ? 'managed' : (input.knownProviderId ? 'managed' : 'adopted'));
    if (normalized.error) {
      return this.#failure(operation, input.appId, normalized.error, input, {
        data: { created, changed: created, providerMutationsExecuted: created ? 1 : 0 },
      });
    }
    const resultData = {
      resource: normalized.resource,
      created,
      adopted: !created && !input.knownProviderId,
      changed: created,
      recoveredAfterUncertainCreate,
      idempotency: 'read-before-create',
      sourceConnected: false,
      sourceRepository: input.repository,
      sourceBranch: input.branch,
      environmentId: input.environmentId,
      initialVariablesWritten: false,
      providerMutationsExecuted: created ? 1 : 0,
    };
    const conflict = knownIdentityConflict(input.knownProviderId, normalized.resource.providerId, 'service');
    if (conflict) return this.#failure(operation, input.appId, conflict, input, { data: resultData });
    const observed = await this.#graphql('agentmeshServiceInstance', QUERIES.serviceInstance, {
      serviceId: normalized.resource.providerId,
      environmentId: input.environmentId,
    }, false);
    if (!observed.ok) return this.#providerFailure(operation, input.appId, observed, input, { data: resultData });
    const instance = observed.data?.serviceInstance;
    if (!instance?.id || instance.serviceName !== input.name) {
      const error = created
        ? providerUnavailableError('Railway has not exposed the newly created candidate-environment Service instance yet.')
        : conflictError('Railway did not return the expected candidate-environment Service instance.');
      return this.#failure(
        operation,
        input.appId,
        error,
        input,
        { data: resultData }
      );
    }
    const sourceConflict = validateObservedServiceSource(instance, {
      ...input,
      serviceId: normalized.resource.providerId,
    });
    if (sourceConflict) {
      return this.#failure(operation, input.appId, sourceConflict, input, {
        data: resultData,
        nextActions: sourceConflict.retryable
          ? ['Retry Service Ensure; read-before-create will adopt the exact Service without creating a duplicate.']
          : [],
      });
    }
    return this.#success(operation, input.appId, {
      ...resultData,
      sourceConnected: true,
    }, input);
  }

  #serviceDomainResult(operation, input, data, created, recoveredAfterUncertainCreate = false) {
    const normalized = normalizeServiceDomain(data, input);
    if (normalized.error) {
      return this.#failure(operation, input.appId, normalized.error, input, {
        data: { created, changed: created, providerMutationsExecuted: created ? 1 : 0 },
      });
    }
    const lifecycle = created ? 'managed' : (input.knownProviderId ? 'managed' : 'adopted');
    const resource = {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: normalized.domain.id,
      type: 'runtime.service-domain',
      name: normalized.domain.domain,
      lifecycle,
      version: 1,
      attributes: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        ...pickScalars(normalized.domain, ['suffix', 'targetPort', 'syncStatus', 'createdAt', 'updatedAt']),
      },
    };
    const conflict = knownIdentityConflict(input.knownProviderId, resource.providerId, 'Service Domain');
    if (conflict) return this.#failure(operation, input.appId, conflict, input, {
      data: { resource, created, changed: created, providerMutationsExecuted: created ? 1 : 0 },
    });
    return this.#success(operation, input.appId, {
      resource,
      domain: normalized.domain.domain,
      url: normalized.domain.url,
      created,
      adopted: !created && !input.knownProviderId,
      changed: created,
      recoveredAfterUncertainCreate,
      idempotency: 'read-before-create',
      providerMutationsExecuted: created ? 1 : 0,
    }, input);
  }

  #deploymentResult(operation, input, deployment, details) {
    if (deployment.id && input.deploymentId && deployment.id !== input.deploymentId) {
      return this.#failure(operation, input.appId, conflictError('Railway returned a different deployment ID.'), input);
    }
    if (deployment.status === 'SUCCESS' || deployment.status === 'SLEEPING') {
      const url = normalizeRailwayCandidateUrl(input.publicUrl) ||
        normalizeRailwayCandidateUrl(deployment.url) || normalizeRailwayCandidateUrl(deployment.staticUrl);
      if (!url) {
        return this.#failure(
          operation,
          input.appId,
          providerResponseError('Railway deployment succeeded without an approved public Service Domain URL.'),
          input,
          { data: { deployment, ...details } }
        );
      }
      return this.#success(operation, input.appId, { deployment: { ...deployment, url }, ...details }, input, {
        status: 'succeeded',
        warnings: deployment.status === 'SLEEPING' ? ['Railway reports the deployment as sleeping (inactive).'] : [],
      });
    }
    if (TERMINAL_DEPLOYMENT_STATES.has(deployment.status)) {
      return this.#failure(operation, input.appId, {
        code: 'DEPLOYMENT_FAILED',
        message: `Railway deployment reached terminal state ${deployment.status}.`,
        retryable: false,
        provider: PROVIDER,
        resourceId: deployment.id,
      }, input, { status: 'failed-terminal', data: { deployment, ...details } });
    }
    if (!WAITING_DEPLOYMENT_STATES.has(deployment.status)) {
      return this.#failure(operation, input.appId, providerResponseError(`Railway returned unknown deployment status ${deployment.status}.`), input);
    }
    return this.#success(operation, input.appId, { deployment, ...details }, input, {
      status: 'waiting-external',
      nextActions: ['Poll the Railway deployment again after nextPollAt.'],
    });
  }

  #validateScopedOperation(input) {
    if (this.#tokenType !== 'project') return null;
    if (!this.#scope.projectId || !this.#scope.environmentId) {
      return capabilityError('Railway Project Token operations require a previously verified projectId and environmentId scope.');
    }
    if (!sameScope(this.#scope, input)) {
      return conflictError('Requested Railway project/environment is outside the verified Project Token scope.');
    }
    return null;
  }

  #requireApiToken(operation, input) {
    if (this.#tokenType === 'api') return null;
    return this.#failure(operation, input.appId, capabilityError('Railway Project Token cannot create or enumerate account-level resources; use an Account/Workspace Token.'), input);
  }

  async #graphql(operationName, query, variables, mutation) {
    try {
      const response = await this.#transport.request({
        method: 'POST',
        url: API_ENDPOINT,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.#tokenType === 'project'
            ? { 'project-access-token': this.#token }
            : { authorization: `Bearer ${this.#token}` }),
        },
        body: { operationName, query, variables },
      });
      if (!response.ok) return { ...sanitizeResponse(response, this.#token), uncertain: response.uncertain === true || (mutation && response.status >= 500) };
      if (Array.isArray(response.data?.errors) && response.data.errors.length > 0) {
        return graphQlError(response.data.errors, this.#token, mutation);
      }
      if (!response.data || typeof response.data.data !== 'object' || response.data.data === null) {
        return { ok: false, status: 502, code: 'PROVIDER_RESPONSE_INVALID', message: 'Railway GraphQL response is missing data.', data: {} };
      }
      return { ok: true, status: response.status || 200, data: response.data.data };
    } catch (error) {
      return {
        ok: false,
        status: 503,
        message: sanitizeText(error.message, this.#token),
        data: {},
        uncertain: mutation === true,
      };
    }
  }

  #providerFailure(operation, appId, response, input, options = {}) {
    const sanitized = sanitizeResponse(response, this.#token);
    const error = sanitized.code === 'PROVIDER_RESPONSE_INVALID'
      ? providerResponseError(sanitized.message || 'Railway returned an invalid response.')
      : mapProviderError(PROVIDER, sanitized);
    return this.#failure(operation, appId, error, input, options);
  }

  #deleteDisabled(operation, input, effect) {
    return this.#failure(operation, input?.appId || '', {
      code: 'UNSUPPORTED',
      message: `Railway deletion is disabled because it would remove the ${effect}.`,
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

export function createRailwayV2AdapterFromConnection(connection, options = {}) {
  if (connection?.provider !== PROVIDER || connection.status !== 'ready') {
    throw new Error('A verified Railway ProviderConnection with status ready is required.');
  }
  const values = resolveConnectionSecretRefs(connection, {
    env: options.env,
    purpose: 'Railway adapter',
  });
  const tokenType = values.RAILWAY_TOKEN ? 'project' : 'api';
  const scope = tokenType === 'project'
    ? {
        projectId: options.projectId || connection.identity?.projectId || '',
        environmentId: options.environmentId || connection.identity?.environmentId || '',
      }
    : {};
  return new RailwayV2Adapter({
    token: values.RAILWAY_TOKEN || values.RAILWAY_API_TOKEN,
    tokenType,
    scope,
    transport: options.transport,
    httpOptions: options.httpOptions,
  });
}

function validateProjectRead(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '')) {
    return validationError('Project Read requires appId, logicalId, and a valid projectId.');
  }
  return null;
}

function validateProjectEnsure(input) {
  if (!input?.appId || !input.logicalId || !SAFE_NAME.test(input.name || '') || !input.idempotencyKey) {
    return validationError('Project Ensure requires appId, logicalId, valid name, and idempotencyKey.');
  }
  if (input.workspaceId && !SAFE_ID.test(input.workspaceId)) return validationError('Railway workspaceId is invalid.');
  if (input.defaultEnvironmentName && !SAFE_NAME.test(input.defaultEnvironmentName)) {
    return validationError('Railway default environment name is invalid.');
  }
  return null;
}

function validateEnvironmentEnsure(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') || !SAFE_NAME.test(input.name || '') || !input.idempotencyKey) {
    return validationError('Environment Ensure requires appId, logicalId, projectId, valid name, and idempotencyKey.');
  }
  return null;
}

function validateServiceEnsure(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') ||
      !SAFE_ID.test(input.environmentId || '') || !SAFE_NAME.test(input.name || '') || !input.idempotencyKey) {
    return validationError('Service Ensure requires appId, logicalId, projectId, environmentId, valid name, and idempotencyKey.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository || '') ||
      !GIT_BRANCH.test(input.branch || '') || input.branch.includes('..') || input.branch.includes('//')) {
    return validationError('Railway Service Ensure requires an exact GitHub repository and candidate branch.');
  }
  if (input.source || input.variables) {
    return validationError('Railway Service Ensure accepts structured repository fields only; raw source and variables are forbidden.');
  }
  return null;
}

function validateServiceDomainEnsure(input) {
  if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.projectId || '') ||
      !SAFE_ID.test(input.environmentId || '') || !SAFE_ID.test(input.serviceId || '') || !input.idempotencyKey) {
    return validationError('Service Domain Ensure requires appId, logicalId, projectId, environmentId, serviceId, and idempotencyKey.');
  }
  return null;
}

function validateVariablePlan(input) {
  if (!input?.appId || !SAFE_ID.test(input.projectId || '') || !SAFE_ID.test(input.environmentId || '') || !SAFE_ID.test(input.serviceId || '')) {
    return validationError('Railway variable plan requires valid appId, projectId, environmentId, and serviceId.');
  }
  const entries = Object.entries(input.secretRefs || {});
  if (entries.length === 0) return validationError('Railway variable plan requires at least one Secret Ref.');
  for (const [name, ref] of entries) {
    if (!VARIABLE_NAME.test(name) || !SECRET_REF.test(ref)) {
      return validationError('Railway variables must use valid names and env:// Secret Refs only.');
    }
  }
  return null;
}

function validateVariableExecutionGates(input) {
  if (input.execute !== true || input.yes !== true || input.allowProviderMutations !== true || !SHA256.test(input.approvalFingerprint || '')) {
    return approvalError('Railway variable execution requires execute, yes, provider-mutation, and immutable approval gates.');
  }
  if (!SHA256.test(input.planFingerprint || '')) return approvalError('Railway variable execution requires the immutable plan fingerprint.');
  return null;
}

function validateCandidate(input) {
  if (
    !input?.appId || !SAFE_ID.test(input.projectId || '') || !SAFE_ID.test(input.environmentId || '') ||
    !SAFE_ID.test(input.serviceId || '') || !SAFE_NAME.test(input.serviceName || '')
  ) return validationError('Railway candidate requires valid appId, projectId, environmentId, serviceId, and serviceName.');
  if (input.environmentClass !== 'candidate' || !SAFE_NAME.test(input.environmentName || '') || PRODUCTION_NAMES.has(input.environmentName.toLowerCase())) {
    return {
      code: 'PRODUCTION_TARGET_VIOLATION',
      message: 'Railway candidate deployment requires a non-production candidate environment.',
      retryable: false,
      provider: PROVIDER,
    };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository || '') || !GIT_COMMIT.test(input.commitSha || '')) {
    return validationError('Railway candidate requires an exact connected GitHub repository and locked commit SHA.');
  }
  if (input.connectedRepositoryVerified !== true) {
    return validationError('Railway candidate requires prior evidence that the service is connected to the exact repository.');
  }
  if (!GIT_BRANCH.test(input.branch || '') || input.branch.includes('..') || input.branch.includes('//') ||
      typeof input.sourceConnectionCreated !== 'boolean') {
    return validationError('Railway candidate requires the verified source branch and source-connection lifecycle evidence.');
  }
  if (input.publicUrl && !normalizeRailwayCandidateUrl(input.publicUrl)) {
    return validationError('Railway candidate publicUrl must be a root HTTPS Railway candidate domain.');
  }
  return null;
}

function validateCandidateExecutionGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    input.allowCostMutations !== true || !SHA256.test(input.approvalFingerprint || '')
  ) return approvalError('Railway candidate execution requires execute, yes, provider-mutation, cost-mutation, and immutable approval gates.');
  if (!SHA256.test(input.planFingerprint || '')) {
    return approvalError('Railway candidate execution requires the immutable plan fingerprint.');
  }
  return null;
}

function candidatePlanFingerprint(input) {
  return sha256(JSON.stringify({
    projectId: input.projectId,
    environmentId: input.environmentId,
    environmentName: input.environmentName,
    environmentClass: 'candidate',
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    repository: input.repository,
    branch: input.branch,
    commitSha: input.commitSha.toLowerCase(),
    connectedRepositoryVerified: true,
    sourceConnectionCreated: input.sourceConnectionCreated,
    publicUrl: normalizeRailwayCandidateUrl(input.publicUrl) || '',
  }));
}

function validateObservedServiceSource(instance, input) {
  if (String(instance?.source?.repo || '').toLowerCase() !== input.repository.toLowerCase() || instance?.source?.image) {
    return conflictError('Railway Service source is not connected to the approved GitHub repository.');
  }
  const triggers = edges(instance?.service?.repoTriggers).filter((trigger) =>
    trigger?.serviceId === input.serviceId || trigger?.serviceId === instance?.service?.id
  );
  const environmentTriggers = triggers.filter((trigger) => trigger.environmentId === input.environmentId);
  const exact = environmentTriggers.filter((trigger) =>
    trigger.projectId === input.projectId &&
    trigger.provider === 'github' &&
    String(trigger.repository || '').toLowerCase() === input.repository.toLowerCase() &&
    trigger.branch === input.branch
  );
  if (environmentTriggers.length === 0) {
    return providerUnavailableError('Railway has not exposed the repository trigger for the candidate environment yet.');
  }
  if (environmentTriggers.length !== 1 || exact.length !== 1) {
    return conflictError('Railway did not verify one exact repository and branch trigger for the candidate environment.');
  }
  return null;
}

function normalizeProject(data, input, lifecycle) {
  if (!data || typeof data !== 'object' || !SAFE_ID.test(String(data.id || '')) || data.name !== input.name && input.name) {
    return { error: providerResponseError('Railway project response does not match the requested identity.') };
  }
  return {
    resource: {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: String(data.id),
      type: 'runtime.project',
      name: String(data.name),
      lifecycle,
      version: 1,
      attributes: pickScalars(data, ['description', 'createdAt', 'updatedAt']),
    },
  };
}

function normalizeEnvironment(data, input, lifecycle) {
  if (!data || typeof data !== 'object' || !SAFE_ID.test(String(data.id || '')) || data.name !== input.name) {
    return { error: providerResponseError('Railway environment response does not match the requested identity.') };
  }
  return {
    resource: {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: String(data.id),
      type: 'runtime.environment',
      name: String(data.name),
      lifecycle,
      version: 1,
      attributes: { projectId: input.projectId, ...pickScalars(data, ['createdAt']) },
    },
  };
}

function normalizeService(data, input, lifecycle) {
  if (!data || typeof data !== 'object' || !SAFE_ID.test(String(data.id || '')) || data.name !== input.name) {
    return { error: providerResponseError('Railway service response does not match the requested identity.') };
  }
  return {
    resource: {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: String(data.id),
      type: 'runtime.service',
      name: String(data.name),
      lifecycle,
      version: 1,
      attributes: { projectId: input.projectId, sourceConnected: false },
    },
  };
}

function normalizeServiceDomain(data, input) {
  const source = data && typeof data === 'object' ? data : {};
  const url = normalizeRailwayCandidateUrl(source.domain);
  if (!SAFE_ID.test(String(source.id || '')) || !url || source.environmentId !== input.environmentId ||
      source.serviceId !== input.serviceId) {
    return { error: providerResponseError('Railway Service Domain response does not match the approved service and environment.') };
  }
  return {
    domain: {
      ...pickScalars(source, ['suffix', 'targetPort', 'syncStatus', 'createdAt', 'updatedAt']),
      id: String(source.id),
      domain: new URL(url).hostname,
      environmentId: source.environmentId,
      serviceId: source.serviceId,
      url,
    },
  };
}

function normalizeDeployment(data) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    ...pickScalars(source, ['id', 'createdAt', 'url', 'staticUrl']),
    id: String(source.id || ''),
    status: String(source.status || '').toUpperCase(),
    commitSha: deploymentCommit(source.meta),
  };
}

function normalizeRailwayCandidateUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  let url;
  try { url = new URL(value.startsWith('http') ? value : `https://${value}`); }
  catch { return ''; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash ||
      !(url.hostname.endsWith('.up.railway.app') || url.hostname.endsWith('.railway.app'))) return '';
  return url.toString();
}

function deploymentCommit(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  for (const key of ['commitSha', 'commitHash', 'githubCommitSha']) {
    if (GIT_COMMIT.test(meta[key] || '')) return String(meta[key]).toLowerCase();
  }
  return '';
}

function exactMatch(items, name, label) {
  const matches = items.filter((item) => item?.name === name);
  if (matches.length > 1) return { conflict: conflictError(`Multiple exact ${label} match the requested name.`) };
  return { project: matches[0] || null };
}

function invalidProviderResponse(message) {
  return { ok: false, status: 502, code: 'PROVIDER_RESPONSE_INVALID', message, data: {} };
}

function edges(connection) {
  return Array.isArray(connection?.edges)
    ? connection.edges.map((edge) => edge?.node).filter((node) => node && typeof node === 'object')
    : [];
}

function knownIdentityConflict(knownProviderId, observedProviderId, kind) {
  if (!knownProviderId || knownProviderId === observedProviderId) return null;
  return conflictError(`Railway ${kind} identity differs from DeploymentState.`);
}

function normalizeScope(scope) {
  return {
    projectId: SAFE_ID.test(scope?.projectId || '') ? scope.projectId : '',
    environmentId: SAFE_ID.test(scope?.environmentId || '') ? scope.environmentId : '',
  };
}

function sameScope(left, right) {
  return left.projectId === right.projectId && left.environmentId === right.environmentId;
}

function resolveRuntimeSecretRefs(secretRefs, env) {
  return Object.fromEntries(Object.entries(secretRefs).map(([name, ref]) => {
    const envName = ref.slice('env://'.length);
    if (!env[envName]) throw new Error(`Environment Secret Ref is missing: ${envName}`);
    return [name, env[envName]];
  }));
}

function graphQlError(errors, token, mutation) {
  const first = errors[0] || {};
  const message = sanitizeText(first.message || 'Railway GraphQL request failed.', token);
  const extensionCode = String(first.extensions?.code || '').toUpperCase();
  const status =
    /UNAUTH|AUTHENTICATION/.test(extensionCode) || /not authorized|unauthorized/i.test(message) ? 401 :
    /FORBIDDEN|PERMISSION/.test(extensionCode) || /forbidden|permission/i.test(message) ? 403 :
    /NOT_FOUND/.test(extensionCode) || /not found/i.test(message) ? 404 :
    /CONFLICT|ALREADY_EXISTS/.test(extensionCode) || /already exists|conflict/i.test(message) ? 409 : 400;
  return { ok: false, status, message, data: {}, uncertain: mutation && status >= 500 };
}

function sanitizeResponse(response, token) {
  return {
    ok: response.ok === true,
    status: Number(response.status || 0),
    code: response.code,
    message: sanitizeText(response.message || '', token),
    retryAfter: response.retryAfter,
    resourceId: response.resourceId,
    uncertain: response.uncertain === true,
    data: {},
  };
}

function sanitizeText(value, token) {
  let text = String(value || '')
    .replace(/Project-Access-Token\s*:\s*\S+/gi, 'Project-Access-Token: [redacted]')
    .replace(/Authorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]');
  if (token) text = text.split(token).join('[redacted]');
  return text;
}

function isUncertainMutation(response) {
  return response.uncertain === true || response.status === 409 || response.status === 429 || response.status >= 500;
}

function pickScalars(value, keys) {
  return Object.fromEntries(keys
    .filter((key) => value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))
    .map((key) => [key, value[key]]));
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

function providerUnavailableError(message) {
  return { code: 'PROVIDER_UNAVAILABLE', message, retryable: true, provider: PROVIDER };
}

function conflictError(message) {
  return { code: 'CONFLICT', message, retryable: false, provider: PROVIDER };
}

function capabilityError(message) {
  return { code: 'CAPABILITY_MISSING', message, retryable: false, provider: PROVIDER };
}

function credentialError(message) {
  return { code: 'CREDENTIAL_MISSING', message, retryable: false, provider: PROVIDER };
}

function approvalError(message) {
  return { code: 'APPROVAL_REQUIRED', message, retryable: false, provider: PROVIDER };
}
