import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from '../provider-contract.js';
import { createProviderHttpTransport } from '../provider-http.js';
import { resolveConnectionSecretRefs } from '../secret-ref.js';

const PROVIDER = 'vercel';
const API_BASE = 'https://api.vercel.com';
const PROJECT_NAME = /^(?!.*---)[a-z0-9][a-z0-9._-]{0,99}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9._-]{1,160}$/;
const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const TERMINAL_DEPLOYMENT_STATES = new Set(['ERROR', 'CANCELED', 'CANCELLED', 'DELETED']);

export class VercelV2Adapter {
  #token;
  #teamId;
  #transport;

  constructor(options = {}) {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('Vercel token is required.');
    if (options.teamId && !SAFE_PROVIDER_ID.test(options.teamId)) throw new Error('Vercel Team ID or slug is invalid.');
    this.#token = options.token;
    this.#teamId = options.teamId || '';
    this.#transport = options.transport || createProviderHttpTransport(options.httpOptions);
  }

  async readProject(input) {
    const operation = 'vercel.project.read';
    const invalid = validateProjectIdentity(input);
    if (invalid) return this.#failure(operation, input.appId, invalid, input);
    const response = await this.#requestSafe('GET', `/v9/projects/${encodeURIComponent(input.idOrName || input.name)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const normalized = normalizeProject(response.data, input, input.lifecycle || 'external');
    if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
    return this.#success(operation, input.appId, {
      resource: normalized.resource,
      observedAt: input.now || new Date().toISOString(),
    }, input);
  }

  async ensureProject(input) {
    const operation = 'vercel.project.ensure';
    const invalid = validateProjectIdentity(input) || validateCreateProjectInput(input);
    if (invalid) return this.#failure(operation, input.appId, invalid, input);

    const lookupPath = `/v9/projects/${encodeURIComponent(input.name)}`;
    const existing = await this.#requestSafe('GET', lookupPath);
    if (existing.ok) return this.#existingProjectResult(operation, input, existing.data, false);
    if (existing.status !== 404) return this.#providerFailure(operation, input.appId, existing, input);

    const body = {
      name: input.name,
      skipGitConnectDuringLink: true,
      ...projectSettingsFromInput(input),
    };
    const created = await this.#requestSafe('POST', '/v11/projects', body);
    if (created.ok) {
      const normalized = normalizeProject(created.data, input, 'managed');
      if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
      return this.#success(operation, input.appId, {
        resource: normalized.resource,
        created: true,
        adopted: false,
        changed: true,
        recoveredAfterUncertainCreate: false,
        idempotency: 'read-before-create',
      }, input);
    }

    if (created.status === 409 || created.status === 503 || created.uncertain === true) {
      const recovered = await this.#requestSafe('GET', lookupPath);
      if (recovered.ok) return this.#existingProjectResult(operation, input, recovered.data, true);
    }
    return this.#providerFailure(operation, input.appId, created, input);
  }

  planCandidateDeployment(input) {
    const operation = 'vercel.deployment.plan-candidate';
    const identityError = validateCandidateIdentity(input);
    if (identityError) return this.#failure(operation, input.appId, identityError, input);
    const artifactError = validateVercelFileManifest(input.artifact);
    if (artifactError) {
      return this.#failure(operation, input.appId, artifactError, input, {
        nextActions: ['Build a vercel-file-manifest artifact from the locked source commit before deployment.'],
      });
    }

    const body = candidateBody(input);
    const request = {
      method: 'POST',
      url: this.#url('/v13/deployments'),
      body,
    };
    const planFingerprint = hashBuffer(Buffer.from(JSON.stringify({
      projectId: input.projectId,
      name: input.name,
      artifactDigest: artifactDigest(input.artifact),
      body,
    })), 'sha256');
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      environment: 'preview',
      request,
      planFingerprint,
      fileUploadsRequired: input.artifact.files.map(({ file, sha, size }) => ({ file, sha, size })),
      productionTargetOmitted: !Object.prototype.hasOwnProperty.call(body, 'target'),
      aliasesOmitted: !Object.prototype.hasOwnProperty.call(body, 'alias'),
      providerMutationsExecuted: 0,
    }, input, {
      status: 'planned',
      nextActions: ['Upload each locked file by digest, then execute this candidate request after graph approval.'],
    });
  }

  async executeCandidateDeployment(input) {
    const operation = 'vercel.deployment.create-candidate';
    const gateError = validateCandidateExecutionGates(input);
    if (gateError) return this.#failure(operation, input?.appId || '', gateError, input || {}, { status: 'needs-approval' });
    const identityError = validateCandidateIdentity(input);
    if (identityError) return this.#failure(operation, input.appId, identityError, input);
    const artifactError = validateExecutableVercelArtifact(input.artifact);
    if (artifactError) return this.#failure(operation, input.appId, artifactError, input);
    const integrityError = verifyExecutableArtifactFiles(input.artifact, input.appId);
    if (integrityError) return this.#failure(operation, input.appId, integrityError, input);

    const observed = await this.#findCandidate(input);
    if (observed.error) return this.#providerFailure(operation, input.appId, observed.error, input);
    if (observed.conflict) {
      return this.#failure(operation, input.appId, {
        code: 'CONFLICT',
        message: 'Multiple Vercel candidate deployments match the same immutable artifact.',
        retryable: false,
        provider: PROVIDER,
      }, input);
    }
    if (observed.deployment) {
      return this.#candidateResult(operation, input, observed.deployment, {
        created: false,
        adopted: true,
        recoveredAfterUncertainCreate: false,
        uploadedBlobs: 0,
        providerMutationsExecuted: 0,
      });
    }

    const artifactBlobs = uniqueBlobs(input.artifact);
    const blobs = observed.artifactObserved ? [] : artifactBlobs;
    let uploadedBlobs = 0;
    for (const blob of blobs) {
      let content;
      try {
        content = readAndVerifyBlob(blob);
      } catch (error) {
        return this.#failure(operation, input.appId, {
          code: 'ARTIFACT_INTEGRITY_FAILED',
          message: error.message,
          retryable: false,
          provider: PROVIDER,
        }, input);
      }
      const uploaded = await this.#requestSafe('POST', '/v2/files', content, {
        'content-type': 'application/octet-stream',
        'content-length': String(blob.size),
        'x-vercel-digest': blob.sha,
      });
      if (!uploaded.ok) {
        return this.#failure(operation, input.appId, mapProviderError(PROVIDER, uploaded), input, {
          data: { uploadedBlobs, providerMutationsExecuted: uploadedBlobs },
        });
      }
      uploadedBlobs += 1;
    }

    const createPath = observed.terminalExactObserved
      ? '/v13/deployments?forceNew=1'
      : '/v13/deployments';
    const created = await this.#requestSafe('POST', createPath, candidateBody(input));
    if (created.ok) {
      return this.#candidateResult(operation, input, normalizeDeployment(created.data), {
        created: true,
        adopted: false,
        recoveredAfterUncertainCreate: false,
        uploadedBlobs,
        reusedUploadedBlobs: artifactBlobs.length - uploadedBlobs,
        providerMutationsExecuted: uploadedBlobs + 1,
      });
    }

    if (created.status === 409 || created.status === 429 || created.status >= 500 || created.uncertain === true) {
      const recovered = await this.#findCandidate(input);
      if (recovered.deployment && !recovered.conflict) {
        return this.#candidateResult(operation, input, recovered.deployment, {
          created: true,
          adopted: false,
          recoveredAfterUncertainCreate: true,
          uploadedBlobs,
          reusedUploadedBlobs: artifactBlobs.length - uploadedBlobs,
          providerMutationsExecuted: uploadedBlobs + 1,
        });
      }
      if (recovered.conflict) {
        return this.#failure(operation, input.appId, {
          code: 'CONFLICT',
          message: 'Candidate Create was uncertain and reconciliation found multiple matching deployments.',
          retryable: false,
          provider: PROVIDER,
        }, input, { data: { uploadedBlobs, providerMutationsExecuted: uploadedBlobs + 1 } });
      }
    }
    return this.#failure(operation, input.appId, mapProviderError(PROVIDER, created), input, {
      data: { uploadedBlobs, providerMutationsExecuted: uploadedBlobs + 1 },
    });
  }

  async pollDeployment(input) {
    const operation = 'vercel.deployment.poll';
    if (!input?.appId || !input.deploymentId || !SAFE_PROVIDER_ID.test(input.deploymentId)) {
      return this.#failure(operation, input?.appId || '', validationError('Deployment ID is invalid.'), input || {});
    }
    const response = await this.#requestSafe('GET', `/v13/deployments/${encodeURIComponent(input.deploymentId)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const deployment = normalizeDeployment(response.data);
    if (!deployment.id || !deployment.readyState) {
      return this.#failure(operation, input.appId, providerResponseError('Vercel deployment response is missing id or readyState.'), input);
    }
    if (deployment.target === 'production') {
      return this.#failure(operation, input.appId, {
        code: 'PRODUCTION_TARGET_VIOLATION',
        message: 'Candidate deployment unexpectedly targets production.',
        retryable: false,
        provider: PROVIDER,
        resourceId: deployment.id,
      }, input, { status: 'failed-terminal', data: { deployment } });
    }
    if (deployment.readyState === 'READY') {
      return this.#success(operation, input.appId, { deployment }, input, { status: 'succeeded' });
    }
    if (TERMINAL_DEPLOYMENT_STATES.has(deployment.readyState)) {
      return this.#failure(operation, input.appId, {
        code: 'DEPLOYMENT_FAILED',
        message: `Vercel deployment reached terminal state ${deployment.readyState}.`,
        retryable: false,
        provider: PROVIDER,
        resourceId: deployment.id,
      }, input, { status: 'failed-terminal', data: { deployment } });
    }
    return this.#success(operation, input.appId, { deployment }, input, {
      status: 'waiting-external',
      nextActions: ['Poll the deployment again after nextPollAt.'],
    });
  }

  deleteProject(input) {
    return this.#failure('vercel.project.delete', input?.appId || '', {
      code: 'UNSUPPORTED',
      message: 'Vercel project deletion is disabled because it cascades to deployments, domains, environment variables, and settings.',
      retryable: false,
      provider: PROVIDER,
    }, input || {});
  }

  async #requestSafe(method, path, body, extraHeaders = {}) {
    try {
      return await this.#transport.request({
        method,
        url: this.#url(path),
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined || body instanceof Uint8Array ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      return { ok: false, status: 503, message: error.message, data: {}, uncertain: method !== 'GET' };
    }
  }

  async #findCandidate(input) {
    const query = new URLSearchParams({ projectId: input.projectId, limit: '20' });
    const response = await this.#requestSafe('GET', `/v7/deployments?${query.toString()}`);
    if (!response.ok) return { error: response };
    const deployments = Array.isArray(response.data?.deployments) ? response.data.deployments : [];
    const digest = artifactDigest(input.artifact);
    const planFingerprint = SHA256.test(input.planFingerprint || '') ? input.planFingerprint : '';
    const artifactMatches = deployments.filter((deployment) => {
      const target = deployment.target === null || deployment.target === undefined
        ? 'preview'
        : String(deployment.target).toLowerCase();
      return deployment.projectId === input.projectId && deployment.name === input.name && target !== 'production' &&
        deployment.meta && typeof deployment.meta === 'object' &&
        deployment.meta.agentmeshDeployArtifact === digest;
    });
    const exactMatches = artifactMatches.filter((deployment) =>
      !planFingerprint || deployment.meta.agentmeshDeployPlan === planFingerprint
    ).map(normalizeDeployment);
    const matches = exactMatches.filter((deployment) => !TERMINAL_DEPLOYMENT_STATES.has(deployment.readyState));
    return matches.length > 1
      ? {
          conflict: true,
          artifactObserved: artifactMatches.length > 0,
          terminalExactObserved: exactMatches.some((deployment) => TERMINAL_DEPLOYMENT_STATES.has(deployment.readyState)),
        }
      : {
          deployment: matches[0] || null,
          artifactObserved: artifactMatches.length > 0,
          terminalExactObserved: exactMatches.some((deployment) => TERMINAL_DEPLOYMENT_STATES.has(deployment.readyState)),
        };
  }

  #candidateResult(operation, input, deployment, details) {
    if (!deployment.id || !deployment.readyState) {
      return this.#failure(operation, input.appId, providerResponseError('Vercel candidate response is missing id or readyState.'), input);
    }
    if (deployment.target === 'production') {
      return this.#failure(operation, input.appId, {
        code: 'PRODUCTION_TARGET_VIOLATION',
        message: 'Candidate deployment unexpectedly targets production.',
        retryable: false,
        provider: PROVIDER,
        resourceId: deployment.id,
      }, input, { status: 'failed-terminal', data: { deployment, ...details } });
    }
    if (TERMINAL_DEPLOYMENT_STATES.has(deployment.readyState)) {
      return this.#failure(operation, input.appId, {
        code: 'DEPLOYMENT_FAILED',
        message: `Vercel deployment reached terminal state ${deployment.readyState}.`,
        retryable: false,
        provider: PROVIDER,
        resourceId: deployment.id,
      }, input, { status: 'failed-terminal', data: { deployment, ...details } });
    }
    return this.#success(operation, input.appId, { deployment, ...details }, input, {
      status: deployment.readyState === 'READY' ? 'succeeded' : 'waiting-external',
      nextActions: deployment.readyState === 'READY' ? [] : ['Poll the candidate deployment after nextPollAt.'],
    });
  }

  #url(path) {
    const url = new URL(path, API_BASE);
    if (this.#teamId) {
      url.searchParams.set(this.#teamId.startsWith('team_') ? 'teamId' : 'slug', this.#teamId);
    }
    return url.toString();
  }

  async #existingProjectResult(operation, input, data, recoveredAfterUncertainCreate) {
    const normalized = normalizeProject(
      data,
      input,
      input.knownProviderId || recoveredAfterUncertainCreate ? 'managed' : 'adopted'
    );
    if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
    if (input.knownProviderId && normalized.resource.providerId !== input.knownProviderId) {
      return this.#failure(operation, input.appId, {
        code: 'CONFLICT',
        message: 'The project name resolves to a different Vercel project than DeploymentState records.',
        retryable: false,
        provider: PROVIDER,
        resourceId: normalized.resource.providerId,
      }, input);
    }
    const desiredSettings = projectSettingsFromInput(input);
    const changedSettings = Object.fromEntries(Object.entries(desiredSettings)
      .filter(([key, value]) => data[key] !== value));
    if (Object.keys(changedSettings).length > 0 && !recoveredAfterUncertainCreate) {
      if (!input.knownProviderId) {
        return this.#failure(operation, input.appId, {
          code: 'CONFLICT',
          message: 'Vercel project settings differ, but DeploymentState has not bound the exact project identity.',
          retryable: false,
          provider: PROVIDER,
          resourceId: normalized.resource.providerId,
        }, input);
      }
      const updated = await this.#requestSafe(
        'PATCH',
        `/v9/projects/${encodeURIComponent(normalized.resource.providerId)}`,
        changedSettings
      );
      if (!updated.ok) return this.#providerFailure(operation, input.appId, updated, input);
      const updatedProject = normalizeProject(updated.data, input, 'managed');
      if (updatedProject.error) return this.#failure(operation, input.appId, updatedProject.error, input);
      if (Object.entries(desiredSettings).some(([key, value]) => updated.data[key] !== value)) {
        return this.#failure(operation, input.appId, providerResponseError(
          'Vercel project update response does not contain the requested build settings.'
        ), input);
      }
      return this.#success(operation, input.appId, {
        resource: updatedProject.resource,
        created: false,
        adopted: false,
        changed: true,
        settingsUpdated: Object.keys(changedSettings).sort(),
        recoveredAfterUncertainCreate: false,
        providerMutationsExecuted: 1,
        idempotency: 'read-compare-patch',
      }, input);
    }
    return this.#success(operation, input.appId, {
      resource: normalized.resource,
      created: recoveredAfterUncertainCreate,
      adopted: !input.knownProviderId && !recoveredAfterUncertainCreate,
      changed: recoveredAfterUncertainCreate,
      recoveredAfterUncertainCreate,
      idempotency: 'read-before-create',
    }, input);
  }

  #providerFailure(operation, appId, response, input) {
    return this.#failure(operation, appId, mapProviderError(PROVIDER, response), input);
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

