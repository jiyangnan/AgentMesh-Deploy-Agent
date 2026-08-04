import { createHash } from 'node:crypto';

import { actionFailure, actionSuccess, mapProviderError, validateActionResult } from '../provider-contract.js';
import { createProviderHttpTransport } from '../provider-http.js';
import { resolveConnectionSecretRefs } from '../secret-ref.js';

const PROVIDER = 'resend';
const API_BASE = 'https://api.resend.com';
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/;
const SECRET_DESTINATION = /^(?:keychain|op|secret):\/\/[A-Za-z0-9._/-]+$/;
const SECRET_REFERENCE = /^(?:env:\/\/[A-Z][A-Z0-9_]*|(?:keychain|op|secret):\/\/[A-Za-z0-9._/-]+)$/;
const EMAIL_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const DOMAIN_REGIONS = new Set(['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1']);
const TLS_MODES = new Set(['opportunistic', 'enforced']);
const DNS_TYPES = new Set(['TXT', 'MX', 'CNAME']);
const WAITING_DOMAIN_STATES = new Set(['not_started', 'pending', 'partially_verified', 'temporary_failure']);
const TERMINAL_DOMAIN_STATES = new Set(['failed', 'partially_failed']);
const WAITING_EMAIL_STATES = new Set(['queued', 'scheduled', 'sent', 'delivery_delayed']);
const PASSED_EMAIL_STATES = new Set(['delivered', 'opened', 'clicked']);
const TERMINAL_EMAIL_STATES = new Set(['bounced', 'canceled', 'complained', 'failed', 'suppressed']);

export class ResendV2Adapter {
  #token;
  #transport;
  #secretSink;
  #secretSource;
  #credentialScope;

