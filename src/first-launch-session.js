import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createArtifact, verifyArtifact } from './artifact.js';
import { showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { generateAdapterExecutionPlan } from './adapter-plan-compiler.js';
import { showApproval } from './approval.js';
import { showBackupEvidence } from './backup-evidence.js';
import { addConnection, listConnections } from './connection-service.js';
import { withControlLock } from './control-lock.js';
import { showDatabaseRuntimeProfile } from './database-runtime-profile.js';
import { createDnsChangeSet, showDnsChangeSet } from './dns-change-set.js';
import { showEmailDeliveryApproval } from './email-delivery-approval.js';
import { showEmailDeliveryPlan } from './email-delivery-plan.js';
import { showEmailDeliveryRun } from './email-delivery-run.js';
import { operationError } from './errors.js';
import {
  createHumanHandoff,
  listHumanHandoffAttestations,
  showHumanHandoff,
} from './human-handoff.js';
import { createProviderBootstrapPlan, showProviderBootstrapPlan } from './provider-bootstrap-plan.js';
import { createLaunchConfiguration, showLaunchConfiguration } from './launch-configuration.js';
import { readLaunchRun } from './launch-run.js';
import { planLaunch, showLaunchGraph } from './launch-service.js';
import { createExternalManifest, showExternalManifest } from './manifest-v2-service.js';
import { showDatabaseMigrationPlan } from './migration-plan.js';
import { projectPath, readProjectRecord, resolveDeployHome, writeJsonAtomic } from './project-store.js';
import {
  showProductVerificationEvidence,
  showProductVerificationPlan,
} from './product-verification.js';
import { assertControlHomeSeparated, captureSourceGuard, completeSourceGuard } from './repository.js';
import { planRecipe, showRecipe } from './recipe-service.js';
import { rollbackApprovalStatusAt, showRollbackApproval } from './rollback-approval.js';
import { showRollbackPlan } from './rollback-plan.js';
import { readRollbackRun } from './rollback-run.js';
import { showSandboxPreflight } from './sandbox-preflight.js';
import {
  estimateSandboxPlanMutations,
  sandboxProfileStatusAt,
  showSandboxProfile,
} from './sandbox-profile.js';
import { nowIso } from './utils.js';
import { createVercelFileManifest } from './vercel-artifact.js';

const SESSION_ID = /^first-launch-[a-f0-9]{24}$/;
const REVISION_ID = /^first-launch-revision-[a-f0-9]{24}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const DATABASE_INSPECT_CHECKPOINTS = Object.freeze([
  'database-inspect-plan-ready',
  'database-inspect-profile-ready',
  'database-inspect-approval-ready',
  'database-inspect-preflight-ready',
  'database-inspect-run-started',
  'database-inspect-stage-succeeded',
]);
const DATABASE_APPLY_CHECKPOINTS = Object.freeze([
  'database-apply-plan-ready',
  'database-runtime-profile-ready',
  'database-apply-profile-ready',
  'database-apply-approval-ready',
  'database-apply-preflight-ready',
  'database-apply-run-started',
  'database-migrated',
]);
const EMAIL_DELIVERY_CHECKPOINTS = Object.freeze([
  'email-delivery-plan-ready',
  'email-delivery-approval-ready',
  'email-delivery-run-started',
  'email-delivery-succeeded',
]);
const CUTOVER_CHECKPOINTS = Object.freeze([
  'cutover-handoff-ready',
  'cutover-plan-ready',
  'cutover-profile-ready',
  'cutover-approval-ready',
  'cutover-preflight-ready',
  'cutover-run-started',
  'cutover-applied',
  ...EMAIL_DELIVERY_CHECKPOINTS,
  'production-verification-observed',
  'production-verified',
]);
const ROLLBACK_CHECKPOINTS = Object.freeze([
  'rollback-plan-ready',
  'rollback-approval-ready',
  'rollback-run-started',
  'rolled-back',
]);

export function startFirstLaunchSession(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  const before = captureSourceGuard(project.source);
  const createdAt = normalizeDate(options.now || nowIso(), 'session creation time');
  const owner = normalizeActor(options.sessionOwner);
  const deadline = normalizeDeadline(options.sessionDeadline, createdAt);
  const recipe = planRecipe({ home, projectId: project.id }).recipe;
  const bootstrap = createProviderBootstrapPlan({
    home,
    projectId: project.id,
    recipeId: recipe.id,
    secretBackend: options.secretBackend,
    platform: options.platform,
    now: createdAt,
  }).plan;
  const bootstrapHandoff = createHumanHandoff({
    home,
    projectId: project.id,
    bootstrapPlanId: bootstrap.id,
    handoffPhase: 'bootstrap',
    handoffOwner: owner,
    handoffDeadline: deadline,
    now: createdAt,
  }).handoff;
  const base = {
    schemaVersion: 1,
    kind: 'FirstLaunchSession',
    projectId: project.id,
    sourceRef: sourceRef(project.source),
    recipeRef: objectRef(recipe),
    bootstrapPlanRef: objectRef(bootstrap),
    bootstrapHandoffRef: objectRef(bootstrapHandoff),
    owner,
    deadline,
    secretBackend: bootstrap.secretBackend,
    workflowVersion: 1,
    status: 'active',
    safety: {
      providerProbesAllowed: false,
      providerMutationsAllowed: false,
      secretValuesAllowed: false,
      browserActionsAllowed: false,
      productRepositoryWritesAllowed: false,
    },
    createdAt,
  };
  const fingerprint = sessionFingerprint(base);
  let session = {
    ...base,
    id: `first-launch-${fingerprint.slice(7, 31)}`,
    fingerprint,
  };
  validateFirstLaunchSession(session, { project, recipe, bootstrap, bootstrapHandoff });
  const stored = withControlLock(home, `project:${project.id}`, 'first-launch-session-start', () => {
    const sessionFile = sessionPath(home, project.id, session.id);
    let reused = false;
    if (fs.existsSync(sessionFile)) {
      session = readSessionFile(sessionFile, { project, recipe, bootstrap, bootstrapHandoff });
      reused = true;
    } else {
      writeJsonAtomic(sessionFile, session);
    }
    return { home, session, sessionFile, reused };
  });
  const revision = ensureInitialRevision(home, project, stored.session, createdAt);
  const report = evaluateSession({ home, project, session: stored.session, revision, now: createdAt });
  return buildReport('start', { ...stored, revision }, report, completeSourceGuard(project.source, before));
}

export function showFirstLaunchSession(options) {
  const context = loadSessionContext(options);
  const report = evaluateSession({
    home: context.home,
    project: context.project,
    session: context.session,
    revision: context.revision,
    now: options.now || nowIso(),
  });
  return buildReport('status', context, report);
}

export function resumeFirstLaunchSession(options) {
  const context = loadSessionContext(options);
  const before = captureSourceGuard(context.project.source);
  const observedAt = options.now || nowIso();
  let revision = context.revision;
  let report = evaluateSession({
    home: context.home,
    project: context.project,
    session: context.session,
    revision,
    now: observedAt,
  });
  const connectionsCreated = [];
  let configurationHandoffCreated = false;
  let candidateControlCreated = false;
  let candidatePlanCreated = false;
  let candidateProfileAdopted = false;
  let candidateApprovalAdopted = false;
  let candidatePreflightAdopted = false;
  let candidateRunAdopted = false;
  let migrationPlanAdopted = false;
  let databaseInspectProfileAdopted = false;
  let databaseInspectApprovalAdopted = false;
  let databaseInspectPreflightAdopted = false;
  let databaseInspectRunAdopted = false;
  let backupEvidenceAdopted = false;
  let databaseRuntimeProfileAdopted = false;
  let databaseApplyProfileAdopted = false;
  let databaseApplyApprovalAdopted = false;
  let databaseApplyPreflightAdopted = false;
  let databaseApplyRunAdopted = false;
  let verificationPlanAdopted = false;
  let candidateEvidenceAdopted = false;
  let cutoverHandoffAdopted = false;
  let cutoverAttestationAdopted = false;
  let cutoverProfileAdopted = false;
  let cutoverApprovalAdopted = false;
  let cutoverPreflightAdopted = false;
  let cutoverRunAdopted = false;
  let emailDeliveryPlanAdopted = false;
  let emailDeliveryApprovalAdopted = false;
  let emailDeliveryRunAdopted = false;
  let productionEvidenceAdopted = false;
  let rollbackPlanAdopted = false;
  let rollbackApprovalAdopted = false;
  let rollbackRunAdopted = false;
  if (report.bootstrapAttestation?.status === 'completed') {
    for (const readiness of report.bootstrapReadiness.filter((item) => item.status === 'missing')) {
      const provider = report.bootstrapPlan.providers.find((item) => item.providerId === readiness.providerId);
      const connection = addConnection({
        home: context.home,
        projectId: context.project.id,
        connectionId: provider.connectionId,
        provider: provider.providerId,
        providerExplicit: true,
        connectionScope: provider.credentialOptions
          .filter((item) => item.selected)
          .map((item) => item.scope)
          .join('+'),
        secretRefs: provider.requiredSecretRefs.map((item) => `${item.env}=${item.ref}`),
        now: observedAt,
      }).connection;
      connectionsCreated.push({ id: connection.id, provider: connection.provider, version: connection.version });
    }
    report = evaluateSession({
      home: context.home,
      project: context.project,
      session: context.session,
      revision,
      now: observedAt,
    });
  }
  if (report.effectiveStatus === 'ready-for-configuration' && !revision.configurationHandoffRef) {
    const configurationRecipe = planRecipe({ home: context.home, projectId: context.project.id }).recipe;
    const bootstrapRecipe = showRecipe({
      home: context.home,
      projectId: context.project.id,
      recipeId: context.session.recipeRef.id,
    }).recipe;
    assertSameProviderStrategy(bootstrapRecipe, configurationRecipe);
    const handoffDeadline = normalizeDeadline(options.sessionDeadline || context.session.deadline, observedAt);
    const configurationHandoff = createHumanHandoff({
      home: context.home,
      projectId: context.project.id,
      bootstrapPlanId: context.session.bootstrapPlanRef.id,
      handoffPhase: 'configuration',
      handoffOwner: context.session.owner,
      handoffDeadline,
      now: observedAt,
    }).handoff;
    revision = appendRevision(context.home, context.project, context.session, revision, {
      checkpoint: 'configuration-human',
      configurationRecipeRef: objectRef(configurationRecipe),
      configurationHandoffRef: objectRef(configurationHandoff),
      createdAt: observedAt,
    });
    configurationHandoffCreated = true;
    report = evaluateSession({
      home: context.home,
      project: context.project,
      session: context.session,
      revision,
      now: observedAt,
    });
  }
  if (options.settings && revision.launchConfigurationRef) {
    const repeated = createLaunchConfiguration({
      home: context.home,
      projectId: context.project.id,
      graphId: revision.graphRef.id,
      settings: options.settings,
      now: observedAt,
    }).configuration;
    if (repeated.id !== revision.launchConfigurationRef.id ||
        repeated.fingerprint !== revision.launchConfigurationRef.fingerprint) {
      throw operationError('CONFLICT', 'Launch settings differ from the immutable First Launch Configuration.');
    }
  } else if (options.settings && report.effectiveStatus !== 'waiting-launch-settings') {
    throw operationError(
      'APPROVAL_REQUIRED',
      'First Launch settings are accepted only after a completed Configuration HumanHandoff Attestation.'
    );
  }
  if (report.effectiveStatus === 'waiting-launch-settings' && options.settings) {
    const controls = ensureCandidateControlObjects({
      home: context.home,
      project: context.project,
      session: context.session,
      revision,
      settings: options.settings,
      now: observedAt,
    });
    revision = appendRevision(context.home, context.project, context.session, revision, {
      checkpoint: 'candidate-control-ready',
      configurationAttestationRef: objectRef(report.configurationAttestation),
      manifestRef: controls.manifestRef,
      artifactRef: controls.artifactRef,
      graphRef: objectRef(controls.graph),
      launchConfigurationRef: objectRef(controls.configuration),
      createdAt: observedAt,
    });
    candidateControlCreated = true;
    report = evaluateSession({
      home: context.home,
      project: context.project,
      session: context.session,
      revision,
      now: observedAt,
    });
  }
  if (report.effectiveStatus === 'ready-for-candidate-plan') {
    const generated = generateAdapterExecutionPlan({
      home: context.home,
      projectId: context.project.id,
      graphId: revision.graphRef.id,
      configurationId: revision.launchConfigurationRef.id,
      now: observedAt,
    });
    if (!generated.plan || generated.compilation.actions.length === 0) {
      throw operationError('UNSUPPORTED', 'First Launch Candidate Adapter Plan has no executable provider actions.');
    }
    revision = appendRevision(context.home, context.project, context.session, revision, {
      checkpoint: 'candidate-plan-ready',
      adapterPlanRef: objectRef(generated.plan),
      createdAt: observedAt,
    });
    candidatePlanCreated = true;
    report = evaluateSession({
      home: context.home,
      project: context.project,
      session: context.session,
      revision,
      now: observedAt,
    });
  }
  if (options.migrationPlanId) {
    if (!report.candidateControl?.recipe.requirements.database) {
      throw operationError('CAPABILITY_MISSING', 'A project without a database cannot adopt a Database Migration Plan.');
    }
    if (revision.migrationPlanRef && revision.migrationPlanRef.id !== options.migrationPlanId) {
      throw operationError('CONFLICT', 'Database Migration Plan cannot replace the immutable First Launch binding.');
    }
    if (!revision.migrationPlanRef) {
      if (report.effectiveStatus !== 'candidate-provider-stage-succeeded') {
        throw operationError('CONFLICT', 'Database Migration Plan can only be adopted after Candidate provider execution succeeds.');
      }
      const migrationPlan = showDatabaseMigrationPlan({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        planId: options.migrationPlanId,
      }).plan;
      if (migrationPlan.status === 'blocked') {
        throw operationError('APPROVAL_REQUIRED', 'Blocked Database Migration Plan cannot enter the First Launch workflow.');
      }
      const generated = generateAdapterExecutionPlan({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        migrationPlanId: migrationPlan.id,
        now: observedAt,
      });
      assertDatabaseInspectPlanShape(generated.plan, migrationPlan);
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'database-inspect-plan-ready',
        migrationPlanRef: objectRef(migrationPlan),
        databaseInspectPlanRef: objectRef(generated.plan),
        createdAt: observedAt,
      });
      migrationPlanAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.sandboxProfileId && report.effectiveStatus === 'waiting-cutover-profile') {
    const current = latestRef(revision.cutoverProfileRefs);
    if (!current || current.id !== options.sandboxProfileId) {
      const profile = adoptCutoverSandboxProfile({
        home: context.home, project: context.project, session: context.session, revision,
        profileId: options.sandboxProfileId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'cutover-profile-ready'),
        cutoverProfileRefs: [...revision.cutoverProfileRefs, objectRef(profile)],
        createdAt: observedAt,
      });
      cutoverProfileAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.sandboxProfileId && report.effectiveStatus === 'waiting-database-apply-profile') {
    const current = latestRef(revision.databaseApplyProfileRefs);
    if (!current || current.id !== options.sandboxProfileId) {
      const profile = adoptDatabaseApplySandboxProfile({
        home: context.home, project: context.project, session: context.session, revision,
        profileId: options.sandboxProfileId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'database-apply-profile-ready'),
        databaseApplyProfileRefs: [...revision.databaseApplyProfileRefs, objectRef(profile)],
        createdAt: observedAt,
      });
      databaseApplyProfileAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.sandboxProfileId && report.effectiveStatus === 'waiting-database-inspect-profile') {
    const current = latestRef(revision.databaseInspectProfileRefs);
    if (!current || current.id !== options.sandboxProfileId) {
      const profile = adoptDatabaseInspectSandboxProfile({
        home: context.home, project: context.project, session: context.session, revision,
        profileId: options.sandboxProfileId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'database-inspect-profile-ready'),
        databaseInspectProfileRefs: [...revision.databaseInspectProfileRefs, objectRef(profile)],
        createdAt: observedAt,
      });
      databaseInspectProfileAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.sandboxProfileId) {
    const current = latestRef(revision.sandboxProfileRefs);
    if (!current || current.id !== options.sandboxProfileId) {
      if (!sessionRequestsCandidateControl(report, 'waiting-sandbox-profile')) {
        throw operationError('CONFLICT', 'A new Sandbox Profile can only be adopted when the First Launch Session requests one.');
      }
      const profile = adoptCandidateSandboxProfile({
        home: context.home, project: context.project, session: context.session, revision,
        profileId: options.sandboxProfileId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'candidate-profile-ready'),
        sandboxProfileRefs: [...revision.sandboxProfileRefs, objectRef(profile)],
        createdAt: observedAt,
      });
      candidateProfileAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.approvalId && report.effectiveStatus === 'waiting-cutover-approval') {
    const current = latestRef(revision.cutoverApprovalRefs);
    if (!current || current.id !== options.approvalId) {
      const approval = adoptCutoverApproval({
        home: context.home, project: context.project, session: context.session, revision,
        approvalId: options.approvalId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'cutover-approval-ready'),
        cutoverApprovalRefs: [...revision.cutoverApprovalRefs, objectRef(approval)],
        createdAt: observedAt,
      });
      cutoverApprovalAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.approvalId && report.effectiveStatus === 'waiting-database-apply-approval') {
    const current = latestRef(revision.databaseApplyApprovalRefs);
    if (!current || current.id !== options.approvalId) {
      const approval = adoptDatabaseApplyApproval({
        home: context.home, project: context.project, session: context.session, revision,
        approvalId: options.approvalId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'database-apply-approval-ready'),
        databaseApplyApprovalRefs: [...revision.databaseApplyApprovalRefs, objectRef(approval)],
        createdAt: observedAt,
      });
      databaseApplyApprovalAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.approvalId && report.effectiveStatus === 'waiting-database-inspect-approval') {
    const current = latestRef(revision.databaseInspectApprovalRefs);
    if (!current || current.id !== options.approvalId) {
      const approval = adoptDatabaseInspectApproval({
        home: context.home, project: context.project, session: context.session, revision,
        approvalId: options.approvalId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'database-inspect-approval-ready'),
        databaseInspectApprovalRefs: [...revision.databaseInspectApprovalRefs, objectRef(approval)],
        createdAt: observedAt,
      });
      databaseInspectApprovalAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.approvalId) {
    const current = latestRef(revision.candidateApprovalRefs);
    if (!current || current.id !== options.approvalId) {
      if (!sessionRequestsCandidateControl(report, 'waiting-candidate-approval')) {
        throw operationError('CONFLICT', 'A new Candidate Approval can only be adopted when the First Launch Session requests one.');
      }
      const approval = adoptCandidateApproval({
        home: context.home, project: context.project, session: context.session, revision,
        approvalId: options.approvalId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'candidate-approval-ready'),
        candidateApprovalRefs: [...revision.candidateApprovalRefs, objectRef(approval)],
        createdAt: observedAt,
      });
      candidateApprovalAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.sandboxPreflightId && report.effectiveStatus === 'waiting-cutover-preflight') {
    const current = latestRef(revision.cutoverPreflightRefs);
    if (!current || current.id !== options.sandboxPreflightId) {
      const adopted = adoptCutoverPreflight({
        home: context.home, project: context.project, session: context.session, revision,
        preflightId: options.sandboxPreflightId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'cutover-preflight-ready'),
        cutoverPreflightRefs: [
          ...revision.cutoverPreflightRefs,
          preflightReference(adopted.evidence, adopted.approval),
        ],
        createdAt: observedAt,
      });
      cutoverPreflightAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.sandboxPreflightId && report.effectiveStatus === 'waiting-database-apply-preflight') {
    const current = latestRef(revision.databaseApplyPreflightRefs);
    if (!current || current.id !== options.sandboxPreflightId) {
      const adopted = adoptDatabaseApplyPreflight({
        home: context.home, project: context.project, session: context.session, revision,
        preflightId: options.sandboxPreflightId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'database-apply-preflight-ready'),
        databaseApplyPreflightRefs: [
          ...revision.databaseApplyPreflightRefs,
          databasePreflightReference(adopted.evidence, adopted.approval, adopted.databaseRuntimeProfile),
        ],
        createdAt: observedAt,
      });
      databaseApplyPreflightAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.sandboxPreflightId && report.effectiveStatus === 'waiting-database-inspect-preflight') {
    const current = latestRef(revision.databaseInspectPreflightRefs);
    if (!current || current.id !== options.sandboxPreflightId) {
      const adopted = adoptDatabaseInspectPreflight({
        home: context.home, project: context.project, session: context.session, revision,
        preflightId: options.sandboxPreflightId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'database-inspect-preflight-ready'),
        databaseInspectPreflightRefs: [
          ...revision.databaseInspectPreflightRefs,
          preflightReference(adopted.evidence, adopted.approval),
        ],
        createdAt: observedAt,
      });
      databaseInspectPreflightAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.sandboxPreflightId) {
    const current = latestRef(revision.sandboxPreflightRefs);
    if (!current || current.id !== options.sandboxPreflightId) {
      if (!sessionRequestsCandidateControl(report, 'waiting-sandbox-preflight')) {
        throw operationError('CONFLICT', 'A new Sandbox Preflight can only be adopted when the First Launch Session requests one.');
      }
      const adopted = adoptCandidatePreflight({
        home: context.home, project: context.project, session: context.session, revision,
        preflightId: options.sandboxPreflightId, now: observedAt,
      });
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'candidate-preflight-ready'),
        sandboxPreflightRefs: [...revision.sandboxPreflightRefs, preflightReference(adopted.evidence, adopted.approval)],
        createdAt: observedAt,
      });
      candidatePreflightAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.runId && isFirstLaunchRollbackRunStatus(report.effectiveStatus)) {
    const current = latestRef(revision.rollbackRunRefs);
    const run = adoptFirstLaunchRollbackRun({
      home: context.home, project: context.project, revision, runId: options.runId, now: observedAt,
    });
    if (!current || current.id !== run.id || current.revision !== run.revision) {
      if (current && current.id !== run.id) {
        throw operationError('CONFLICT', 'A different Rollback Run cannot replace the bound recovery Run.');
      }
      if (current && run.revision <= current.revision) {
        throw operationError('CONFLICT', 'Rollback Run Revision must advance monotonically.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: run.status === 'succeeded' ? 'rolled-back' : 'rollback-run-started',
        rollbackRunRefs: [...revision.rollbackRunRefs, rollbackRunReference(run)],
        createdAt: observedAt,
      });
      rollbackRunAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.runId && isCutoverRunStatus(report.effectiveStatus)) {
    const current = latestRef(revision.cutoverRunRefs);
    const run = adoptCutoverRun({
      home: context.home, project: context.project, revision, runId: options.runId, now: observedAt,
    });
    if (!current || current.id !== run.id || current.revision !== run.revision) {
      if (current && current.id !== run.id && ![
        'cutover-run-failed', 'cutover-run-authorization-expired',
      ].includes(report.effectiveStatus)) {
        throw operationError('CONFLICT', 'A different Cutover LaunchRun cannot replace an active or successful Run.');
      }
      if (current && current.id === run.id && run.revision <= current.revision) {
        throw operationError('CONFLICT', 'Cutover LaunchRun Revision must advance monotonically.');
      }
      const plan = showBoundCutoverPlan({
        home: context.home, project: context.project, revision,
        candidateControl: report.candidateControl,
      }).plan;
      const classification = classifyStageRun(run, plan, 'cutover-applied', 'cutover-run');
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: classification.status === 'cutover-applied' ? 'cutover-applied' : 'cutover-run-started',
        cutoverRunRefs: [...revision.cutoverRunRefs, candidateRunReference(run)],
        createdAt: observedAt,
      });
      cutoverRunAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.runId && isDatabaseApplyRunStatus(report.effectiveStatus)) {
    const current = latestRef(revision.databaseApplyRunRefs);
    const run = adoptDatabaseApplyRun({
      home: context.home, project: context.project, revision, runId: options.runId, now: observedAt,
    });
    if (!current || current.id !== run.id || current.revision !== run.revision) {
      if (current && current.id !== run.id && ![
        'database-apply-run-failed', 'database-apply-run-authorization-expired',
      ].includes(report.effectiveStatus)) {
        throw operationError('CONFLICT', 'A different Database Apply LaunchRun cannot replace an active or successful Run.');
      }
      if (current && current.id === run.id && run.revision <= current.revision) {
        throw operationError('CONFLICT', 'Database Apply LaunchRun Revision must advance monotonically.');
      }
      const plan = showBoundDatabaseApplyPlan({
        home: context.home, project: context.project, revision,
        candidateControl: report.candidateControl,
      }).plan;
      const classification = classifyStageRun(run, plan, 'database-migrated', 'database-apply-run');
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: classification.status === 'database-migrated'
          ? 'database-migrated'
          : 'database-apply-run-started',
        databaseApplyRunRefs: [...revision.databaseApplyRunRefs, databaseRunReference(run)],
        createdAt: observedAt,
      });
      databaseApplyRunAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.runId && isDatabaseInspectRunStatus(report.effectiveStatus)) {
    const current = latestRef(revision.databaseInspectRunRefs);
    const run = adoptDatabaseInspectRun({
      home: context.home, project: context.project, revision, runId: options.runId, now: observedAt,
    });
    if (!current || current.id !== run.id || current.revision !== run.revision) {
      if (current && current.id !== run.id && ![
        'database-inspect-run-failed', 'database-inspect-run-authorization-expired',
      ].includes(report.effectiveStatus)) {
        throw operationError('CONFLICT', 'A different Database Inspect LaunchRun cannot replace an active or successful Run.');
      }
      if (current && current.id === run.id && run.revision <= current.revision) {
        throw operationError('CONFLICT', 'Database Inspect LaunchRun Revision must advance monotonically.');
      }
      const plan = showBoundDatabaseInspectPlan({
        home: context.home, project: context.project, revision,
        candidateControl: report.candidateControl,
      }).plan;
      const classification = classifyStageRun(run, plan, 'database-inspect-stage-succeeded', 'database-inspect-run');
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: classification.status === 'database-inspect-stage-succeeded'
          ? 'database-inspect-stage-succeeded'
          : 'database-inspect-run-started',
        databaseInspectRunRefs: [...revision.databaseInspectRunRefs, candidateRunReference(run)],
        createdAt: observedAt,
      });
      databaseInspectRunAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  } else if (options.runId) {
    if (!revision.graphRef || !revision.adapterPlanRef || revision.sandboxProfileRefs.length === 0 ||
        revision.sandboxPreflightRefs.length === 0) {
      throw operationError('APPROVAL_REQUIRED', 'Candidate LaunchRun can only be adopted after Candidate authorization is complete.');
    }
    const current = latestRef(revision.candidateRunRefs);
    const run = adoptCandidateRun({
      home: context.home, project: context.project, revision, runId: options.runId, now: observedAt,
    });
    if (!current || current.id !== run.id || current.revision !== run.revision) {
      if (current && current.id !== run.id && ![
        'candidate-run-failed', 'candidate-run-authorization-expired',
      ].includes(report.effectiveStatus)) {
        throw operationError('CONFLICT', 'A different Candidate LaunchRun cannot replace an active or successful Run.');
      }
      if (current && current.id === run.id && run.revision <= current.revision) {
        throw operationError('CONFLICT', 'Candidate LaunchRun Revision must advance monotonically.');
      }
      const classification = classifyCandidateRun(run, report.candidateAuthorization.plan);
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(
          revision.checkpoint,
          classification.status === 'candidate-provider-stage-succeeded'
            ? 'candidate-provider-stage-succeeded'
            : 'candidate-run-started'
        ),
        candidateRunRefs: [...revision.candidateRunRefs, candidateRunReference(run)],
        createdAt: observedAt,
      });
      candidateRunAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.backupEvidenceId) {
    if (revision.backupEvidenceRef && revision.backupEvidenceRef.id !== options.backupEvidenceId) {
      throw operationError('CONFLICT', 'Backup Evidence cannot replace the immutable First Launch binding.');
    }
    if (!revision.backupEvidenceRef) {
      if (report.effectiveStatus !== 'database-inspect-stage-succeeded') {
        throw operationError('CONFLICT', 'Backup Evidence can only be adopted after Database Inspect and Backup succeed.');
      }
      const shown = showBackupEvidence({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        adapterPlanId: revision.databaseInspectPlanRef.id,
        evidenceId: options.backupEvidenceId,
      });
      const evidence = shown.evidence;
      if (evidence.status !== 'verified' || evidence.migrationPlanId !== revision.migrationPlanRef.id ||
          evidence.migrationPlanFingerprint !== revision.migrationPlanRef.fingerprint) {
        throw operationError('APPROVAL_REQUIRED', 'First Launch requires verified Backup Evidence for the bound Migration Plan.');
      }
      const generated = generateAdapterExecutionPlan({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        migrationPlanId: revision.migrationPlanRef.id,
        backupEvidenceId: evidence.id,
        now: observedAt,
      });
      assertDatabaseApplyPlanShape(generated.plan, report.databaseMigration.migrationPlan, evidence);
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'database-apply-plan-ready',
        backupEvidenceRef: objectRef(evidence),
        databaseApplyPlanRef: objectRef(generated.plan),
        createdAt: observedAt,
      });
      backupEvidenceAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.databaseRuntimeProfileId) {
    const current = latestRef(revision.databaseRuntimeProfileRefs);
    if (!current || current.id !== options.databaseRuntimeProfileId) {
      if (report.effectiveStatus !== 'waiting-database-runtime-profile') {
        throw operationError('CONFLICT', 'Database Runtime Profile can only be adopted for the bound Migration Apply Plan.');
      }
      const shown = showDatabaseRuntimeProfile({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        adapterPlanId: revision.databaseApplyPlanRef.id,
        profileId: options.databaseRuntimeProfileId,
        now: observedAt,
      });
      if (shown.effectiveStatus !== 'active' || shown.profile.approvedBy !== context.session.owner) {
        throw operationError('APPROVAL_REQUIRED', 'Database Runtime Profile must be active and approved by the First Launch owner.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: furthestCheckpoint(revision.checkpoint, 'database-runtime-profile-ready'),
        databaseRuntimeProfileRefs: [...revision.databaseRuntimeProfileRefs, objectRef(shown.profile)],
        createdAt: observedAt,
      });
      databaseRuntimeProfileAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.verificationPlanId) {
    if (report.candidateControl?.recipe.requirements.database && report.effectiveStatus !== 'database-migrated') {
      throw operationError('APPROVAL_REQUIRED', 'Database projects must complete the Migration stage before Candidate Verification.');
    }
    const current = revision.verificationPlanRef;
    if (!current || current.id !== options.verificationPlanId) {
      if (!['candidate-provider-stage-succeeded', 'database-migrated'].includes(report.effectiveStatus)) {
        throw operationError('CONFLICT', 'Product Verification Plan can only be adopted after Candidate provider execution succeeds.');
      }
      const plan = showProductVerificationPlan({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        planId: options.verificationPlanId,
      }).plan;
      if (!plan.checks.some((check) => check.phase === 'candidate' && check.required)) {
        throw operationError('VALIDATION_FAILED', 'Product Verification Plan has no required Candidate checks.');
      }
      if (report.candidateControl?.recipe.requirements.database &&
          !plan.checks.some((check) => check.phase === 'candidate' && check.required && check.capability === 'database')) {
        throw operationError('VALIDATION_FAILED', 'Database Product Verification Plan requires a Candidate database evidence check.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'verification-plan-ready',
        verificationPlanRef: objectRef(plan),
        createdAt: observedAt,
      });
      verificationPlanAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.candidateEvidenceId) {
    const current = revision.candidateEvidenceRef;
    if (!current || current.id !== options.candidateEvidenceId) {
      if (report.effectiveStatus !== 'waiting-candidate-verification') {
        throw operationError('CONFLICT', 'Candidate Evidence can only be adopted for the bound Product Verification Plan.');
      }
      const shown = showProductVerificationEvidence({
        home: context.home, projectId: context.project.id, evidenceId: options.candidateEvidenceId,
      });
      const evidence = shown.evidence;
      if (evidence.phase !== 'candidate' || evidence.status !== 'passed' ||
          evidence.planId !== revision.verificationPlanRef.id ||
          evidence.planFingerprint !== revision.verificationPlanRef.fingerprint ||
          Date.parse(observedAt) < Date.parse(evidence.createdAt)) {
        throw operationError('APPROVAL_REQUIRED', 'First Launch requires current passed Candidate Product Verification Evidence.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'candidate-verified',
        candidateEvidenceRef: objectRef(evidence),
        createdAt: observedAt,
      });
      candidateEvidenceAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.cutoverHandoffId) {
    const current = revision.cutoverHandoffRef;
    if (!current || current.id !== options.cutoverHandoffId) {
      if (report.effectiveStatus !== 'candidate-verified') {
        throw operationError('CONFLICT', 'Cutover HumanHandoff can only be adopted after Candidate verification passes.');
      }
      const handoff = showHumanHandoff({
        home: context.home, projectId: context.project.id, handoffId: options.cutoverHandoffId,
      }).handoff;
      if (handoff.phase !== 'cutover' || handoff.owner !== context.session.owner ||
          handoff.candidateEvidenceRef?.id !== revision.candidateEvidenceRef.id ||
          handoff.candidateEvidenceRef?.fingerprint !== revision.candidateEvidenceRef.fingerprint ||
          Date.parse(observedAt) < Date.parse(handoff.createdAt)) {
        throw operationError('APPROVAL_REQUIRED', 'Cutover HumanHandoff does not bind the current Candidate Evidence and Session owner.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'cutover-handoff-ready',
        cutoverHandoffRef: objectRef(handoff),
        createdAt: observedAt,
      });
      cutoverHandoffAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.cutoverAttestationId) {
    const current = revision.cutoverAttestationRef;
    if (!current || current.id !== options.cutoverAttestationId) {
      if (report.effectiveStatus !== 'waiting-cutover-attestation') {
        throw operationError('CONFLICT', 'Cutover Attestation can only be adopted for the bound Cutover Handoff.');
      }
      const shown = showHumanHandoff({
        home: context.home,
        projectId: context.project.id,
        handoffId: revision.cutoverHandoffRef.id,
        handoffAttestationId: options.cutoverAttestationId,
      });
      const attestation = shown.attestation;
      if (attestation.status !== 'completed' || attestation.actor !== context.session.owner ||
          Date.parse(observedAt) < Date.parse(attestation.createdAt)) {
        throw operationError('APPROVAL_REQUIRED', 'Cutover Attestation must be completed by the First Launch owner.');
      }
      const changeSet = createDnsChangeSet({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        now: observedAt,
      }).changeSet;
      const generated = generateAdapterExecutionPlan({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        changeSetId: changeSet.id,
        now: observedAt,
      });
      assertCutoverPlanShape(generated.plan, changeSet);
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'cutover-plan-ready',
        cutoverAttestationRef: objectRef(attestation),
        dnsChangeSetRef: objectRef(changeSet),
        cutoverPlanRef: objectRef(generated.plan),
        createdAt: observedAt,
      });
      cutoverAttestationAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.emailDeliveryPlanId) {
    const current = revision.emailDeliveryPlanRef;
    if (!current || current.id !== options.emailDeliveryPlanId) {
      if (report.effectiveStatus !== 'waiting-email-delivery-plan') {
        throw operationError('CONFLICT', 'Email Delivery Plan can only be adopted after the Cutover Run succeeds.');
      }
      const shown = showEmailDeliveryPlan({
        home: context.home, projectId: context.project.id, planId: options.emailDeliveryPlanId,
      });
      const plan = shown.plan;
      const emailCheck = report.candidateVerification.plan.checks.find((check) =>
        check.id === 'production.email.delivery' && check.required
      );
      if (!emailCheck || plan.graphId !== revision.graphRef.id ||
          plan.graphFingerprint !== revision.graphRef.fingerprint ||
          plan.configurationId !== revision.launchConfigurationRef.id ||
          plan.configurationFingerprint !== revision.launchConfigurationRef.fingerprint ||
          plan.verificationPlanId !== revision.verificationPlanRef.id ||
          plan.verificationPlanFingerprint !== revision.verificationPlanRef.fingerprint ||
          plan.recipientSecretRef !== emailCheck.secretRefs[0]) {
        throw operationError('APPROVAL_REQUIRED', 'Email Delivery Plan does not bind the current production verification contract.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'email-delivery-plan-ready',
        emailDeliveryPlanRef: objectRef(plan),
        createdAt: observedAt,
      });
      emailDeliveryPlanAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.emailDeliveryApprovalId) {
    const current = latestRef(revision.emailDeliveryApprovalRefs);
    if (!current || current.id !== options.emailDeliveryApprovalId) {
      if (report.effectiveStatus !== 'waiting-email-delivery-approval') {
        throw operationError('CONFLICT', 'Email Delivery Approval can only be adopted for the bound Email Delivery Plan.');
      }
      const shown = showEmailDeliveryApproval({
        home: context.home, projectId: context.project.id,
        approvalId: options.emailDeliveryApprovalId, now: observedAt,
      });
      if (shown.effectiveStatus !== 'active' || shown.approval.approvedBy !== context.session.owner ||
          shown.approval.emailDeliveryPlanId !== revision.emailDeliveryPlanRef.id ||
          shown.approval.emailDeliveryPlanFingerprint !== revision.emailDeliveryPlanRef.fingerprint) {
        throw operationError('APPROVAL_REQUIRED', 'Email Delivery Approval must be active, owner-approved, and bind the current Plan.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'email-delivery-approval-ready',
        emailDeliveryApprovalRefs: [...revision.emailDeliveryApprovalRefs, objectRef(shown.approval)],
        createdAt: observedAt,
      });
      emailDeliveryApprovalAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.emailDeliveryRunId) {
    const current = latestRef(revision.emailDeliveryRunRefs);
    const shown = showEmailDeliveryRun({
      home: context.home, projectId: context.project.id, runId: options.emailDeliveryRunId, now: observedAt,
    });
    const run = shown.run;
    if (!current || current.id !== run.id || current.revision < run.revision) {
      if (![
        'ready-for-email-delivery-apply', 'email-delivery-run-resumable',
        'email-delivery-run-update-available', 'email-delivery-run-authorization-expired',
      ].includes(report.effectiveStatus)) {
        throw operationError('CONFLICT', 'Email Delivery Run can only be adopted for the bound Plan and Approval.');
      }
      const approvalRef = latestRef(revision.emailDeliveryApprovalRefs);
      const runApproval = showEmailDeliveryApproval({
        home: context.home, projectId: context.project.id, approvalId: run.approvalId, now: observedAt,
      });
      if (run.emailDeliveryPlanId !== revision.emailDeliveryPlanRef.id ||
          run.emailDeliveryPlanFingerprint !== revision.emailDeliveryPlanRef.fingerprint ||
          run.approvalFingerprint !== runApproval.approval.fingerprint ||
          runApproval.approval.approvedBy !== context.session.owner ||
          runApproval.approval.emailDeliveryPlanId !== revision.emailDeliveryPlanRef.id ||
          runApproval.approval.emailDeliveryPlanFingerprint !== revision.emailDeliveryPlanRef.fingerprint ||
          (run.send.attempt === 0 && runApproval.effectiveStatus !== 'active')) {
        throw operationError('APPROVAL_REQUIRED', 'Email Delivery Run does not bind the current Plan and owner Approval.');
      }
      const approvalRefs = approvalRef?.id === runApproval.approval.id
        ? revision.emailDeliveryApprovalRefs
        : [...revision.emailDeliveryApprovalRefs, objectRef(runApproval.approval)];
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: run.status === 'succeeded'
          ? 'email-delivery-succeeded'
          : furthestCheckpoint(revision.checkpoint, 'email-delivery-run-started'),
        emailDeliveryApprovalRefs: approvalRefs,
        emailDeliveryRunRefs: [...revision.emailDeliveryRunRefs, emailDeliveryRunReference(run)],
        createdAt: observedAt,
      });
      emailDeliveryRunAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    } else if (current.fingerprint !== run.fingerprint || current.revision !== run.revision) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Email Delivery Run Revision moved backwards or changed.');
    }
  }
  if (options.productionEvidenceId) {
    const current = latestRef(revision.productionVerificationRefs);
    if (!current || current.id !== options.productionEvidenceId) {
      if (![
        'waiting-production-verification',
        'production-verification-failed',
        'production-verification-needs-human',
      ].includes(report.effectiveStatus)) {
        throw operationError('CONFLICT', 'Production Evidence can only be adopted after the Cutover Run succeeds.');
      }
      const shown = showProductVerificationEvidence({
        home: context.home, projectId: context.project.id, evidenceId: options.productionEvidenceId,
      });
      const evidence = shown.evidence;
      if (evidence.phase !== 'production' ||
          evidence.planId !== revision.verificationPlanRef.id ||
          evidence.planFingerprint !== revision.verificationPlanRef.fingerprint ||
          Date.parse(observedAt) < Date.parse(evidence.createdAt)) {
        throw operationError('APPROVAL_REQUIRED', 'First Launch requires current Production Verification Evidence.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: evidence.status === 'passed' ? 'production-verified' : 'production-verification-observed',
        productionVerificationRefs: [...revision.productionVerificationRefs, objectRef(evidence)],
        ...(evidence.status === 'passed' ? { productionEvidenceRef: objectRef(evidence) } : {}),
        createdAt: observedAt,
      });
      productionEvidenceAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.rollbackPlanId) {
    const current = revision.rollbackPlanRef;
    if (!current || current.id !== options.rollbackPlanId) {
      if (report.effectiveStatus !== 'production-verification-failed') {
        throw operationError('CONFLICT', 'Rollback Plan can only be adopted after failed Production Verification.');
      }
      const plan = showRollbackPlan({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        planId: options.rollbackPlanId,
      }).plan;
      const failedEvidence = latestProductionEvidence(report);
      if (plan.trigger.evidenceId !== failedEvidence.id ||
          plan.trigger.evidenceFingerprint !== failedEvidence.fingerprint ||
          plan.trigger.status !== 'failed') {
        throw operationError('APPROVAL_REQUIRED', 'Rollback Plan does not bind the current failed Production Evidence.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'rollback-plan-ready',
        rollbackPlanRef: objectRef(plan),
        createdAt: observedAt,
      });
      rollbackPlanAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  if (options.rollbackApprovalId) {
    const current = latestRef(revision.rollbackApprovalRefs);
    if (!current || current.id !== options.rollbackApprovalId) {
      if (report.effectiveStatus !== 'waiting-rollback-approval') {
        throw operationError('CONFLICT', 'Rollback Approval can only be adopted for the bound ready Rollback Plan.');
      }
      const shown = showRollbackApproval({
        home: context.home,
        projectId: context.project.id,
        graphId: revision.graphRef.id,
        configurationId: revision.launchConfigurationRef.id,
        approvalId: options.rollbackApprovalId,
        now: observedAt,
      });
      const required = requiredRollbackStepIds(report.cutover.rollback.plan);
      if (shown.effectiveStatus !== 'active' || shown.approval.approvedBy !== context.session.owner ||
          shown.approval.rollbackPlanId !== revision.rollbackPlanRef.id ||
          shown.approval.rollbackPlanFingerprint !== revision.rollbackPlanRef.fingerprint ||
          !required.every((stepId) => shown.approval.stepIds.includes(stepId))) {
        throw operationError('APPROVAL_REQUIRED', 'Rollback Approval must be active, owner-approved, and cover every recovery mutation.');
      }
      revision = appendRevision(context.home, context.project, context.session, revision, {
        checkpoint: 'rollback-approval-ready',
        rollbackApprovalRefs: [...revision.rollbackApprovalRefs, objectRef(shown.approval)],
        createdAt: observedAt,
      });
      rollbackApprovalAdopted = true;
      report = evaluateSession({
        home: context.home, project: context.project, session: context.session, revision, now: observedAt,
      });
    }
  }
  return buildReport(
    'resume',
    {
      ...context,
      revision,
      connectionsCreated,
      configurationHandoffCreated,
      candidateControlCreated,
      candidatePlanCreated,
      candidateProfileAdopted,
      candidateApprovalAdopted,
      candidatePreflightAdopted,
      candidateRunAdopted,
      migrationPlanAdopted,
      databaseInspectProfileAdopted,
      databaseInspectApprovalAdopted,
      databaseInspectPreflightAdopted,
      databaseInspectRunAdopted,
      backupEvidenceAdopted,
      databaseRuntimeProfileAdopted,
      databaseApplyProfileAdopted,
      databaseApplyApprovalAdopted,
      databaseApplyPreflightAdopted,
      databaseApplyRunAdopted,
      verificationPlanAdopted,
      candidateEvidenceAdopted,
      cutoverHandoffAdopted,
      cutoverAttestationAdopted,
      cutoverProfileAdopted,
      cutoverApprovalAdopted,
      cutoverPreflightAdopted,
      cutoverRunAdopted,
      emailDeliveryPlanAdopted,
      emailDeliveryApprovalAdopted,
      emailDeliveryRunAdopted,
      productionEvidenceAdopted,
      rollbackPlanAdopted,
      rollbackApprovalAdopted,
      rollbackRunAdopted,
    },
    report,
    completeSourceGuard(context.project.source, before)
  );
}

export function validateFirstLaunchSession(session, expected = {}) {
  const issues = [];
  exactKeys(session, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'projectId', 'sourceRef', 'recipeRef',
    'bootstrapPlanRef', 'bootstrapHandoffRef', 'owner', 'deadline', 'secretBackend',
    'workflowVersion', 'status', 'safety', 'createdAt',
  ], '$', issues);
  if (session?.schemaVersion !== 1 || session?.kind !== 'FirstLaunchSession' ||
      !SESSION_ID.test(session?.id || '') || !SHA256.test(session?.fingerprint || '') ||
      !isActor(session?.owner) || !isDate(session?.deadline) || !isDate(session?.createdAt) ||
      Date.parse(session.deadline) <= Date.parse(session.createdAt) ||
      !['env', 'keychain'].includes(session?.secretBackend) || session?.workflowVersion !== 1 ||
      session?.status !== 'active') issues.push('$');
  validateSourceRef(session?.sourceRef, 'sourceRef', issues);
  validateRef(session?.recipeRef, /^recipe-[a-f0-9]{24}$/, 'recipeRef', issues);
  validateRef(session?.bootstrapPlanRef, /^bootstrap-plan-[a-f0-9]{24}$/, 'bootstrapPlanRef', issues);
  validateRef(session?.bootstrapHandoffRef, /^human-handoff-[a-f0-9]{24}$/, 'bootstrapHandoffRef', issues);
  if (session?.safety?.providerProbesAllowed !== false || session?.safety?.providerMutationsAllowed !== false ||
      session?.safety?.secretValuesAllowed !== false || session?.safety?.browserActionsAllowed !== false ||
      session?.safety?.productRepositoryWritesAllowed !== false) issues.push('safety');
  if (expected.project && (session?.projectId !== expected.project.id || !sameSource(session?.sourceRef, expected.project.source))) {
    issues.push('project');
  }
  for (const [field, value] of [
    ['recipeRef', expected.recipe],
    ['bootstrapPlanRef', expected.bootstrap],
    ['bootstrapHandoffRef', expected.bootstrapHandoff],
  ]) {
    if (value && (session?.[field]?.id !== value.id || session?.[field]?.fingerprint !== value.fingerprint)) issues.push(field);
  }
  if (expected.bootstrapHandoff && (
    expected.bootstrapHandoff.phase !== 'bootstrap' || expected.bootstrapHandoff.owner !== session?.owner ||
    expected.bootstrapHandoff.deadline !== session?.deadline
  )) issues.push('bootstrapHandoffRef');
  if (expected.bootstrap && session?.secretBackend !== expected.bootstrap.secretBackend) issues.push('secretBackend');
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `First Launch Session is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = sessionFingerprint(session);
  if (session.fingerprint !== actual || session.id !== `first-launch-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `First Launch Session fingerprint mismatch: ${session.id}`);
  }
  return session;
}

function loadSessionContext(options) {
  const home = resolveDeployHome(options.home);
  const project = readProjectRecord(home, options.projectId);
  assertControlHomeSeparated(home, project.source);
  if (!SESSION_ID.test(options.sessionId || '')) throw operationError('VALIDATION_FAILED', 'First Launch Session id is invalid.');
  const sessionFile = sessionPath(home, project.id, options.sessionId);
  if (!fs.existsSync(sessionFile)) throw operationError('NOT_FOUND', `First Launch Session not found: ${options.sessionId}`);
  const shell = readJson(sessionFile, 'First Launch Session');
  const recipe = showRecipe({ home, projectId: project.id, recipeId: shell.recipeRef?.id }).recipe;
  const bootstrap = showProviderBootstrapPlan({
    home, projectId: project.id, bootstrapPlanId: shell.bootstrapPlanRef?.id,
  }).plan;
  const bootstrapHandoff = showHumanHandoff({
    home, projectId: project.id, handoffId: shell.bootstrapHandoffRef?.id,
  }).handoff;
  const session = validateFirstLaunchSession(shell, { project, recipe, bootstrap, bootstrapHandoff });
  const revision = readRevisionChain(home, project, session);
  return { home, project, session, sessionFile, revision, reused: true };
}

function evaluateSession({ home, project, session, revision, now }) {
  const observedAt = normalizeDate(now, 'session observation time');
  const bootstrapReport = showProviderBootstrapPlan({
    home,
    projectId: project.id,
    bootstrapPlanId: session.bootstrapPlanRef.id,
  });
  const attestationList = listHumanHandoffAttestations({
    home,
    projectId: project.id,
    handoffId: session.bootstrapHandoffRef.id,
  });
  const bootstrapAttestation = attestationList.attestations.at(-1) || null;
  let effectiveStatus;
  if (!bootstrapAttestation || bootstrapAttestation.status === 'blocked') {
    effectiveStatus = Date.parse(observedAt) > Date.parse(session.deadline)
      ? 'expired'
      : bootstrapAttestation ? 'blocked' : 'waiting-human-bootstrap';
  } else if (bootstrapReport.effectiveStatus === 'waiting-human') {
    effectiveStatus = 'waiting-secrets-and-connections';
  } else if (bootstrapReport.effectiveStatus === 'needs-probe') {
    effectiveStatus = 'needs-connection-probe';
  } else if (bootstrapReport.effectiveStatus === 'blocked') {
    effectiveStatus = 'blocked';
  } else {
    effectiveStatus = 'ready-for-configuration';
  }
  let configurationHandoff = null;
  let configurationAttestation = null;
  let candidateControl = null;
  let candidateAuthorization = null;
  let candidateRun = null;
  let databaseMigration = null;
  let candidateVerification = null;
  let cutover = null;
  if (effectiveStatus === 'ready-for-configuration' && revision.configurationHandoffRef) {
    configurationHandoff = showHumanHandoff({
      home,
      projectId: project.id,
      handoffId: revision.configurationHandoffRef.id,
    }).handoff;
    if (configurationHandoff.phase !== 'configuration' ||
        configurationHandoff.fingerprint !== revision.configurationHandoffRef.fingerprint) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Configuration Handoff binding mismatch.');
    }
    const attestations = listHumanHandoffAttestations({
      home,
      projectId: project.id,
      handoffId: configurationHandoff.id,
    }).attestations;
    configurationAttestation = attestations.at(-1) || null;
    if (!configurationAttestation || configurationAttestation.status === 'blocked') {
      effectiveStatus = Date.parse(observedAt) > Date.parse(configurationHandoff.deadline)
        ? 'expired'
        : configurationAttestation ? 'blocked' : 'waiting-human-configuration';
    } else if (!revision.launchConfigurationRef) {
      effectiveStatus = 'waiting-launch-settings';
    } else {
      candidateControl = validateCandidateControlObjects({ home, project, session, revision });
      candidateAuthorization = evaluateCandidateAuthorization({
        home, project, session, revision, candidateControl, now: observedAt,
      });
      effectiveStatus = candidateAuthorization.status;
      if (revision.candidateRunRefs.length > 0) {
        candidateRun = evaluateCandidateRun({
          home, project, revision, candidateControl, candidateAuthorization, now: observedAt,
        });
        effectiveStatus = candidateRun.status;
        if (effectiveStatus === 'candidate-provider-stage-succeeded') {
          if (candidateControl.recipe.requirements.database) {
            databaseMigration = evaluateDatabaseMigration({
              home, project, session, revision, candidateControl, now: observedAt,
            });
            effectiveStatus = databaseMigration.status;
            if (effectiveStatus === 'database-migrated') {
              candidateVerification = evaluateCandidateVerification({
                home, project, revision, candidateControl,
              });
              effectiveStatus = candidateVerification.status === 'candidate-provider-stage-succeeded'
                ? 'database-migrated'
                : candidateVerification.status;
            }
          } else {
            candidateVerification = evaluateCandidateVerification({
              home, project, revision, candidateControl,
            });
            effectiveStatus = candidateVerification.status;
          }
        }
      }
      if (effectiveStatus === 'candidate-verified') {
        cutover = evaluateCutover({
          home, project, session, revision, candidateControl, candidateVerification, now: observedAt,
        });
        effectiveStatus = cutover.status;
      }
    }
  }
  return {
    effectiveStatus,
    observedAt,
    bootstrapPlan: bootstrapReport.plan,
    bootstrapReadiness: bootstrapReport.readiness,
    bootstrapAttestation,
    revision,
    configurationHandoff,
    configurationAttestation,
    candidateControl,
    candidateAuthorization,
    candidateRun,
    databaseMigration,
    candidateVerification,
    cutover,
    nextActions: nextActions(
      session,
      revision,
      bootstrapReport,
      bootstrapAttestation,
      configurationHandoff,
      configurationAttestation,
      candidateControl,
      candidateAuthorization,
      candidateRun,
      databaseMigration,
      candidateVerification,
      cutover,
      effectiveStatus,
      observedAt
    ),
  };
}