export function createVercelV2AdapterFromConnection(connection, options = {}) {
  if (connection?.provider !== PROVIDER || connection.status !== 'ready') {
    throw new Error('A verified Vercel ProviderConnection with status ready is required.');
  }
  const values = resolveConnectionSecretRefs(connection, {
    env: options.env,
    purpose: 'Vercel adapter',
  });
  return new VercelV2Adapter({
    token: values.VERCEL_TOKEN,
    teamId: options.teamId || values.VERCEL_ORG_ID || '',
    transport: options.transport,
    httpOptions: options.httpOptions,
  });
}

function validateProjectIdentity(input) {
  if (!input?.appId || !input.logicalId) return validationError('appId and logicalId are required.');
  const identity = input.idOrName || input.name;
  if (!identity || !(PROJECT_NAME.test(identity) || SAFE_PROVIDER_ID.test(identity))) {
    return validationError('Vercel project id or name is invalid.');
  }
  if (input.name && !PROJECT_NAME.test(input.name)) return validationError('Vercel project name is invalid.');
  return null;
}

function validateCreateProjectInput(input) {
  if (!input.idempotencyKey) return validationError('Project Ensure requires an idempotency key.');
  if (!PROJECT_NAME.test(input.name || '')) return validationError('Vercel project name is invalid.');
  return validateCandidateProjectSettings(projectSettingsFromInput(input));
}