  constructor(options = {}) {
    if (typeof options.token !== 'string' || !options.token.trim()) throw new Error('Resend Full Access API key is required.');
    this.#token = options.token;
    this.#transport = options.transport || createProviderHttpTransport(options.httpOptions);
    this.#secretSink = options.secretSink || null;
    this.#secretSource = options.secretSource || null;
    this.#credentialScope = options.credentialScope || 'full-access';
    if (!['full-access', 'sending-access'].includes(this.#credentialScope)) {
      throw new Error('Resend credentialScope must be full-access or sending-access.');
    }
  }

  async readDomain(input) {
    const operation = 'resend.domain.read';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    if (!input?.appId || !input.logicalId || !SAFE_ID.test(input.domainId || '')) {
      return this.#failure(operation, input?.appId || '', validationError('Domain Read requires appId, logicalId, and a valid domainId.'), input || {});
    }
    const response = await this.#requestSafe('GET', `/domains/${encodeURIComponent(input.domainId)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const normalized = normalizeDomain(response.data, input, input.lifecycle || 'external');
    if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
    return this.#success(operation, input.appId, {
      resource: normalized.resource,
      dnsIntent: normalized.dnsIntent,
      observedAt: input.now || new Date().toISOString(),
    }, input);
  }

  async ensureDomain(input) {
    const operation = 'resend.domain.ensure';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateDomainEnsure(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});

    const existing = await this.#findDomainByName(input.name);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.domain) return this.#readDomainResult(operation, input, existing.domain.id, false);

    const body = {
      name: input.name,
      region: input.region || 'us-east-1',
      tls: input.tls || 'opportunistic',
      capabilities: { sending: 'enabled', receiving: 'disabled' },
    };
    if (input.customReturnPath) body.custom_return_path = input.customReturnPath;
    const created = await this.#requestSafe('POST', '/domains', body);
    if (created.ok) return this.#domainResult(operation, input, created.data, true, false);

    if (isUncertainMutation(created)) {
      const recovered = await this.#findDomainByName(input.name);
      if (recovered.domain && !recovered.conflict) {
        return this.#readDomainResult(operation, input, recovered.domain.id, true, true);
      }
      if (recovered.conflict) return this.#failure(operation, input.appId, recovered.conflict, input);
    }
    return this.#providerFailure(operation, input.appId, created, input);
  }

  planVerification(input) {
    const operation = 'resend.domain.plan-verification';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateVerification(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const planFingerprint = verificationPlanFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      domainId: input.domainId,
      domainName: input.domainName,
      dnsAppliedFingerprint: input.dnsAppliedFingerprint,
      planFingerprint,
      request: { method: 'POST', url: `${API_BASE}/domains/${input.domainId}/verify` },
      providerMutationsExecuted: 0,
    }, input, {
      status: 'planned',
      nextActions: ['Approve verification after the unified DNS plan has been applied.'],
    });
  }

  async executeVerification(input) {
    const operation = 'resend.domain.verify';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateVerification(input) || validateVerificationGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    if (input.planFingerprint !== verificationPlanFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Resend verification plan fingerprint does not match the approved plan.'), input);
    }

    const observed = await this.#requestSafe('GET', `/domains/${encodeURIComponent(input.domainId)}`);
    if (!observed.ok) return this.#providerFailure(operation, input.appId, observed, input);
    const domain = normalizeDomainState(observed.data);
    const identityError = validateObservedDomain(domain, input);
    if (identityError) return this.#failure(operation, input.appId, identityError, input);
    if (domain.status === 'verified') {
      return this.#success(operation, input.appId, {
        domain,
        created: false,
        adopted: true,
        providerMutationsExecuted: 0,
      }, input);
    }
    if (WAITING_DOMAIN_STATES.has(domain.status) && domain.status !== 'not_started') {
      return this.#success(operation, input.appId, { domain, providerMutationsExecuted: 0 }, input, {
        status: 'waiting-external',
        warnings: domain.status === 'temporary_failure'
          ? ['Resend temporarily cannot detect a previously verified DNS record.']
          : [],
        nextActions: ['Poll the Resend domain after DNS propagation.'],
      });
    }
    if (!TERMINAL_DOMAIN_STATES.has(domain.status) && domain.status !== 'not_started') {
      return this.#failure(operation, input.appId, providerResponseError(`Resend returned unknown domain status ${domain.status}.`), input);
    }

    const response = await this.#requestSafe('POST', `/domains/${encodeURIComponent(input.domainId)}/verify`, {});
    if (response.ok) {
      if (response.data?.id !== input.domainId) {
        return this.#failure(operation, input.appId, providerResponseError('Resend verification response returned a different domain ID.'), input);
      }
      return this.#success(operation, input.appId, {
        domain: { ...domain, status: 'pending' },
        providerMutationsExecuted: 1,
        recoveredAfterUncertainVerify: false,
      }, input, {
        status: 'waiting-external',
        nextActions: ['Poll the Resend domain after DNS propagation.'],
      });
    }

    if (isUncertainMutation(response)) {
      const recovered = await this.#requestSafe('GET', `/domains/${encodeURIComponent(input.domainId)}`);
      if (recovered.ok) {
        const state = normalizeDomainState(recovered.data);
        const recoveredIdentityError = validateObservedDomain(state, input);
        if (recoveredIdentityError) return this.#failure(operation, input.appId, recoveredIdentityError, input);
        if (state.status === 'pending' || state.status === 'verified') {
          return this.#success(operation, input.appId, {
            domain: state,
            providerMutationsExecuted: 1,
            recoveredAfterUncertainVerify: true,
          }, input, {
            status: state.status === 'verified' ? 'succeeded' : 'waiting-external',
          });
        }
      }
      return this.#failure(operation, input.appId, reconciliationError('Resend verification may have started, but provider state is not conclusive; automatic retry is disabled.'), input, {
        data: { providerMutationsExecuted: 1, duplicateMutationPrevented: true },
      });
    }
    return this.#providerFailure(operation, input.appId, response, input);
  }

  async pollDomain(input) {
    const operation = 'resend.domain.poll';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    if (!input?.appId || !SAFE_ID.test(input.domainId || '') || !isDomainName(input.domainName || '')) {
      return this.#failure(operation, input?.appId || '', validationError('Domain Poll requires appId, domainId, and domainName.'), input || {});
    }
    const response = await this.#requestSafe('GET', `/domains/${encodeURIComponent(input.domainId)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const domain = normalizeDomainState(response.data);
    const identityError = validateObservedDomain(domain, input);
    if (identityError) return this.#failure(operation, input.appId, identityError, input);
    if (domain.status === 'verified') return this.#success(operation, input.appId, { domain }, input);
    if (TERMINAL_DOMAIN_STATES.has(domain.status)) {
      return this.#failure(operation, input.appId, {
        code: 'VERIFICATION_FAILED',
        message: `Resend domain reached terminal state ${domain.status}.`,
        retryable: false,
        provider: PROVIDER,
        resourceId: domain.id,
      }, input, { status: 'failed-terminal', data: { domain } });
    }
    if (!WAITING_DOMAIN_STATES.has(domain.status)) {
      return this.#failure(operation, input.appId, providerResponseError(`Resend returned unknown domain status ${domain.status}.`), input);
    }
    return this.#success(operation, input.appId, { domain }, input, {
      status: 'waiting-external',
      warnings: domain.status === 'temporary_failure'
        ? ['Resend temporarily cannot detect a previously verified DNS record.']
        : [],
      nextActions: ['Poll the Resend domain again after nextPollAt.'],
    });
  }

  planSendingKey(input) {
    const operation = 'resend.api-key.plan-sending';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateSendingKeyPlan(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const planFingerprint = sendingKeyPlanFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      keyName: input.keyName,
      permission: 'sending_access',
      domainId: input.domainId,
      domainName: input.domainName,
      destinationSecretRef: input.destinationSecretRef,
      planFingerprint,
      providerMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve one-time key creation only after the destination Secret Sink is writable.'],
    });
  }

  async executeSendingKey(input) {
    const operation = 'resend.api-key.create-sending';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateSendingKeyPlan(input) || validateSendingKeyGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    if (input.planFingerprint !== sendingKeyPlanFingerprint(input)) {
      return this.#failure(operation, input.appId, conflictError('Resend Sending Key plan fingerprint does not match the approved plan.'), input);
    }
    if (
      !this.#secretSink || typeof this.#secretSink.check !== 'function' ||
      typeof this.#secretSink.store !== 'function'
    ) {
      return this.#failure(operation, input.appId, capabilityError('A writable Secret Sink is required before creating a one-time Resend Sending Key.'), input);
    }
    let secretReadiness;
    try {
      secretReadiness = await this.#secretSink.check(input.destinationSecretRef);
      if (!secretReadiness || secretReadiness.ref !== input.destinationSecretRef || secretReadiness.writable !== true) {
        throw new Error('Secret Sink did not confirm the exact writable destination.');
      }
    } catch {
      return this.#failure(operation, input.appId, capabilityError('The destination Secret Sink is not writable; no Resend API call was made.'), input);
    }

    const domainResponse = await this.#requestSafe('GET', `/domains/${encodeURIComponent(input.domainId)}`);
    if (!domainResponse.ok) return this.#providerFailure(operation, input.appId, domainResponse, input);
    const domain = normalizeDomainState(domainResponse.data);
    const domainError = validateObservedDomain(domain, input);
    if (domainError) return this.#failure(operation, input.appId, domainError, input);
    if (domain.status !== 'verified') {
      return this.#failure(operation, input.appId, {
        code: 'VERIFICATION_FAILED',
        message: 'Resend Sending Key creation requires a verified domain.',
        retryable: false,
        provider: PROVIDER,
        resourceId: domain.id,
      }, input);
    }

    const existing = await this.#findApiKeyByName(input.keyName);
    if (existing.error) return this.#providerFailure(operation, input.appId, existing.error, input);
    if (existing.conflict) return this.#failure(operation, input.appId, existing.conflict, input);
    if (existing.apiKey) {
      if (
        input.knownProviderId === existing.apiKey.id && input.knownPlanFingerprint === input.planFingerprint &&
        secretReadiness.present === true
      ) {
        return this.#success(operation, input.appId, {
          apiKey: normalizeApiKey(existing.apiKey),
          created: false,
          adopted: true,
          destinationSecretRef: input.destinationSecretRef,
          providerMutationsExecuted: 0,
          secretValuesExposed: false,
        }, input);
      }
      return this.#failure(operation, input.appId, {
        code: 'SECRET_CAPTURE_REQUIRED',
        message: 'A Resend API Key with this name exists, but its one-time token and approved scope cannot be reconstructed from List API Keys.',
        retryable: false,
        provider: PROVIDER,
        resourceId: existing.apiKey.id,
      }, input, {
        nextActions: ['Confirm the existing Secret Store value or revoke the orphan key before creating another.'],
      });
    }
    if (secretReadiness.present === true) {
      return this.#failure(operation, input.appId, conflictError('The destination Secret Ref is already occupied but no matching recorded Resend API Key exists.'), input, {
        nextActions: ['Use a new destination Secret Ref for rotation or restore the matching provider key state.'],
      });
    }

    const created = await this.#requestSafe('POST', '/api-keys', {
      name: input.keyName,
      permission: 'sending_access',
      domain_id: input.domainId,
    });
    if (!created.ok) {
      if (isUncertainMutation(created)) {
        const recovered = await this.#findApiKeyByName(input.keyName);
        if (recovered.apiKey && !recovered.conflict) {
          return this.#failure(operation, input.appId, {
            code: 'SECRET_CAPTURE_REQUIRED',
            message: 'Resend created a matching API Key, but the one-time token was lost with the provider response.',
            retryable: false,
            provider: PROVIDER,
            resourceId: recovered.apiKey.id,
          }, input, {
            data: { providerMutationsExecuted: 1, duplicateCreatePrevented: true },
            nextActions: ['Revoke the orphan API Key and create a replacement under a new approval.'],
          });
        }
        return this.#failure(operation, input.appId, reconciliationError('Resend API Key Create response was uncertain; automatic retry is disabled to prevent duplicate one-time keys.'), input, {
          data: { providerMutationsExecuted: 1, duplicateCreatePrevented: true },
        });
      }
      return this.#providerFailure(operation, input.appId, created, input);
    }

    const apiKey = normalizeCreatedApiKey(created.data);
    if (apiKey.error) return this.#failure(operation, input.appId, apiKey.error, input, {
      data: {
        providerMutationsExecuted: 1,
        secretCaptured: false,
        ...(SAFE_ID.test(created.data?.id || '') ? { apiKeyId: created.data.id } : {}),
      },
      nextActions: SAFE_ID.test(created.data?.id || '')
        ? ['Revoke the API Key whose one-time token was absent before creating a replacement.']
        : [],
    });
    try {
      const receipt = await this.#secretSink.store(input.destinationSecretRef, apiKey.token, {
        provider: PROVIDER,
        providerId: apiKey.id,
        purpose: 'sending_access',
        domainId: input.domainId,
        planFingerprint: input.planFingerprint,
      });
      if (!receipt || receipt.ref !== input.destinationSecretRef) {
        throw new Error('Secret Sink did not confirm the exact destination Secret Ref.');
      }
    } catch (error) {
      return this.#failure(operation, input.appId, {
        code: 'SECRET_CAPTURE_FAILED',
        message: 'Resend created the Sending Key, but the Secret Sink did not confirm durable capture.',
        retryable: false,
        provider: PROVIDER,
        resourceId: apiKey.id,
      }, input, {
        data: { providerMutationsExecuted: 1, secretCaptured: false, apiKeyId: apiKey.id },
        nextActions: ['Revoke the uncaptured API Key before any replacement attempt.'],
      });
    }
    return this.#success(operation, input.appId, {
      apiKey: { id: apiKey.id, name: input.keyName, permission: 'sending_access', domainId: input.domainId },
      created: true,
      adopted: false,
      destinationSecretRef: input.destinationSecretRef,
      secretCaptured: true,
      providerMutationsExecuted: 1,
      secretValuesExposed: false,
    }, input);
  }

  planTestEmail(input) {
    const operation = 'resend.email.plan-test';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'sending-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateTestEmail(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {});
    const planFingerprint = testEmailPlanFingerprint(input);
    return this.#success(operation, input.appId, {
      mode: 'plan-only',
      domainId: input.domainId,
      domainName: input.domainName,
      fromLocalPart: input.fromLocalPart,
      recipientSecretRef: input.recipientSecretRef,
      domainVerificationFingerprint: input.domainVerificationFingerprint,
      planFingerprint,
      idempotencyKey: testEmailIdempotencyKey(planFingerprint),
      providerMutationsExecuted: 0,
      secretValuesExposed: false,
    }, input, {
      status: 'planned',
      nextActions: ['Approve one test email after the domain-scoped Sending Key and recipient Secret Ref are ready.'],
    });
  }

  async executeTestEmail(input) {
    const operation = 'resend.email.send-test';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'sending-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateTestEmail(input) || validateTestEmailGates(input);
    if (invalid) return this.#failure(operation, input?.appId || '', invalid, input || {}, {
      status: invalid.code === 'APPROVAL_REQUIRED' ? 'needs-approval' : undefined,
    });
    const expectedFingerprint = testEmailPlanFingerprint(input);
    if (input.planFingerprint !== expectedFingerprint) {
      return this.#failure(operation, input.appId, conflictError('Resend test email plan fingerprint does not match the approved plan.'), input);
    }
    const recipient = await this.#readTestRecipient(operation, input);
    if (recipient.result) return recipient.result;
    const idempotencyKey = testEmailIdempotencyKey(input.planFingerprint);
    const response = await this.#requestSafe('POST', '/emails', {
      from: `${input.fromLocalPart}@${input.domainName}`,
      to: [recipient.value],
      subject: `AgentMesh Deploy verification for ${input.appId}`,
      text: 'AgentMesh Deploy email delivery verification.',
      tags: [{ name: 'category', value: 'agentmesh_deploy_verification' }],
    }, { 'idempotency-key': idempotencyKey }, [recipient.value]);
    if (!response.ok) {
      const result = this.#providerFailure(operation, input.appId, response, input);
      if (isUncertainMutation(response)) {
        return this.#failure(operation, input.appId, result.error, input, {
          status: 'failed-retryable',
          data: {
            providerMutationsExecuted: 1,
            duplicateMutationPrevented: true,
            idempotencyKey,
            secretValuesExposed: false,
          },
          nextActions: ['Retry the exact approved request with the same idempotency key within 24 hours.'],
        });
      }
      return result;
    }
    if (!SAFE_ID.test(response.data?.id || '')) {
      return this.#failure(operation, input.appId, providerResponseError('Resend Send Email response is missing a valid Email ID.'), input, {
        data: { providerMutationsExecuted: 1, secretValuesExposed: false },
      });
    }
    return this.#success(operation, input.appId, {
      emailId: response.data.id,
      domainId: input.domainId,
      domainName: input.domainName,
      recipientSecretRef: input.recipientSecretRef,
      planFingerprint: input.planFingerprint,
      idempotencyKey,
      providerMutationsExecuted: 1,
      duplicateMutationPrevented: true,
      secretValuesExposed: false,
    }, input, {
      status: 'waiting-external',
      nextActions: ['Use a Full Access Resend connection to read the exact Email ID until delivery succeeds or fails.'],
    });
  }

  async readTestEmail(input) {
    const operation = 'resend.email.read-test';
    const scopeFailure = this.#requireCredentialScope(operation, input, 'full-access');
    if (scopeFailure) return scopeFailure;
    const invalid = validateTestEmail(input);
    if (invalid || !SAFE_ID.test(input?.emailId || '') || input.planFingerprint !== testEmailPlanFingerprint(input)) {
      return this.#failure(operation, input?.appId || '', invalid || validationError('Resend test email read requires an exact Email ID and matching send plan fingerprint.'), input || {});
    }
    const recipient = await this.#readTestRecipient(operation, input);
    if (recipient.result) return recipient.result;
    const response = await this.#requestSafe('GET', `/emails/${encodeURIComponent(input.emailId)}`, undefined, {}, [recipient.value]);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    const delivery = normalizeTestEmail(response.data, input, recipient.value);
    if (delivery.error) return this.#failure(operation, input.appId, delivery.error, input);
    const data = {
      emailId: delivery.emailId,
      lastEvent: delivery.lastEvent,
      createdAt: delivery.createdAt,
      recipientMatched: true,
      secretValuesExposed: false,
    };
    if (PASSED_EMAIL_STATES.has(delivery.lastEvent)) return this.#success(operation, input.appId, data, input);
    if (WAITING_EMAIL_STATES.has(delivery.lastEvent)) {
      return this.#success(operation, input.appId, data, input, {
        status: 'waiting-external',
        warnings: delivery.lastEvent === 'delivery_delayed' ? ['Resend reports a temporary delivery delay.'] : [],
        nextActions: ['Read the exact Resend Email ID again after the next polling interval.'],
      });
    }
    if (TERMINAL_EMAIL_STATES.has(delivery.lastEvent)) {
      return this.#failure(operation, input.appId, {
        code: 'VERIFICATION_FAILED',
        message: `Resend test email reached terminal event ${delivery.lastEvent}.`,
        retryable: false,
        provider: PROVIDER,
        resourceId: delivery.emailId,
      }, input, { status: 'failed-terminal', data });
    }
    return this.#failure(operation, input.appId, providerResponseError(`Resend returned unknown Email event ${delivery.lastEvent}.`), input);
  }

  deleteDomain(input) {
    return this.#deleteDisabled('resend.domain.delete', input, 'domain, DNS verification state, and sending capability');
  }

  deleteApiKey(input) {
    return this.#deleteDisabled('resend.api-key.delete', input, 'credential before replacement rollout and usage verification');
  }

  async #readDomainResult(operation, input, domainId, created, recoveredAfterUncertainCreate = false) {
    const response = await this.#requestSafe('GET', `/domains/${encodeURIComponent(domainId)}`);
    if (!response.ok) return this.#providerFailure(operation, input.appId, response, input);
    return this.#domainResult(operation, input, response.data, created, recoveredAfterUncertainCreate);
  }

  #domainResult(operation, input, data, created, recoveredAfterUncertainCreate) {
    const normalized = normalizeDomain(data, input, created ? 'managed' : (input.knownProviderId ? 'managed' : 'adopted'));
    if (normalized.error) return this.#failure(operation, input.appId, normalized.error, input);
    if (input.knownProviderId && normalized.resource.providerId !== input.knownProviderId) {
      return this.#failure(operation, input.appId, conflictError('Resend domain identity differs from DeploymentState.'), input);
    }
    return this.#success(operation, input.appId, {
      resource: normalized.resource,
      dnsIntent: normalized.dnsIntent,
      created,
      adopted: !created && !input.knownProviderId,
      changed: created,
      recoveredAfterUncertainCreate,
      idempotency: 'read-before-create',
    }, input);
  }

  async #findDomainByName(name) {
    const listed = await this.#listAll('/domains');
    if (listed.error) return { error: listed.error };
    const matches = listed.items.filter((domain) => domain?.name === name);
    if (matches.length > 1) return { conflict: conflictError('Multiple exact Resend domains match the requested name.') };
    return { domain: matches[0] || null };
  }

  async #findApiKeyByName(name) {
    const listed = await this.#listAll('/api-keys');
    if (listed.error) return { error: listed.error };
    const matches = listed.items.filter((key) => key?.name === name);
    if (matches.length > 1) return { conflict: conflictError('Multiple exact Resend API Keys match the requested name.') };
    return { apiKey: matches[0] || null };
  }

  async #listAll(path) {
    const items = [];
    let after = '';
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (after) query.set('after', after);
      const response = await this.#requestSafe('GET', `${path}?${query.toString()}`);
      if (!response.ok) return { error: response };
      if (!Array.isArray(response.data?.data)) {
        return { error: { ok: false, status: 422, code: 'PROVIDER_RESPONSE_INVALID', message: 'Resend list response is missing data.', data: {} } };
      }
      items.push(...response.data.data);
      if (response.data.has_more !== true) return { items };
      const lastId = response.data.data.at(-1)?.id;
      if (!SAFE_ID.test(lastId || '') || lastId === after) {
        return { error: { ok: false, status: 422, code: 'PROVIDER_RESPONSE_INVALID', message: 'Resend pagination cursor is invalid.', data: {} } };
      }
      after = lastId;
    }
    return { error: { ok: false, status: 422, code: 'PROVIDER_RESPONSE_INVALID', message: 'Resend pagination exceeded the safety bound.', data: {} } };
  }

  async #readTestRecipient(operation, input) {
    if (!this.#secretSource || typeof this.#secretSource.read !== 'function') {
      return { result: this.#failure(operation, input.appId, capabilityError('A Secret Source is required to read the test email recipient.'), input) };
    }
    try {
      const receipt = await this.#secretSource.read(input.recipientSecretRef);
      const value = String(receipt?.value || '').trim().toLowerCase();
      if (!receipt || receipt.ref !== input.recipientSecretRef || !isEmailAddress(value)) {
        throw new Error('Secret Source did not return the exact valid recipient address.');
      }
      return { value };
    } catch {
      return { result: this.#failure(operation, input.appId, capabilityError('The exact test recipient Secret Ref is unavailable or invalid; no Resend request was made.'), input) };
    }
  }

  #requireCredentialScope(operation, input, requiredScope) {
    if (this.#credentialScope === requiredScope) return null;
    return this.#failure(operation, input?.appId || '', capabilityError(
      requiredScope === 'sending-access'
        ? 'Resend test email sending requires a domain-scoped Sending Access connection; Full Access provisioning credentials are rejected.'
        : 'This Resend operation requires a Full Access provisioning connection; Sending Access credentials are restricted to email send.'
    ), input || {});
  }

  async #requestSafe(method, path, body, extraHeaders = {}, secretValues = []) {
    try {
      const response = await this.#transport.request({
        method,
        url: new URL(path, API_BASE).toString(),
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
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

  #deleteDisabled(operation, input, effect) {
    return this.#failure(operation, input?.appId || '', {
      code: 'UNSUPPORTED',
      message: `Resend deletion is disabled because it would remove the ${effect}.`,
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

export function createResendV2AdapterFromConnection(connection, options = {}) {
  if (connection?.provider !== PROVIDER || connection.status !== 'ready') {
    throw new Error('A verified Resend ProviderConnection with status ready is required.');
  }
  const values = resolveConnectionSecretRefs(connection, {
    env: options.env,
    purpose: 'Resend adapter',
  });
  const token = values.RESEND_API_KEY || values.RESEND_SENDING_API_KEY;
  if (!token) throw new Error('Resend requires either a Full Access RESEND_API_KEY or Sending Access RESEND_SENDING_API_KEY connection.');
  return new ResendV2Adapter({
    token,
    credentialScope: values.RESEND_SENDING_API_KEY ? 'sending-access' : 'full-access',
    transport: options.transport,
    httpOptions: options.httpOptions,
    secretSink: options.secretSink,
    secretSource: options.secretSource,
  });
}

function validateDomainEnsure(input) {
  if (!input?.appId || !input.logicalId || !isDomainName(input.name || '') || !input.idempotencyKey) {
    return validationError('Domain Ensure requires appId, logicalId, valid domain name, and idempotencyKey.');
  }
  if (input.region && !DOMAIN_REGIONS.has(input.region)) return validationError('Resend domain region is invalid.');
  if (input.tls && !TLS_MODES.has(input.tls)) return validationError('Resend TLS mode is invalid.');
  if (input.customReturnPath && !/^[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(input.customReturnPath)) {
    return validationError('Resend custom return path is invalid.');
  }
  return null;
}

function validateVerification(input) {
  if (!input?.appId || !SAFE_ID.test(input.domainId || '') || !isDomainName(input.domainName || '')) {
    return validationError('Resend verification requires valid appId, domainId, and domainName.');
  }
  if (!SHA256.test(input.dnsAppliedFingerprint || '')) {
    return validationError('Resend verification requires immutable evidence that the unified DNS plan was applied.');
  }
  return null;
}

function validateVerificationGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    !SHA256.test(input.approvalFingerprint || '') || !SHA256.test(input.planFingerprint || '')
  ) return approvalError('Resend verification requires execute, yes, provider-mutation, plan, and approval gates.');
  return null;
}