function nextActions(
  session,
  revision,
  bootstrapReport,
  attestation,
  configurationHandoff,
  configurationAttestation,
  candidateControl,
  candidateAuthorization,
  candidateRun,
  databaseMigration,
  candidateVerification,
  cutover,
  status,
  observedAt
) {
  const homeArgs = ['--home', bootstrapReport.home];
  if (status === 'waiting-human-configuration') {
    return [{
      kind: 'configuration-attestation',
      handoffId: configurationHandoff.id,
      showArgv: ['agentmesh-deploy', 'human-handoff', 'show', session.projectId, configurationHandoff.id, ...homeArgs],
      attestArgvPrefix: [
        'agentmesh-deploy', 'human-handoff', 'attest', session.projectId, configurationHandoff.id,
        '--handoff-spec',
      ],
      requiredInput: 'results.json',
    }];
  }
  if (status === 'waiting-launch-settings') {
    return [{
      kind: 'provide-launch-settings',
      requiredInput: 'launch-settings.json',
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--settings-file',
      ],
    }];
  }
  if (status === 'ready-for-candidate-plan') {
    return [{
      kind: 'create-candidate-adapter-plan',
      argv: [
        'agentmesh-deploy', 'adapter-plan', 'generate', session.projectId,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        ...homeArgs,
      ],
    }];
  }
  if (status === 'waiting-sandbox-profile') {
    const plan = candidateAuthorization.plan;
    const configuration = candidateControl.configuration;
    const argv = [
      'agentmesh-deploy', 'sandbox', 'create', session.projectId,
      '--graph', revision.graphRef.id,
      '--adapter-plan', plan.id,
      '--resource-prefix', configuration.resourcePrefix,
      ...candidateAllowedDomains(configuration).flatMap((domain) => ['--allowed-domain', domain]),
      '--max-provider-mutations', String(estimateSandboxPlanMutations(plan)),
      '--expires-at', new Date(Date.parse(observedAt) + 24 * 60 * 60 * 1000).toISOString(),
      '--account-environment', 'test',
      ...(candidatePlanHasCostMutation(candidateControl.graph, plan) ? ['--allow-paid-resources'] : []),
      '--yes', ...homeArgs,
    ];
    return [{
      kind: 'create-candidate-sandbox-profile',
      argv,
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--sandbox-profile',
      ],
      requiredInput: 'sandbox-profile-id',
    }];
  }
  if (status === 'waiting-candidate-approval') {
    const requiredNodeIds = candidateApprovalNodeIds(candidateControl.graph, candidateAuthorization.plan);
    return [{
      kind: 'approve-candidate-provider-mutations',
      argv: [
        'agentmesh-deploy', 'approval', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--nodes', requiredNodeIds.join(','),
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--approved-by', session.owner,
        '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--approval',
      ],
      requiredInput: 'approval-id',
    }];
  }
  if (status === 'waiting-sandbox-preflight') {
    return [{
      kind: 'run-candidate-sandbox-preflight',
      argv: [
        'agentmesh-deploy', 'sandbox', 'preflight', session.projectId,
        candidateAuthorization.profile.id,
        '--graph', revision.graphRef.id,
        '--adapter-plan', candidateAuthorization.plan.id,
        '--probe-secrets', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--preflight',
      ],
      requiredInput: 'sandbox-preflight-id',
    }];
  }
  if (status === 'ready-for-candidate-apply') {
    return [{
      kind: 'execute-candidate-sandbox-plan',
      argv: [
        'agentmesh-deploy', 'sandbox', 'apply', session.projectId,
        candidateAuthorization.profile.id,
        '--graph', revision.graphRef.id,
        '--adapter-plan', candidateAuthorization.plan.id,
        '--preflight', candidateAuthorization.preflight.id,
        '--execute', '--yes', '--allow-sandbox-network', '--allow-provider-mutations',
        ...(candidatePlanHasCostMutation(candidateControl.graph, candidateAuthorization.plan)
          ? ['--allow-cost-mutations'] : []),
        ...homeArgs,
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
    }];
  }
  if (status === 'candidate-run-update-available') {
    return [{
      kind: 'adopt-candidate-run-revision',
      runId: candidateRun.run.id,
      argv: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--run', candidateRun.run.id, ...homeArgs,
      ],
    }];
  }
  if (['waiting-candidate-run', 'candidate-run-resumable'].includes(status)) {
    return [{
      kind: 'resume-candidate-sandbox-run',
      argv: [
        'agentmesh-deploy', 'sandbox', 'resume', session.projectId,
        candidateRun.run.sandboxProfileId,
        '--graph', revision.graphRef.id,
        '--adapter-plan', candidateRun.run.adapterPlanId,
        '--preflight', candidateRun.run.sandboxPreflightId,
        '--run', candidateRun.run.id,
        '--execute', '--yes', '--allow-sandbox-network', '--allow-provider-mutations',
        ...(candidatePlanHasCostMutation(candidateControl.graph, candidateAuthorization.plan)
          ? ['--allow-cost-mutations'] : []),
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
    }];
  }
  if (status === 'candidate-run-authorization-expired') {
    return [{
      kind: 'start-new-candidate-run-required',
      reason: candidateRun.authorizationStatus,
    }, ...nextActions(
      session,
      revision,
      bootstrapReport,
      attestation,
      configurationHandoff,
      configurationAttestation,
      candidateControl,
      candidateAuthorization,
      null,
      null,
      null,
      null,
      candidateAuthorization.status,
      observedAt
    )];
  }
  if (status === 'candidate-run-failed') {
    return [{
      kind: 'resolve-candidate-run-failure',
      runId: candidateRun.run.id,
      failedNodes: candidateRun.failedNodes,
    }];
  }
  if (status === 'candidate-provider-stage-succeeded') {
    if (candidateControl.recipe.requirements.database) {
      return [{
        kind: 'prepare-database-migration-plan',
        requiredInput: 'migration-spec.json',
        argvPrefix: [
          'agentmesh-deploy', 'migration-plan', 'create', session.projectId,
          '--graph', revision.graphRef.id,
          '--launch-config', revision.launchConfigurationRef.id,
          '--migration-spec',
        ],
        adoptPlanArgvPrefix: [
          'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
          '--migration-plan',
        ],
      }];
    }
    return [{
      kind: 'prepare-candidate-product-verification',
      requiredInput: 'verification-spec.json',
      argvPrefix: [
        'agentmesh-deploy', 'verification', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--verification-spec',
      ],
    }];
  }
  if (status === 'waiting-database-inspect-profile') {
    const plan = databaseMigration.inspectPlan;
    const configuration = candidateControl.configuration;
    return [{
      kind: 'create-database-inspect-sandbox-profile',
      argv: [
        'agentmesh-deploy', 'sandbox', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--adapter-plan', plan.id,
        '--resource-prefix', configuration.resourcePrefix,
        '--max-provider-mutations', String(estimateSandboxPlanMutations(plan)),
        '--expires-at', new Date(Date.parse(observedAt) + 24 * 60 * 60 * 1000).toISOString(),
        '--account-environment', 'test',
        ...(candidatePlanHasCostMutation(candidateControl.graph, plan) ? ['--allow-paid-resources'] : []),
        '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--sandbox-profile',
      ],
      requiredInput: 'sandbox-profile-id',
    }];
  }
  if (status === 'waiting-database-inspect-approval') {
    const requiredNodeIds = candidateApprovalNodeIds(candidateControl.graph, databaseMigration.inspectPlan);
    return [{
      kind: 'approve-database-inspect-and-backup',
      argv: [
        'agentmesh-deploy', 'approval', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--nodes', requiredNodeIds.join(','),
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--approved-by', session.owner, '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--approval',
      ],
      requiredInput: 'approval-id',
    }];
  }
  if (status === 'waiting-database-inspect-preflight') {
    return [{
      kind: 'run-database-inspect-sandbox-preflight',
      argv: [
        'agentmesh-deploy', 'sandbox', 'preflight', session.projectId,
        databaseMigration.authorization.profile.id,
        '--graph', revision.graphRef.id,
        '--adapter-plan', databaseMigration.inspectPlan.id,
        '--probe-secrets', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--preflight',
      ],
      requiredInput: 'sandbox-preflight-id',
    }];
  }
  if (status === 'ready-for-database-inspect-apply') {
    const authorization = databaseMigration.authorization;
    return [{
      kind: 'execute-database-inspect-sandbox-plan',
      argv: [
        'agentmesh-deploy', 'sandbox', 'apply', session.projectId,
        authorization.profile.id,
        '--graph', revision.graphRef.id,
        '--adapter-plan', databaseMigration.inspectPlan.id,
        '--preflight', authorization.preflight.id,
        '--execute', '--yes', '--allow-sandbox-network', '--allow-provider-mutations',
        ...(candidatePlanHasCostMutation(candidateControl.graph, databaseMigration.inspectPlan)
          ? ['--allow-cost-mutations'] : []),
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
    }];
  }
  if (status === 'database-inspect-run-update-available') {
    return [{
      kind: 'adopt-database-inspect-run-revision',
      runId: databaseMigration.run.run.id,
      argv: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--run', databaseMigration.run.run.id, ...homeArgs,
      ],
    }];
  }
  if (['waiting-database-inspect-run', 'database-inspect-run-resumable'].includes(status)) {
    const run = databaseMigration.run.run;
    return [{
      kind: 'resume-database-inspect-sandbox-run',
      argv: [
        'agentmesh-deploy', 'sandbox', 'resume', session.projectId, run.sandboxProfileId,
        '--graph', revision.graphRef.id,
        '--adapter-plan', run.adapterPlanId,
        '--preflight', run.sandboxPreflightId,
        '--run', run.id,
        '--execute', '--yes', '--allow-sandbox-network', '--allow-provider-mutations',
        ...(candidatePlanHasCostMutation(candidateControl.graph, databaseMigration.inspectPlan)
          ? ['--allow-cost-mutations'] : []),
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
    }];
  }
  if (status === 'database-inspect-run-failed') {
    return [{
      kind: 'resolve-database-inspect-run-failure',
      runId: databaseMigration.run.run.id,
      failedNodes: databaseMigration.run.failedNodes,
    }];
  }
  if (status === 'database-inspect-run-authorization-expired') {
    return [{
      kind: 'start-new-database-inspect-run-required',
      reason: databaseMigration.run.authorizationStatus,
    }];
  }
  if (status === 'database-inspect-stage-succeeded') {
    return [{
      kind: 'create-database-backup-evidence',
      argv: [
        'agentmesh-deploy', 'backup-evidence', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--adapter-plan', databaseMigration.inspectPlan.id,
        ...homeArgs,
      ],
      adoptEvidenceArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--backup-evidence',
      ],
    }];
  }
  if (status === 'waiting-database-runtime-profile') {
    return [{
      kind: 'create-database-runtime-profile',
      requiredInput: 'database-host',
      argvPrefix: [
        'agentmesh-deploy', 'database-runtime', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--adapter-plan', databaseMigration.applyPlan.id,
        '--database-host',
      ],
      argvSuffix: [
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--approved-by', session.owner, '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--database-runtime-profile',
      ],
    }];
  }
  if (status === 'waiting-database-apply-profile') {
    const plan = databaseMigration.applyPlan;
    return [{
      kind: 'create-database-apply-sandbox-profile',
      argv: [
        'agentmesh-deploy', 'sandbox', 'create', session.projectId,
        '--graph', revision.graphRef.id, '--adapter-plan', plan.id,
        '--resource-prefix', candidateControl.configuration.resourcePrefix,
        '--max-provider-mutations', String(estimateSandboxPlanMutations(plan)),
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--account-environment', 'test', '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--sandbox-profile',
      ],
      requiredInput: 'sandbox-profile-id',
    }];
  }
  if (status === 'waiting-database-apply-approval') {
    const requiredNodeIds = candidateApprovalNodeIds(candidateControl.graph, databaseMigration.applyPlan);
    return [{
      kind: 'approve-database-migration',
      argv: [
        'agentmesh-deploy', 'approval', 'create', session.projectId,
        '--graph', revision.graphRef.id, '--nodes', requiredNodeIds.join(','),
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--approved-by', session.owner, '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--approval',
      ],
      requiredInput: 'approval-id',
    }];
  }
  if (status === 'waiting-database-apply-preflight') {
    return [{
      kind: 'run-database-apply-sandbox-preflight',
      argv: [
        'agentmesh-deploy', 'sandbox', 'preflight', session.projectId,
        databaseMigration.applyAuthorization.profile.id,
        '--graph', revision.graphRef.id,
        '--adapter-plan', databaseMigration.applyPlan.id,
        '--database-runtime-profile', databaseMigration.databaseRuntime.profile.id,
        '--probe-secrets', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--preflight',
      ],
      requiredInput: 'sandbox-preflight-id',
    }];
  }
  if (status === 'ready-for-database-apply') {
    const authorization = databaseMigration.applyAuthorization;
    return [{
      kind: 'execute-database-migration-sandbox-plan',
      argv: [
        'agentmesh-deploy', 'sandbox', 'apply', session.projectId, authorization.profile.id,
        '--graph', revision.graphRef.id, '--adapter-plan', databaseMigration.applyPlan.id,
        '--preflight', authorization.preflight.id,
        '--database-runtime-profile', databaseMigration.databaseRuntime.profile.id,
        '--execute', '--yes', '--allow-sandbox-network', '--allow-provider-mutations',
        '--allow-database-migration', ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
      requiresExplicitDatabaseMigrationAuthorization: true,
    }];
  }
  if (status === 'database-apply-run-update-available') {
    return [{
      kind: 'adopt-database-apply-run-revision',
      runId: databaseMigration.applyRun.run.id,
      argv: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--run', databaseMigration.applyRun.run.id, ...homeArgs,
      ],
    }];
  }
  if (['waiting-database-apply-run', 'database-apply-run-resumable'].includes(status)) {
    const run = databaseMigration.applyRun.run;
    return [{
      kind: 'resume-database-apply-sandbox-run',
      argv: [
        'agentmesh-deploy', 'sandbox', 'resume', session.projectId, run.sandboxProfileId,
        '--graph', revision.graphRef.id, '--adapter-plan', run.adapterPlanId,
        '--preflight', run.sandboxPreflightId,
        '--database-runtime-profile', run.databaseRuntimeProfileId,
        '--run', run.id, '--execute', '--yes', '--allow-sandbox-network',
        '--allow-provider-mutations', '--allow-database-migration', ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
      requiresExplicitDatabaseMigrationAuthorization: true,
    }];
  }
  if (status === 'database-apply-run-failed') {
    return [{
      kind: 'resolve-database-apply-run-failure',
      runId: databaseMigration.applyRun.run.id,
      failedNodes: databaseMigration.applyRun.failedNodes,
    }];
  }
  if (status === 'database-apply-run-authorization-expired') {
    return [{
      kind: 'start-new-database-apply-run-required',
      reason: databaseMigration.applyRun.authorizationStatus,
    }];
  }
  if (status === 'database-migrated') {
    return [{
      kind: 'prepare-candidate-product-verification',
      requiredInput: 'verification-spec.json',
      argvPrefix: [
        'agentmesh-deploy', 'verification', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--verification-spec',
      ],
    }];
  }
  if (status === 'waiting-candidate-verification') {
    return [{
      kind: 'run-candidate-product-verification',
      argv: [
        'agentmesh-deploy', 'verification', 'run', session.projectId,
        candidateVerification.plan.id,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--phase', 'candidate', '--allow-network', '--yes', ...homeArgs,
      ],
      adoptEvidenceArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--candidate-evidence',
      ],
      requiresExplicitNetworkAuthorization: true,
    }];
  }
  if (status === 'candidate-verified') {
    return [{
      kind: 'create-evidence-bound-cutover-handoff',
      argv: [
        'agentmesh-deploy', 'human-handoff', 'create', session.projectId,
        '--bootstrap-plan', session.bootstrapPlanRef.id,
        '--candidate-evidence', candidateVerification.evidence.id,
        '--handoff-phase', 'cutover',
        '--handoff-owner', session.owner,
        '--handoff-deadline', new Date(Date.parse(observedAt) + 24 * 60 * 60 * 1000).toISOString(),
        ...homeArgs,
      ],
      adoptHandoffArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--cutover-handoff',
      ],
    }];
  }
  if (status === 'waiting-cutover-attestation') {
    return [{
      kind: 'complete-cutover-attestation',
      handoffId: cutover.handoff.id,
      showArgv: [
        'agentmesh-deploy', 'human-handoff', 'show', session.projectId, cutover.handoff.id, ...homeArgs,
      ],
      attestArgvPrefix: [
        'agentmesh-deploy', 'human-handoff', 'attest', session.projectId, cutover.handoff.id,
        '--handoff-spec',
      ],
      adoptAttestationArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--cutover-attestation',
      ],
      requiredInput: 'results.json',
    }];
  }
  if (status === 'waiting-cutover-profile') {
    const plan = cutover.plan;
    const configuration = candidateControl.configuration;
    return [{
      kind: 'create-cutover-sandbox-profile',
      argv: [
        'agentmesh-deploy', 'sandbox', 'create', session.projectId,
        '--graph', revision.graphRef.id, '--adapter-plan', plan.id,
        '--resource-prefix', configuration.resourcePrefix,
        ...candidateAllowedDomains(configuration).flatMap((domain) => ['--allowed-domain', domain]),
        '--max-provider-mutations', String(estimateSandboxPlanMutations(plan)),
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--account-environment', 'test', '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--sandbox-profile',
      ],
      requiredInput: 'sandbox-profile-id',
    }];
  }
  if (status === 'waiting-cutover-approval') {
    const nodeIds = candidateApprovalNodeIds(candidateControl.graph, cutover.plan);
    return [{
      kind: 'approve-production-cutover-mutations',
      argv: [
        'agentmesh-deploy', 'approval', 'create', session.projectId,
        '--graph', revision.graphRef.id, '--nodes', nodeIds.join(','),
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--approved-by', session.owner, '--yes', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--approval',
      ],
      requiredInput: 'approval-id',
    }];
  }
  if (status === 'waiting-cutover-preflight') {
    return [{
      kind: 'run-cutover-sandbox-preflight',
      argv: [
        'agentmesh-deploy', 'sandbox', 'preflight', session.projectId,
        cutover.authorization.profile.id,
        '--graph', revision.graphRef.id, '--adapter-plan', cutover.plan.id,
        '--probe-secrets', ...homeArgs,
      ],
      resumeArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--preflight',
      ],
      requiredInput: 'sandbox-preflight-id',
    }];
  }
  if (status === 'ready-for-cutover-apply') {
    return [{
      kind: 'execute-production-cutover-sandbox-plan',
      argv: [
        'agentmesh-deploy', 'sandbox', 'apply', session.projectId, cutover.authorization.profile.id,
        '--graph', revision.graphRef.id, '--adapter-plan', cutover.plan.id,
        '--preflight', cutover.authorization.preflight.id,
        '--execute', '--yes', '--allow-sandbox-network', '--allow-provider-mutations', ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
    }];
  }
  if (status === 'cutover-run-update-available') {
    return [{
      kind: 'adopt-cutover-run-revision',
      runId: cutover.run.run.id,
      argv: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--run', cutover.run.run.id, ...homeArgs,
      ],
    }];
  }
  if (['waiting-cutover-run', 'cutover-run-resumable'].includes(status)) {
    const run = cutover.run.run;
    return [{
      kind: 'resume-production-cutover-sandbox-run',
      argv: [
        'agentmesh-deploy', 'sandbox', 'resume', session.projectId, run.sandboxProfileId,
        '--graph', revision.graphRef.id, '--adapter-plan', run.adapterPlanId,
        '--preflight', run.sandboxPreflightId, '--run', run.id,
        '--execute', '--yes', '--allow-sandbox-network', '--allow-provider-mutations', ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
    }];
  }
  if (status === 'cutover-run-failed') {
    return [{ kind: 'resolve-cutover-run-failure', runId: cutover.run.run.id, failedNodes: cutover.run.failedNodes }];
  }
  if (status === 'cutover-run-authorization-expired') {
    return [{ kind: 'start-new-cutover-run-required', reason: cutover.run.authorizationStatus }];
  }
  if (status === 'waiting-email-delivery-plan') {
    const delivery = cutover.emailDelivery;
    if (delivery.provisioningConnections.length !== 1 || delivery.sendingConnections.length !== 1) {
      return [{
        kind: 'select-resend-email-delivery-connections',
        requiredProvisioningAuthMethod: 'provisioning-key',
        requiredSendingAuthMethod: 'sending-key',
        provisioningConnectionIds: delivery.provisioningConnections.map((item) => item.id),
        sendingConnectionIds: delivery.sendingConnections.map((item) => item.id),
      }];
    }
    return [{
      kind: 'create-email-delivery-plan',
      argv: [
        'agentmesh-deploy', 'email-delivery', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--verification-plan', candidateVerification.plan.id,
        '--provisioning-connection', delivery.provisioningConnections[0].id,
        '--sending-connection', delivery.sendingConnections[0].id,
        ...homeArgs,
      ],
      adoptPlanArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--email-delivery-plan',
      ],
    }];
  }
  if (status === 'waiting-email-delivery-approval') {
    const plan = cutover.emailDelivery.plan;
    return [{
      kind: 'approve-email-delivery-test',
      argv: [
        'agentmesh-deploy', 'email-delivery', 'approve', session.projectId, plan.id,
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--approved-by', session.owner, '--yes', ...homeArgs,
      ],
      adoptApprovalArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--email-delivery-approval',
      ],
    }];
  }
  if (status === 'ready-for-email-delivery-apply') {
    const delivery = cutover.emailDelivery;
    return [{
      kind: 'execute-email-delivery-test',
      argv: [
        'agentmesh-deploy', 'email-delivery', 'apply', session.projectId, delivery.plan.id,
        '--email-delivery-approval', delivery.approval.id,
        '--execute', '--yes', '--allow-network', '--allow-provider-mutations', '--allow-cost-mutations',
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--email-delivery-run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
      requiresExplicitCostAuthorization: true,
    }];
  }
  if (status === 'email-delivery-run-update-available') {
    return [{
      kind: 'adopt-email-delivery-run-revision',
      runId: cutover.emailDelivery.run.id,
      argv: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--email-delivery-run', cutover.emailDelivery.run.id, ...homeArgs,
      ],
    }];
  }
  if (status === 'email-delivery-run-resumable') {
    const run = cutover.emailDelivery.run;
    return [{
      kind: 'resume-email-delivery-test',
      argv: [
        'agentmesh-deploy', 'email-delivery', 'resume', session.projectId, run.id,
        '--execute', '--yes', '--allow-network', '--allow-provider-mutations', '--allow-cost-mutations',
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--email-delivery-run',
      ],
      nextPollAt: run.delivery.nextPollAt || null,
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
      requiresExplicitCostAuthorization: true,
    }];
  }
  if (status === 'email-delivery-run-authorization-expired') {
    return [{
      kind: 'reauthorize-email-delivery-test',
      runId: cutover.emailDelivery.run.id,
      approvalStatus: cutover.emailDelivery.approvalStatus,
      createApprovalArgv: [
        'agentmesh-deploy', 'email-delivery', 'approve', session.projectId,
        cutover.emailDelivery.plan.id,
        '--expires-at', '<timestamp-within-24-hours>', '--approved-by', session.owner, '--yes',
        ...homeArgs,
      ],
      resumeRunArgvPrefix: [
        'agentmesh-deploy', 'email-delivery', 'resume', session.projectId,
        cutover.emailDelivery.run.id, '--email-delivery-approval',
      ],
      resumeRunArgvSuffix: [
        '--execute', '--yes', '--allow-network', '--allow-provider-mutations', '--allow-cost-mutations',
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--email-delivery-run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
      requiresExplicitCostAuthorization: true,
    }];
  }
  if (status === 'email-delivery-run-failed') {
    return [{
      kind: 'resolve-email-delivery-failure',
      runId: cutover.emailDelivery.run.id,
      sendError: cutover.emailDelivery.run.send.lastError,
      deliveryError: cutover.emailDelivery.run.delivery.lastError,
    }];
  }
  if (status === 'waiting-production-verification') {
    const emailRun = cutover.emailDelivery?.required ? cutover.emailDelivery.run : null;
    return [{
      kind: 'run-production-product-verification',
      argv: [
        'agentmesh-deploy', 'verification', 'run', session.projectId,
        candidateVerification.plan.id,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--phase', 'production',
        ...(emailRun ? ['--email-delivery-run', emailRun.id] : []),
        '--allow-network', '--yes', ...homeArgs,
      ],
      adoptEvidenceArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--production-evidence',
      ],
      requiresExplicitNetworkAuthorization: true,
    }];
  }
  if (status === 'production-verification-failed') {
    const failedChecks = cutover.productionEvidence.checks
      .filter((check) => check.required && check.status === 'failed')
      .map((check) => ({ id: check.id, capability: check.capability, reasonCode: check.reasonCode }));
    return [{
      kind: 'create-evidence-bound-rollback-plan',
      failedEvidenceId: cutover.productionEvidence.id,
      failedChecks,
      argv: [
        'agentmesh-deploy', 'rollback', 'create', session.projectId,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        ...homeArgs,
      ],
      adoptPlanArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--rollback-plan',
      ],
    }];
  }
  if (status === 'rollback-plan-blocked') {
    return [{
      kind: 'resolve-blocked-rollback-plan',
      rollbackPlanId: cutover.rollback.plan.id,
      blockers: cutover.rollback.plan.blockers,
    }];
  }
  if (status === 'waiting-rollback-approval') {
    const plan = cutover.rollback.plan;
    const stepIds = requiredRollbackStepIds(plan);
    return [{
      kind: 'approve-evidence-bound-rollback',
      argv: [
        'agentmesh-deploy', 'rollback', 'approve', session.projectId, plan.id,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--steps', stepIds.join(','),
        '--expires-at', new Date(Date.parse(observedAt) + 60 * 60 * 1000).toISOString(),
        '--approved-by', session.owner, '--yes', ...homeArgs,
      ],
      adoptApprovalArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--rollback-approval',
      ],
    }];
  }
  if (status === 'ready-for-rollback-apply') {
    const rollback = cutover.rollback;
    return [{
      kind: 'execute-evidence-bound-rollback',
      argv: [
        'agentmesh-deploy', 'rollback', 'apply', session.projectId, rollback.plan.id,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--rollback-approval', rollback.approval.id,
        '--execute', '--yes', '--allow-rollback-network', '--allow-provider-mutations',
        ...(requiredRollbackStepIds(rollback.plan).includes('database.rollback')
          ? ['--allow-database-restore'] : []),
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
    }];
  }
  if (status === 'rollback-run-update-available') {
    return [{
      kind: 'adopt-rollback-run-revision',
      runId: cutover.rollback.run.id,
      argv: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--run', cutover.rollback.run.id, ...homeArgs,
      ],
    }];
  }
  if (status === 'rollback-run-resumable') {
    const rollback = cutover.rollback;
    return [{
      kind: 'resume-evidence-bound-rollback',
      argv: [
        'agentmesh-deploy', 'rollback', 'resume', session.projectId, rollback.run.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--execute', '--yes', '--allow-rollback-network', '--allow-provider-mutations',
        ...(requiredRollbackStepIds(rollback.plan).includes('database.rollback')
          ? ['--allow-database-restore'] : []),
        ...homeArgs,
      ],
      adoptRunArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id, '--run',
      ],
      requiresExplicitNetworkAuthorization: true,
      requiresExplicitProviderMutationAuthorization: true,
    }];
  }
  if (status === 'rollback-run-authorization-expired') {
    return [{
      kind: 'rollback-run-authorization-expired',
      runId: cutover.rollback.run.id,
      approvalStatus: cutover.rollback.approvalStatus,
    }];
  }
  if (status === 'rollback-run-failed') {
    return [{
      kind: 'resolve-terminal-rollback-failure',
      runId: cutover.rollback.run.id,
      failedSteps: Object.entries(cutover.rollback.run.stepStates)
        .filter(([, step]) => step.status === 'failed-terminal' || step.status === 'blocked')
        .map(([stepId, step]) => ({ stepId, error: step.lastError })),
    }];
  }
  if (status === 'rolled-back') {
    return [{
      kind: 'first-launch-rolled-back',
      failedProductionEvidenceId: cutover.productionEvidence.id,
      rollbackPlanId: cutover.rollback.plan.id,
      rollbackRunId: cutover.rollback.run.id,
      nextRequirement: 'fix-product-and-start-new-first-launch-session-from-a-new-commit',
    }];
  }
  if (status === 'production-verification-needs-human') {
    const pendingChecks = cutover.productionEvidence.checks
      .filter((check) => check.required && check.status === 'needs-human')
      .map((check) => ({ id: check.id, capability: check.capability, handoff: check.handoff }));
    return [{
      kind: 'complete-production-verification-handoff',
      evidenceId: cutover.productionEvidence.id,
      pendingChecks,
      rerunArgv: [
        'agentmesh-deploy', 'verification', 'run', session.projectId,
        candidateVerification.plan.id,
        '--graph', revision.graphRef.id,
        '--launch-config', revision.launchConfigurationRef.id,
        '--phase', 'production',
        ...(cutover.emailDelivery?.required
          ? ['--email-delivery-run', cutover.emailDelivery.run.id]
          : []),
        '--allow-network', '--yes', ...homeArgs,
      ],
      adoptEvidenceArgvPrefix: [
        'agentmesh-deploy', 'first-launch', 'resume', session.projectId, session.id,
        '--production-evidence',
      ],
    }];
  }
  if (status === 'production-verified') {
    return [{
      kind: 'first-launch-complete',
      candidateEvidenceId: revision.candidateEvidenceRef.id,
      productionEvidenceId: revision.productionEvidenceRef.id,
    }];
  }
  if (status === 'waiting-human-bootstrap') {
    return [{
      kind: 'human-attestation',
      handoffId: session.bootstrapHandoffRef.id,
      showArgv: ['agentmesh-deploy', 'human-handoff', 'show', session.projectId, session.bootstrapHandoffRef.id, ...homeArgs],
      attestArgvPrefix: ['agentmesh-deploy', 'human-handoff', 'attest', session.projectId, session.bootstrapHandoffRef.id, '--handoff-spec'],
      requiredInput: 'results.json',
    }];
  }
  if (status === 'expired') {
    return [{
      kind: revision.configurationHandoffRef ? 'new-configuration-handoff-required' : 'new-session-required',
      reason: revision.configurationHandoffRef
        ? 'configuration-handoff-deadline-expired'
        : 'bootstrap-handoff-deadline-expired',
    }];
  }
  if (status === 'blocked') {
    const blockedAttestation = configurationAttestation?.status === 'blocked'
      ? configurationAttestation
      : attestation?.status === 'blocked' ? attestation : null;
    return [{
      kind: 'resolve-blocker',
      source: blockedAttestation ? 'human-attestation' : 'provider-connection',
      referenceId: blockedAttestation?.id || '',
    }];
  }
  if (status === 'waiting-secrets-and-connections') {
    return bootstrapReport.plan.providers
      .filter((provider) => bootstrapReport.readiness.some((item) => item.providerId === provider.providerId && item.status === 'missing'))
      .map((provider) => ({
        kind: 'provision-provider-connection',
        providerId: provider.providerId,
        capture: provider.requiredSecretRefs.map((item) => ({
          ref: item.ref,
          provisioningMethod: item.provisioningMethod,
          argv: item.captureArgv,
          requiresStdin: item.requiresStdin,
        })),
        addArgv: provider.commands.add.argv,
      }));
  }
  if (status === 'needs-connection-probe') {
    return bootstrapReport.plan.providers
      .filter((provider) => bootstrapReport.readiness.some((item) => item.providerId === provider.providerId && item.status !== 'ready'))
      .map((provider) => ({
        kind: 'verify-provider-connection',
        providerId: provider.providerId,
        checkArgv: provider.commands.check.argv,
        probeArgv: provider.commands.probe.argv,
        probeRequiresExplicitNetworkAuthorization: true,
      }));
  }
  return [{
    kind: 'create-configuration-handoff',
    argv: [
      'agentmesh-deploy', 'human-handoff', 'create', session.projectId,
      '--bootstrap-plan', session.bootstrapPlanRef.id,
      '--handoff-phase', 'configuration',
      '--handoff-owner', session.owner,
      '--handoff-deadline', session.deadline,
      ...homeArgs,
    ],
  }];
}

