import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from '../provider-contract.js';
import { createProviderHttpTransport } from '../provider-http.js';
import { resolveConnectionSecretRefs } from '../secret-ref.js';

const PROVIDER = 'github';
const API_BASE = 'https://api.github.com';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/i;

export class GitHubV2Adapter {
  #token;
  #transport;

  constructor(options = {}) {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('GitHub token is required.');
    this.#token = options.token;
    this.#transport = options.transport || createProviderHttpTransport(options.httpOptions);
  }

  async readRepositoryCommit(input) {
    const operation = 'github.repository.read-commit';
    const invalid = validateInput(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const [owner, repositoryName] = input.repository.split('/');
    const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`;
    const repository = await this.#request(repositoryPath);
    if (!repository.ok) return this.#providerFailure(operation, input.appId, repository, input);
    if (String(repository.data?.full_name || '').toLowerCase() !== input.repository.toLowerCase()) {
      return this.#failure(operation, input.appId, conflictError('GitHub returned a different repository identity.'), input);
    }
    if (repository.data?.archived === true || repository.data?.disabled === true) {
      return this.#failure(operation, input.appId, capabilityError('GitHub repository is archived or disabled.'), input);
    }

    const encodedBranch = input.branch.split('/').map(encodeURIComponent).join('/');
    const reference = await this.#request(`${repositoryPath}/git/ref/heads/${encodedBranch}`);
    if (!reference.ok) return this.#providerFailure(operation, input.appId, reference, input);
    const observedRef = String(reference.data?.ref || '');
    const observedCommit = String(reference.data?.object?.sha || '').toLowerCase();
    if (observedRef !== `refs/heads/${input.branch}` || observedCommit !== input.commitSha.toLowerCase()) {
      return this.#failure(
        operation,
        input.appId,
        conflictError('GitHub candidate branch does not point to the locked source Commit.'),
        input
      );
    }
    return this.#success(operation, input.appId, {
      repository: {
        providerId: String(repository.data.id || ''),
        fullName: String(repository.data.full_name),
        visibility: String(repository.data.visibility || (repository.data.private ? 'private' : 'public')),
        defaultBranch: String(repository.data.default_branch || ''),
      },
      branch: { name: input.branch, commitSha: observedCommit },
      repositoryVerified: true,
      commitVerified: true,
      providerMutationsExecuted: 0,
    }, input);
  }

  async #request(path) {
    try {
      return await this.#transport.request({
        method: 'GET',
        url: new URL(path, API_BASE).toString(),
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'agentmesh-deploy',
        },
      });
    } catch (error) {
      return { ok: false, status: 503, message: error.message, data: {}, uncertain: false };
    }
  }

  #providerFailure(operation, appId, response, input) {
    return this.#failure(operation, appId, mapProviderError(PROVIDER, response), input);
  }

  #success(operation, appId, data, input) {
    return validateActionResult(actionSuccess(operation, appId, data, {
      requestId: input.requestId,
    }), { operation, appId });
  }

  #failure(operation, appId, error, input) {
    return validateActionResult(actionFailure(operation, appId, error, {
      requestId: input?.requestId,
    }), { operation, appId });
  }
}

export function createGitHubV2AdapterFromConnection(connection, options = {}) {
  if (connection?.provider !== PROVIDER || connection.status !== 'ready') {
    throw new Error('A verified GitHub ProviderConnection with status ready is required.');
  }
  const values = resolveConnectionSecretRefs(connection, {
    env: options.env,
    purpose: 'GitHub adapter',
  });
  return new GitHubV2Adapter({
    token: values.GH_TOKEN,
    transport: options.transport,
    httpOptions: options.httpOptions,
  });
}

function validateInput(input) {
  if (!input?.appId || !input.logicalId || !REPOSITORY.test(input.repository || '') ||
      !BRANCH.test(input.branch || '') || !GIT_COMMIT.test(input.commitSha || '')) {
    return validationError('GitHub repository verification requires appId, logicalId, owner/repo, branch, and a locked SHA-1 Commit.');
  }
  if (input.branch.includes('..') || input.branch.includes('//') || input.branch.endsWith('/') || input.branch.endsWith('.lock')) {
    return validationError('GitHub candidate branch is invalid.');
  }
  return null;
}

function validationError(message) {
  return { code: 'VALIDATION_FAILED', message, retryable: false, provider: PROVIDER };
}

function conflictError(message) {
  return { code: 'CONFLICT', message, retryable: false, provider: PROVIDER };
}

function capabilityError(message) {
  return { code: 'CAPABILITY_MISSING', message, retryable: false, provider: PROVIDER };
}