function validateSendingKeyPlan(input) {
  if (
    !input?.appId || !KEY_NAME.test(input.keyName || '') || !SAFE_ID.test(input.domainId || '') ||
    !isDomainName(input.domainName || '') || !SECRET_DESTINATION.test(input.destinationSecretRef || '')
  ) return validationError('Resend Sending Key plan requires valid appId, key name, verified domain identity, and writable Secret Ref destination.');
  return null;
}

function validateSendingKeyGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    !SHA256.test(input.approvalFingerprint || '') || !SHA256.test(input.planFingerprint || '')
  ) return approvalError('Resend Sending Key creation requires execute, yes, provider-mutation, plan, and approval gates.');
  return null;
}

function validateTestEmail(input) {
  if (
    !input?.appId || !SAFE_ID.test(input.domainId || '') || !isDomainName(input.domainName || '') ||
    !EMAIL_LOCAL_PART.test(input.fromLocalPart || '') || !SECRET_REFERENCE.test(input.recipientSecretRef || '') ||
    !SHA256.test(input.domainVerificationFingerprint || '')
  ) {
    return validationError('Resend test email requires appId, verified domain identity, lowercase sender local part, recipient Secret Ref, and domain verification fingerprint.');
  }
  return null;
}

function validateTestEmailGates(input) {
  if (
    input.execute !== true || input.yes !== true || input.allowProviderMutations !== true ||
    input.allowCostMutations !== true || !SHA256.test(input.approvalFingerprint || '') ||
    !SHA256.test(input.planFingerprint || '')
  ) return approvalError('Resend test email requires execute, yes, provider-mutation, cost, plan, and approval gates.');
  return null;
}