function ensureInitialRevision(home, project, session, createdAt) {
  const directory = revisionDirectory(home, project.id, session.id);
  if (fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.endsWith('.json'))) {
    return readRevisionChain(home, project, session);
  }
  return withControlLock(home, `project:${project.id}`, 'first-launch-revision-initialize', () => {
    if (fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.endsWith('.json'))) {
      return readRevisionChain(home, project, session);
    }
    const revision = buildRevision(session, null, {
      checkpoint: 'bootstrap-human',
      configurationRecipeRef: null,
      configurationHandoffRef: null,
      configurationAttestationRef: null,
      manifestRef: null,
      artifactRef: null,
      graphRef: null,
      launchConfigurationRef: null,
      adapterPlanRef: null,
      sandboxProfileRefs: [],
      candidateApprovalRefs: [],
      sandboxPreflightRefs: [],
      candidateRunRefs: [],
      migrationPlanRef: null,
      databaseInspectPlanRef: null,
      databaseInspectProfileRefs: [],
      databaseInspectApprovalRefs: [],
      databaseInspectPreflightRefs: [],
      databaseInspectRunRefs: [],
      backupEvidenceRef: null,
      databaseApplyPlanRef: null,
      databaseRuntimeProfileRefs: [],
      databaseApplyProfileRefs: [],
      databaseApplyApprovalRefs: [],
      databaseApplyPreflightRefs: [],
      databaseApplyRunRefs: [],
      verificationPlanRef: null,
      candidateEvidenceRef: null,
      cutoverHandoffRef: null,
      cutoverAttestationRef: null,
      dnsChangeSetRef: null,
      cutoverPlanRef: null,
      cutoverProfileRefs: [],
      cutoverApprovalRefs: [],
      cutoverPreflightRefs: [],
      cutoverRunRefs: [],
      emailDeliveryPlanRef: null,
      emailDeliveryApprovalRefs: [],
      emailDeliveryRunRefs: [],
      productionVerificationRefs: [],
      productionEvidenceRef: null,
      rollbackPlanRef: null,
      rollbackApprovalRefs: [],
      rollbackRunRefs: [],
      createdAt,
    });
    writeJsonAtomic(revisionPath(home, project.id, session.id, 1), revision);
    return revision;
  });
}