function validateCandidateIdentity(input) {
  if (!input?.appId || !PROJECT_NAME.test(input.name || '') || !SAFE_PROVIDER_ID.test(input.projectId || '')) {
    return validationError('Candidate deployment requires valid appId, name, and Vercel projectId.');
  }
  const settingsError = validateCandidateProjectSettings(input.projectSettings);
  if (settingsError) return settingsError;
  return null;
}

function validateCandidateProjectSettings(settings) {
  if (settings === undefined) return null;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return validationError('Vercel projectSettings must be an object.');
  }
  const allowed = new Set(['framework', 'buildCommand', 'installCommand', 'outputDirectory']);
  if (Object.keys(settings).some((key) => !allowed.has(key))) {
    return validationError('Vercel projectSettings contains an unsupported field.');
  }
  if (
    settings.framework !== undefined && settings.framework !== null &&
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(settings.framework)
  ) return validationError('Vercel projectSettings framework is invalid.');
  for (const key of ['buildCommand', 'installCommand']) {
    if (
      settings[key] !== undefined &&
      (typeof settings[key] !== 'string' || !settings[key] || settings[key].length > 512 || /[\u0000-\u001f\u007f]/.test(settings[key]))
    ) return validationError(`Vercel projectSettings ${key} is invalid.`);
  }
  if (settings.outputDirectory !== undefined && !validOutputDirectory(settings.outputDirectory)) {
    return validationError('Vercel projectSettings outputDirectory is invalid.');
  }
  return null;
}