function normalizeDomain(data, input, lifecycle) {
  const state = normalizeDomainState(data);
  const identityError = validateObservedDomain(state, {
    domainId: input.domainId || input.knownProviderId || state.id,
    domainName: input.name || input.domainName || state.name,
  });
  if (identityError) return { error: identityError };
  const records = normalizeDnsRecords(data.records, state.name);
  if (records.error) return { error: records.error };
  return {
    resource: {
      logicalId: input.logicalId,
      provider: PROVIDER,
      providerId: state.id,
      type: 'email.domain',
      name: state.name,
      lifecycle,
      version: 1,
      attributes: {
        status: state.status,
        region: state.region,
        capabilities: state.capabilities,
        ...pickScalars(data, ['created_at', 'open_tracking', 'click_tracking', 'tracking_subdomain', 'tls']),
      },
    },
    dnsIntent: {
      provider: PROVIDER,
      domainId: state.id,
      domainName: state.name,
      records: records.records,
    },
  };
}

function normalizeDomainState(data) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || '').toLowerCase(),
    status: String(source.status || '').toLowerCase(),
    region: typeof source.region === 'string' ? source.region : '',
    capabilities: {
      sending: source.capabilities?.sending === 'enabled' ? 'enabled' : 'disabled',
      receiving: source.capabilities?.receiving === 'enabled' ? 'enabled' : 'disabled',
    },
  };
}