function appendRevision(home, project, session, previous, changes) {
  return withControlLock(home, `project:${project.id}`, 'first-launch-revision-append', () => {
    const current = readRevisionChain(home, project, session);
    if (current.fingerprint !== previous.fingerprint || current.revision !== previous.revision) {
      throw operationError('CONFLICT', 'First Launch Session advanced concurrently; reload status before resuming.');
    }
    const revision = buildRevision(session, current, {
      checkpoint: changes.checkpoint,
      configurationRecipeRef: changes.configurationRecipeRef ?? current.configurationRecipeRef,
      configurationHandoffRef: changes.configurationHandoffRef ?? current.configurationHandoffRef,
      configurationAttestationRef: changes.configurationAttestationRef ?? current.configurationAttestationRef,
      manifestRef: changes.manifestRef ?? current.manifestRef,
      artifactRef: changes.artifactRef ?? current.artifactRef,
      graphRef: changes.graphRef ?? current.graphRef,
      launchConfigurationRef: changes.launchConfigurationRef ?? current.launchConfigurationRef,
      adapterPlanRef: changes.adapterPlanRef ?? current.adapterPlanRef,
      sandboxProfileRefs: changes.sandboxProfileRefs ?? current.sandboxProfileRefs,
      candidateApprovalRefs: changes.candidateApprovalRefs ?? current.candidateApprovalRefs,
      sandboxPreflightRefs: changes.sandboxPreflightRefs ?? current.sandboxPreflightRefs,
      candidateRunRefs: changes.candidateRunRefs ?? current.candidateRunRefs,
      migrationPlanRef: changes.migrationPlanRef ?? current.migrationPlanRef,
      databaseInspectPlanRef: changes.databaseInspectPlanRef ?? current.databaseInspectPlanRef,
      databaseInspectProfileRefs: changes.databaseInspectProfileRefs ?? current.databaseInspectProfileRefs,
      databaseInspectApprovalRefs: changes.databaseInspectApprovalRefs ?? current.databaseInspectApprovalRefs,
      databaseInspectPreflightRefs: changes.databaseInspectPreflightRefs ?? current.databaseInspectPreflightRefs,
      databaseInspectRunRefs: changes.databaseInspectRunRefs ?? current.databaseInspectRunRefs,
      backupEvidenceRef: changes.backupEvidenceRef ?? current.backupEvidenceRef,
      databaseApplyPlanRef: changes.databaseApplyPlanRef ?? current.databaseApplyPlanRef,
      databaseRuntimeProfileRefs: changes.databaseRuntimeProfileRefs ?? current.databaseRuntimeProfileRefs,
      databaseApplyProfileRefs: changes.databaseApplyProfileRefs ?? current.databaseApplyProfileRefs,
      databaseApplyApprovalRefs: changes.databaseApplyApprovalRefs ?? current.databaseApplyApprovalRefs,
      databaseApplyPreflightRefs: changes.databaseApplyPreflightRefs ?? current.databaseApplyPreflightRefs,
      databaseApplyRunRefs: changes.databaseApplyRunRefs ?? current.databaseApplyRunRefs,
      verificationPlanRef: changes.verificationPlanRef ?? current.verificationPlanRef,
      candidateEvidenceRef: changes.candidateEvidenceRef ?? current.candidateEvidenceRef,
      cutoverHandoffRef: changes.cutoverHandoffRef ?? current.cutoverHandoffRef,
      cutoverAttestationRef: changes.cutoverAttestationRef ?? current.cutoverAttestationRef,
      dnsChangeSetRef: changes.dnsChangeSetRef ?? current.dnsChangeSetRef,
      cutoverPlanRef: changes.cutoverPlanRef ?? current.cutoverPlanRef,
      cutoverProfileRefs: changes.cutoverProfileRefs ?? current.cutoverProfileRefs,
      cutoverApprovalRefs: changes.cutoverApprovalRefs ?? current.cutoverApprovalRefs,
      cutoverPreflightRefs: changes.cutoverPreflightRefs ?? current.cutoverPreflightRefs,
      cutoverRunRefs: changes.cutoverRunRefs ?? current.cutoverRunRefs,
      emailDeliveryPlanRef: changes.emailDeliveryPlanRef ?? current.emailDeliveryPlanRef,
      emailDeliveryApprovalRefs: changes.emailDeliveryApprovalRefs ?? current.emailDeliveryApprovalRefs,
      emailDeliveryRunRefs: changes.emailDeliveryRunRefs ?? current.emailDeliveryRunRefs,
      productionVerificationRefs: changes.productionVerificationRefs ?? current.productionVerificationRefs,
      productionEvidenceRef: changes.productionEvidenceRef ?? current.productionEvidenceRef,
      rollbackPlanRef: changes.rollbackPlanRef ?? current.rollbackPlanRef,
      rollbackApprovalRefs: changes.rollbackApprovalRefs ?? current.rollbackApprovalRefs,
      rollbackRunRefs: changes.rollbackRunRefs ?? current.rollbackRunRefs,
      createdAt: changes.createdAt,
    });
    const file = revisionPath(home, project.id, session.id, revision.revision);
    if (fs.existsSync(file)) {
      const existing = validateFirstLaunchSessionRevision(readJson(file, 'First Launch Session Revision'), {
        project,
        session,
        previous: current,
      });
      if (existing.fingerprint !== revision.fingerprint) {
        throw operationError('CONFLICT', `First Launch Session Revision already exists: ${revision.revision}`);
      }
      return existing;
    }
    writeJsonAtomic(file, revision);
    return revision;
  });
}

function buildRevision(session, previous, values) {
  const base = {
    schemaVersion: 1,
    kind: 'FirstLaunchSessionRevision',
    sessionId: session.id,
    sessionFingerprint: session.fingerprint,
    projectId: session.projectId,
    sourceCommit: session.sourceRef.commit,
    revision: previous ? previous.revision + 1 : 1,
    previousFingerprint: previous?.fingerprint || null,
    checkpoint: values.checkpoint,
    configurationRecipeRef: values.configurationRecipeRef,
    configurationHandoffRef: values.configurationHandoffRef,
    configurationAttestationRef: values.configurationAttestationRef,
    manifestRef: values.manifestRef,
    artifactRef: values.artifactRef,
    graphRef: values.graphRef,
    launchConfigurationRef: values.launchConfigurationRef,
    adapterPlanRef: values.adapterPlanRef,
    sandboxProfileRefs: values.sandboxProfileRefs,
    candidateApprovalRefs: values.candidateApprovalRefs,
    sandboxPreflightRefs: values.sandboxPreflightRefs,
    candidateRunRefs: values.candidateRunRefs,
    migrationPlanRef: values.migrationPlanRef,
    databaseInspectPlanRef: values.databaseInspectPlanRef,
    databaseInspectProfileRefs: values.databaseInspectProfileRefs,
    databaseInspectApprovalRefs: values.databaseInspectApprovalRefs,
    databaseInspectPreflightRefs: values.databaseInspectPreflightRefs,
    databaseInspectRunRefs: values.databaseInspectRunRefs,
    backupEvidenceRef: values.backupEvidenceRef,
    databaseApplyPlanRef: values.databaseApplyPlanRef,
    databaseRuntimeProfileRefs: values.databaseRuntimeProfileRefs,
    databaseApplyProfileRefs: values.databaseApplyProfileRefs,
    databaseApplyApprovalRefs: values.databaseApplyApprovalRefs,
    databaseApplyPreflightRefs: values.databaseApplyPreflightRefs,
    databaseApplyRunRefs: values.databaseApplyRunRefs,
    verificationPlanRef: values.verificationPlanRef,
    candidateEvidenceRef: values.candidateEvidenceRef,
    cutoverHandoffRef: values.cutoverHandoffRef,
    cutoverAttestationRef: values.cutoverAttestationRef,
    dnsChangeSetRef: values.dnsChangeSetRef,
    cutoverPlanRef: values.cutoverPlanRef,
    cutoverProfileRefs: values.cutoverProfileRefs,
    cutoverApprovalRefs: values.cutoverApprovalRefs,
    cutoverPreflightRefs: values.cutoverPreflightRefs,
    cutoverRunRefs: values.cutoverRunRefs,
    emailDeliveryPlanRef: values.emailDeliveryPlanRef,
    emailDeliveryApprovalRefs: values.emailDeliveryApprovalRefs,
    emailDeliveryRunRefs: values.emailDeliveryRunRefs,
    productionVerificationRefs: values.productionVerificationRefs,
    productionEvidenceRef: values.productionEvidenceRef,
    rollbackPlanRef: values.rollbackPlanRef,
    rollbackApprovalRefs: values.rollbackApprovalRefs,
    rollbackRunRefs: values.rollbackRunRefs,
    createdAt: normalizeDate(values.createdAt, 'revision creation time'),
  };
  const fingerprint = revisionFingerprint(base);
  const revision = {
    ...base,
    id: `first-launch-revision-${fingerprint.slice(7, 31)}`,
    fingerprint,
  };
  return validateFirstLaunchSessionRevision(revision, { session, previous });
}

export function validateFirstLaunchSessionRevision(revision, expected = {}) {
  const issues = [];
  exactKeys(revision, [
    'schemaVersion', 'kind', 'id', 'fingerprint', 'sessionId', 'sessionFingerprint', 'projectId',
    'sourceCommit', 'revision', 'previousFingerprint', 'checkpoint', 'configurationRecipeRef',
    'configurationHandoffRef', 'configurationAttestationRef', 'manifestRef', 'artifactRef',
    'graphRef', 'launchConfigurationRef', 'adapterPlanRef', 'sandboxProfileRefs',
    'candidateApprovalRefs', 'sandboxPreflightRefs', 'candidateRunRefs', 'migrationPlanRef',
    'databaseInspectPlanRef', 'databaseInspectProfileRefs', 'databaseInspectApprovalRefs',
    'databaseInspectPreflightRefs', 'databaseInspectRunRefs', 'backupEvidenceRef',
    'databaseApplyPlanRef', 'databaseRuntimeProfileRefs', 'databaseApplyProfileRefs',
    'databaseApplyApprovalRefs', 'databaseApplyPreflightRefs', 'databaseApplyRunRefs', 'verificationPlanRef',
    'candidateEvidenceRef', 'cutoverHandoffRef', 'cutoverAttestationRef', 'dnsChangeSetRef',
    'cutoverPlanRef', 'cutoverProfileRefs', 'cutoverApprovalRefs', 'cutoverPreflightRefs',
    'cutoverRunRefs', 'emailDeliveryPlanRef', 'emailDeliveryApprovalRefs', 'emailDeliveryRunRefs',
    'productionVerificationRefs', 'productionEvidenceRef', 'rollbackPlanRef',
    'rollbackApprovalRefs', 'rollbackRunRefs', 'createdAt',
  ], '$', issues);
  if (revision?.schemaVersion !== 1 || revision?.kind !== 'FirstLaunchSessionRevision' ||
      !REVISION_ID.test(revision?.id || '') || !SHA256.test(revision?.fingerprint || '') ||
      !SESSION_ID.test(revision?.sessionId || '') || !SHA256.test(revision?.sessionFingerprint || '') ||
      !Number.isInteger(revision?.revision) || revision.revision < 1 || !isDate(revision?.createdAt) ||
      ![
        'bootstrap-human', 'configuration-human', 'waiting-launch-settings', 'candidate-control-ready',
        'candidate-plan-ready', 'candidate-profile-ready', 'candidate-approval-ready',
        'candidate-preflight-ready', 'candidate-run-started', 'candidate-provider-stage-succeeded',
        'database-inspect-plan-ready', 'database-inspect-profile-ready',
        'database-inspect-approval-ready', 'database-inspect-preflight-ready',
        'database-inspect-run-started', 'database-inspect-stage-succeeded',
        ...DATABASE_APPLY_CHECKPOINTS,
        'verification-plan-ready', 'candidate-verified', ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
      ]
        .includes(revision?.checkpoint)) issues.push('$');
  for (const [field, pattern] of [
    ['configurationRecipeRef', /^recipe-[a-f0-9]{24}$/],
    ['configurationHandoffRef', /^human-handoff-[a-f0-9]{24}$/],
    ['configurationAttestationRef', /^human-attestation-[a-f0-9]{24}$/],
    ['graphRef', /^graph-[a-f0-9]{24}$/],
    ['launchConfigurationRef', /^launch-config-[a-f0-9]{24}$/],
    ['adapterPlanRef', /^adapter-plan-[a-f0-9]{24}$/],
    ['migrationPlanRef', /^migration-plan-[a-f0-9]{24}$/],
    ['databaseInspectPlanRef', /^adapter-plan-[a-f0-9]{24}$/],
    ['backupEvidenceRef', /^backup-evidence-[a-f0-9]{24}$/],
    ['databaseApplyPlanRef', /^adapter-plan-[a-f0-9]{24}$/],
    ['verificationPlanRef', /^verification-plan-[a-f0-9]{24}$/],
    ['candidateEvidenceRef', /^product-verification-[a-f0-9]{24}$/],
    ['cutoverHandoffRef', /^human-handoff-[a-f0-9]{24}$/],
    ['cutoverAttestationRef', /^human-attestation-[a-f0-9]{24}$/],
    ['dnsChangeSetRef', /^dns-change-[a-f0-9]{24}$/],
    ['cutoverPlanRef', /^adapter-plan-[a-f0-9]{24}$/],
    ['emailDeliveryPlanRef', /^email-delivery-plan-[a-f0-9]{24}$/],
    ['productionEvidenceRef', /^product-verification-[a-f0-9]{24}$/],
    ['rollbackPlanRef', /^rollback-plan-[a-f0-9]{24}$/],
  ]) validateNullableRef(revision?.[field], pattern, field, issues);
  validateRefHistory(revision?.sandboxProfileRefs, /^sandbox-[a-f0-9]{24}$/, 'sandboxProfileRefs', issues);
  validateRefHistory(revision?.candidateApprovalRefs, /^approval-[a-f0-9-]+$/, 'candidateApprovalRefs', issues);
  validatePreflightRefHistory(revision?.sandboxPreflightRefs, issues);
  validateCandidateRunRefHistory(revision?.candidateRunRefs, issues);
  validateRefHistory(revision?.databaseInspectProfileRefs, /^sandbox-[a-f0-9]{24}$/, 'databaseInspectProfileRefs', issues);
  validateRefHistory(revision?.databaseInspectApprovalRefs, /^approval-[a-f0-9-]+$/, 'databaseInspectApprovalRefs', issues);
  validatePreflightRefHistory(revision?.databaseInspectPreflightRefs, issues, 'databaseInspectPreflightRefs');
  validateCandidateRunRefHistory(revision?.databaseInspectRunRefs, issues, 'databaseInspectRunRefs');
  validateRefHistory(revision?.databaseRuntimeProfileRefs, /^database-runtime-[a-f0-9]{24}$/, 'databaseRuntimeProfileRefs', issues);
  validateRefHistory(revision?.databaseApplyProfileRefs, /^sandbox-[a-f0-9]{24}$/, 'databaseApplyProfileRefs', issues);
  validateRefHistory(revision?.databaseApplyApprovalRefs, /^approval-[a-f0-9-]+$/, 'databaseApplyApprovalRefs', issues);
  validateDatabasePreflightRefHistory(revision?.databaseApplyPreflightRefs, issues);
  validateDatabaseRunRefHistory(revision?.databaseApplyRunRefs, issues);
  validateRefHistory(revision?.cutoverProfileRefs, /^sandbox-[a-f0-9]{24}$/, 'cutoverProfileRefs', issues);
  validateRefHistory(revision?.cutoverApprovalRefs, /^approval-[a-f0-9-]+$/, 'cutoverApprovalRefs', issues);
  validatePreflightRefHistory(revision?.cutoverPreflightRefs, issues, 'cutoverPreflightRefs');
  validateCandidateRunRefHistory(revision?.cutoverRunRefs, issues, 'cutoverRunRefs');
  validateRefHistory(
    revision?.emailDeliveryApprovalRefs,
    /^email-delivery-approval-[a-f0-9-]{36}$/,
    'emailDeliveryApprovalRefs',
    issues
  );
  validateEmailDeliveryRunRefHistory(revision?.emailDeliveryRunRefs, issues);
  validateRefHistory(
    revision?.productionVerificationRefs,
    /^product-verification-[a-f0-9]{24}$/,
    'productionVerificationRefs',
    issues
  );
  validateRefHistory(
    revision?.rollbackApprovalRefs,
    /^rollback-approval-[a-f0-9-]{36}$/,
    'rollbackApprovalRefs',
    issues
  );
  validateRollbackRunRefHistory(revision?.rollbackRunRefs, issues);
  validateManifestRef(revision?.manifestRef, issues);
  validateArtifactRef(revision?.artifactRef, issues);
  if (revision?.revision === 1) {
    if (revision.previousFingerprint !== null || revision.checkpoint !== 'bootstrap-human' ||
        hasAnyProgressRef(revision)) issues.push('initial');
  } else if (!SHA256.test(revision?.previousFingerprint || '')) issues.push('previousFingerprint');
  if ([
    'configuration-human', 'waiting-launch-settings', 'candidate-control-ready', 'candidate-plan-ready',
    'candidate-profile-ready', 'candidate-approval-ready', 'candidate-preflight-ready',
    'candidate-run-started', 'candidate-provider-stage-succeeded', 'verification-plan-ready',
    'candidate-verified', ...DATABASE_INSPECT_CHECKPOINTS, ...DATABASE_APPLY_CHECKPOINTS,
    ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
  ].includes(revision?.checkpoint) &&
      (!revision.configurationRecipeRef || !revision.configurationHandoffRef)) issues.push('configuration');
  if (['configuration-human', 'waiting-launch-settings'].includes(revision?.checkpoint) && (
    revision.configurationAttestationRef !== null || revision.manifestRef !== null || revision.artifactRef !== null ||
    revision.graphRef !== null || revision.launchConfigurationRef !== null || revision.adapterPlanRef !== null ||
    revision.migrationPlanRef !== null || revision.databaseInspectPlanRef !== null ||
    revision.backupEvidenceRef !== null || revision.databaseApplyPlanRef !== null ||
    revision.verificationPlanRef !== null || revision.candidateEvidenceRef !== null ||
    revision.cutoverHandoffRef !== null || revision.cutoverAttestationRef !== null ||
    revision.dnsChangeSetRef !== null || revision.cutoverPlanRef !== null ||
    revision.emailDeliveryPlanRef !== null || revision.productionEvidenceRef !== null || revision.rollbackPlanRef !== null ||
    (revision.productionVerificationRefs?.length || 0) > 0 ||
    (revision.sandboxProfileRefs?.length || 0) > 0 || (revision.candidateApprovalRefs?.length || 0) > 0 ||
    (revision.sandboxPreflightRefs?.length || 0) > 0 || (revision.candidateRunRefs?.length || 0) > 0 ||
    (revision.databaseInspectProfileRefs?.length || 0) > 0 ||
    (revision.databaseInspectApprovalRefs?.length || 0) > 0 ||
    (revision.databaseInspectPreflightRefs?.length || 0) > 0 ||
    (revision.databaseInspectRunRefs?.length || 0) > 0 ||
    (revision.databaseRuntimeProfileRefs?.length || 0) > 0 ||
    (revision.databaseApplyProfileRefs?.length || 0) > 0 ||
    (revision.databaseApplyApprovalRefs?.length || 0) > 0 ||
    (revision.databaseApplyPreflightRefs?.length || 0) > 0 ||
    (revision.databaseApplyRunRefs?.length || 0) > 0 ||
    (revision.cutoverProfileRefs?.length || 0) > 0 ||
    (revision.cutoverApprovalRefs?.length || 0) > 0 ||
    (revision.cutoverPreflightRefs?.length || 0) > 0 ||
    (revision.cutoverRunRefs?.length || 0) > 0 ||
    (revision.emailDeliveryApprovalRefs?.length || 0) > 0 ||
    (revision.emailDeliveryRunRefs?.length || 0) > 0 ||
    (revision.rollbackApprovalRefs?.length || 0) > 0 ||
    (revision.rollbackRunRefs?.length || 0) > 0
  )) issues.push('configuration.prematureCandidateControl');
  if ([
    'candidate-control-ready', 'candidate-plan-ready', 'candidate-profile-ready',
    'candidate-approval-ready', 'candidate-preflight-ready', 'candidate-run-started',
    'candidate-provider-stage-succeeded', 'verification-plan-ready', 'candidate-verified',
    ...DATABASE_INSPECT_CHECKPOINTS, ...DATABASE_APPLY_CHECKPOINTS, ...CUTOVER_CHECKPOINTS,
    ...ROLLBACK_CHECKPOINTS,
  ].includes(revision?.checkpoint) && (
    !revision.configurationAttestationRef || !revision.manifestRef || !revision.artifactRef ||
    !revision.graphRef || !revision.launchConfigurationRef
  )) issues.push('candidateControl');
  if ([
    'candidate-plan-ready', 'candidate-profile-ready', 'candidate-approval-ready', 'candidate-preflight-ready',
    'candidate-run-started', 'candidate-provider-stage-succeeded', 'verification-plan-ready',
    'candidate-verified', ...DATABASE_INSPECT_CHECKPOINTS, ...DATABASE_APPLY_CHECKPOINTS,
    ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
  ]
      .includes(revision?.checkpoint) && !revision.adapterPlanRef) issues.push('candidatePlan');
  if ([
    'candidate-profile-ready', 'candidate-approval-ready', 'candidate-preflight-ready',
    'candidate-run-started', 'candidate-provider-stage-succeeded',
    'verification-plan-ready', 'candidate-verified', ...DATABASE_INSPECT_CHECKPOINTS,
    ...DATABASE_APPLY_CHECKPOINTS, ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
  ]
      .includes(revision?.checkpoint) && (revision.sandboxProfileRefs?.length || 0) === 0) issues.push('candidateProfile');
  if ([
    'candidate-approval-ready', 'candidate-preflight-ready', 'candidate-run-started',
    'candidate-provider-stage-succeeded',
    'verification-plan-ready', 'candidate-verified', ...DATABASE_INSPECT_CHECKPOINTS,
    ...DATABASE_APPLY_CHECKPOINTS, ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
  ].includes(revision?.checkpoint) &&
      (revision.candidateApprovalRefs?.length || 0) === 0) issues.push('candidateApproval');
  if ([
    'candidate-preflight-ready', 'candidate-run-started', 'candidate-provider-stage-succeeded',
    'verification-plan-ready', 'candidate-verified', ...DATABASE_INSPECT_CHECKPOINTS,
    ...DATABASE_APPLY_CHECKPOINTS, ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
  ]
      .includes(revision?.checkpoint) && (revision.sandboxPreflightRefs?.length || 0) === 0) {
    issues.push('candidatePreflight');
  }
  if ([
    'candidate-run-started', 'candidate-provider-stage-succeeded', 'verification-plan-ready',
    'candidate-verified', ...DATABASE_INSPECT_CHECKPOINTS, ...DATABASE_APPLY_CHECKPOINTS,
    ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
  ].includes(revision?.checkpoint) &&
      (revision.candidateRunRefs?.length || 0) === 0) issues.push('candidateRun');
  if ([...DATABASE_INSPECT_CHECKPOINTS, ...DATABASE_APPLY_CHECKPOINTS].includes(revision?.checkpoint) &&
      (!revision.migrationPlanRef || !revision.databaseInspectPlanRef)) issues.push('databaseInspectPlan');
  if ([...DATABASE_INSPECT_CHECKPOINTS.slice(1), ...DATABASE_APPLY_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.databaseInspectProfileRefs?.length || 0) === 0) issues.push('databaseInspectProfile');
  if ([...DATABASE_INSPECT_CHECKPOINTS.slice(2), ...DATABASE_APPLY_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.databaseInspectApprovalRefs?.length || 0) === 0) issues.push('databaseInspectApproval');
  if ([...DATABASE_INSPECT_CHECKPOINTS.slice(3), ...DATABASE_APPLY_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.databaseInspectPreflightRefs?.length || 0) === 0) issues.push('databaseInspectPreflight');
  if ([...DATABASE_INSPECT_CHECKPOINTS.slice(4), ...DATABASE_APPLY_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.databaseInspectRunRefs?.length || 0) === 0) issues.push('databaseInspectRun');
  if (DATABASE_APPLY_CHECKPOINTS.includes(revision?.checkpoint) &&
      (!revision.backupEvidenceRef || !revision.databaseApplyPlanRef)) issues.push('databaseApplyPlan');
  if (DATABASE_APPLY_CHECKPOINTS.slice(1).includes(revision?.checkpoint) &&
      (revision.databaseRuntimeProfileRefs?.length || 0) === 0) issues.push('databaseRuntimeProfile');
  if (DATABASE_APPLY_CHECKPOINTS.slice(2).includes(revision?.checkpoint) &&
      (revision.databaseApplyProfileRefs?.length || 0) === 0) issues.push('databaseApplyProfile');
  if (DATABASE_APPLY_CHECKPOINTS.slice(3).includes(revision?.checkpoint) &&
      (revision.databaseApplyApprovalRefs?.length || 0) === 0) issues.push('databaseApplyApproval');
  if (DATABASE_APPLY_CHECKPOINTS.slice(4).includes(revision?.checkpoint) &&
      (revision.databaseApplyPreflightRefs?.length || 0) === 0) issues.push('databaseApplyPreflight');
  if (DATABASE_APPLY_CHECKPOINTS.slice(5).includes(revision?.checkpoint) &&
      (revision.databaseApplyRunRefs?.length || 0) === 0) issues.push('databaseApplyRun');
  if (['verification-plan-ready', 'candidate-verified'].includes(revision?.checkpoint) &&
      !revision.verificationPlanRef) issues.push('verificationPlan');
  if (revision?.checkpoint === 'candidate-verified' && !revision.candidateEvidenceRef) {
    issues.push('candidateEvidence');
  }
  if ([...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) &&
      (!revision.verificationPlanRef || !revision.candidateEvidenceRef || !revision.cutoverHandoffRef)) {
    issues.push('cutoverHandoff');
  }
  if ([...CUTOVER_CHECKPOINTS.slice(1), ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) && !revision.cutoverAttestationRef) {
    issues.push('cutoverAttestation');
  }
  if ([...CUTOVER_CHECKPOINTS.slice(1), ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) &&
      (!revision.dnsChangeSetRef || !revision.cutoverPlanRef)) issues.push('cutoverPlan');
  if ([...CUTOVER_CHECKPOINTS.slice(2), ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.cutoverProfileRefs?.length || 0) === 0) issues.push('cutoverProfile');
  if ([...CUTOVER_CHECKPOINTS.slice(3), ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.cutoverApprovalRefs?.length || 0) === 0) issues.push('cutoverApproval');
  if ([...CUTOVER_CHECKPOINTS.slice(4), ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.cutoverPreflightRefs?.length || 0) === 0) issues.push('cutoverPreflight');
  if ([...CUTOVER_CHECKPOINTS.slice(5), ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.cutoverRunRefs?.length || 0) === 0) issues.push('cutoverRun');
  if (EMAIL_DELIVERY_CHECKPOINTS.includes(revision?.checkpoint) && !revision.emailDeliveryPlanRef) {
    issues.push('emailDeliveryPlan');
  }
  if (EMAIL_DELIVERY_CHECKPOINTS.slice(1).includes(revision?.checkpoint) &&
      (revision.emailDeliveryApprovalRefs?.length || 0) === 0) issues.push('emailDeliveryApproval');
  if (EMAIL_DELIVERY_CHECKPOINTS.slice(2).includes(revision?.checkpoint) &&
      (revision.emailDeliveryRunRefs?.length || 0) === 0) issues.push('emailDeliveryRun');
  if ((revision?.emailDeliveryApprovalRefs?.length || 0) > 0 && !revision?.emailDeliveryPlanRef) {
    issues.push('emailDeliveryApproval.plan');
  }
  if ((revision?.emailDeliveryRunRefs?.length || 0) > 0 &&
      (revision?.emailDeliveryApprovalRefs?.length || 0) === 0) issues.push('emailDeliveryRun.approval');
  if (revision?.emailDeliveryPlanRef && ![
    ...EMAIL_DELIVERY_CHECKPOINTS,
    'production-verification-observed', 'production-verified',
    ...ROLLBACK_CHECKPOINTS,
  ].includes(revision?.checkpoint)) issues.push('emailDeliveryPlan.checkpoint');
  if (['production-verification-observed', 'production-verified', ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint) &&
      (revision.productionVerificationRefs?.length || 0) === 0) issues.push('productionVerification');
  if (revision?.checkpoint === 'production-verified' && !revision.productionEvidenceRef) {
    issues.push('productionEvidence');
  }
  if (revision?.productionEvidenceRef && revision?.checkpoint !== 'production-verified') {
    issues.push('productionEvidence.checkpoint');
  }
  if ((revision?.productionVerificationRefs?.length || 0) > 0 &&
      !['production-verification-observed', 'production-verified', ...ROLLBACK_CHECKPOINTS].includes(revision?.checkpoint)) {
    issues.push('productionVerification.checkpoint');
  }
  if (ROLLBACK_CHECKPOINTS.includes(revision?.checkpoint) && !revision.rollbackPlanRef) {
    issues.push('rollbackPlan');
  }
  if (ROLLBACK_CHECKPOINTS.slice(1).includes(revision?.checkpoint) &&
      (revision.rollbackApprovalRefs?.length || 0) === 0) issues.push('rollbackApproval');
  if (ROLLBACK_CHECKPOINTS.slice(2).includes(revision?.checkpoint) &&
      (revision.rollbackRunRefs?.length || 0) === 0) issues.push('rollbackRun');
  if (revision?.rollbackPlanRef && !ROLLBACK_CHECKPOINTS.includes(revision?.checkpoint)) {
    issues.push('rollbackPlan.checkpoint');
  }
  if ((revision?.rollbackApprovalRefs?.length || 0) > 0 && !revision?.rollbackPlanRef) {
    issues.push('rollbackApproval.plan');
  }
  if ((revision?.rollbackRunRefs?.length || 0) > 0 &&
      (revision?.rollbackApprovalRefs?.length || 0) === 0) issues.push('rollbackRun.approval');
  if (expected.session && (
    revision?.sessionId !== expected.session.id || revision?.sessionFingerprint !== expected.session.fingerprint ||
    revision?.projectId !== expected.session.projectId || revision?.sourceCommit !== expected.session.sourceRef.commit
  )) issues.push('session');
  if (expected.project && (
    revision?.projectId !== expected.project.id || revision?.sourceCommit !== expected.project.source.commit
  )) issues.push('project');
  if (expected.previous && (
    revision?.revision !== expected.previous.revision + 1 ||
    revision?.previousFingerprint !== expected.previous.fingerprint ||
    Date.parse(revision?.createdAt || 0) < Date.parse(expected.previous.createdAt)
  )) issues.push('previous');
  if (expected.previous) {
    const order = [
      'bootstrap-human', 'configuration-human', 'waiting-launch-settings', 'candidate-control-ready',
      'candidate-plan-ready', 'candidate-profile-ready', 'candidate-approval-ready',
      'candidate-preflight-ready', 'candidate-run-started', 'candidate-provider-stage-succeeded',
      ...DATABASE_INSPECT_CHECKPOINTS,
      ...DATABASE_APPLY_CHECKPOINTS,
      'verification-plan-ready', 'candidate-verified', ...CUTOVER_CHECKPOINTS, ...ROLLBACK_CHECKPOINTS,
    ];
    if (order.indexOf(revision.checkpoint) < order.indexOf(expected.previous.checkpoint)) issues.push('checkpoint.regression');
    for (const field of [
      'configurationRecipeRef', 'configurationHandoffRef', 'configurationAttestationRef',
      'manifestRef', 'artifactRef', 'graphRef', 'launchConfigurationRef', 'adapterPlanRef',
      'migrationPlanRef', 'databaseInspectPlanRef', 'verificationPlanRef', 'candidateEvidenceRef',
      'backupEvidenceRef', 'databaseApplyPlanRef',
      'cutoverHandoffRef', 'cutoverAttestationRef', 'dnsChangeSetRef', 'cutoverPlanRef',
      'emailDeliveryPlanRef', 'productionEvidenceRef', 'rollbackPlanRef',
    ]) {
      if (expected.previous[field] !== null &&
          stableStringify(revision[field]) !== stableStringify(expected.previous[field])) issues.push(`${field}.replacement`);
    }
    for (const field of [
      'sandboxProfileRefs', 'candidateApprovalRefs', 'sandboxPreflightRefs', 'candidateRunRefs',
      'databaseInspectProfileRefs', 'databaseInspectApprovalRefs', 'databaseInspectPreflightRefs',
      'databaseInspectRunRefs',
      'databaseRuntimeProfileRefs', 'databaseApplyProfileRefs', 'databaseApplyApprovalRefs',
      'databaseApplyPreflightRefs', 'databaseApplyRunRefs',
      'cutoverProfileRefs', 'cutoverApprovalRefs', 'cutoverPreflightRefs', 'cutoverRunRefs',
      'emailDeliveryApprovalRefs', 'emailDeliveryRunRefs',
      'productionVerificationRefs', 'rollbackApprovalRefs', 'rollbackRunRefs',
    ]) {
      if (!historyExtends(expected.previous[field], revision[field])) issues.push(`${field}.replacement`);
    }
  }
  if (issues.length > 0) {
    throw operationError('VALIDATION_FAILED', `First Launch Session Revision is invalid at: ${[...new Set(issues)].join(', ')}`);
  }
  const actual = revisionFingerprint(revision);
  if (revision.fingerprint !== actual || revision.id !== `first-launch-revision-${actual.slice(7, 31)}`) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `First Launch Session Revision fingerprint mismatch: ${revision.id}`);
  }
  return revision;
}

