import path from 'node:path';

import { createAdapterExecutionPlan, readAdapterActionsFile, showAdapterExecutionPlan } from './adapter-execution-plan.js';
import { generateAdapterExecutionPlan } from './adapter-plan-compiler.js';
import { createArtifact, listArtifacts, showArtifact, verifyArtifact } from './artifact.js';
import { createApproval, listApprovals, revokeApproval, showApproval } from './approval.js';
import { createBackupEvidence, showBackupEvidence } from './backup-evidence.js';
import {
  createAcceptanceCleanupAttestation,
  createAcceptanceCleanupPlan,
  readCleanupDispositionSpecFile,
  showAcceptanceCleanupAttestation,
  showAcceptanceCleanupPlan,
} from './acceptance-cleanup.js';
import { verifyCandidate } from './candidate-verification.js';
import {
  addConnection,
  checkConnection,
  copyConnection,
  listConnections,
  removeConnection,
  showConnection,
  updateConnection,
} from './connection-service.js';
import { probeConnection } from './connection-probe.js';
import { parseArgs } from './args.js';
import { detectProject } from './detect.js';
import { createDnsChangeSet, showDnsChangeSet } from './dns-change-set.js';
import { assertRequiredDiff, buildManagedFileDiff, writeManagedFileDiffArtifact } from './diff.js';
import { inspectPlanReadiness } from './doctor.js';
import {
  createEmailDeliveryApproval,
  revokeEmailDeliveryApproval,
  showEmailDeliveryApproval,
} from './email-delivery-approval.js';
import { createEmailDeliveryPlan, showEmailDeliveryPlan } from './email-delivery-plan.js';
import {
  resumeEmailDeliveryRun,
  showEmailDeliveryRun,
  startEmailDeliveryRun,
} from './email-delivery-run.js';
import { executePlan } from './executor.js';
import { buildHandoff, invalidManifestPlan, writeHandoffArtifact } from './handoff.js';
import { withDeploymentLock } from './lock.js';
import { importLegacyProject } from './legacy-import.js';
import {
  createHumanHandoff,
  createHumanHandoffAttestation,
  readHumanHandoffResultSpecFile,
  showHumanHandoff,
} from './human-handoff.js';
import {
  resumeFirstLaunchSession,
  showFirstLaunchSession,
  startFirstLaunchSession,
} from './first-launch-session.js';
import { listLaunchGraphs, planLaunch, showLaunchGraph } from './launch-service.js';
import {
  createLaunchConfiguration,
  readLaunchConfigurationSettingsFile,
  showLaunchConfiguration,
} from './launch-configuration.js';
import { resumeProviderLaunchRun, startProviderLaunchRun } from './provider-launch-run.js';
import { createExternalManifest, showExternalManifest } from './manifest-v2-service.js';
import {
  createDatabaseMigrationPlan,
  readMigrationPlanSpecFile,
  showDatabaseMigrationPlan,
} from './migration-plan.js';
import { createManifest, loadManifest, manifestPath, writeManifest } from './manifest.js';
import { onboardProduct } from './onboard.js';
import { buildDestroyPlan, buildPlan } from './plan.js';
import { prepareHandoffArtifacts } from './prepare.js';
import {
  createProductVerificationPlan,
  readProductVerificationSpecFile,
  runProductVerification,
  showProductVerificationPlan,
} from './product-verification.js';
import { createRollbackPlan, showRollbackPlan } from './rollback-plan.js';
import {
  createRollbackApproval,
  listRollbackApprovals,
  revokeRollbackApproval,
  showRollbackApproval,
} from './rollback-approval.js';
import { resumeRollbackRun, startRollbackRun } from './rollback-run.js';
import { listProviderCatalog, providerBootstrapGuide, showProviderCatalog } from './provider-catalog.js';
import { createProviderBootstrapPlan, showProviderBootstrapPlan } from './provider-bootstrap-plan.js';
import {
  buildHelpPayload,
  printDetection,
  printDnsChangeSetResult,
  printDoctor,
  printEmailDeliveryApprovalResult,
  printEmailDeliveryPlanResult,
  printEmailDeliveryRunResult,
  printArtifactResult,
  printApprovalResult,
  printAdapterPlanResult,
  printBackupEvidenceResult,
  printConnectionResult,
  printDatabaseRuntimeResult,
  printAcceptanceCleanupResult,
  printProviderAcceptancePortfolioResult,
  printProviderAcceptanceSuiteResult,
  printCandidateVerificationResult,
  printHandoff,
  printHelp,
  printHumanHandoffResult,
  printFirstLaunchSessionResult,
  printLegacyImport,
  printLaunchResult,
  printLaunchConfigurationResult,
  printManifestV2Result,
  printMigrationPlanResult,
  printManagedFileDiff,
  printOnboard,
  printPlan,
  printPrepare,
  printProjectAnalysis,
  printProjectResult,
  printProviderResult,
  printProviderBootstrapPlanResult,
  printProductVerificationResult,
  printRecipeResult,
  printSandboxResult,
  printSecretCaptureResult,
  printSourcePatchResult,
  printReview,
  printRollbackPlanResult,
  printRollbackApprovalResult,
  printRollbackRunResult,
  printRuns,
  printSecrets,
  printStatus,
  printValidation,
  printVersion,
} from './output.js';
import {
  addProject,
  analyzeProject,
  listProjects,
  removeProject,
  showProject,
  updateProject,
} from './project-service.js';
import { previewManagedFile, writeManagedFile } from './renderers.js';
import { listRecipes, planRecipe, showRecipe } from './recipe-service.js';
import { buildRuntimeArtifact } from './runtime-artifact.js';
import { createSandboxProfile, revokeSandboxProfile, showSandboxProfile } from './sandbox-profile.js';
import {
  createDatabaseRuntimeProfile,
  revokeDatabaseRuntimeProfile,
  showDatabaseRuntimeProfile,
} from './database-runtime-profile.js';
import { createSandboxAcceptanceReport } from './sandbox-acceptance.js';
import {
  createProviderAcceptanceSuite,
  showProviderAcceptanceSuite,
} from './provider-acceptance-suite.js';
import {
  createProviderAcceptancePortfolio,
  showProviderAcceptancePortfolio,
} from './provider-acceptance-portfolio.js';
import { createProviderAcceptanceReadiness } from './provider-acceptance-readiness.js';
import { createSandboxPreflight } from './sandbox-preflight.js';
import { resumeSandboxRun, startSandboxRun } from './sandbox-run.js';
import { captureSecret } from './secret-capture.js';
import { createSourcePatchProposal, showSourcePatchProposal } from './source-patch.js';
import { createVercelFileManifest } from './vercel-artifact.js';
import { assertRequiredReview, buildReview, writeReviewArtifact } from './review.js';
import { buildRunsReport } from './runs.js';
import { loadDeployManifestSchema } from './schema.js';
import { buildSecretsReport } from './secrets.js';
import { prepareInitialState, readState, recordRun, statePath, writeState } from './state.js';
import { buildStatus } from './status.js';
import { nowIso } from './utils.js';
import { manifestValidationError, validateManifest } from './validate.js';