function validateObservedDomain(domain, input) {
  if (!SAFE_ID.test(domain.id) || domain.id !== input.domainId || !isDomainName(domain.name) || domain.name !== input.domainName.toLowerCase()) {
    return conflictError('Resend returned a domain that does not match the approved identity.');
  }
  if (!domain.status) return providerResponseError('Resend domain response is missing status.');
  return null;
}

function normalizeDnsRecords(value, domainName) {
  if (!Array.isArray(value) || value.length === 0) return { error: providerResponseError('Resend domain response is missing DNS records.') };
  const records = [];
  const identities = new Set();
  for (const item of value) {
    const type = String(item?.type || '').toUpperCase();
    const name = String(item?.name || '').toLowerCase();
    const recordValue = typeof item?.value === 'string' ? item.value : '';
    const priority = item?.priority === undefined ? null : Number(item.priority);
    if (!DNS_TYPES.has(type) || !name || !recordValue || (type === 'MX' && !Number.isInteger(priority))) {
      return { error: providerResponseError('Resend returned an invalid DNS record.') };
    }
    const fqdn = name === domainName || name.endsWith(`.${domainName}`) ? name : `${name}.${domainName}`;
    if (!isDnsName(fqdn)) return { error: providerResponseError('Resend returned an invalid DNS record name.') };
    const identity = `${type}\n${fqdn}\n${recordValue}\n${priority ?? ''}`;
    if (identities.has(identity)) return { error: providerResponseError('Resend returned duplicate DNS records.') };
    identities.add(identity);
    records.push({
      type,
      name,
      fqdn,
      value: recordValue,
      ttl: typeof item.ttl === 'string' || Number.isInteger(item.ttl) ? item.ttl : 'Auto',
      priority,
      purpose: typeof item.record === 'string' ? item.record : '',
      status: typeof item.status === 'string' ? item.status : '',
    });
  }
  records.sort((left, right) => `${left.fqdn}:${left.type}:${left.value}`.localeCompare(`${right.fqdn}:${right.type}:${right.value}`));
  return { records };
}