function validateCandidateExecutionGates(input) {
  if (input?.execute !== true || input.yes !== true || input.allowProviderMutations !== true || input.allowCostMutations !== true) {
    return {
      code: 'APPROVAL_REQUIRED',
      message: 'Candidate execution requires execute, yes, provider-mutation, and cost-mutation gates.',
      retryable: false,
      provider: PROVIDER,
    };
  }
  if (!SHA256.test(input.approvalFingerprint || '')) {
    return {
      code: 'APPROVAL_REQUIRED',
      message: 'Candidate execution requires an immutable approval fingerprint.',
      retryable: false,
      provider: PROVIDER,
    };
  }
  return null;
}

function validateVercelFileManifest(artifact) {
  if (artifact?.kind !== 'vercel-file-manifest') {
    return {
      code: 'BUILD_OUTPUT_INCOMPATIBLE',
      message: 'Candidate deployment requires a vercel-file-manifest; generic runtime archives cannot be sent to Vercel.',
      retryable: false,
      provider: PROVIDER,
    };
  }
  if (!SHA256.test(artifactDigest(artifact)) || !Array.isArray(artifact.files) || artifact.files.length === 0) {
    return validationError('Vercel file manifest digest or files are invalid.');
  }
  const names = new Set();
  for (const file of artifact.files) {
    if (!isSafeRelativeFile(file?.file) || !SHA1.test(file?.sha || '') || !Number.isInteger(file?.size) || file.size < 0) {
      return validationError('Vercel file manifest contains an invalid file, SHA-1 digest, or size.');
    }
    if (names.has(file.file)) return validationError(`Vercel file manifest contains duplicate path: ${file.file}`);
    names.add(file.file);
  }
  return null;
}