function readRevisionChain(home, project, session) {
  const directory = revisionDirectory(home, project.id, session.id);
  if (!fs.existsSync(directory)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', `First Launch Session has no Revision chain: ${session.id}`);
  }
  const files = fs.readdirSync(directory)
    .filter((name) => /^\d{6}\.json$/.test(name))
    .sort();
  if (files.length === 0) throw operationError('ARTIFACT_INTEGRITY_FAILED', `First Launch Session has no Revisions: ${session.id}`);
  let previous = null;
  for (const [index, name] of files.entries()) {
    if (name !== `${String(index + 1).padStart(6, '0')}.json`) {
      throw operationError('ARTIFACT_INTEGRITY_FAILED', `First Launch Session Revision sequence has a gap: ${name}`);
    }
    previous = validateFirstLaunchSessionRevision(
      readJson(path.join(directory, name), 'First Launch Session Revision'),
      { project, session, previous }
    );
  }
  return previous;
}

function ensureCandidateControlObjects({ home, project, session, revision, settings, now }) {
  const recipe = showRecipe({
    home,
    projectId: project.id,
    recipeId: revision.configurationRecipeRef.id,
  }).recipe;
  if (recipe.fingerprint !== revision.configurationRecipeRef.fingerprint ||
      recipe.requiredConnections.some((item) => item.status !== 'ready')) {
    throw operationError('CONFLICT', 'Configuration Recipe Connections are no longer ready.');
  }
  let manifest;
  try {
    manifest = showExternalManifest({ home, projectId: project.id }).manifest;
    if (manifest.recipeRef?.id !== recipe.id || manifest.recipeRef?.fingerprint !== recipe.fingerprint ||
        !sameSource(manifest.sourceRef, session.sourceRef)) {
      throw operationError('CONFLICT', 'Existing Deployment Manifest does not belong to this First Launch Session Recipe.');
    }
  } catch (error) {
    if (error?.code !== 'NOT_FOUND') throw error;
    manifest = createExternalManifest({ home, projectId: project.id, recipeId: recipe.id, now }).manifest;
  }
  const artifactReport = recipe.providers.runtime === 'vercel'
    ? createVercelFileManifest({ home, projectId: project.id, now })
    : createArtifact({ home, projectId: project.id, now });
  const artifact = verifyArtifact({ home, projectId: project.id, artifactId: artifactReport.artifact.id }).artifact;
  const graph = planLaunch({ home, projectId: project.id, now }).graph;
  const configuration = createLaunchConfiguration({
    home,
    projectId: project.id,
    graphId: graph.id,
    settings,
    now,
  }).configuration;
  return {
    manifestRef: {
      fingerprint: manifest.fingerprint,
      recipeId: recipe.id,
      recipeFingerprint: recipe.fingerprint,
    },
    artifactRef: artifactReference(artifact),
    graph,
    configuration,
  };
}

function validateCandidateControlObjects({ home, project, session, revision }) {
  const configurationAttestation = showHumanHandoff({
    home,
    projectId: project.id,
    handoffId: revision.configurationHandoffRef.id,
    handoffAttestationId: revision.configurationAttestationRef.id,
  }).attestation;
  if (configurationAttestation.status !== 'completed' ||
      configurationAttestation.fingerprint !== revision.configurationAttestationRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Configuration Attestation binding mismatch.');
  }
  const recipe = showRecipe({
    home,
    projectId: project.id,
    recipeId: revision.configurationRecipeRef.id,
  }).recipe;
  if (recipe.fingerprint !== revision.configurationRecipeRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Configuration Recipe fingerprint mismatch.');
  }
  const manifest = showExternalManifest({ home, projectId: project.id }).manifest;
  if (manifest.fingerprint !== revision.manifestRef.fingerprint || manifest.recipeRef?.id !== recipe.id ||
      manifest.recipeRef?.fingerprint !== recipe.fingerprint || !sameSource(manifest.sourceRef, session.sourceRef)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Manifest binding mismatch.');
  }
  const artifact = verifyArtifact({
    home,
    projectId: project.id,
    artifactId: revision.artifactRef.id,
  }).artifact;
  if (stableStringify(artifactReference(artifact)) !== stableStringify(revision.artifactRef)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Artifact binding mismatch.');
  }
  const graph = showLaunchGraph({ home, projectId: project.id, graphId: revision.graphRef.id }).graph;
  if (graph.fingerprint !== revision.graphRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Graph binding mismatch.');
  }
  const configuration = showLaunchConfiguration({
    home,
    projectId: project.id,
    graphId: graph.id,
    configurationId: revision.launchConfigurationRef.id,
  }).configuration;
  if (configuration.fingerprint !== revision.launchConfigurationRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Configuration binding mismatch.');
  }
  return { recipe, manifest, artifact, graph, configuration };
}

function evaluateCandidateAuthorization({ home, project, session, revision, candidateControl, now }) {
  if (!revision.adapterPlanRef) {
    return {
      status: 'ready-for-candidate-plan', plan: null, profile: null, approval: null, preflight: null,
    };
  }
  const plan = showBoundCandidatePlan({ home, project, revision, candidateControl });
  const profileRef = latestRef(revision.sandboxProfileRefs);
  if (!profileRef) {
    return { status: 'waiting-sandbox-profile', plan, profile: null, approval: null, preflight: null };
  }
  const shownProfile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profileRef.id, now,
  });
  if (shownProfile.profile.fingerprint !== profileRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Sandbox Profile binding mismatch.');
  }
  assertCandidateProfileScope(shownProfile.profile, candidateControl.configuration);
  if (shownProfile.effectiveStatus !== 'active') {
    return {
      status: 'waiting-sandbox-profile', plan, profile: shownProfile.profile,
      profileStatus: shownProfile.effectiveStatus, approval: null, preflight: null,
    };
  }
  const profile = shownProfile.profile;
  const approvalRef = latestRef(revision.candidateApprovalRefs);
  if (!approvalRef) {
    return { status: 'waiting-candidate-approval', plan, profile, approval: null, preflight: null };
  }
  const shownApproval = showApproval({
    home, projectId: project.id, approvalId: approvalRef.id, now,
  });
  if (shownApproval.approval.fingerprint !== approvalRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Candidate Approval binding mismatch.');
  }
  const approval = shownApproval.approval;
  const approvalValid = shownApproval.effectiveStatus === 'active' &&
    approval.graphId === candidateControl.graph.id &&
    approval.graphFingerprint === candidateControl.graph.fingerprint &&
    approval.approvedBy === session.owner &&
    candidateApprovalNodeIds(candidateControl.graph, plan).every((nodeId) => approval.nodeIds.includes(nodeId));
  if (!approvalValid) {
    return {
      status: 'waiting-candidate-approval', plan, profile, approval,
      approvalStatus: shownApproval.effectiveStatus, preflight: null,
    };
  }
  const preflightRef = latestRef(revision.sandboxPreflightRefs);
  if (!preflightRef || preflightRef.profileId !== profile.id ||
      preflightRef.profileFingerprint !== profile.fingerprint || preflightRef.approvalId !== approval.id ||
      preflightRef.approvalFingerprint !== approval.fingerprint) {
    return { status: 'waiting-sandbox-preflight', plan, profile, approval, preflight: null };
  }
  const shownPreflight = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profile.id, evidenceId: preflightRef.id, now,
  });
  if (shownPreflight.evidence.fingerprint !== preflightRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Sandbox Preflight binding mismatch.');
  }
  assertPreflightApprovalBinding(shownPreflight.evidence, approval, candidateControl.graph, plan);
  if (shownPreflight.effectiveStatus !== 'ready') {
    return {
      status: 'waiting-sandbox-preflight', plan, profile, approval,
      preflight: shownPreflight.evidence, preflightStatus: shownPreflight.effectiveStatus,
    };
  }
  return {
    status: 'ready-for-candidate-apply', plan, profile, approval, preflight: shownPreflight.evidence,
  };
}

function evaluateCandidateRun({ home, project, revision, candidateControl, candidateAuthorization, now }) {
  const ref = latestRef(revision.candidateRunRefs);
  const run = adoptCandidateRun({ home, project, revision, runId: ref.id, now });
  if (run.revision < ref.revision) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Candidate LaunchRun Revision history moved backwards.');
  }
  if (run.revision === ref.revision && run.fingerprint !== ref.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Candidate LaunchRun Revision fingerprint mismatch.');
  }
  const classification = classifyCandidateRun(run, candidateAuthorization.plan);
  if (run.revision > ref.revision) {
    return { ...classification, status: 'candidate-run-update-available', run, storedRef: ref };
  }
  if (classification.status === 'candidate-provider-stage-succeeded' ||
      classification.status === 'candidate-run-failed') {
    return { ...classification, run, storedRef: ref };
  }
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    planId: candidateAuthorization.plan.id, profileId: run.sandboxProfileId, now,
  });
  if (profile.effectiveStatus !== 'active') {
    return {
      ...classification, status: 'candidate-run-authorization-expired', run, storedRef: ref,
      authorizationStatus: `sandbox-profile-${profile.effectiveStatus}`,
    };
  }
  const approvalRef = latestRef(revision.candidateApprovalRefs);
  const approval = approvalRef ? showApproval({
    home, projectId: project.id, approvalId: approvalRef.id, now,
  }) : null;
  const approvalReady = approval?.effectiveStatus === 'active' &&
    candidateApprovalNodeIds(candidateControl.graph, candidateAuthorization.plan)
      .every((nodeId) => approval.approval.nodeIds.includes(nodeId));
  if (!approvalReady) {
    return { ...classification, status: 'waiting-candidate-approval', run, storedRef: ref };
  }
  return { ...classification, run, storedRef: ref };
}

function adoptCandidateRun({ home, project, revision, runId, now }) {
  const run = readLaunchRun(home, project.id, runId);
  if (now && Date.parse(now) < Date.parse(run.updatedAt)) {
    throw operationError('CONFLICT', 'Candidate LaunchRun cannot be observed before its latest Revision timestamp.');
  }
  if (run.mode !== 'execute' || run.providerMode !== 'sandbox' ||
      run.transportProvenance !== 'native-cli-fixed-host' || run.graphId !== revision.graphRef.id ||
      run.graphFingerprint !== revision.graphRef.fingerprint || run.adapterPlanId !== revision.adapterPlanRef.id ||
      run.adapterPlanFingerprint !== revision.adapterPlanRef.fingerprint) {
    throw operationError('CONFLICT', 'Candidate LaunchRun is not the native Sandbox Run for this First Launch Graph and Plan.');
  }
  const profileRef = revision.sandboxProfileRefs.find((ref) =>
    ref.id === run.sandboxProfileId && ref.fingerprint === run.sandboxProfileFingerprint
  );
  const preflightRef = revision.sandboxPreflightRefs.find((ref) =>
    ref.id === run.sandboxPreflightId && ref.fingerprint === run.sandboxPreflightFingerprint &&
    ref.profileId === run.sandboxProfileId && ref.profileFingerprint === run.sandboxProfileFingerprint
  );
  if (!profileRef || !preflightRef) {
    throw operationError('CONFLICT', 'Candidate LaunchRun uses an unbound Sandbox Profile or Preflight.');
  }
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: revision.adapterPlanRef.id,
  }).plan;
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, now: run.createdAt,
  });
  const preflight = showSandboxPreflight({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, evidenceId: preflightRef.id, now: run.createdAt,
  });
  if (Date.parse(run.createdAt) < Date.parse(profile.profile.createdAt) ||
      sandboxProfileStatusAt(home, project.id, profile.profile, run.createdAt) !== 'active' ||
      preflight.effectiveStatus !== 'ready' ||
      Date.parse(run.createdAt) < Date.parse(preflight.evidence.checkedAt) ||
      Date.parse(run.createdAt) >= Date.parse(preflight.evidence.validUntil)) {
    throw operationError('CONFLICT', 'Candidate LaunchRun was not started inside its approved Profile and Preflight window.');
  }
  if (!plan.actions.some((action) => action.nodeId === 'candidate.deploy')) {
    throw operationError('CONFLICT', 'Candidate LaunchRun Plan does not contain candidate.deploy.');
  }
  return run;
}

function classifyCandidateRun(run, plan) {
  const nodeIds = [...new Set(plan.actions.map((action) => action.nodeId))].sort();
  const states = nodeIds.map((nodeId) => ({ nodeId, ...run.nodeStates[nodeId] }));
  const failedNodes = states.filter((state) =>
    ['failed-terminal', 'compensated', 'skipped'].includes(state.status)
  ).map((state) => state.nodeId);
  if (failedNodes.length > 0) return { status: 'candidate-run-failed', failedNodes };
  if (states.every((state) => state.status === 'succeeded') &&
      run.nodeStates['candidate.deploy']?.status === 'succeeded') {
    return { status: 'candidate-provider-stage-succeeded', failedNodes: [] };
  }
  if (states.some((state) => state.status === 'waiting-external')) {
    return { status: 'waiting-candidate-run', failedNodes: [] };
  }
  return { status: 'candidate-run-resumable', failedNodes: [] };
}

function evaluateDatabaseMigration({ home, project, session, revision, candidateControl, now }) {
  if (!revision.migrationPlanRef) {
    return {
      status: 'candidate-provider-stage-succeeded', migrationPlan: null, inspectPlan: null,
      authorization: null, run: null,
    };
  }
  const bound = showBoundDatabaseInspectPlan({ home, project, revision, candidateControl });
  const authorization = evaluateDatabaseInspectAuthorization({
    home, project, session, revision, candidateControl, inspectPlan: bound.plan, now,
  });
  if (revision.databaseInspectRunRefs.length === 0) {
    return {
      status: authorization.status, migrationPlan: bound.migrationPlan,
      inspectPlan: bound.plan, authorization, run: null,
    };
  }
  const run = evaluateDatabaseInspectRun({
    home, project, revision, candidateControl, inspectPlan: bound.plan, authorization, now,
  });
  if (run.status !== 'database-inspect-stage-succeeded' || !revision.backupEvidenceRef) {
    return {
      status: run.status, migrationPlan: bound.migrationPlan,
      inspectPlan: bound.plan, authorization, run,
      backupEvidence: null, applyPlan: null, databaseRuntime: null,
      applyAuthorization: null, applyRun: null,
    };
  }
  const apply = showBoundDatabaseApplyPlan({ home, project, revision, candidateControl });
  const databaseRuntime = evaluateDatabaseRuntimeProfile({
    home, project, session, revision, candidateControl, applyPlan: apply.plan, now,
  });
  if (databaseRuntime.status !== 'database-runtime-profile-ready') {
    return {
      status: databaseRuntime.status, migrationPlan: bound.migrationPlan,
      inspectPlan: bound.plan, authorization, run, backupEvidence: apply.backupEvidence,
      applyPlan: apply.plan, databaseRuntime, applyAuthorization: null, applyRun: null,
    };
  }
  const applyAuthorization = evaluateDatabaseApplyAuthorization({
    home, project, session, revision, candidateControl, applyPlan: apply.plan,
    databaseRuntimeProfile: databaseRuntime.profile, now,
  });
  if (revision.databaseApplyRunRefs.length === 0) {
    return {
      status: applyAuthorization.status, migrationPlan: bound.migrationPlan,
      inspectPlan: bound.plan, authorization, run, backupEvidence: apply.backupEvidence,
      applyPlan: apply.plan, databaseRuntime, applyAuthorization, applyRun: null,
    };
  }
  const applyRun = evaluateDatabaseApplyRun({
    home, project, revision, candidateControl, applyPlan: apply.plan,
    databaseRuntimeProfile: databaseRuntime.profile, authorization: applyAuthorization, now,
  });
  return {
    status: applyRun.status, migrationPlan: bound.migrationPlan,
    inspectPlan: bound.plan, authorization, run, backupEvidence: apply.backupEvidence,
    applyPlan: apply.plan, databaseRuntime, applyAuthorization, applyRun,
  };
}

function showBoundDatabaseInspectPlan({ home, project, revision, candidateControl }) {
  const migrationPlan = showDatabaseMigrationPlan({
    home,
    projectId: project.id,
    graphId: candidateControl.graph.id,
    configurationId: candidateControl.configuration.id,
    planId: revision.migrationPlanRef.id,
  }).plan;
  if (migrationPlan.fingerprint !== revision.migrationPlanRef.fingerprint || migrationPlan.status === 'blocked') {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Database Migration Plan binding mismatch.');
  }
  const plan = showAdapterExecutionPlan({
    home,
    projectId: project.id,
    graphId: candidateControl.graph.id,
    planId: revision.databaseInspectPlanRef.id,
  }).plan;
  if (plan.fingerprint !== revision.databaseInspectPlanRef.fingerprint ||
      plan.configurationId !== candidateControl.configuration.id ||
      plan.configurationFingerprint !== candidateControl.configuration.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Database Inspect Adapter Plan binding mismatch.');
  }
  assertDatabaseInspectPlanShape(plan, migrationPlan);
  return { migrationPlan, plan };
}

function assertDatabaseInspectPlanShape(plan, migrationPlan) {
  const nodeIds = [...new Set((plan?.actions || []).map((action) => action.nodeId))].sort();
  if (plan?.migrationPlanId !== migrationPlan.id ||
      plan?.migrationPlanFingerprint !== migrationPlan.fingerprint ||
      plan?.backupEvidenceId || plan?.dnsChangeSetId ||
      stableStringify(nodeIds) !== stableStringify(['database.backup', 'database.inspect']) ||
      plan.actions.length < 2) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Inspect Adapter Plan does not contain the exact inspect and backup stage.');
  }
}