function normalizeApiKey(data) {
  return {
    ...pickScalars(data || {}, ['id', 'name', 'created_at', 'last_used_at']),
    id: String(data?.id || ''),
    name: String(data?.name || ''),
  };
}

function normalizeCreatedApiKey(data) {
  if (SAFE_ID.test(data?.id || '') && (typeof data?.token !== 'string' || !data.token.startsWith('re_') || data.token.length < 12)) {
    return {
      error: {
        code: 'SECRET_CAPTURE_FAILED',
        message: 'Resend created an API Key ID without returning its one-time token.',
        retryable: false,
        provider: PROVIDER,
        resourceId: data.id,
      },
    };
  }
  if (!SAFE_ID.test(data?.id || '') || typeof data?.token !== 'string' || !data.token.startsWith('re_') || data.token.length < 12) {
    return { error: providerResponseError('Resend API Key response is missing the one-time token or key ID.') };
  }
  return { id: data.id, token: data.token };
}

function normalizeTestEmail(data, input, recipient) {
  const emailId = String(data?.id || '');
  const lastEvent = String(data?.last_event || '').toLowerCase();
  const createdAt = String(data?.created_at || '');
  const recipients = Array.isArray(data?.to) ? data.to.map((value) => String(value || '').trim().toLowerCase()) : [];
  const from = bareEmailAddress(data?.from);
  const expectedFrom = `${input.fromLocalPart}@${input.domainName}`;
  const expectedSubject = `AgentMesh Deploy verification for ${input.appId}`;
  if (
    !SAFE_ID.test(emailId) || emailId !== input.emailId || !lastEvent || !Number.isFinite(Date.parse(createdAt)) ||
    recipients.length !== 1 || recipients[0] !== recipient || from !== expectedFrom || data?.subject !== expectedSubject
  ) return { error: conflictError('Resend returned an Email that does not match the approved test delivery identity.') };
  return { emailId, lastEvent, createdAt };
}