function validateExecutableVercelArtifact(artifact) {
  const base = validateVercelFileManifest(artifact);
  if (base) return base;
  if (!Array.isArray(artifact.blobs) || artifact.blobs.length === 0) {
    return validationError('Executable Vercel artifact is missing content-addressed blobs.');
  }
  const blobs = new Map(artifact.blobs.map((blob) => [blob.digest, blob]));
  for (const file of artifact.files) {
    const blob = blobs.get(file.contentDigest);
    if (
      !SHA256.test(file.contentDigest || '') || !blob || blob.digest !== file.contentDigest ||
      blob.sha !== file.sha || blob.size !== file.size || typeof blob.file !== 'string'
    ) {
      return validationError(`Executable Vercel blob metadata is invalid for ${file.file}.`);
    }
  }
  return null;
}

function verifyExecutableArtifactFiles(artifact, appId) {
  try {
    if (artifact.projectId !== appId || typeof artifact.file !== 'string') {
      throw new Error('Vercel artifact project ownership is invalid.');
    }
    const digest = artifactDigest(artifact);
    const artifactRoot = path.dirname(path.dirname(path.resolve(artifact.file)));
    const expectedManifest = path.join(artifactRoot, 'vercel-manifests', `${digest}.json`);
    if (path.resolve(artifact.file) !== expectedManifest) throw new Error('Vercel manifest path is outside its canonical artifact location.');
    const stat = fs.statSync(artifact.file);
    if (stat.size !== artifact.size || hashFile(artifact.file, 'sha256') !== digest) {
      throw new Error('Vercel manifest size or SHA-256 is invalid.');
    }
    const manifest = JSON.parse(fs.readFileSync(artifact.file, 'utf8'));
    if (
      manifest.kind !== 'vercel-file-manifest' || manifest.projectId !== appId ||
      JSON.stringify(manifest.files) !== JSON.stringify(artifact.files)
    ) {
      throw new Error('Vercel manifest metadata does not match the executable artifact.');
    }
    for (const blob of uniqueBlobs(artifact)) {
      const expectedBlob = path.join(artifactRoot, 'vercel-blobs', blob.digest);
      if (path.resolve(blob.file) !== expectedBlob) throw new Error(`Vercel blob path is invalid: ${blob.digest}`);
      if (fs.statSync(blob.file).size !== blob.size || hashFile(blob.file, 'sha256') !== blob.digest || hashFile(blob.file, 'sha1') !== blob.sha) {
        throw new Error(`Vercel blob integrity is invalid: ${blob.digest}`);
      }
    }
    return null;
  } catch (error) {
    return {
      code: 'ARTIFACT_INTEGRITY_FAILED',
      message: error.message,
      retryable: false,
      provider: PROVIDER,
    };
  }
}