function showBoundDatabaseApplyPlan({ home, project, revision, candidateControl }) {
  const migrationPlan = showDatabaseMigrationPlan({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    configurationId: candidateControl.configuration.id, planId: revision.migrationPlanRef.id,
  }).plan;
  const backupEvidence = showBackupEvidence({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    adapterPlanId: revision.databaseInspectPlanRef.id, evidenceId: revision.backupEvidenceRef.id,
  }).evidence;
  if (backupEvidence.fingerprint !== revision.backupEvidenceRef.fingerprint ||
      backupEvidence.status !== 'verified' || backupEvidence.migrationPlanId !== migrationPlan.id ||
      backupEvidence.migrationPlanFingerprint !== migrationPlan.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Backup Evidence binding mismatch.');
  }
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    planId: revision.databaseApplyPlanRef.id,
  }).plan;
  if (plan.fingerprint !== revision.databaseApplyPlanRef.fingerprint ||
      plan.configurationId !== candidateControl.configuration.id ||
      plan.configurationFingerprint !== candidateControl.configuration.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Database Apply Adapter Plan binding mismatch.');
  }
  assertDatabaseApplyPlanShape(plan, migrationPlan, backupEvidence);
  return { migrationPlan, backupEvidence, plan };
}

function assertDatabaseApplyPlanShape(plan, migrationPlan, backupEvidence) {
  const nodeIds = [...new Set((plan?.actions || []).map((action) => action.nodeId))].sort();
  if (plan?.migrationPlanId !== migrationPlan.id ||
      plan?.migrationPlanFingerprint !== migrationPlan.fingerprint ||
      plan?.backupEvidenceId !== backupEvidence.id ||
      plan?.backupEvidenceFingerprint !== backupEvidence.fingerprint ||
      plan?.dnsChangeSetId || stableStringify(nodeIds) !== stableStringify(['database.migrate']) ||
      plan.actions.length !== 1) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Apply Adapter Plan does not contain the exact evidence-bound migration stage.');
  }
}

function evaluateDatabaseRuntimeProfile({
  home, project, session, revision, candidateControl, applyPlan, now,
}) {
  const ref = latestRef(revision.databaseRuntimeProfileRefs);
  if (!ref) return { status: 'waiting-database-runtime-profile', profile: null };
  const shown = showDatabaseRuntimeProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    adapterPlanId: applyPlan.id, profileId: ref.id, now,
  });
  if (shown.profile.fingerprint !== ref.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Runtime Profile binding mismatch.');
  }
  if (shown.effectiveStatus !== 'active' || shown.profile.approvedBy !== session.owner) {
    return {
      status: 'waiting-database-runtime-profile', profile: shown.profile,
      profileStatus: shown.effectiveStatus,
    };
  }
  return { status: 'database-runtime-profile-ready', profile: shown.profile };
}

function evaluateDatabaseApplyAuthorization({
  home, project, session, revision, candidateControl, applyPlan, databaseRuntimeProfile, now,
}) {
  const profileRef = latestRef(revision.databaseApplyProfileRefs);
  if (!profileRef) {
    return { status: 'waiting-database-apply-profile', profile: null, approval: null, preflight: null };
  }
  const shownProfile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: applyPlan.id,
    profileId: profileRef.id, now,
  });
  if (shownProfile.profile.fingerprint !== profileRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Apply Sandbox Profile binding mismatch.');
  }
  assertDatabaseApplyProfileScope(shownProfile.profile, candidateControl.configuration);
  if (shownProfile.effectiveStatus !== 'active') {
    return {
      status: 'waiting-database-apply-profile', profile: shownProfile.profile,
      profileStatus: shownProfile.effectiveStatus, approval: null, preflight: null,
    };
  }
  const profile = shownProfile.profile;
  const approvalRef = latestRef(revision.databaseApplyApprovalRefs);
  if (!approvalRef) {
    return { status: 'waiting-database-apply-approval', profile, approval: null, preflight: null };
  }
  const shownApproval = showApproval({ home, projectId: project.id, approvalId: approvalRef.id, now });
  if (shownApproval.approval.fingerprint !== approvalRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Apply Approval binding mismatch.');
  }
  const required = candidateApprovalNodeIds(candidateControl.graph, applyPlan);
  const approval = shownApproval.approval;
  if (shownApproval.effectiveStatus !== 'active' || approval.graphId !== candidateControl.graph.id ||
      approval.graphFingerprint !== candidateControl.graph.fingerprint || approval.approvedBy !== session.owner ||
      !required.every((nodeId) => approval.nodeIds.includes(nodeId))) {
    return {
      status: 'waiting-database-apply-approval', profile, approval,
      approvalStatus: shownApproval.effectiveStatus, preflight: null,
    };
  }
  const preflightRef = latestRef(revision.databaseApplyPreflightRefs);
  if (!preflightRef || preflightRef.profileId !== profile.id ||
      preflightRef.profileFingerprint !== profile.fingerprint || preflightRef.approvalId !== approval.id ||
      preflightRef.approvalFingerprint !== approval.fingerprint ||
      preflightRef.databaseRuntimeProfileId !== databaseRuntimeProfile.id ||
      preflightRef.databaseRuntimeProfileFingerprint !== databaseRuntimeProfile.fingerprint) {
    return { status: 'waiting-database-apply-preflight', profile, approval, preflight: null };
  }
  const shownPreflight = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: applyPlan.id,
    profileId: profile.id, databaseRuntimeProfileId: databaseRuntimeProfile.id,
    evidenceId: preflightRef.id, now,
  });
  if (shownPreflight.evidence.fingerprint !== preflightRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Apply Preflight binding mismatch.');
  }
  assertPreflightApprovalBinding(shownPreflight.evidence, approval, candidateControl.graph, applyPlan);
  if (shownPreflight.effectiveStatus !== 'ready') {
    return {
      status: 'waiting-database-apply-preflight', profile, approval,
      preflight: shownPreflight.evidence, preflightStatus: shownPreflight.effectiveStatus,
    };
  }
  return { status: 'ready-for-database-apply', profile, approval, preflight: shownPreflight.evidence };
}

function evaluateDatabaseInspectAuthorization({
  home, project, session, revision, candidateControl, inspectPlan, now,
}) {
  const profileRef = latestRef(revision.databaseInspectProfileRefs);
  if (!profileRef) {
    return { status: 'waiting-database-inspect-profile', profile: null, approval: null, preflight: null };
  }
  const shownProfile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: inspectPlan.id,
    profileId: profileRef.id, now,
  });
  if (shownProfile.profile.fingerprint !== profileRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Inspect Sandbox Profile binding mismatch.');
  }
  assertDatabaseInspectProfileScope(shownProfile.profile, candidateControl.configuration);
  if (shownProfile.effectiveStatus !== 'active') {
    return {
      status: 'waiting-database-inspect-profile', profile: shownProfile.profile,
      profileStatus: shownProfile.effectiveStatus, approval: null, preflight: null,
    };
  }
  const profile = shownProfile.profile;
  const approvalRef = latestRef(revision.databaseInspectApprovalRefs);
  if (!approvalRef) {
    return { status: 'waiting-database-inspect-approval', profile, approval: null, preflight: null };
  }
  const shownApproval = showApproval({ home, projectId: project.id, approvalId: approvalRef.id, now });
  if (shownApproval.approval.fingerprint !== approvalRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Inspect Approval binding mismatch.');
  }
  const required = candidateApprovalNodeIds(candidateControl.graph, inspectPlan);
  const approval = shownApproval.approval;
  if (shownApproval.effectiveStatus !== 'active' || approval.graphId !== candidateControl.graph.id ||
      approval.graphFingerprint !== candidateControl.graph.fingerprint || approval.approvedBy !== session.owner ||
      !required.every((nodeId) => approval.nodeIds.includes(nodeId))) {
    return {
      status: 'waiting-database-inspect-approval', profile, approval,
      approvalStatus: shownApproval.effectiveStatus, preflight: null,
    };
  }
  const preflightRef = latestRef(revision.databaseInspectPreflightRefs);
  if (!preflightRef || preflightRef.profileId !== profile.id ||
      preflightRef.profileFingerprint !== profile.fingerprint || preflightRef.approvalId !== approval.id ||
      preflightRef.approvalFingerprint !== approval.fingerprint) {
    return { status: 'waiting-database-inspect-preflight', profile, approval, preflight: null };
  }
  const shownPreflight = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: inspectPlan.id,
    profileId: profile.id, evidenceId: preflightRef.id, now,
  });
  if (shownPreflight.evidence.fingerprint !== preflightRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Inspect Preflight binding mismatch.');
  }
  assertPreflightApprovalBinding(shownPreflight.evidence, approval, candidateControl.graph, inspectPlan);
  if (shownPreflight.effectiveStatus !== 'ready') {
    return {
      status: 'waiting-database-inspect-preflight', profile, approval,
      preflight: shownPreflight.evidence, preflightStatus: shownPreflight.effectiveStatus,
    };
  }
  return { status: 'ready-for-database-inspect-apply', profile, approval, preflight: shownPreflight.evidence };
}

function evaluateDatabaseInspectRun({ home, project, revision, candidateControl, inspectPlan, authorization, now }) {
  const ref = latestRef(revision.databaseInspectRunRefs);
  const run = adoptDatabaseInspectRun({ home, project, revision, runId: ref.id, now });
  if (run.revision < ref.revision) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Inspect LaunchRun Revision history moved backwards.');
  }
  if (run.revision === ref.revision && run.fingerprint !== ref.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Inspect LaunchRun Revision fingerprint mismatch.');
  }
  const classification = classifyStageRun(
    run, inspectPlan, 'database-inspect-stage-succeeded', 'database-inspect-run'
  );
  if (run.revision > ref.revision) {
    return { ...classification, status: 'database-inspect-run-update-available', run, storedRef: ref };
  }
  if (['database-inspect-stage-succeeded', 'database-inspect-run-failed'].includes(classification.status)) {
    return { ...classification, run, storedRef: ref };
  }
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    planId: inspectPlan.id, profileId: run.sandboxProfileId, now,
  });
  if (profile.effectiveStatus !== 'active') {
    return {
      ...classification, status: 'database-inspect-run-authorization-expired', run, storedRef: ref,
      authorizationStatus: `sandbox-profile-${profile.effectiveStatus}`,
    };
  }
  if (authorization.status !== 'ready-for-database-inspect-apply') {
    return { ...classification, status: authorization.status, run, storedRef: ref };
  }
  return { ...classification, run, storedRef: ref };
}

function evaluateDatabaseApplyRun({
  home, project, revision, candidateControl, applyPlan, databaseRuntimeProfile, authorization, now,
}) {
  const ref = latestRef(revision.databaseApplyRunRefs);
  const run = adoptDatabaseApplyRun({ home, project, revision, runId: ref.id, now });
  if (run.revision < ref.revision) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Apply LaunchRun Revision history moved backwards.');
  }
  if (run.revision === ref.revision && run.fingerprint !== ref.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Database Apply LaunchRun Revision fingerprint mismatch.');
  }
  const classification = classifyStageRun(run, applyPlan, 'database-migrated', 'database-apply-run');
  if (run.revision > ref.revision) {
    return { ...classification, status: 'database-apply-run-update-available', run, storedRef: ref };
  }
  if (['database-migrated', 'database-apply-run-failed'].includes(classification.status)) {
    return { ...classification, run, storedRef: ref };
  }
  const runtime = showDatabaseRuntimeProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    adapterPlanId: applyPlan.id, profileId: run.databaseRuntimeProfileId, now,
  });
  if (runtime.effectiveStatus !== 'active' || run.databaseRuntimeProfileId !== databaseRuntimeProfile.id ||
      run.databaseRuntimeProfileFingerprint !== databaseRuntimeProfile.fingerprint) {
    return {
      ...classification, status: 'database-apply-run-authorization-expired', run, storedRef: ref,
      authorizationStatus: runtime.effectiveStatus === 'active'
        ? 'database-runtime-profile-replaced'
        : `database-runtime-profile-${runtime.effectiveStatus}`,
    };
  }
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    planId: applyPlan.id, profileId: run.sandboxProfileId, now,
  });
  if (profile.effectiveStatus !== 'active') {
    return {
      ...classification, status: 'database-apply-run-authorization-expired', run, storedRef: ref,
      authorizationStatus: `sandbox-profile-${profile.effectiveStatus}`,
    };
  }
  if (authorization.status !== 'ready-for-database-apply') {
    return { ...classification, status: authorization.status, run, storedRef: ref };
  }
  return { ...classification, run, storedRef: ref };
}

function adoptDatabaseInspectRun({ home, project, revision, runId, now }) {
  const run = readLaunchRun(home, project.id, runId);
  if (now && Date.parse(now) < Date.parse(run.updatedAt)) {
    throw operationError('CONFLICT', 'Database Inspect LaunchRun cannot be observed before its latest Revision timestamp.');
  }
  if (run.mode !== 'execute' || run.providerMode !== 'sandbox' ||
      run.transportProvenance !== 'native-cli-fixed-host' || run.graphId !== revision.graphRef.id ||
      run.graphFingerprint !== revision.graphRef.fingerprint ||
      run.adapterPlanId !== revision.databaseInspectPlanRef.id ||
      run.adapterPlanFingerprint !== revision.databaseInspectPlanRef.fingerprint ||
      run.databaseRuntimeProfileId || run.databaseRuntimeProfileFingerprint) {
    throw operationError('CONFLICT', 'Database Inspect LaunchRun is not the native Sandbox Run for the bound inspect Plan.');
  }
  const profileRef = revision.databaseInspectProfileRefs.find((ref) =>
    ref.id === run.sandboxProfileId && ref.fingerprint === run.sandboxProfileFingerprint
  );
  const preflightRef = revision.databaseInspectPreflightRefs.find((ref) =>
    ref.id === run.sandboxPreflightId && ref.fingerprint === run.sandboxPreflightFingerprint &&
    ref.profileId === run.sandboxProfileId && ref.profileFingerprint === run.sandboxProfileFingerprint
  );
  if (!profileRef || !preflightRef) {
    throw operationError('CONFLICT', 'Database Inspect LaunchRun uses an unbound Sandbox Profile or Preflight.');
  }
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: revision.databaseInspectPlanRef.id,
  }).plan;
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, now: run.createdAt,
  });
  const preflight = showSandboxPreflight({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, evidenceId: preflightRef.id, now: run.createdAt,
  });
  if (Date.parse(run.createdAt) < Date.parse(profile.profile.createdAt) ||
      sandboxProfileStatusAt(home, project.id, profile.profile, run.createdAt) !== 'active' ||
      preflight.effectiveStatus !== 'ready' || Date.parse(run.createdAt) < Date.parse(preflight.evidence.checkedAt) ||
      Date.parse(run.createdAt) >= Date.parse(preflight.evidence.validUntil)) {
    throw operationError('CONFLICT', 'Database Inspect LaunchRun was not started inside its Profile and Preflight window.');
  }
  return run;
}

function adoptDatabaseApplyRun({ home, project, revision, runId, now }) {
  const run = readLaunchRun(home, project.id, runId);
  if (now && Date.parse(now) < Date.parse(run.updatedAt)) {
    throw operationError('CONFLICT', 'Database Apply LaunchRun cannot be observed before its latest Revision timestamp.');
  }
  if (run.mode !== 'execute' || run.providerMode !== 'sandbox' ||
      run.transportProvenance !== 'native-cli-fixed-host' || run.graphId !== revision.graphRef.id ||
      run.graphFingerprint !== revision.graphRef.fingerprint ||
      run.adapterPlanId !== revision.databaseApplyPlanRef.id ||
      run.adapterPlanFingerprint !== revision.databaseApplyPlanRef.fingerprint) {
    throw operationError('CONFLICT', 'Database Apply LaunchRun is not the native Sandbox Run for the bound Apply Plan.');
  }
  const runtimeRef = revision.databaseRuntimeProfileRefs.find((ref) =>
    ref.id === run.databaseRuntimeProfileId && ref.fingerprint === run.databaseRuntimeProfileFingerprint
  );
  const profileRef = revision.databaseApplyProfileRefs.find((ref) =>
    ref.id === run.sandboxProfileId && ref.fingerprint === run.sandboxProfileFingerprint
  );
  const preflightRef = revision.databaseApplyPreflightRefs.find((ref) =>
    ref.id === run.sandboxPreflightId && ref.fingerprint === run.sandboxPreflightFingerprint &&
    ref.profileId === run.sandboxProfileId && ref.profileFingerprint === run.sandboxProfileFingerprint &&
    ref.databaseRuntimeProfileId === run.databaseRuntimeProfileId &&
    ref.databaseRuntimeProfileFingerprint === run.databaseRuntimeProfileFingerprint
  );
  if (!runtimeRef || !profileRef || !preflightRef) {
    throw operationError('CONFLICT', 'Database Apply LaunchRun uses an unbound Runtime Profile, Sandbox Profile, or Preflight.');
  }
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: revision.databaseApplyPlanRef.id,
  }).plan;
  const runtime = showDatabaseRuntimeProfile({
    home, projectId: project.id, graphId: revision.graphRef.id, adapterPlanId: plan.id,
    profileId: runtimeRef.id, now: run.createdAt,
  });
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, now: run.createdAt,
  });
  const preflight = showSandboxPreflight({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, databaseRuntimeProfileId: runtimeRef.id,
    evidenceId: preflightRef.id, now: run.createdAt,
  });
  if (Date.parse(run.createdAt) < Date.parse(runtime.profile.createdAt) ||
      Date.parse(run.createdAt) >= Date.parse(runtime.profile.expiresAt) ||
      Date.parse(run.createdAt) < Date.parse(profile.profile.createdAt) ||
      sandboxProfileStatusAt(home, project.id, profile.profile, run.createdAt) !== 'active' ||
      preflight.effectiveStatus !== 'ready' || Date.parse(run.createdAt) < Date.parse(preflight.evidence.checkedAt) ||
      Date.parse(run.createdAt) >= Date.parse(preflight.evidence.validUntil)) {
    throw operationError('CONFLICT', 'Database Apply LaunchRun was not started inside its Runtime Profile and Preflight window.');
  }
  return run;
}

function classifyStageRun(run, plan, succeededStatus, prefix) {
  const nodeIds = [...new Set(plan.actions.map((action) => action.nodeId))].sort();
  const states = nodeIds.map((nodeId) => ({ nodeId, ...run.nodeStates[nodeId] }));
  const failedNodes = states.filter((state) =>
    ['failed-terminal', 'compensated', 'skipped'].includes(state.status)
  ).map((state) => state.nodeId);
  if (failedNodes.length > 0) return { status: `${prefix}-failed`, failedNodes };
  if (states.every((state) => state.status === 'succeeded')) {
    return { status: succeededStatus, failedNodes: [] };
  }
  if (states.some((state) => state.status === 'waiting-external')) {
    return { status: `waiting-${prefix}`, failedNodes: [] };
  }
  return { status: `${prefix}-resumable`, failedNodes: [] };
}

function isDatabaseInspectRunStatus(status) {
  return [
    'ready-for-database-inspect-apply', 'waiting-database-inspect-run',
    'database-inspect-run-resumable', 'database-inspect-run-update-available',
    'database-inspect-run-authorization-expired', 'database-inspect-run-failed',
    'database-inspect-stage-succeeded',
  ].includes(status);
}

function isDatabaseApplyRunStatus(status) {
  return [
    'ready-for-database-apply', 'waiting-database-apply-run',
    'database-apply-run-resumable', 'database-apply-run-update-available',
    'database-apply-run-authorization-expired', 'database-apply-run-failed', 'database-migrated',
  ].includes(status);
}

function adoptDatabaseInspectSandboxProfile({ home, project, session, revision, profileId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundDatabaseInspectPlan({ home, project, revision, candidateControl });
  const shown = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id, profileId, now,
  });
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Database Inspect Sandbox Profile is not active: ${profileId}`);
  }
  assertDatabaseInspectProfileScope(shown.profile, candidateControl.configuration);
  return shown.profile;
}

function adoptDatabaseInspectApproval({ home, project, session, revision, approvalId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundDatabaseInspectPlan({ home, project, revision, candidateControl });
  const shown = showApproval({ home, projectId: project.id, approvalId, now });
  const required = candidateApprovalNodeIds(candidateControl.graph, plan);
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Database Inspect Approval is not active: ${approvalId}`);
  }
  if (shown.approval.graphId !== candidateControl.graph.id ||
      shown.approval.graphFingerprint !== candidateControl.graph.fingerprint ||
      shown.approval.approvedBy !== session.owner ||
      !required.every((nodeId) => shown.approval.nodeIds.includes(nodeId))) {
    throw operationError('APPROVAL_REQUIRED', 'Database Inspect Approval does not cover the exact Plan and owner.');
  }
  return shown.approval;
}

function adoptDatabaseInspectPreflight({ home, project, session, revision, preflightId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundDatabaseInspectPlan({ home, project, revision, candidateControl });
  const profileRef = latestRef(revision.databaseInspectProfileRefs);
  const approvalRef = latestRef(revision.databaseInspectApprovalRefs);
  if (!profileRef || !approvalRef) {
    throw operationError('CONFLICT', 'Database Inspect Profile and Approval must be bound first.');
  }
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profileRef.id, now,
  });
  const approval = showApproval({ home, projectId: project.id, approvalId: approvalRef.id, now });
  if (profile.effectiveStatus !== 'active' || approval.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', 'Database Inspect Profile or Approval expired before Preflight adoption.');
  }
  const shown = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profile.profile.id, evidenceId: preflightId, now,
  });
  if (shown.effectiveStatus !== 'ready') {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REQUIRED',
      `Database Inspect Sandbox Preflight is not ready: ${preflightId}`
    );
  }
  assertPreflightApprovalBinding(shown.evidence, approval.approval, candidateControl.graph, plan);
  return { evidence: shown.evidence, approval: approval.approval };
}

function assertDatabaseInspectProfileScope(profile, configuration) {
  if (profile.resourcePrefix !== configuration.resourcePrefix || profile.accountEnvironment !== 'test' ||
      stableStringify(profile.allowedDomains) !== '[]') {
    throw operationError('CONFLICT', 'Database Inspect Sandbox Profile exceeds the approved database-only scope.');
  }
}

function adoptDatabaseApplySandboxProfile({ home, project, session, revision, profileId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundDatabaseApplyPlan({ home, project, revision, candidateControl });
  const shown = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id, profileId, now,
  });
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Database Apply Sandbox Profile is not active: ${profileId}`);
  }
  assertDatabaseApplyProfileScope(shown.profile, candidateControl.configuration);
  return shown.profile;
}

function adoptDatabaseApplyApproval({ home, project, session, revision, approvalId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundDatabaseApplyPlan({ home, project, revision, candidateControl });
  const shown = showApproval({ home, projectId: project.id, approvalId, now });
  const required = candidateApprovalNodeIds(candidateControl.graph, plan);
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Database Apply Approval is not active: ${approvalId}`);
  }
  if (shown.approval.graphId !== candidateControl.graph.id ||
      shown.approval.graphFingerprint !== candidateControl.graph.fingerprint ||
      shown.approval.approvedBy !== session.owner ||
      !required.every((nodeId) => shown.approval.nodeIds.includes(nodeId))) {
    throw operationError('APPROVAL_REQUIRED', 'Database Apply Approval does not cover the exact Plan and owner.');
  }
  return shown.approval;
}

function adoptDatabaseApplyPreflight({ home, project, session, revision, preflightId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundDatabaseApplyPlan({ home, project, revision, candidateControl });
  const runtimeRef = latestRef(revision.databaseRuntimeProfileRefs);
  const profileRef = latestRef(revision.databaseApplyProfileRefs);
  const approvalRef = latestRef(revision.databaseApplyApprovalRefs);
  if (!runtimeRef || !profileRef || !approvalRef) {
    throw operationError('CONFLICT', 'Database Runtime Profile, Apply Profile, and Approval must be bound first.');
  }
  const runtime = showDatabaseRuntimeProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    adapterPlanId: plan.id, profileId: runtimeRef.id, now,
  });
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profileRef.id, now,
  });
  const approval = showApproval({ home, projectId: project.id, approvalId: approvalRef.id, now });
  if (runtime.effectiveStatus !== 'active' || profile.effectiveStatus !== 'active' ||
      approval.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', 'Database Apply authorization expired before Preflight adoption.');
  }
  const shown = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profile.profile.id, databaseRuntimeProfileId: runtime.profile.id,
    evidenceId: preflightId, now,
  });
  if (shown.effectiveStatus !== 'ready') {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REQUIRED',
      `Database Apply Sandbox Preflight is not ready: ${preflightId}`
    );
  }
  assertPreflightApprovalBinding(shown.evidence, approval.approval, candidateControl.graph, plan);
  return {
    evidence: shown.evidence,
    approval: approval.approval,
    databaseRuntimeProfile: runtime.profile,
  };
}

function assertDatabaseApplyProfileScope(profile, configuration) {
  if (profile.resourcePrefix !== configuration.resourcePrefix || profile.accountEnvironment !== 'test' ||
      stableStringify(profile.allowedDomains) !== '[]') {
    throw operationError('CONFLICT', 'Database Apply Sandbox Profile exceeds the approved database-only scope.');
  }
}

function evaluateCandidateVerification({ home, project, revision, candidateControl }) {
  if (!revision.verificationPlanRef) {
    return { status: 'candidate-provider-stage-succeeded', plan: null, evidence: null };
  }
  const plan = showProductVerificationPlan({
    home,
    projectId: project.id,
    graphId: candidateControl.graph.id,
    configurationId: candidateControl.configuration.id,
    planId: revision.verificationPlanRef.id,
  }).plan;
  if (plan.fingerprint !== revision.verificationPlanRef.fingerprint ||
      !plan.checks.some((check) => check.phase === 'candidate' && check.required)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Product Verification Plan binding mismatch.');
  }
  if (!revision.candidateEvidenceRef) {
    return { status: 'waiting-candidate-verification', plan, evidence: null };
  }
  const shown = showProductVerificationEvidence({
    home, projectId: project.id, evidenceId: revision.candidateEvidenceRef.id,
  });
  const evidence = shown.evidence;
  if (evidence.fingerprint !== revision.candidateEvidenceRef.fingerprint ||
      evidence.planId !== plan.id || evidence.planFingerprint !== plan.fingerprint ||
      evidence.graphId !== candidateControl.graph.id ||
      evidence.configurationId !== candidateControl.configuration.id ||
      evidence.phase !== 'candidate' || evidence.status !== 'passed') {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Candidate Verification Evidence binding mismatch.');
  }
  return { status: 'candidate-verified', plan, evidence };
}