function verificationPlanFingerprint(input) {
  return sha256(JSON.stringify({
    domainId: input.domainId,
    domainName: input.domainName.toLowerCase(),
    dnsAppliedFingerprint: input.dnsAppliedFingerprint,
  }));
}

function sendingKeyPlanFingerprint(input) {
  return sha256(JSON.stringify({
    keyName: input.keyName,
    permission: 'sending_access',
    domainId: input.domainId,
    domainName: input.domainName.toLowerCase(),
    destinationSecretRef: input.destinationSecretRef,
  }));
}

function testEmailPlanFingerprint(input) {
  return sha256(JSON.stringify({
    domainId: input.domainId,
    domainName: input.domainName.toLowerCase(),
    fromLocalPart: input.fromLocalPart,
    recipientSecretRef: input.recipientSecretRef,
    domainVerificationFingerprint: input.domainVerificationFingerprint,
  }));
}

function testEmailIdempotencyKey(planFingerprint) {
  return `agentmesh-test-${planFingerprint}`;
}

function isDomainName(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isDnsName(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label));
}

function isEmailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s<>]/.test(value)) return false;
  const separator = value.lastIndexOf('@');
  if (separator < 1) return false;
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return local.length <= 64 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && isDomainName(domain.toLowerCase());
}

function bareEmailAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/<([^<>]+)>$/);
  return match ? match[1].trim() : text;
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
  let text = String(value || '').replace(/Authorization\s*:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]');
  if (token) text = text.split(token).join('[redacted]');
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/re_[A-Za-z0-9_-]{8,}/g, '[redacted]');
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