export async function main(argv) {
  const options = parseArgs(argv);

  if (options.command === 'help' || options.help) {
    const helpCommand = options.helpCommand || (options.command === 'help' ? '' : options.command);
    if (options.json) {
      console.log(JSON.stringify(buildHelpPayload(helpCommand), null, 2));
      return;
    }
    printHelp(helpCommand);
    return;
  }
  if (options.command === 'version') {
    printVersion();
    return;
  }

  if (options.command === 'project') {
    const operation = {
      add: addProject,
      list: listProjects,
      show: showProject,
      update: updateProject,
      remove: removeProject,
    }[options.projectAction];
    const report = operation(options);
    printJsonOr(options.json, report, () => printProjectResult(report));
    return;
  }

  if (options.command === 'analyze') {
    const analysis = analyzeProject(options);
    printJsonOr(options.json, analysis, () => printProjectAnalysis(analysis));
    return;
  }

  if (options.command === 'artifact') {
    const operation = {
      create: createArtifact,
      build: buildRuntimeArtifact,
      vercel: createVercelFileManifest,
      list: listArtifacts,
      show: showArtifact,
      verify: verifyArtifact,
    }[options.artifactAction];
    const report = await operation(options);
    printJsonOr(options.json, report, () => printArtifactResult(report));
    return;
  }

  if (options.command === 'import') {
    const report = importLegacyProject(options);
    printJsonOr(options.json, report, () => printLegacyImport(report));
    return;
  }

  if (options.command === 'launch') {
    const operation = {
      plan: planLaunch,
      list: listLaunchGraphs,
      show: showLaunchGraph,
      apply: startProviderLaunchRun,
      resume: resumeProviderLaunchRun,
    }[options.launchAction];
    const report = await operation({
      ...options,
      nativeCliNetwork: options.providerMode === 'real',
    });
    printJsonOr(options.json, report, () => printLaunchResult(report));
    return;
  }

  if (options.command === 'approval') {
    const operation = {
      create: createApproval,
      list: listApprovals,
      show: showApproval,
      revoke: revokeApproval,
    }[options.approvalAction];
    const report = operation(options);
    printJsonOr(options.json, report, () => printApprovalResult(report));
    return;
  }

  if (options.command === 'adapter-plan') {
    const report = options.adapterPlanAction === 'create'
      ? createAdapterExecutionPlan({
          ...options,
          actions: readAdapterActionsFile(options.actionsFile).actions,
        })
      : options.adapterPlanAction === 'generate'
        ? generateAdapterExecutionPlan({
            ...options,
            configurationId: options.launchConfigurationId,
            changeSetId: options.dnsChangeSetId,
            migrationPlanId: options.migrationPlanId,
            backupEvidenceId: options.backupEvidenceId,
            acceptanceProviders: options.acceptanceProviders,
          })
      : showAdapterExecutionPlan({
          ...options,
          planId: options.adapterPlanId,
        });
    printJsonOr(options.json, report, () => printAdapterPlanResult(report));
    return;
  }

  if (options.command === 'source-patch') {
    const report = options.sourcePatchAction === 'create'
      ? createSourcePatchProposal({
          ...options,
          reason: options.patchReason,
        })
      : showSourcePatchProposal({
          ...options,
          proposalId: options.sourcePatchId,
        });
    printJsonOr(options.json, report, () => printSourcePatchResult(report));
    return;
  }

  if (options.command === 'backup-evidence') {
    const report = options.backupEvidenceAction === 'create'
      ? createBackupEvidence({ ...options, adapterPlanId: options.adapterPlanId })
      : showBackupEvidence({
          ...options, adapterPlanId: options.adapterPlanId, evidenceId: options.backupEvidenceId,
        });
    printJsonOr(options.json, report, () => printBackupEvidenceResult(report));
    return;
  }

  if (options.command === 'launch-config') {
    const report = options.launchConfigAction === 'create'
      ? createLaunchConfiguration({
          ...options,
          settings: readLaunchConfigurationSettingsFile(options.settingsFile).settings,
        })
      : showLaunchConfiguration({
          ...options,
          configurationId: options.launchConfigurationId,
        });
    printJsonOr(options.json, report, () => printLaunchConfigurationResult(report));
    return;
  }

  if (options.command === 'dns-change') {
    const report = options.dnsChangeAction === 'create'
      ? createDnsChangeSet({
          ...options,
          configurationId: options.launchConfigurationId,
        })
      : showDnsChangeSet({
          ...options,
          configurationId: options.launchConfigurationId,
          changeSetId: options.dnsChangeSetId,
        });
    printJsonOr(options.json, report, () => printDnsChangeSetResult(report));
    return;
  }

  if (options.command === 'candidate') {
    const report = await verifyCandidate({
      ...options,
      configurationId: options.launchConfigurationId,
    });
    printJsonOr(options.json, report, () => printCandidateVerificationResult(report));
    return;
  }

  if (options.command === 'verification') {
    const report = options.verificationAction === 'create'
      ? createProductVerificationPlan({
          ...options,
          configurationId: options.launchConfigurationId,
          spec: readProductVerificationSpecFile(options.verificationSpecFile).spec,
        })
      : (options.verificationAction === 'show'
          ? showProductVerificationPlan({
              ...options,
              configurationId: options.launchConfigurationId,
              planId: options.verificationPlanId,
            })
          : await runProductVerification({
              ...options,
              configurationId: options.launchConfigurationId,
              planId: options.verificationPlanId,
              phase: options.verificationPhase,
            }));
    printJsonOr(options.json, report, () => printProductVerificationResult(report));
    return;
  }

  if (options.command === 'email-delivery') {
    const report = await {
      create: () => createEmailDeliveryPlan({
        ...options,
        configurationId: options.launchConfigurationId,
        planId: options.emailDeliveryPlanId,
      }),
      show: () => showEmailDeliveryPlan({
        ...options,
        planId: options.emailDeliveryPlanId,
      }),
      approve: () => createEmailDeliveryApproval({
        ...options,
        planId: options.emailDeliveryPlanId,
      }),
      approval: () => showEmailDeliveryApproval({
        ...options,
        approvalId: options.emailDeliveryApprovalId,
      }),
      revoke: () => revokeEmailDeliveryApproval({
        ...options,
        approvalId: options.emailDeliveryApprovalId,
      }),
      apply: () => startEmailDeliveryRun({
        ...options,
        planId: options.emailDeliveryPlanId,
        approvalId: options.emailDeliveryApprovalId,
      }),
      resume: () => resumeEmailDeliveryRun({
        ...options,
        runId: options.emailDeliveryRunId,
      }),
      run: () => showEmailDeliveryRun({
        ...options,
        runId: options.emailDeliveryRunId,
      }),
    }[options.emailDeliveryAction]();
    const printer = ['create', 'show'].includes(options.emailDeliveryAction)
      ? printEmailDeliveryPlanResult
      : (['approve', 'approval', 'revoke'].includes(options.emailDeliveryAction)
          ? printEmailDeliveryApprovalResult
          : printEmailDeliveryRunResult);
    printJsonOr(options.json, report, () => printer(report));
    return;
  }

  if (options.command === 'rollback') {
    if (options.rollbackAction === 'create' || options.rollbackAction === 'show') {
      const report = options.rollbackAction === 'create'
        ? createRollbackPlan({ ...options, configurationId: options.launchConfigurationId })
        : showRollbackPlan({
            ...options,
            configurationId: options.launchConfigurationId,
            planId: options.rollbackPlanId,
          });
      printJsonOr(options.json, report, () => printRollbackPlanResult(report));
      return;
    }
    if (options.rollbackAction === 'apply' || options.rollbackAction === 'resume') {
      const report = options.rollbackAction === 'apply'
        ? await startRollbackRun({
            ...options,
            configurationId: options.launchConfigurationId,
            planId: options.rollbackPlanId,
            approvalId: options.rollbackApprovalId,
          })
        : await resumeRollbackRun({
            ...options,
            configurationId: options.launchConfigurationId,
          });
      printJsonOr(options.json, report, () => printRollbackRunResult(report));
      return;
    }
    const report = options.rollbackAction === 'approve'
      ? createRollbackApproval({
          ...options,
          configurationId: options.launchConfigurationId,
          planId: options.rollbackPlanId,
          stepIds: options.rollbackStepIds,
        })
      : (options.rollbackAction === 'list-approvals'
          ? listRollbackApprovals(options)
          : (options.rollbackAction === 'approval'
              ? showRollbackApproval({
                  ...options,
                  configurationId: options.launchConfigurationId,
                  approvalId: options.rollbackApprovalId,
                })
              : revokeRollbackApproval({
                  ...options,
                  configurationId: options.launchConfigurationId,
                  approvalId: options.rollbackApprovalId,
                })));
    printJsonOr(options.json, report, () => printRollbackApprovalResult(report));
    return;
  }

  if (options.command === 'migration-plan') {
    const report = options.migrationPlanAction === 'create'
      ? createDatabaseMigrationPlan({
          ...options,
          configurationId: options.launchConfigurationId,
          spec: readMigrationPlanSpecFile(options.migrationSpecFile).spec,
        })
      : showDatabaseMigrationPlan({
          ...options,
          configurationId: options.launchConfigurationId,
          planId: options.migrationPlanId,
        });
    printJsonOr(options.json, report, () => printMigrationPlanResult(report));
    return;
  }

  if (options.command === 'database-runtime') {
    const report = options.databaseRuntimeAction === 'create'
      ? createDatabaseRuntimeProfile({
          ...options, adapterPlanId: options.adapterPlanId, allowedHosts: options.databaseHosts,
        })
      : options.databaseRuntimeAction === 'revoke'
        ? revokeDatabaseRuntimeProfile({
            ...options, adapterPlanId: options.adapterPlanId, profileId: options.databaseRuntimeProfileId,
          })
        : showDatabaseRuntimeProfile({
            ...options, adapterPlanId: options.adapterPlanId, profileId: options.databaseRuntimeProfileId,
          });
    printJsonOr(options.json, report, () => printDatabaseRuntimeResult(report));
    return;
  }

  if (options.command === 'acceptance-suite') {
    const report = options.acceptanceSuiteAction === 'readiness'
      ? createProviderAcceptanceReadiness({
          ...options, providers: options.acceptanceProviders,
        })
      : options.acceptanceSuiteAction === 'create'
        ? createProviderAcceptanceSuite({
          ...options, runIds: options.acceptanceRunIds, providers: options.acceptanceProviders,
          })
        : showProviderAcceptanceSuite({
            ...options, suiteId: options.acceptanceSuiteId,
          });
    printJsonOr(options.json, report, () => printProviderAcceptanceSuiteResult(report));
    return;
  }

  if (options.command === 'acceptance-portfolio') {
    const report = options.acceptancePortfolioAction === 'create'
      ? createProviderAcceptancePortfolio({
          ...options,
          suiteRefs: options.acceptanceSuiteRefs,
          providers: options.acceptanceProviders,
        })
      : showProviderAcceptancePortfolio({
          ...options,
          portfolioId: options.acceptancePortfolioId,
        });
    printJsonOr(options.json, report, () => printProviderAcceptancePortfolioResult(report));
    return;
  }

  if (options.command === 'acceptance-cleanup') {
    const report = options.acceptanceCleanupAction === 'create'
      ? createAcceptanceCleanupPlan({
          ...options,
          suiteId: options.acceptanceSuiteId,
          cleanupOwner: options.cleanupOwner,
          cleanupDeadline: options.cleanupDeadline,
        })
      : options.acceptanceCleanupAction === 'attest'
        ? createAcceptanceCleanupAttestation({
            ...options,
            planId: options.cleanupPlanId,
            actor: options.approvedBy,
            dispositions: readCleanupDispositionSpecFile(options.cleanupSpecFile).dispositions,
          })
        : options.cleanupAttestationId
          ? showAcceptanceCleanupAttestation({
              ...options,
              planId: options.cleanupPlanId,
              attestationId: options.cleanupAttestationId,
            })
          : showAcceptanceCleanupPlan({
              ...options,
              planId: options.cleanupPlanId,
            });
    printJsonOr(options.json, report, () => printAcceptanceCleanupResult(report));
    return;
  }

  if (options.command === 'sandbox') {
    const report = options.sandboxAction === 'apply'
      ? await startSandboxRun({
          ...options,
          planId: options.adapterPlanId,
          profileId: options.sandboxProfileId,
          preflightId: options.sandboxPreflightId,
          nativeCliNetwork: true,
        })
      : options.sandboxAction === 'resume'
        ? await resumeSandboxRun({
            ...options,
            planId: options.adapterPlanId,
            profileId: options.sandboxProfileId,
            preflightId: options.sandboxPreflightId,
            nativeCliNetwork: true,
          })
      : options.sandboxAction === 'report'
        ? createSandboxAcceptanceReport({
            ...options,
            planId: options.adapterPlanId,
            profileId: options.sandboxProfileId,
          })
      : options.sandboxAction === 'preflight'
      ? await createSandboxPreflight({
          ...options,
          planId: options.adapterPlanId,
          profileId: options.sandboxProfileId,
          databaseRuntimeProfileId: options.databaseRuntimeProfileId,
        })
      : options.sandboxAction === 'create'
        ? createSandboxProfile({ ...options, planId: options.adapterPlanId })
      : options.sandboxAction === 'revoke'
        ? revokeSandboxProfile({
            ...options,
            planId: options.adapterPlanId,
            profileId: options.sandboxProfileId,
          })
        : showSandboxProfile({
          ...options,
          planId: options.adapterPlanId,
          profileId: options.sandboxProfileId,
        });
    printJsonOr(options.json, report, () => printSandboxResult(report));
    return;
  }

  if (options.command === 'provider') {
    const report = {
      list: () => listProviderCatalog(),
      show: () => showProviderCatalog(options.providerCatalogId),
      guide: () => providerBootstrapGuide(options.providerCatalogId),
    }[options.providerAction]();
    printJsonOr(options.json, report, () => printProviderResult(report));
    return;
  }

  if (options.command === 'secret') {
    const report = await captureSecret(options);
    printJsonOr(options.json, report, () => printSecretCaptureResult(report));
    return;
  }

  if (options.command === 'connection') {
    const operation = {
      add: addConnection,
      copy: copyConnection,
      list: listConnections,
      show: showConnection,
      update: updateConnection,
      remove: removeConnection,
      check: checkConnection,
      probe: probeConnection,
    }[options.connectionAction];
    const report = await operation(options);
    printJsonOr(options.json, report, () => printConnectionResult(report));
    return;
  }

  if (options.command === 'recipe') {
    const operation = {
      plan: planRecipe,
      list: listRecipes,
      show: showRecipe,
    }[options.recipeAction];
    const report = operation(options);
    printJsonOr(options.json, report, () => printRecipeResult(report));
    return;
  }

  if (options.command === 'bootstrap-plan') {
    const report = options.bootstrapPlanAction === 'create'
      ? createProviderBootstrapPlan(options)
      : showProviderBootstrapPlan(options);
    printJsonOr(options.json, report, () => printProviderBootstrapPlanResult(report));
    return;
  }

  if (options.command === 'first-launch') {
    const report = {
      start: () => startFirstLaunchSession(options),
      status: () => showFirstLaunchSession(options),
      resume: () => resumeFirstLaunchSession({
        ...options,
        ...(options.settingsFile ? readLaunchConfigurationSettingsFile(options.settingsFile) : {}),
      }),
    }[options.firstLaunchAction]();
    printJsonOr(options.json, report, () => printFirstLaunchSessionResult(report));
    return;
  }

  if (options.command === 'human-handoff') {
    const report = options.humanHandoffAction === 'create'
      ? createHumanHandoff(options)
      : options.humanHandoffAction === 'attest'
        ? createHumanHandoffAttestation({
            ...options,
            actor: options.approvedBy,
            results: readHumanHandoffResultSpecFile(options.handoffSpecFile).results,
          })
        : showHumanHandoff(options);
    printJsonOr(options.json, report, () => printHumanHandoffResult(report));
    return;
  }

  if (options.command === 'manifest') {
    const report = {
      create: () => createExternalManifest(options),
      show: () => showExternalManifest(options),
    }[options.manifestAction]();
    printJsonOr(options.json, report, () => printManifestV2Result(report));
    return;
  }

  if (options.command === 'detect') {
    const detection = detectProject(options.root);
    printJsonOr(options.json, detection, () => printDetection(detection));
    return;
  }

  if (options.command === 'schema') {
    console.log(JSON.stringify(loadDeployManifestSchema(), null, 2));
    return;
  }

  if (options.command === 'init') {
    await withDeploymentLock(options.root, 'init', async () => {
      const detection = detectProject(options.root);
      const manifest = createManifest(options.root, detection, options);
      const state = prepareInitialState(options.root, manifest, { force: options.force });
      const manifestFile = writeManifest(options.root, manifest, { force: options.force });
      const nextState = writeState(options.root, state);
      writeManagedFile(
        options.root,
        {
          type: 'file',
          path: '.gitignore',
          effect: 'upsert deployment-safe ignore rules',
          sideEffect: 'filesystem',
        },
        manifest,
        nextState
      );
      writeManagedFile(
        options.root,
        {
          type: 'file',
          path: '.agentmesh-deploy/RUNBOOK.md',
          effect: 'write AI deployment handoff runbook',
          sideEffect: 'filesystem',
        },
        manifest,
        nextState
      );
      const gitignoreFile = path.join(options.root, '.gitignore');
      const runbookFile = path.join(options.root, '.agentmesh-deploy/RUNBOOK.md');
      if (options.json) {
        console.log(JSON.stringify({
          manifest,
          manifestFile,
          stateFile: statePath(options.root),
          gitignoreFile,
          runbookFile,
        }, null, 2));
        return;
      }
      console.log(`Created ${manifestFile}`);
      console.log(`Created ${statePath(options.root)}`);
      console.log(`Updated ${gitignoreFile}`);
      console.log(`Updated ${runbookFile}`);
    });
    return;
  }

  if (options.command === 'onboard') {
    await withDeploymentLock(options.root, 'onboard', async () => {
      const report = onboardProduct(options.root, options);
      printJsonOr(options.json, report, () => printOnboard(report));
    });
    return;
  }

  const manifest = loadManifest(options.root);
  const validation = validateManifest(manifest);

  if (options.command === 'validate') {
    printJsonOr(options.json, validation, () => printValidation(validation));
    return;
  }

  if (options.command === 'doctor' && validation.status === 'invalid') {
    const report = inspectPlanReadiness(invalidManifestPlan(manifest), {
      ...options,
      manifestIssues: validation.issues,
    });
    printJsonOr(options.json, report, () => printDoctor(report));
    return;
  }

  if (options.command === 'handoff' && validation.status === 'invalid') {
    const { handoff, file } = writeHandoffArtifact(
      options.root,
      buildHandoff(manifest, validation, null, options),
      options.outFile
    );
    printJsonOr(options.json, handoff, () => {
      printHandoff(handoff);
      printSavedHandoff(file);
    });
    return;
  }

  if (options.command === 'status' && validation.status === 'invalid') {
    const status = buildStatus(manifest, validation, null, options);
    printJsonOr(options.json, status, () => printStatus(status));
    return;
  }

  if (options.command === 'review' && validation.status === 'invalid') {
    const { review, file } = writeReviewArtifact(
      options.root,
      buildReview(options.root, manifest, validation, null, options),
      options.outFile
    );
    printJsonOr(options.json, review, () => {
      printReview(review);
      printSavedReview(file);
    });
    return;
  }

  if (options.command === 'prepare' && validation.status === 'invalid') {
    const report = prepareHandoffArtifacts(options.root, manifest, validation, null, options);
    printJsonOr(options.json, report, () => printPrepare(report));
    return;
  }

  if (validation.status === 'invalid') {
    throw manifestValidationError(validation);
  }

  if (options.command === 'status') {
    const state = readState(options.root, manifest);
    const status = buildStatus(manifest, validation, state, options);
    printJsonOr(options.json, status, () => printStatus(status));
    return;
  }

  if (options.command === 'review') {
    const state = readState(options.root, manifest);
    const { review, file } = writeReviewArtifact(
      options.root,
      buildReview(options.root, manifest, validation, state, options),
      options.outFile
    );
    printJsonOr(options.json, review, () => {
      printReview(review);
      printSavedReview(file);
    });
    return;
  }

  if (options.command === 'prepare') {
    const state = readState(options.root, manifest);
    const report = prepareHandoffArtifacts(options.root, manifest, validation, state, options);
    printJsonOr(options.json, report, () => printPrepare(report));
    return;
  }

  if (options.command === 'runs') {
    const state = readState(options.root, manifest);
    const report = buildRunsReport(options.root, state, options);
    printJsonOr(options.json, report, () => printRuns(report));
    return;
  }

  if (options.command === 'secrets') {
    const state = readState(options.root, manifest);
    const plan = buildPlan(manifest, state);
    const report = buildSecretsReport(options.root, manifest, plan, state);
    printJsonOr(options.json, report, () => printSecrets(report));
    return;
  }

  if (options.command === 'handoff') {
    const state = readState(options.root, manifest);
    const { handoff, file } = writeHandoffArtifact(
      options.root,
      buildHandoff(manifest, validation, state, options),
      options.outFile
    );
    printJsonOr(options.json, handoff, () => {
      printHandoff(handoff);
      printSavedHandoff(file);
    });
    return;
  }

  if (options.command === 'plan') {
    const printCurrentPlan = () => {
      const state = readState(options.root, manifest);
      const plan = buildPlan(manifest, state);
      const nextState = options.save
        ? recordRun(options.root, state, {
            id: plan.id,
            command: 'plan',
            mode: 'plan',
            status: 'completed',
            createdAt: nowIso(),
            plan,
          })
        : state;
      printJsonOr(options.json, { plan, state: nextState }, () => printPlan(plan));
    };
    if (options.save) {
      await withDeploymentLock(options.root, 'plan', printCurrentPlan);
    } else {
      printCurrentPlan();
    }
    return;
  }

  if (options.command === 'doctor') {
    const state = readState(options.root, manifest);
    const plan = buildPlan(manifest, state);
    const report = inspectPlanReadiness(plan, {
      ...options,
      manifest,
      state,
      manifestIssues: validation.issues,
    });
    printJsonOr(options.json, report, () => printDoctor(report));
    return;
  }

  if (options.command === 'preview') {
    const state = readState(options.root, manifest);
    const plan = buildPlan(manifest, state);
    const fileActions = plan.steps.flatMap((step) => step.actions || []).filter((action) => action.type === 'file');
    const renderContext = {};
    const previews = fileActions.map((action) =>
      previewManagedFile(options.root, action, manifest, state, renderContext, {
        revealSecrets: options.unsafeRevealSecrets,
      })
    );
    printJsonOr(options.json, previews, () => {
      for (const preview of previews) {
        console.log(`--- ${preview.path} ---`);
        process.stdout.write(preview.content);
      }
    });
    return;
  }

  if (options.command === 'diff') {
    const state = readState(options.root, manifest);
    const { report, file } = writeManagedFileDiffArtifact(
      options.root,
      buildManagedFileDiff(options.root, manifest, state, options),
      options.outFile
    );
    printJsonOr(options.json, report, () => {
      printManagedFileDiff(report);
      printSavedDiff(file);
    });
    return;
  }

  if (options.command === 'apply') {
    await withDeploymentLock(options.root, 'apply', async () => {
      const state = readState(options.root, manifest);
      const plan = buildPlan(manifest, state);
      assertExpectedPlan(plan, options);
      assertRequiredReview(options.root, plan, options.requireReviewFile);
      assertRequiredDiff(options.root, manifest, state, plan, options.requireDiffFile, options);
      const run = executePlan(options.root, plan, state, { ...options, manifest, quiet: options.json });
      const nextState = recordRun(options.root, readState(options.root, manifest), run);
      printJsonOr(options.json, { run, state: nextState }, () => {
        console.log(`Run: ${run.id}`);
        console.log(`Mode: ${run.mode}`);
        console.log(`Status: ${run.status}`);
      });
    });
    return;
  }

  if (options.command === 'destroy') {
    await withDeploymentLock(options.root, 'destroy', async () => {
      const state = readState(options.root, manifest);
      const plan = buildDestroyPlan(manifest, state);
      assertExpectedPlan(plan, options);
      const run = {
        id: plan.id,
        command: 'destroy',
        mode: options.dryRun ? 'dry-run' : 'execute',
        status: options.dryRun ? 'completed' : 'blocked',
        createdAt: nowIso(),
        plan,
        results: options.dryRun
          ? plan.steps.map((step) => ({ stepId: step.id, status: 'dry-run' }))
          : [],
      };
      if (!options.dryRun) {
        throw new Error(
          'Destroy execution is intentionally disabled in v0.1. Run destroy without --execute for a deletion plan.'
        );
      }
      const nextState = recordRun(options.root, state, run);
      printJsonOr(options.json, { run, state: nextState }, () => printPlan(plan));
    });
    return;
  }
}

function printJsonOr(json, value, fallback) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  fallback();
}

function assertExpectedPlan(plan, options) {
  if (!options.expectPlan) return;
  if (plan.fingerprint === options.expectPlan) return;
  throw new Error(
    `Plan fingerprint mismatch. Expected ${options.expectPlan}, current ${plan.fingerprint || '(none)'}. Re-run plan/doctor/handoff and review the updated plan before apply.`
  );
}

function printSavedHandoff(file) {
  if (!file) return;
  console.log(`Saved handoff: ${file}`);
}

function printSavedReview(file) {
  if (!file) return;
  console.log(`Saved review: ${file}`);
}

function printSavedDiff(file) {
  if (!file) return;
  console.log(`Saved diff: ${file}`);
}