function artifactDigest(artifact) {
  return typeof artifact?.digest === 'string' ? artifact.digest : artifact?.digest?.value || '';
}

function candidateBody(input) {
  return {
    name: input.name,
    project: input.projectId,
    files: input.artifact.files.map(({ file, sha, size }) => ({ file, sha, size })),
    meta: {
      agentmeshDeployArtifact: artifactDigest(input.artifact),
      ...(SHA256.test(input.planFingerprint || '') ? { agentmeshDeployPlan: input.planFingerprint } : {}),
      ...(SHA256.test(input.approvalFingerprint || '') ? { agentmeshDeployApproval: input.approvalFingerprint } : {}),
    },
    ...(input.projectSettings ? { projectSettings: structuredClone(input.projectSettings) } : {}),
  };
}

function projectSettingsFromInput(input) {
  return Object.fromEntries(['framework', 'buildCommand', 'installCommand', 'outputDirectory']
    .filter((key) => Object.prototype.hasOwnProperty.call(input || {}, key))
    .map((key) => [key, input[key]]));
}

function validOutputDirectory(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function uniqueBlobs(artifact) {
  const needed = new Set(artifact.files.map((file) => file.contentDigest));
  return artifact.blobs.filter((blob) => needed.has(blob.digest))
    .sort((left, right) => left.digest.localeCompare(right.digest));
}

function readAndVerifyBlob(blob) {
  const content = fs.readFileSync(blob.file);
  if (content.byteLength !== blob.size) throw new Error(`Vercel blob size mismatch: ${blob.digest}`);
  if (hashBuffer(content, 'sha256') !== blob.digest) throw new Error(`Vercel blob SHA-256 mismatch: ${blob.digest}`);
  if (hashBuffer(content, 'sha1') !== blob.sha) throw new Error(`Vercel blob SHA-1 mismatch: ${blob.digest}`);
  return content;
}

function hashBuffer(value, algorithm) {
  return createHash(algorithm).update(value).digest('hex');
}

function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function normalizeProject(data, input, lifecycle) {
  if (!data || typeof data !== 'object' || !data.id || !data.name) {
    return { error: providerResponseError('Vercel project response is missing id or name.') };
  }
  const requestedName = input.name || (
    PROJECT_NAME.test(input.idOrName || '') && !String(input.idOrName).startsWith('prj_')
      ? input.idOrName
      : ''
  );
  if (requestedName && data.name !== requestedName) {
    return { error: {
      code: 'CONFLICT',
      message: 'Vercel returned a project whose name does not match the requested identity.',
      retryable: false,
      provider: PROVIDER,
      resourceId: String(data.id),
    } };
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
      attributes: pickScalars(data, ['framework', 'accountId', 'createdAt', 'updatedAt']),
    },
  };
}

function normalizeDeployment(data) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    ...pickScalars(source, ['id', 'url', 'name', 'createdAt']),
    id: String(source.id || source.uid || ''),
    readyState: String(source.readyState || source.state || source.status || '').toUpperCase(),
    target: source.target === null || source.target === undefined ? 'preview' : String(source.target).toLowerCase(),
    projectId: typeof source.project?.id === 'string' ? source.project.id : '',
  };
}

function pickScalars(value, keys) {
  return Object.fromEntries(keys
    .filter((key) => value[key] === null || ['string', 'number', 'boolean'].includes(typeof value[key]))
    .map((key) => [key, value[key]]));
}

function isSafeRelativeFile(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) return false;
  return !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function validationError(message) {
  return { code: 'VALIDATION_FAILED', message, retryable: false, provider: PROVIDER };
}

function providerResponseError(message) {
  return { code: 'PROVIDER_RESPONSE_INVALID', message, retryable: false, provider: PROVIDER };
}