function evaluateCutover({ home, project, session, revision, candidateControl, candidateVerification, now }) {
  if (!revision.cutoverHandoffRef) {
    return { status: 'candidate-verified', handoff: null, attestation: null, changeSet: null, plan: null, authorization: null, run: null, productionEvidence: null };
  }
  const handoff = showHumanHandoff({
    home, projectId: project.id, handoffId: revision.cutoverHandoffRef.id,
  }).handoff;
  if (handoff.fingerprint !== revision.cutoverHandoffRef.fingerprint || handoff.phase !== 'cutover' ||
      handoff.owner !== session.owner || handoff.candidateEvidenceRef?.id !== candidateVerification.evidence.id ||
      handoff.candidateEvidenceRef?.fingerprint !== candidateVerification.evidence.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Cutover HumanHandoff binding mismatch.');
  }
  if (!revision.cutoverAttestationRef) {
    return { status: 'waiting-cutover-attestation', handoff, attestation: null, changeSet: null, plan: null, authorization: null, run: null, productionEvidence: null };
  }
  const attestation = showHumanHandoff({
    home, projectId: project.id, handoffId: handoff.id,
    handoffAttestationId: revision.cutoverAttestationRef.id,
  }).attestation;
  if (attestation.fingerprint !== revision.cutoverAttestationRef.fingerprint ||
      attestation.status !== 'completed' || attestation.actor !== session.owner) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Cutover Attestation binding mismatch.');
  }
  const bound = showBoundCutoverPlan({ home, project, revision, candidateControl });
  const authorization = evaluateCutoverAuthorization({
    home, project, session, revision, candidateControl, plan: bound.plan, now,
  });
  if (revision.cutoverRunRefs.length === 0) {
    return {
      status: authorization.status, handoff, attestation, changeSet: bound.changeSet,
      plan: bound.plan, authorization, run: null, productionEvidence: null,
    };
  }
  const run = evaluateCutoverRun({
    home, project, revision, candidateControl, plan: bound.plan, authorization, now,
  });
  if (run.status !== 'cutover-applied') {
    return {
      status: run.status, handoff, attestation, changeSet: bound.changeSet,
      plan: bound.plan, authorization, run, productionEvidence: null,
    };
  }
  const emailDelivery = evaluateFirstLaunchEmailDelivery({
    home, project, session, revision, candidateControl, candidateVerification, now,
  });
  if (emailDelivery.status !== 'succeeded') {
    return {
      status: emailDelivery.status, handoff, attestation, changeSet: bound.changeSet,
      plan: bound.plan, authorization, run, emailDelivery, productionEvidence: null,
    };
  }
  const latestProductionRef = latestRef(revision.productionVerificationRefs);
  if (!latestProductionRef) {
    return {
      status: 'waiting-production-verification', handoff, attestation, changeSet: bound.changeSet,
      plan: bound.plan, authorization, run, emailDelivery, productionEvidence: null,
    };
  }
  const shown = showProductVerificationEvidence({
    home, projectId: project.id, evidenceId: latestProductionRef.id,
  });
  const evidence = shown.evidence;
  if (evidence.fingerprint !== latestProductionRef.fingerprint ||
      evidence.planId !== candidateVerification.plan.id ||
      evidence.planFingerprint !== candidateVerification.plan.fingerprint ||
      evidence.graphId !== candidateControl.graph.id ||
      evidence.configurationId !== candidateControl.configuration.id ||
      evidence.phase !== 'production') {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Production Verification Evidence binding mismatch.');
  }
  if (evidence.status !== 'passed') {
    const rollback = evidence.status === 'failed'
      ? evaluateFirstLaunchRollback({ home, project, session, revision, candidateControl, evidence, now })
      : null;
    return {
      status: rollback?.status || (evidence.status === 'failed'
        ? 'production-verification-failed'
        : 'production-verification-needs-human'),
      handoff, attestation, changeSet: bound.changeSet, plan: bound.plan,
      authorization, run, emailDelivery, productionEvidence: evidence, rollback,
    };
  }
  if (revision.productionEvidenceRef?.id !== evidence.id ||
      revision.productionEvidenceRef?.fingerprint !== evidence.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Passed Production Evidence is not bound as the final Session result.');
  }
  return {
    status: 'production-verified', handoff, attestation, changeSet: bound.changeSet,
    plan: bound.plan, authorization, run, emailDelivery, productionEvidence: evidence,
  };
}

function evaluateFirstLaunchEmailDelivery({
  home, project, session, revision, candidateControl, candidateVerification, now,
}) {
  const check = candidateVerification.plan.checks.find((item) =>
    item.id === 'production.email.delivery' && item.required && item.capability === 'email-delivery'
  );
  if (!check) return { status: 'succeeded', required: false, plan: null, approval: null, run: null };
  const connections = listConnections({ home, projectId: project.id }).connections;
  const provisioningConnections = connections.filter((item) =>
    item.provider === 'resend' && item.status === 'ready' && item.authMethod === 'provisioning-key'
  );
  const sendingConnections = connections.filter((item) =>
    item.provider === 'resend' && item.status === 'ready' && item.authMethod === 'sending-key'
  );
  if (!revision.emailDeliveryPlanRef) {
    return {
      status: 'waiting-email-delivery-plan', required: true, plan: null, approval: null, run: null,
      provisioningConnections, sendingConnections,
    };
  }
  const shownPlan = showEmailDeliveryPlan({
    home, projectId: project.id, planId: revision.emailDeliveryPlanRef.id,
  });
  const plan = shownPlan.plan;
  if (plan.fingerprint !== revision.emailDeliveryPlanRef.fingerprint ||
      plan.graphId !== candidateControl.graph.id ||
      plan.graphFingerprint !== candidateControl.graph.fingerprint ||
      plan.configurationId !== candidateControl.configuration.id ||
      plan.configurationFingerprint !== candidateControl.configuration.fingerprint ||
      plan.verificationPlanId !== candidateVerification.plan.id ||
      plan.verificationPlanFingerprint !== candidateVerification.plan.fingerprint ||
      plan.recipientSecretRef !== check.secretRefs[0]) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Email Delivery Plan binding mismatch.');
  }
  const approvalRef = latestRef(revision.emailDeliveryApprovalRefs);
  if (!approvalRef) {
    return { status: 'waiting-email-delivery-approval', required: true, plan, approval: null, run: null };
  }
  const shownApproval = showEmailDeliveryApproval({
    home, projectId: project.id, approvalId: approvalRef.id, now,
  });
  const approval = shownApproval.approval;
  if (approval.fingerprint !== approvalRef.fingerprint || approval.approvedBy !== session.owner ||
      approval.emailDeliveryPlanId !== plan.id || approval.emailDeliveryPlanFingerprint !== plan.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Email Delivery Approval binding mismatch.');
  }
  const runRef = latestRef(revision.emailDeliveryRunRefs);
  if (!runRef) {
    return {
      status: shownApproval.effectiveStatus === 'active'
        ? 'ready-for-email-delivery-apply'
        : 'waiting-email-delivery-approval',
      required: true, plan, approval, approvalStatus: shownApproval.effectiveStatus, run: null,
    };
  }
  const shownRun = showEmailDeliveryRun({ home, projectId: project.id, runId: runRef.id, now });
  const run = shownRun.run;
  const shownRunApproval = run.approvalId === approval.id
    ? shownApproval
    : showEmailDeliveryApproval({
        home, projectId: project.id, approvalId: run.approvalId, now,
      });
  const runApproval = shownRunApproval.approval;
  if (run.emailDeliveryPlanId !== plan.id || run.emailDeliveryPlanFingerprint !== plan.fingerprint ||
      run.approvalFingerprint !== runApproval.fingerprint ||
      runApproval.approvedBy !== session.owner ||
      runApproval.emailDeliveryPlanId !== plan.id || runApproval.emailDeliveryPlanFingerprint !== plan.fingerprint ||
      run.revision < runRef.revision ||
      (run.revision === runRef.revision && (
        run.fingerprint !== runRef.fingerprint || run.approvalId !== runRef.approvalId ||
        run.approvalFingerprint !== runRef.approvalFingerprint
      ))) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Email Delivery Run binding mismatch.');
  }
  if (run.revision > runRef.revision) {
    return {
      status: 'email-delivery-run-update-available', required: true, plan, approval: runApproval,
      approvalStatus: shownRunApproval.effectiveStatus, run, storedRef: runRef,
    };
  }
  if (run.status === 'succeeded') {
    return { status: 'succeeded', required: true, plan, approval, run };
  }
  if (run.status === 'failed-terminal') {
    return { status: 'email-delivery-run-failed', required: true, plan, approval, run };
  }
  if (run.send.status !== 'succeeded' && shownApproval.effectiveStatus !== 'active') {
    return {
      status: 'email-delivery-run-authorization-expired', required: true, plan, approval,
      approvalStatus: shownApproval.effectiveStatus, run,
    };
  }
  return {
    status: 'email-delivery-run-resumable', required: true, plan, approval,
    approvalStatus: shownApproval.effectiveStatus, run,
  };
}

function evaluateFirstLaunchRollback({ home, project, session, revision, candidateControl, evidence, now }) {
  if (!revision.rollbackPlanRef) {
    return { status: 'production-verification-failed', plan: null, approval: null, run: null };
  }
  const plan = showRollbackPlan({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    configurationId: candidateControl.configuration.id, planId: revision.rollbackPlanRef.id,
  }).plan;
  if (plan.fingerprint !== revision.rollbackPlanRef.fingerprint ||
      plan.trigger.evidenceId !== evidence.id || plan.trigger.evidenceFingerprint !== evidence.fingerprint ||
      plan.trigger.status !== 'failed') {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Rollback Plan binding mismatch.');
  }
  if (plan.status !== 'ready') {
    return { status: 'rollback-plan-blocked', plan, approval: null, run: null };
  }
  const approvalRef = latestRef(revision.rollbackApprovalRefs);
  if (!approvalRef) return { status: 'waiting-rollback-approval', plan, approval: null, run: null };
  const shownApproval = showRollbackApproval({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    configurationId: candidateControl.configuration.id, approvalId: approvalRef.id, now,
  });
  const approval = shownApproval.approval;
  const required = requiredRollbackStepIds(plan);
  if (approval.fingerprint !== approvalRef.fingerprint || approval.approvedBy !== session.owner ||
      approval.rollbackPlanId !== plan.id || approval.rollbackPlanFingerprint !== plan.fingerprint ||
      !required.every((stepId) => approval.stepIds.includes(stepId))) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Rollback Approval binding mismatch.');
  }
  const runRef = latestRef(revision.rollbackRunRefs);
  if (!runRef) {
    return {
      status: shownApproval.effectiveStatus === 'active'
        ? 'ready-for-rollback-apply'
        : 'waiting-rollback-approval',
      plan, approval, approvalStatus: shownApproval.effectiveStatus, run: null,
    };
  }
  const run = adoptFirstLaunchRollbackRun({ home, project, revision, runId: runRef.id, now });
  if (run.revision < runRef.revision ||
      (run.revision === runRef.revision && run.fingerprint !== runRef.fingerprint)) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Rollback Run Revision binding mismatch.');
  }
  if (run.revision > runRef.revision) {
    return { status: 'rollback-run-update-available', plan, approval, run, storedRef: runRef };
  }
  if (run.status === 'succeeded') return { status: 'rolled-back', plan, approval, run, storedRef: runRef };
  if (run.status === 'failed-terminal') {
    return { status: 'rollback-run-failed', plan, approval, run, storedRef: runRef };
  }
  if (shownApproval.effectiveStatus !== 'active') {
    return {
      status: 'rollback-run-authorization-expired', plan, approval, run, storedRef: runRef,
      approvalStatus: shownApproval.effectiveStatus,
    };
  }
  return { status: 'rollback-run-resumable', plan, approval, run, storedRef: runRef };
}

function showBoundCutoverPlan({ home, project, revision, candidateControl }) {
  const changeSet = showDnsChangeSet({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    configurationId: candidateControl.configuration.id, changeSetId: revision.dnsChangeSetRef.id,
  }).changeSet;
  if (changeSet.fingerprint !== revision.dnsChangeSetRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch DNS ChangeSet binding mismatch.');
  }
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: revision.cutoverPlanRef.id,
  }).plan;
  if (plan.fingerprint !== revision.cutoverPlanRef.fingerprint ||
      plan.configurationId !== candidateControl.configuration.id ||
      plan.configurationFingerprint !== candidateControl.configuration.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Cutover Adapter Plan binding mismatch.');
  }
  assertCutoverPlanShape(plan, changeSet);
  return { changeSet, plan };
}

function assertCutoverPlanShape(plan, changeSet) {
  const nodeIds = new Set((plan?.actions || []).map((action) => action.nodeId));
  if ((changeSet.scope || 'production-cutover') !== 'production-cutover' ||
      plan?.dnsChangeSetId !== changeSet.id || plan?.dnsChangeSetFingerprint !== changeSet.fingerprint ||
      plan?.migrationPlanId || plan?.backupEvidenceId || !nodeIds.has('production.dns.apply') ||
      plan.actions.length === 0) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Cutover Adapter Plan does not contain the exact DNS ChangeSet stage.');
  }
}

function evaluateCutoverAuthorization({ home, project, session, revision, candidateControl, plan, now }) {
  const profileRef = latestRef(revision.cutoverProfileRefs);
  if (!profileRef) return { status: 'waiting-cutover-profile', profile: null, approval: null, preflight: null };
  const shownProfile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profileRef.id, now,
  });
  if (shownProfile.profile.fingerprint !== profileRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Cutover Sandbox Profile binding mismatch.');
  }
  assertCutoverProfileScope(shownProfile.profile, candidateControl.configuration);
  if (shownProfile.effectiveStatus !== 'active') {
    return {
      status: 'waiting-cutover-profile', profile: shownProfile.profile,
      profileStatus: shownProfile.effectiveStatus, approval: null, preflight: null,
    };
  }
  const profile = shownProfile.profile;
  const approvalRef = latestRef(revision.cutoverApprovalRefs);
  if (!approvalRef) return { status: 'waiting-cutover-approval', profile, approval: null, preflight: null };
  const shownApproval = showApproval({ home, projectId: project.id, approvalId: approvalRef.id, now });
  if (shownApproval.approval.fingerprint !== approvalRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Cutover Approval binding mismatch.');
  }
  const required = candidateApprovalNodeIds(candidateControl.graph, plan);
  const approval = shownApproval.approval;
  if (shownApproval.effectiveStatus !== 'active' || approval.graphId !== candidateControl.graph.id ||
      approval.graphFingerprint !== candidateControl.graph.fingerprint || approval.approvedBy !== session.owner ||
      !required.every((nodeId) => approval.nodeIds.includes(nodeId))) {
    return {
      status: 'waiting-cutover-approval', profile, approval,
      approvalStatus: shownApproval.effectiveStatus, preflight: null,
    };
  }
  const preflightRef = latestRef(revision.cutoverPreflightRefs);
  if (!preflightRef || preflightRef.profileId !== profile.id ||
      preflightRef.profileFingerprint !== profile.fingerprint || preflightRef.approvalId !== approval.id ||
      preflightRef.approvalFingerprint !== approval.fingerprint) {
    return { status: 'waiting-cutover-preflight', profile, approval, preflight: null };
  }
  const shownPreflight = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profile.id, evidenceId: preflightRef.id, now,
  });
  if (shownPreflight.evidence.fingerprint !== preflightRef.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Cutover Preflight binding mismatch.');
  }
  assertPreflightApprovalBinding(shownPreflight.evidence, approval, candidateControl.graph, plan);
  if (shownPreflight.effectiveStatus !== 'ready') {
    return {
      status: 'waiting-cutover-preflight', profile, approval,
      preflight: shownPreflight.evidence, preflightStatus: shownPreflight.effectiveStatus,
    };
  }
  return { status: 'ready-for-cutover-apply', profile, approval, preflight: shownPreflight.evidence };
}

function evaluateCutoverRun({ home, project, revision, candidateControl, plan, authorization, now }) {
  const ref = latestRef(revision.cutoverRunRefs);
  const run = adoptCutoverRun({ home, project, revision, runId: ref.id, now });
  if (run.revision < ref.revision) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Cutover LaunchRun Revision history moved backwards.');
  }
  if (run.revision === ref.revision && run.fingerprint !== ref.fingerprint) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'Cutover LaunchRun Revision fingerprint mismatch.');
  }
  const classification = classifyStageRun(run, plan, 'cutover-applied', 'cutover-run');
  if (run.revision > ref.revision) {
    return { ...classification, status: 'cutover-run-update-available', run, storedRef: ref };
  }
  if (['cutover-applied', 'cutover-run-failed'].includes(classification.status)) {
    return { ...classification, run, storedRef: ref };
  }
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id,
    planId: plan.id, profileId: run.sandboxProfileId, now,
  });
  if (profile.effectiveStatus !== 'active') {
    return {
      ...classification, status: 'cutover-run-authorization-expired', run, storedRef: ref,
      authorizationStatus: `sandbox-profile-${profile.effectiveStatus}`,
    };
  }
  if (authorization.status !== 'ready-for-cutover-apply') {
    return { ...classification, status: authorization.status, run, storedRef: ref };
  }
  return { ...classification, run, storedRef: ref };
}

function adoptCutoverRun({ home, project, revision, runId, now }) {
  const run = readLaunchRun(home, project.id, runId);
  if (now && Date.parse(now) < Date.parse(run.updatedAt)) {
    throw operationError('CONFLICT', 'Cutover LaunchRun cannot be observed before its latest Revision timestamp.');
  }
  if (run.mode !== 'execute' || run.providerMode !== 'sandbox' ||
      run.transportProvenance !== 'native-cli-fixed-host' || run.graphId !== revision.graphRef.id ||
      run.graphFingerprint !== revision.graphRef.fingerprint || run.adapterPlanId !== revision.cutoverPlanRef.id ||
      run.adapterPlanFingerprint !== revision.cutoverPlanRef.fingerprint ||
      run.databaseRuntimeProfileId || run.databaseRuntimeProfileFingerprint) {
    throw operationError('CONFLICT', 'Cutover LaunchRun is not the native Sandbox Run for the bound Cutover Plan.');
  }
  const profileRef = revision.cutoverProfileRefs.find((ref) =>
    ref.id === run.sandboxProfileId && ref.fingerprint === run.sandboxProfileFingerprint
  );
  const preflightRef = revision.cutoverPreflightRefs.find((ref) =>
    ref.id === run.sandboxPreflightId && ref.fingerprint === run.sandboxPreflightFingerprint &&
    ref.profileId === run.sandboxProfileId && ref.profileFingerprint === run.sandboxProfileFingerprint
  );
  if (!profileRef || !preflightRef) {
    throw operationError('CONFLICT', 'Cutover LaunchRun uses an unbound Sandbox Profile or Preflight.');
  }
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: revision.cutoverPlanRef.id,
  }).plan;
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, now: run.createdAt,
  });
  const preflight = showSandboxPreflight({
    home, projectId: project.id, graphId: revision.graphRef.id, planId: plan.id,
    profileId: profileRef.id, evidenceId: preflightRef.id, now: run.createdAt,
  });
  if (Date.parse(run.createdAt) < Date.parse(profile.profile.createdAt) ||
      sandboxProfileStatusAt(home, project.id, profile.profile, run.createdAt) !== 'active' ||
      preflight.effectiveStatus !== 'ready' || Date.parse(run.createdAt) < Date.parse(preflight.evidence.checkedAt) ||
      Date.parse(run.createdAt) >= Date.parse(preflight.evidence.validUntil)) {
    throw operationError('CONFLICT', 'Cutover LaunchRun was not started inside its Profile and Preflight window.');
  }
  return run;
}

function isCutoverRunStatus(status) {
  return [
    'ready-for-cutover-apply', 'waiting-cutover-run', 'cutover-run-resumable',
    'cutover-run-update-available', 'cutover-run-authorization-expired', 'cutover-run-failed',
    'cutover-applied', 'waiting-production-verification',
  ].includes(status);
}

function adoptFirstLaunchRollbackRun({ home, project, revision, runId, now }) {
  const run = readRollbackRun(home, project.id, runId);
  if (now && Date.parse(now) < Date.parse(run.updatedAt)) {
    throw operationError('CONFLICT', 'Rollback Run cannot be observed before its latest Revision timestamp.');
  }
  if (run.graphId !== revision.graphRef.id || run.graphFingerprint !== revision.graphRef.fingerprint ||
      run.rollbackPlanId !== revision.rollbackPlanRef?.id ||
      run.rollbackPlanFingerprint !== revision.rollbackPlanRef?.fingerprint) {
    throw operationError('CONFLICT', 'Rollback Run does not bind the First Launch recovery Plan and Graph.');
  }
  const approvalRef = revision.rollbackApprovalRefs.find((ref) =>
    ref.id === run.approvalId && ref.fingerprint === run.approvalFingerprint
  );
  if (!approvalRef) throw operationError('CONFLICT', 'Rollback Run uses an Approval not bound to this Session.');
  const shown = showRollbackApproval({
    home, projectId: project.id, graphId: revision.graphRef.id,
    configurationId: revision.launchConfigurationRef.id, approvalId: approvalRef.id,
    now: run.createdAt,
  });
  if (shown.approval.fingerprint !== approvalRef.fingerprint ||
      Date.parse(run.createdAt) < Date.parse(shown.approval.approvedAt) ||
      Date.parse(run.createdAt) >= Date.parse(shown.approval.expiresAt) ||
      rollbackApprovalStatusAt(home, project.id, shown.approval, run.createdAt) !== 'active') {
    throw operationError('CONFLICT', 'Rollback Run was not started inside its bound Approval window.');
  }
  return run;
}

function isFirstLaunchRollbackRunStatus(status) {
  return [
    'ready-for-rollback-apply', 'rollback-run-resumable', 'rollback-run-update-available',
    'rollback-run-authorization-expired', 'rollback-run-failed', 'rolled-back',
  ].includes(status);
}

function requiredRollbackStepIds(plan) {
  return plan.steps
    .filter((step) => step.status === 'ready' && step.approval &&
      ['dns.restore', 'database.rollback'].includes(step.id))
    .map((step) => step.id)
    .sort();
}

function latestProductionEvidence(report) {
  const evidence = report?.cutover?.productionEvidence;
  if (!evidence || evidence.phase !== 'production') {
    throw operationError('CONFLICT', 'First Launch has no current Production Verification Evidence.');
  }
  return evidence;
}

function adoptCutoverSandboxProfile({ home, project, session, revision, profileId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundCutoverPlan({ home, project, revision, candidateControl });
  const shown = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id, profileId, now,
  });
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Cutover Sandbox Profile is not active: ${profileId}`);
  }
  assertCutoverProfileScope(shown.profile, candidateControl.configuration);
  return shown.profile;
}

function adoptCutoverApproval({ home, project, session, revision, approvalId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundCutoverPlan({ home, project, revision, candidateControl });
  const shown = showApproval({ home, projectId: project.id, approvalId, now });
  const required = candidateApprovalNodeIds(candidateControl.graph, plan);
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Cutover Approval is not active: ${approvalId}`);
  }
  if (shown.approval.graphId !== candidateControl.graph.id ||
      shown.approval.graphFingerprint !== candidateControl.graph.fingerprint ||
      shown.approval.approvedBy !== session.owner ||
      !required.every((nodeId) => shown.approval.nodeIds.includes(nodeId))) {
    throw operationError('APPROVAL_REQUIRED', 'Cutover Approval does not cover the exact Plan and owner.');
  }
  return shown.approval;
}

function adoptCutoverPreflight({ home, project, session, revision, preflightId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const { plan } = showBoundCutoverPlan({ home, project, revision, candidateControl });
  const profileRef = latestRef(revision.cutoverProfileRefs);
  const approvalRef = latestRef(revision.cutoverApprovalRefs);
  if (!profileRef || !approvalRef) throw operationError('CONFLICT', 'Cutover Profile and Approval must be bound first.');
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profileRef.id, now,
  });
  const approval = showApproval({ home, projectId: project.id, approvalId: approvalRef.id, now });
  if (profile.effectiveStatus !== 'active' || approval.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', 'Cutover Profile or Approval expired before Preflight adoption.');
  }
  const shown = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profile.profile.id, evidenceId: preflightId, now,
  });
  if (shown.effectiveStatus !== 'ready') {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REQUIRED',
      `Cutover Sandbox Preflight is not ready: ${preflightId}`
    );
  }
  assertPreflightApprovalBinding(shown.evidence, approval.approval, candidateControl.graph, plan);
  return { evidence: shown.evidence, approval: approval.approval };
}

function assertCutoverProfileScope(profile, configuration) {
  if (profile.resourcePrefix !== configuration.resourcePrefix || profile.accountEnvironment !== 'test' ||
      stableStringify(profile.allowedDomains) !== stableStringify(candidateAllowedDomains(configuration))) {
    throw operationError('CONFLICT', 'Cutover Sandbox Profile exceeds the approved production domain scope.');
  }
}

function showBoundCandidatePlan({ home, project, revision, candidateControl }) {
  const plan = showAdapterExecutionPlan({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: revision.adapterPlanRef.id,
  }).plan;
  if (plan.fingerprint !== revision.adapterPlanRef.fingerprint ||
      plan.configurationId !== candidateControl.configuration.id ||
      plan.configurationFingerprint !== candidateControl.configuration.fingerprint || plan.dnsChangeSetId ||
      plan.migrationPlanId || plan.backupEvidenceId || plan.actions.length === 0) {
    throw operationError('ARTIFACT_INTEGRITY_FAILED', 'First Launch Candidate Adapter Plan binding mismatch.');
  }
  return plan;
}

function adoptCandidateSandboxProfile({ home, project, session, revision, profileId, now }) {
  const candidateControl = validateCandidateControlObjects({
    home, project, session, revision,
  });
  const plan = showBoundCandidatePlan({ home, project, revision, candidateControl });
  const shown = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id, profileId, now,
  });
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Candidate Sandbox Profile is not active: ${profileId}`);
  }
  assertCandidateProfileScope(shown.profile, candidateControl.configuration);
  return shown.profile;
}

function adoptCandidateApproval({ home, project, session, revision, approvalId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const plan = showBoundCandidatePlan({ home, project, revision, candidateControl });
  const shown = showApproval({ home, projectId: project.id, approvalId, now });
  const required = candidateApprovalNodeIds(candidateControl.graph, plan);
  if (shown.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', `Candidate Approval is not active: ${approvalId}`);
  }
  if (shown.approval.graphId !== candidateControl.graph.id ||
      shown.approval.graphFingerprint !== candidateControl.graph.fingerprint ||
      shown.approval.approvedBy !== session.owner ||
      !required.every((nodeId) => shown.approval.nodeIds.includes(nodeId))) {
    throw operationError('APPROVAL_REQUIRED', 'Candidate Approval does not cover the exact First Launch plan and owner.');
  }
  return shown.approval;
}

function adoptCandidatePreflight({ home, project, session, revision, preflightId, now }) {
  const candidateControl = validateCandidateControlObjects({ home, project, session, revision });
  const plan = showBoundCandidatePlan({ home, project, revision, candidateControl });
  const profileRef = latestRef(revision.sandboxProfileRefs);
  const approvalRef = latestRef(revision.candidateApprovalRefs);
  if (!profileRef || !approvalRef) throw operationError('CONFLICT', 'Candidate Profile and Approval must be bound first.');
  const profile = showSandboxProfile({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profileRef.id, now,
  });
  const approval = showApproval({ home, projectId: project.id, approvalId: approvalRef.id, now });
  if (profile.effectiveStatus !== 'active' || approval.effectiveStatus !== 'active') {
    throw operationError('APPROVAL_EXPIRED', 'Candidate Profile or Approval expired before Preflight adoption.');
  }
  const shown = showSandboxPreflight({
    home, projectId: project.id, graphId: candidateControl.graph.id, planId: plan.id,
    profileId: profile.profile.id, evidenceId: preflightId, now,
  });
  if (shown.effectiveStatus !== 'ready') {
    throw operationError(
      shown.effectiveStatus === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_REQUIRED',
      `Candidate Sandbox Preflight is not ready: ${preflightId}`
    );
  }
  assertPreflightApprovalBinding(shown.evidence, approval.approval, candidateControl.graph, plan);
  return { evidence: shown.evidence, approval: approval.approval };
}

function assertCandidateProfileScope(profile, configuration) {
  const expectedDomains = candidateAllowedDomains(configuration);
  if (profile.resourcePrefix !== configuration.resourcePrefix || profile.accountEnvironment !== 'test' ||
      stableStringify(profile.allowedDomains) !== stableStringify(expectedDomains)) {
    throw operationError('CONFLICT', 'Candidate Sandbox Profile exceeds or differs from the approved Launch Configuration scope.');
  }
}

function assertPreflightApprovalBinding(evidence, approval, graph, plan) {
  const required = candidateApprovalNodeIds(graph, plan);
  if (evidence.approvalChecks.length !== required.length || evidence.approvalChecks.some((check) =>
    !required.includes(check.nodeId) || check.status !== 'ready' || check.approvalId !== approval.id ||
    check.fingerprint !== approval.fingerprint)) {
    throw operationError('CONFLICT', 'Sandbox Preflight is not bound to the selected Candidate Approval.');
  }
}

function candidateApprovalNodeIds(graph, plan) {
  const planned = new Set(plan.actions.map((action) => action.nodeId));
  const ids = graph.nodes.filter((node) => node.approval && planned.has(node.id)).map((node) => node.id).sort();
  if (ids.length === 0) throw operationError('UNSUPPORTED', 'Candidate Adapter Plan contains no approvable provider mutations.');
  return ids;
}

function candidatePlanHasCostMutation(graph, plan) {
  const planned = new Set(plan.actions.map((action) => action.nodeId));
  return graph.nodes.some((node) => planned.has(node.id) && node.sideEffect === 'cost-mutation');
}

function candidateAllowedDomains(configuration) {
  const values = [configuration.domain?.apex, configuration.email?.domain]
    .map((value) => String(value || '').toLowerCase()).filter(Boolean).sort();
  return [...new Set(values)].filter((value, index, all) =>
    !all.some((other, otherIndex) => otherIndex !== index && value.endsWith(`.${other}`))
  );
}

function preflightReference(evidence, approval) {
  return {
    id: evidence.id,
    fingerprint: evidence.fingerprint,
    profileId: evidence.sandboxProfileId,
    profileFingerprint: evidence.sandboxProfileFingerprint,
    approvalId: approval.id,
    approvalFingerprint: approval.fingerprint,
  };
}

function databasePreflightReference(evidence, approval, databaseRuntimeProfile) {
  return {
    ...preflightReference(evidence, approval),
    databaseRuntimeProfileId: databaseRuntimeProfile.id,
    databaseRuntimeProfileFingerprint: databaseRuntimeProfile.fingerprint,
  };
}

function candidateRunReference(run) {
  return {
    id: run.id,
    revision: run.revision,
    fingerprint: run.fingerprint,
    adapterPlanId: run.adapterPlanId,
    adapterPlanFingerprint: run.adapterPlanFingerprint,
    profileId: run.sandboxProfileId,
    profileFingerprint: run.sandboxProfileFingerprint,
    preflightId: run.sandboxPreflightId,
    preflightFingerprint: run.sandboxPreflightFingerprint,
  };
}

function databaseRunReference(run) {
  return {
    ...candidateRunReference(run),
    databaseRuntimeProfileId: run.databaseRuntimeProfileId,
    databaseRuntimeProfileFingerprint: run.databaseRuntimeProfileFingerprint,
  };
}

function rollbackRunReference(run) {
  return {
    id: run.id,
    revision: run.revision,
    fingerprint: run.fingerprint,
    rollbackPlanId: run.rollbackPlanId,
    rollbackPlanFingerprint: run.rollbackPlanFingerprint,
    approvalId: run.approvalId,
    approvalFingerprint: run.approvalFingerprint,
  };
}

function emailDeliveryRunReference(run) {
  return {
    id: run.id,
    revision: run.revision,
    fingerprint: run.fingerprint,
    planId: run.emailDeliveryPlanId,
    planFingerprint: run.emailDeliveryPlanFingerprint,
    approvalId: run.approvalId,
    approvalFingerprint: run.approvalFingerprint,
  };
}

function latestRef(refs) { return Array.isArray(refs) && refs.length > 0 ? refs.at(-1) : null; }

function sessionRequestsCandidateControl(report, status) {
  return report.effectiveStatus === status ||
    (report.effectiveStatus === 'candidate-run-authorization-expired' &&
      report.candidateAuthorization?.status === status);
}

function furthestCheckpoint(current, candidate) {
  const order = [
    'bootstrap-human', 'configuration-human', 'waiting-launch-settings', 'candidate-control-ready',
    'candidate-plan-ready', 'candidate-profile-ready', 'candidate-approval-ready', 'candidate-preflight-ready',
    'candidate-run-started', 'candidate-provider-stage-succeeded',
    ...DATABASE_INSPECT_CHECKPOINTS,
    ...DATABASE_APPLY_CHECKPOINTS,
    'verification-plan-ready', 'candidate-verified',
    ...CUTOVER_CHECKPOINTS,
    ...ROLLBACK_CHECKPOINTS,
  ];
  return order.indexOf(candidate) > order.indexOf(current) ? candidate : current;
}

function assertSameProviderStrategy(bootstrapRecipe, configurationRecipe) {
  if (!sameSource(bootstrapRecipe.sourceRef, configurationRecipe.sourceRef) ||
      stableStringify(bootstrapRecipe.requirements) !== stableStringify(configurationRecipe.requirements) ||
      stableStringify(bootstrapRecipe.providers) !== stableStringify(configurationRecipe.providers) ||
      stableStringify(bootstrapRecipe.humanDecisions) !== stableStringify(configurationRecipe.humanDecisions) ||
      configurationRecipe.requiredConnections.some((item) => item.status !== 'ready')) {
    throw operationError('CONFLICT', 'Provider strategy changed or Connections are not fully ready; start a reviewed First Launch Session.');
  }
}

function buildReport(operation, stored, evaluation, repositoryGuard = undefined) {
  return {
    kind: 'first-launch-session',
    operation,
    status: evaluation.effectiveStatus,
    home: stored.home,
    projectId: stored.session.projectId,
    session: stored.session,
    sessionFile: stored.sessionFile,
    revision: stored.revision || evaluation.revision,
    reused: stored.reused,
    ...(stored.connectionsCreated ? { connectionsCreated: stored.connectionsCreated } : {}),
    ...(stored.configurationHandoffCreated !== undefined
      ? { configurationHandoffCreated: stored.configurationHandoffCreated }
      : {}),
    ...(stored.candidateControlCreated !== undefined
      ? { candidateControlCreated: stored.candidateControlCreated }
      : {}),
    ...(stored.candidatePlanCreated !== undefined
      ? { candidatePlanCreated: stored.candidatePlanCreated }
      : {}),
    ...(stored.candidateProfileAdopted !== undefined
      ? { candidateProfileAdopted: stored.candidateProfileAdopted }
      : {}),
    ...(stored.candidateApprovalAdopted !== undefined
      ? { candidateApprovalAdopted: stored.candidateApprovalAdopted }
      : {}),
    ...(stored.candidatePreflightAdopted !== undefined
      ? { candidatePreflightAdopted: stored.candidatePreflightAdopted }
      : {}),
    ...(stored.candidateRunAdopted !== undefined
      ? { candidateRunAdopted: stored.candidateRunAdopted }
      : {}),
    ...(stored.migrationPlanAdopted !== undefined
      ? { migrationPlanAdopted: stored.migrationPlanAdopted }
      : {}),
    ...(stored.databaseInspectProfileAdopted !== undefined
      ? { databaseInspectProfileAdopted: stored.databaseInspectProfileAdopted }
      : {}),
    ...(stored.databaseInspectApprovalAdopted !== undefined
      ? { databaseInspectApprovalAdopted: stored.databaseInspectApprovalAdopted }
      : {}),
    ...(stored.databaseInspectPreflightAdopted !== undefined
      ? { databaseInspectPreflightAdopted: stored.databaseInspectPreflightAdopted }
      : {}),
    ...(stored.databaseInspectRunAdopted !== undefined
      ? { databaseInspectRunAdopted: stored.databaseInspectRunAdopted }
      : {}),
    ...(stored.backupEvidenceAdopted !== undefined
      ? { backupEvidenceAdopted: stored.backupEvidenceAdopted }
      : {}),
    ...(stored.databaseRuntimeProfileAdopted !== undefined
      ? { databaseRuntimeProfileAdopted: stored.databaseRuntimeProfileAdopted }
      : {}),
    ...(stored.databaseApplyProfileAdopted !== undefined
      ? { databaseApplyProfileAdopted: stored.databaseApplyProfileAdopted }
      : {}),
    ...(stored.databaseApplyApprovalAdopted !== undefined
      ? { databaseApplyApprovalAdopted: stored.databaseApplyApprovalAdopted }
      : {}),
    ...(stored.databaseApplyPreflightAdopted !== undefined
      ? { databaseApplyPreflightAdopted: stored.databaseApplyPreflightAdopted }
      : {}),
    ...(stored.databaseApplyRunAdopted !== undefined
      ? { databaseApplyRunAdopted: stored.databaseApplyRunAdopted }
      : {}),
    ...(stored.verificationPlanAdopted !== undefined
      ? { verificationPlanAdopted: stored.verificationPlanAdopted }
      : {}),
    ...(stored.candidateEvidenceAdopted !== undefined
      ? { candidateEvidenceAdopted: stored.candidateEvidenceAdopted }
      : {}),
    ...(stored.cutoverHandoffAdopted !== undefined
      ? { cutoverHandoffAdopted: stored.cutoverHandoffAdopted }
      : {}),
    ...(stored.cutoverAttestationAdopted !== undefined
      ? { cutoverAttestationAdopted: stored.cutoverAttestationAdopted }
      : {}),
    ...(stored.cutoverProfileAdopted !== undefined
      ? { cutoverProfileAdopted: stored.cutoverProfileAdopted }
      : {}),
    ...(stored.cutoverApprovalAdopted !== undefined
      ? { cutoverApprovalAdopted: stored.cutoverApprovalAdopted }
      : {}),
    ...(stored.cutoverPreflightAdopted !== undefined
      ? { cutoverPreflightAdopted: stored.cutoverPreflightAdopted }
      : {}),
    ...(stored.cutoverRunAdopted !== undefined
      ? { cutoverRunAdopted: stored.cutoverRunAdopted }
      : {}),
    ...(stored.emailDeliveryPlanAdopted !== undefined
      ? { emailDeliveryPlanAdopted: stored.emailDeliveryPlanAdopted }
      : {}),
    ...(stored.emailDeliveryApprovalAdopted !== undefined
      ? { emailDeliveryApprovalAdopted: stored.emailDeliveryApprovalAdopted }
      : {}),
    ...(stored.emailDeliveryRunAdopted !== undefined
      ? { emailDeliveryRunAdopted: stored.emailDeliveryRunAdopted }
      : {}),
    ...(stored.productionEvidenceAdopted !== undefined
      ? { productionEvidenceAdopted: stored.productionEvidenceAdopted }
      : {}),
    ...(stored.rollbackPlanAdopted !== undefined
      ? { rollbackPlanAdopted: stored.rollbackPlanAdopted }
      : {}),
    ...(stored.rollbackApprovalAdopted !== undefined
      ? { rollbackApprovalAdopted: stored.rollbackApprovalAdopted }
      : {}),
    ...(stored.rollbackRunAdopted !== undefined
      ? { rollbackRunAdopted: stored.rollbackRunAdopted }
      : {}),
    ...evaluation,
    ...(repositoryGuard ? { repositoryGuard } : {}),
    browserActionsExecuted: 0,
    networkRequestsExecuted: 0,
    providerProbesExecuted: 0,
    providerMutationsExecuted: 0,
    secretValuesRead: false,
    productRepositoryChanged: false,
  };
}

function readSessionFile(file, expected) {
  return validateFirstLaunchSession(readJson(file, 'First Launch Session'), expected);
}

function sessionPath(home, projectId, sessionId) {
  if (!SESSION_ID.test(sessionId || '')) throw operationError('VALIDATION_FAILED', 'First Launch Session id is invalid.');
  return path.join(projectPath(home, projectId), 'first-launch-sessions', `${sessionId}.json`);
}

function revisionDirectory(home, projectId, sessionId) {
  if (!SESSION_ID.test(sessionId || '')) throw operationError('VALIDATION_FAILED', 'First Launch Session id is invalid.');
  return path.join(projectPath(home, projectId), 'first-launch-session-revisions', sessionId);
}

function revisionPath(home, projectId, sessionId, revision) {
  return path.join(revisionDirectory(home, projectId, sessionId), `${String(revision).padStart(6, '0')}.json`);
}

function sessionFingerprint(session) {
  const copy = structuredClone(session);
  delete copy.id;
  delete copy.fingerprint;
  delete copy.createdAt;
  return `sha256:${hash(stableStringify(copy))}`;
}

function revisionFingerprint(revision) {
  const copy = structuredClone(revision);
  delete copy.id;
  delete copy.fingerprint;
  delete copy.createdAt;
  return `sha256:${hash(stableStringify(copy))}`;
}

function normalizeActor(value) {
  const actor = String(value || '').trim();
  if (!isActor(actor)) throw operationError('VALIDATION_FAILED', 'First Launch Session owner is invalid.');
  return actor;
}

function normalizeDate(value, label) {
  if (!isDate(value)) throw operationError('VALIDATION_FAILED', `${label} is invalid.`);
  return new Date(Date.parse(value)).toISOString();
}

function normalizeDeadline(value, createdAt) {
  const deadline = normalizeDate(value, 'session deadline');
  if (Date.parse(deadline) <= Date.parse(createdAt)) {
    throw operationError('VALIDATION_FAILED', 'First Launch Session deadline must be after creation time.');
  }
  return deadline;
}

function validateSourceRef(ref, label, issues) {
  if (!ref || !['local-git', 'remote-git'].includes(ref.kind) || typeof ref.locator !== 'string' || !ref.locator ||
      !/^[a-fA-F0-9]{40,64}$/.test(ref.commit || '')) issues.push(label);
}

function validateRef(ref, idPattern, label, issues) {
  if (!ref || !idPattern.test(ref.id || '') || !SHA256.test(ref.fingerprint || '')) issues.push(label);
}

function validateNullableRef(ref, idPattern, label, issues) {
  if (ref === null) return;
  validateRef(ref, idPattern, label, issues);
}

function validateRefHistory(refs, idPattern, label, issues) {
  if (!Array.isArray(refs)) return issues.push(label);
  const ids = new Set();
  for (const [index, ref] of refs.entries()) {
    validateRef(ref, idPattern, `${label}[${index}]`, issues);
    if (ids.has(ref?.id)) issues.push(`${label}.duplicate(${ref.id})`);
    ids.add(ref?.id);
  }
}

function validatePreflightRefHistory(refs, issues, field = 'sandboxPreflightRefs') {
  if (!Array.isArray(refs)) return issues.push(field);
  const ids = new Set();
  for (const [index, ref] of refs.entries()) {
    const label = `${field}[${index}]`;
    exactKeys(ref, [
      'id', 'fingerprint', 'profileId', 'profileFingerprint', 'approvalId', 'approvalFingerprint',
    ], label, issues);
    if (!/^sandbox-preflight-[a-f0-9]{24}$/.test(ref?.id || '') ||
        !SHA256.test(ref?.fingerprint || '') || !/^sandbox-[a-f0-9]{24}$/.test(ref?.profileId || '') ||
        !SHA256.test(ref?.profileFingerprint || '') || !/^approval-[a-f0-9-]+$/.test(ref?.approvalId || '') ||
        !SHA256.test(ref?.approvalFingerprint || '')) issues.push(label);
    if (ids.has(ref?.id)) issues.push(`${field}.duplicate(${ref.id})`);
    ids.add(ref?.id);
  }
}

function validateCandidateRunRefHistory(refs, issues, field = 'candidateRunRefs') {
  if (!Array.isArray(refs)) return issues.push(field);
  const revisions = new Set();
  const latestById = new Map();
  for (const [index, ref] of refs.entries()) {
    const label = `${field}[${index}]`;
    exactKeys(ref, [
      'id', 'revision', 'fingerprint', 'adapterPlanId', 'adapterPlanFingerprint',
      'profileId', 'profileFingerprint', 'preflightId', 'preflightFingerprint',
    ], label, issues);
    if (!/^launch-[a-f0-9-]+$/.test(ref?.id || '') || !Number.isInteger(ref?.revision) || ref.revision < 1 ||
        !SHA256.test(ref?.fingerprint || '') || !/^adapter-plan-[a-f0-9]{24}$/.test(ref?.adapterPlanId || '') ||
        !SHA256.test(ref?.adapterPlanFingerprint || '') || !/^sandbox-[a-f0-9]{24}$/.test(ref?.profileId || '') ||
        !SHA256.test(ref?.profileFingerprint || '') || !/^sandbox-preflight-[a-f0-9]{24}$/.test(ref?.preflightId || '') ||
        !SHA256.test(ref?.preflightFingerprint || '')) issues.push(label);
    const key = `${ref?.id}:${ref?.revision}`;
    if (revisions.has(key)) issues.push(`${field}.duplicate(${key})`);
    revisions.add(key);
    const previous = latestById.get(ref?.id);
    if (previous && (ref.revision <= previous.revision ||
        stableStringify(runAuthorizationBinding(ref)) !== stableStringify(runAuthorizationBinding(previous)))) {
      issues.push(`${field}.nonMonotonic(${ref.id})`);
    }
    latestById.set(ref?.id, ref);
  }
}

function validateRollbackRunRefHistory(refs, issues) {
  const field = 'rollbackRunRefs';
  if (!Array.isArray(refs)) return issues.push(field);
  const revisions = new Set();
  let latestRevision = 0;
  let runId = '';
  for (const [index, ref] of refs.entries()) {
    const label = `${field}[${index}]`;
    exactKeys(ref, [
      'id', 'revision', 'fingerprint', 'rollbackPlanId', 'rollbackPlanFingerprint',
      'approvalId', 'approvalFingerprint',
    ], label, issues);
    if (!/^rollback-run-[a-f0-9-]{36}$/.test(ref?.id || '') ||
        !Number.isInteger(ref?.revision) || ref.revision < 1 || !SHA256.test(ref?.fingerprint || '') ||
        !/^rollback-plan-[a-f0-9]{24}$/.test(ref?.rollbackPlanId || '') ||
        !SHA256.test(ref?.rollbackPlanFingerprint || '') ||
        !/^rollback-approval-[a-f0-9-]{36}$/.test(ref?.approvalId || '') ||
        !SHA256.test(ref?.approvalFingerprint || '')) issues.push(label);
    if ((runId && ref?.id !== runId) || ref?.revision <= latestRevision ||
        revisions.has(`${ref?.id}:${ref?.revision}`)) issues.push(`${field}.order`);
    runId = ref?.id || runId;
    latestRevision = ref?.revision || latestRevision;
    revisions.add(`${ref?.id}:${ref?.revision}`);
  }
}

function validateEmailDeliveryRunRefHistory(refs, issues) {
  const field = 'emailDeliveryRunRefs';
  if (!Array.isArray(refs)) return issues.push(field);
  let runId = '';
  let latestRevision = 0;
  const revisions = new Set();
  for (const [index, ref] of refs.entries()) {
    const label = `${field}[${index}]`;
    exactKeys(ref, [
      'id', 'revision', 'fingerprint', 'planId', 'planFingerprint', 'approvalId', 'approvalFingerprint',
    ], label, issues);
    if (!/^email-delivery-run-[a-f0-9-]{36}$/.test(ref?.id || '') ||
        !Number.isInteger(ref?.revision) || ref.revision < 1 || !SHA256.test(ref?.fingerprint || '') ||
        !/^email-delivery-plan-[a-f0-9]{24}$/.test(ref?.planId || '') ||
        !SHA256.test(ref?.planFingerprint || '') ||
        !/^email-delivery-approval-[a-f0-9-]{36}$/.test(ref?.approvalId || '') ||
        !SHA256.test(ref?.approvalFingerprint || '')) issues.push(label);
    if ((runId && ref?.id !== runId) || ref?.revision <= latestRevision ||
        revisions.has(`${ref?.id}:${ref?.revision}`)) issues.push(`${field}.order`);
    runId = ref?.id || runId;
    latestRevision = Number.isInteger(ref?.revision) ? ref.revision : latestRevision;
    revisions.add(`${ref?.id}:${ref?.revision}`);
  }
}

function validateDatabasePreflightRefHistory(refs, issues) {
  const field = 'databaseApplyPreflightRefs';
  if (!Array.isArray(refs)) return issues.push(field);
  const ids = new Set();
  for (const [index, ref] of refs.entries()) {
    const label = `${field}[${index}]`;
    exactKeys(ref, [
      'id', 'fingerprint', 'profileId', 'profileFingerprint', 'approvalId', 'approvalFingerprint',
      'databaseRuntimeProfileId', 'databaseRuntimeProfileFingerprint',
    ], label, issues);
    if (!/^sandbox-preflight-[a-f0-9]{24}$/.test(ref?.id || '') ||
        !SHA256.test(ref?.fingerprint || '') || !/^sandbox-[a-f0-9]{24}$/.test(ref?.profileId || '') ||
        !SHA256.test(ref?.profileFingerprint || '') || !/^approval-[a-f0-9-]+$/.test(ref?.approvalId || '') ||
        !SHA256.test(ref?.approvalFingerprint || '') ||
        !/^database-runtime-[a-f0-9]{24}$/.test(ref?.databaseRuntimeProfileId || '') ||
        !SHA256.test(ref?.databaseRuntimeProfileFingerprint || '')) issues.push(label);
    if (ids.has(ref?.id)) issues.push(`${field}.duplicate(${ref.id})`);
    ids.add(ref?.id);
  }
}

function validateDatabaseRunRefHistory(refs, issues) {
  const field = 'databaseApplyRunRefs';
  if (!Array.isArray(refs)) return issues.push(field);
  const revisions = new Set();
  const latestById = new Map();
  for (const [index, ref] of refs.entries()) {
    const label = `${field}[${index}]`;
    exactKeys(ref, [
      'id', 'revision', 'fingerprint', 'adapterPlanId', 'adapterPlanFingerprint',
      'profileId', 'profileFingerprint', 'preflightId', 'preflightFingerprint',
      'databaseRuntimeProfileId', 'databaseRuntimeProfileFingerprint',
    ], label, issues);
    if (!/^launch-[a-f0-9-]+$/.test(ref?.id || '') || !Number.isInteger(ref?.revision) || ref.revision < 1 ||
        !SHA256.test(ref?.fingerprint || '') || !/^adapter-plan-[a-f0-9]{24}$/.test(ref?.adapterPlanId || '') ||
        !SHA256.test(ref?.adapterPlanFingerprint || '') || !/^sandbox-[a-f0-9]{24}$/.test(ref?.profileId || '') ||
        !SHA256.test(ref?.profileFingerprint || '') || !/^sandbox-preflight-[a-f0-9]{24}$/.test(ref?.preflightId || '') ||
        !SHA256.test(ref?.preflightFingerprint || '') ||
        !/^database-runtime-[a-f0-9]{24}$/.test(ref?.databaseRuntimeProfileId || '') ||
        !SHA256.test(ref?.databaseRuntimeProfileFingerprint || '')) issues.push(label);
    const key = `${ref?.id}:${ref?.revision}`;
    if (revisions.has(key)) issues.push(`${field}.duplicate(${key})`);
    revisions.add(key);
    const previous = latestById.get(ref?.id);
    if (previous && (ref.revision <= previous.revision ||
        stableStringify(databaseRunAuthorizationBinding(ref)) !==
        stableStringify(databaseRunAuthorizationBinding(previous)))) {
      issues.push(`${field}.nonMonotonic(${ref.id})`);
    }
    latestById.set(ref?.id, ref);
  }
}

function validateManifestRef(ref, issues) {
  if (ref === null) return;
  if (!ref || !SHA256.test(ref.fingerprint || '') || !/^recipe-[a-f0-9]{24}$/.test(ref.recipeId || '') ||
      !SHA256.test(ref.recipeFingerprint || '') || Object.keys(ref).some((key) =>
        !['fingerprint', 'recipeId', 'recipeFingerprint'].includes(key))) issues.push('manifestRef');
}

function validateArtifactRef(ref, issues) {
  if (ref === null) return;
  if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.id || '') || !/^[a-f0-9]{64}$/.test(ref.digest || '') ||
      ref.id !== `sha256:${ref.digest}` || !['source-archive', 'vercel-file-manifest', 'runtime-build'].includes(ref.kind) ||
      !/^[a-fA-F0-9]{40,64}$/.test(ref.sourceCommit || '') || Object.keys(ref).some((key) =>
        !['id', 'kind', 'digest', 'sourceCommit'].includes(key))) issues.push('artifactRef');
}

function hasAnyProgressRef(revision) {
  return [
    revision.configurationRecipeRef,
    revision.configurationHandoffRef,
    revision.configurationAttestationRef,
    revision.manifestRef,
    revision.artifactRef,
    revision.graphRef,
    revision.launchConfigurationRef,
    revision.adapterPlanRef,
    revision.migrationPlanRef,
    revision.databaseInspectPlanRef,
    revision.backupEvidenceRef,
    revision.databaseApplyPlanRef,
    revision.verificationPlanRef,
    revision.candidateEvidenceRef,
    revision.cutoverHandoffRef,
    revision.cutoverAttestationRef,
    revision.dnsChangeSetRef,
    revision.cutoverPlanRef,
    revision.emailDeliveryPlanRef,
    revision.productionEvidenceRef,
    revision.rollbackPlanRef,
  ].some((value) => value !== null) ||
    (revision.sandboxProfileRefs?.length || 0) > 0 ||
    (revision.candidateApprovalRefs?.length || 0) > 0 ||
    (revision.sandboxPreflightRefs?.length || 0) > 0 ||
    (revision.candidateRunRefs?.length || 0) > 0 ||
    (revision.databaseInspectProfileRefs?.length || 0) > 0 ||
    (revision.databaseInspectApprovalRefs?.length || 0) > 0 ||
    (revision.databaseInspectPreflightRefs?.length || 0) > 0 ||
    (revision.databaseInspectRunRefs?.length || 0) > 0 ||
    (revision.databaseRuntimeProfileRefs?.length || 0) > 0 ||
    (revision.databaseApplyProfileRefs?.length || 0) > 0 ||
    (revision.databaseApplyApprovalRefs?.length || 0) > 0 ||
    (revision.databaseApplyPreflightRefs?.length || 0) > 0 ||
    (revision.databaseApplyRunRefs?.length || 0) > 0 ||
    (revision.cutoverProfileRefs?.length || 0) > 0 ||
    (revision.cutoverApprovalRefs?.length || 0) > 0 ||
    (revision.cutoverPreflightRefs?.length || 0) > 0 ||
    (revision.cutoverRunRefs?.length || 0) > 0 ||
    (revision.emailDeliveryApprovalRefs?.length || 0) > 0 ||
    (revision.emailDeliveryRunRefs?.length || 0) > 0 ||
    (revision.productionVerificationRefs?.length || 0) > 0 ||
    (revision.rollbackApprovalRefs?.length || 0) > 0 ||
    (revision.rollbackRunRefs?.length || 0) > 0;
}

function runAuthorizationBinding(ref) {
  return {
    adapterPlanId: ref?.adapterPlanId,
    adapterPlanFingerprint: ref?.adapterPlanFingerprint,
    profileId: ref?.profileId,
    profileFingerprint: ref?.profileFingerprint,
    preflightId: ref?.preflightId,
    preflightFingerprint: ref?.preflightFingerprint,
  };
}

function databaseRunAuthorizationBinding(ref) {
  return {
    ...runAuthorizationBinding(ref),
    databaseRuntimeProfileId: ref?.databaseRuntimeProfileId,
    databaseRuntimeProfileFingerprint: ref?.databaseRuntimeProfileFingerprint,
  };
}

function historyExtends(previous, current) {
  return Array.isArray(previous) && Array.isArray(current) && current.length >= previous.length &&
    previous.every((value, index) => stableStringify(value) === stableStringify(current[index]));
}

function exactKeys(value, allowed, label, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return issues.push(label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${label}.unsupported(${key})`);
  for (const key of allowed) if (!(key in value)) issues.push(`${label}.missing(${key})`);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw operationError('ARTIFACT_INTEGRITY_FAILED', `${label} JSON is invalid: ${error.message}`); }
}

function sourceRef(source) { return { kind: source.kind, locator: source.locator, commit: source.commit }; }
function objectRef(value) { return { id: value.id, fingerprint: value.fingerprint }; }
function artifactReference(artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    digest: artifact.digest.value,
    sourceCommit: artifact.sourceRef.commit,
  };
}
function sameSource(left, right) { return left?.kind === right?.kind && left?.locator === right?.locator && left?.commit === right?.commit; }
function isDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isActor(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
