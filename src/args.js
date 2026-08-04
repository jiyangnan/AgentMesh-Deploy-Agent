import path from 'node:path';
import process from 'node:process';

const COMMANDS = new Set([
  'project',
  'analyze',
  'artifact',
  'import',
  'launch',
  'approval',
  'provider',
  'secret',
  'connection',
  'recipe',
  'bootstrap-plan',
  'first-launch',
  'human-handoff',
  'manifest',
  'launch-config',
  'dns-change',
  'candidate',
  'verification',
  'email-delivery',
  'rollback',
  'migration-plan',
  'backup-evidence',
  'database-runtime',
  'acceptance-suite',
  'acceptance-portfolio',
  'acceptance-cleanup',
  'source-patch',
  'adapter-plan',
  'sandbox',
  'init',
  'onboard',
  'detect',
  'plan',
  'validate',
  'schema',
  'doctor',
  'prepare',
  'handoff',
  'apply',
  'preview',
  'diff',
  'status',
  'review',
  'runs',
  'secrets',
  'destroy',
  'help',
  'version',
]);

const PROJECT_ACTIONS = new Set(['add', 'list', 'show', 'update', 'remove']);
const ARTIFACT_ACTIONS = new Set(['create', 'build', 'vercel', 'list', 'show', 'verify']);
const IMPORT_ACTIONS = new Set(['legacy']);
const LAUNCH_ACTIONS = new Set(['plan', 'list', 'show', 'apply', 'resume']);
const APPROVAL_ACTIONS = new Set(['create', 'list', 'show', 'revoke']);
const PROVIDER_ACTIONS = new Set(['list', 'show', 'guide']);
const SECRET_ACTIONS = new Set(['capture']);
const CONNECTION_ACTIONS = new Set(['add', 'copy', 'list', 'show', 'update', 'remove', 'check', 'probe']);
const RECIPE_ACTIONS = new Set(['plan', 'list', 'show']);
const BOOTSTRAP_PLAN_ACTIONS = new Set(['create', 'show']);
const FIRST_LAUNCH_ACTIONS = new Set(['start', 'status', 'resume']);
const HUMAN_HANDOFF_ACTIONS = new Set(['create', 'attest', 'show']);
const MANIFEST_ACTIONS = new Set(['create', 'show']);
const LAUNCH_CONFIG_ACTIONS = new Set(['create', 'show']);
const DNS_CHANGE_ACTIONS = new Set(['create', 'show']);
const CANDIDATE_ACTIONS = new Set(['verify']);
const VERIFICATION_ACTIONS = new Set(['create', 'show', 'run']);
const EMAIL_DELIVERY_ACTIONS = new Set([
  'create', 'show', 'approve', 'approval', 'revoke', 'apply', 'resume', 'run',
]);
const ROLLBACK_ACTIONS = new Set([
  'create', 'show', 'approve', 'list-approvals', 'approval', 'revoke', 'apply', 'resume',
]);
const MIGRATION_PLAN_ACTIONS = new Set(['create', 'show']);
const BACKUP_EVIDENCE_ACTIONS = new Set(['create', 'show']);
const DATABASE_RUNTIME_ACTIONS = new Set(['create', 'show', 'revoke']);
const ACCEPTANCE_SUITE_ACTIONS = new Set(['readiness', 'create', 'show']);
const ACCEPTANCE_PORTFOLIO_ACTIONS = new Set(['create', 'show']);
const ACCEPTANCE_CLEANUP_ACTIONS = new Set(['create', 'attest', 'show']);
const SOURCE_PATCH_ACTIONS = new Set(['create', 'show']);
const ADAPTER_PLAN_ACTIONS = new Set(['create', 'generate', 'show']);
const SANDBOX_ACTIONS = new Set(['create', 'show', 'preflight', 'apply', 'resume', 'report', 'revoke']);
const V2_COMMANDS = new Set([
  'project', 'analyze', 'artifact', 'import', 'launch', 'approval', 'connection', 'recipe', 'bootstrap-plan', 'first-launch', 'human-handoff', 'manifest',
  'launch-config', 'dns-change', 'candidate', 'adapter-plan', 'sandbox',
  'verification', 'email-delivery', 'rollback', 'migration-plan', 'backup-evidence', 'database-runtime', 'acceptance-suite',
  'acceptance-portfolio',
  'acceptance-cleanup',
  'source-patch',
]);

export function parseArgs(argv) {
  const args = [...argv];
  const rawCommand = args.shift() || 'help';
  const command = rawCommand === '--help' || rawCommand === '-h' ? 'help' : rawCommand;
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = {
    command,
    root: process.cwd(),
    json: false,
    force: false,
    save: true,
    dryRun: command === 'apply' || command === 'destroy',
    execute: false,
    yes: false,
    allowProviderMutations: false,
    allowCostMutations: false,
    allowProviderDeletes: false,
    probeAuth: false,
    unsafeRevealSecrets: false,
    latestRun: false,
    runId: '',
    limit: 10,
    help: command === 'help',
    helpCommand: '',
    expectPlan: '',
    requireReviewFile: '',
    requireDiffFile: '',
    outFile: '',
    target: 'cloudflare-workers',
    provider: 'cloudflare',
    targetExplicit: false,
    providerExplicit: false,
    providerMode: '',
    preset: 'detected',
    name: '',
    repo: '',
    domain: '',
    home: '',
    projectAction: '',
    projectId: '',
    artifactAction: '',
    artifactId: '',
    artifactOutputDirs: [],
    importAction: '',
    launchAction: '',
    graphId: '',
    approvalAction: '',
    approvalId: '',
    nodeIds: '',
    expiresAt: '',
    approvedBy: '',
    providerAction: '',
    providerCatalogId: '',
    secretAction: '',
    secretRef: '',
    fromStdin: false,
    overwriteSecret: false,
    connectionAction: '',
    connectionId: '',
    connectionSourceProjectId: '',
    connectionSourceId: '',
    secretRefs: [],
    connectionScope: '',
    expectedVersion: 0,
    recipeAction: '',
    recipeId: '',
    bootstrapPlanAction: '',
    bootstrapPlanId: '',
    secretBackend: '',
    firstLaunchAction: '',
    sessionId: '',
    sessionOwner: '',
    sessionDeadline: '',
    humanHandoffAction: '',
    handoffId: '',
    handoffAttestationId: '',
    handoffPhase: '',
    handoffOwner: '',
    handoffDeadline: '',
    handoffSpecFile: '',
    candidateEvidenceId: '',
    cutoverHandoffId: '',
    cutoverAttestationId: '',
    productionEvidenceId: '',
    manifestAction: '',
    launchConfigAction: '',
    launchConfigurationId: '',
    settingsFile: '',
    dnsChangeAction: '',
    dnsChangeSetId: '',
    acceptanceOnly: false,
    candidateAction: '',
    verificationAction: '',
    verificationPlanId: '',
    verificationSpecFile: '',
    verificationPhase: '',
    emailDeliveryAction: '',
    emailDeliveryPlanId: '',
    emailDeliveryApprovalId: '',
    emailDeliveryRunId: '',
    provisioningConnectionId: '',
    sendingConnectionId: '',
    fromLocalPart: '',
    rollbackAction: '',
    rollbackPlanId: '',
    rollbackApprovalId: '',
    rollbackStepIds: '',
    migrationPlanAction: '',
    migrationPlanId: '',
    migrationSpecFile: '',
    backupEvidenceAction: '',
    backupEvidenceId: '',
    adapterPlanAction: '',
    adapterPlanId: '',
    actionsFile: '',
    sandboxAction: '',
    sandboxProfileId: '',
    sandboxPreflightId: '',
    accountEnvironment: '',
    resourcePrefix: '',
    allowedDomains: [],
    protectedDomains: [],
    allowPaidResources: false,
    allowNetwork: false,
    allowProviderNetwork: false,
    allowSandboxNetwork: false,
    allowRollbackNetwork: false,
    allowDatabaseRestore: false,
    allowDatabaseMigration: false,
    databaseRuntimeAction: '',
    databaseRuntimeProfileId: '',
    databaseHosts: [],
    acceptanceSuiteAction: '',
    acceptanceSuiteId: '',
    acceptanceRunIds: [],
    acceptanceProviders: [],
    acceptancePortfolioAction: '',
    acceptancePortfolioId: '',
    acceptanceSuiteRefs: [],
    acceptanceCleanupAction: '',
    cleanupPlanId: '',
    cleanupAttestationId: '',
    cleanupOwner: '',
    cleanupDeadline: '',
    cleanupSpecFile: '',
    sourcePatchAction: '',
    sourcePatchId: '',
    patchFile: '',
    patchReason: '',
    probeSecrets: false,
    maxProviderMutations: 0,
    includeArchived: false,
    refreshSource: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--stdin') {
      options.fromStdin = true;
      continue;
    }
    if (arg === '--overwrite') {
      options.overwriteSecret = true;
      continue;
    }
    if (arg === '--all') {
      options.includeArchived = true;
      continue;
    }
    if (arg === '--refresh-source') {
      options.refreshSource = true;
      continue;
    }
    if (arg === '--artifact-output') {
      options.artifactOutputDirs.push(requireValue(args, ++index, '--artifact-output'));
      continue;
    }
    if (arg.startsWith('--artifact-output=')) {
      options.artifactOutputDirs.push(requireInlineValue(arg, '--artifact-output'));
      continue;
    }
    if (arg === '--no-save') {
      options.save = false;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      options.execute = false;
      continue;
    }
    if (arg === '--execute') {
      options.execute = true;
      options.dryRun = false;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
      continue;
    }
    if (arg === '--allow-provider-mutations') {
      options.allowProviderMutations = true;
      continue;
    }
    if (arg === '--allow-cost-mutations') {
      options.allowCostMutations = true;
      continue;
    }
    if (arg === '--allow-provider-deletes') {
      options.allowProviderDeletes = true;
      continue;
    }
    if (arg === '--allow-paid-resources') {
      options.allowPaidResources = true;
      continue;
    }
    if (arg === '--acceptance-only') {
      options.acceptanceOnly = true;
      continue;
    }
    if (arg === '--allow-network') {
      options.allowNetwork = true;
      continue;
    }
    if (arg === '--allow-provider-network') {
      options.allowProviderNetwork = true;
      continue;
    }
    if (arg === '--allow-sandbox-network') {
      options.allowSandboxNetwork = true;
      continue;
    }
    if (arg === '--allow-rollback-network') {
      options.allowRollbackNetwork = true;
      continue;
    }
    if (arg === '--allow-database-restore') {
      options.allowDatabaseRestore = true;
      continue;
    }
    if (arg === '--allow-database-migration') {
      options.allowDatabaseMigration = true;
      continue;
    }
    if (arg === '--probe-auth') {
      options.probeAuth = true;
      continue;
    }
    if (arg === '--probe-secrets') {
      options.probeSecrets = true;
      continue;
    }
    if (arg === '--account-environment') {
      options.accountEnvironment = requireValue(args, ++index, '--account-environment');
      continue;
    }
    if (arg.startsWith('--account-environment=')) {
      options.accountEnvironment = requireInlineValue(arg, '--account-environment');
      continue;
    }
    if (arg === '--unsafe-reveal-secrets') {
      options.unsafeRevealSecrets = true;
      continue;
    }
    if (arg === '--latest') {
      options.latestRun = true;
      continue;
    }
    if (arg === '--run') {
      options.runId = requireValue(args, ++index, '--run');
      continue;
    }
    if (arg.startsWith('--run=')) {
      options.runId = arg.slice('--run='.length);
      continue;
    }
    if (arg === '--limit') {
      options.limit = parsePositiveInteger(requireValue(args, ++index, '--limit'), '--limit');
      continue;
    }
    if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(arg.slice('--limit='.length), '--limit');
      continue;
    }
    if (arg === '--expect-plan') {
      options.expectPlan = requireValue(args, ++index, '--expect-plan');
      continue;
    }
    if (arg.startsWith('--expect-plan=')) {
      options.expectPlan = arg.slice('--expect-plan='.length);
      continue;
    }
    if (arg === '--require-review') {
      options.requireReviewFile = requireValue(args, ++index, '--require-review');
      continue;
    }
    if (arg.startsWith('--require-review=')) {
      options.requireReviewFile = requireInlineValue(arg, '--require-review');
      continue;
    }
    if (arg === '--require-diff') {
      options.requireDiffFile = requireValue(args, ++index, '--require-diff');
      continue;
    }
    if (arg.startsWith('--require-diff=')) {
      options.requireDiffFile = requireInlineValue(arg, '--require-diff');
      continue;
    }
    if (arg === '--out') {
      options.outFile = requireValue(args, ++index, '--out');
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.outFile = requireInlineValue(arg, '--out');
      continue;
    }
    if (arg === '--name') {
      options.name = requireValue(args, ++index, '--name');
      continue;
    }
    if (arg === '--id') {
      options.projectId = requireValue(args, ++index, '--id');
      continue;
    }
    if (arg.startsWith('--id=')) {
      options.projectId = requireInlineValue(arg, '--id');
      continue;
    }
    if (arg === '--home') {
      options.home = requireValue(args, ++index, '--home');
      continue;
    }
    if (arg === '--graph') {
      options.graphId = requireValue(args, ++index, '--graph');
      continue;
    }
    if (arg === '--adapter-plan') {
      options.adapterPlanId = requireValue(args, ++index, '--adapter-plan');
      continue;
    }
    if (arg.startsWith('--adapter-plan=')) {
      options.adapterPlanId = requireInlineValue(arg, '--adapter-plan');
      continue;
    }
    if (arg === '--actions-file') {
      options.actionsFile = requireValue(args, ++index, '--actions-file');
      continue;
    }
    if (arg === '--patch-file') {
      options.patchFile = requireValue(args, ++index, '--patch-file');
      continue;
    }
    if (arg.startsWith('--patch-file=')) {
      options.patchFile = requireInlineValue(arg, '--patch-file');
      continue;
    }
    if (arg === '--patch-reason') {
      options.patchReason = requireValue(args, ++index, '--patch-reason');
      continue;
    }
    if (arg.startsWith('--patch-reason=')) {
      options.patchReason = requireInlineValue(arg, '--patch-reason');
      continue;
    }
    if (arg === '--settings-file') {
      options.settingsFile = requireValue(args, ++index, '--settings-file');
      continue;
    }
    if (arg.startsWith('--settings-file=')) {
      options.settingsFile = requireInlineValue(arg, '--settings-file');
      continue;
    }
    if (arg === '--migration-spec') {
      options.migrationSpecFile = requireValue(args, ++index, '--migration-spec');
      continue;
    }
    if (arg.startsWith('--migration-spec=')) {
      options.migrationSpecFile = requireInlineValue(arg, '--migration-spec');
      continue;
    }
    if (arg === '--verification-spec') {
      options.verificationSpecFile = requireValue(args, ++index, '--verification-spec');
      continue;
    }
    if (arg.startsWith('--verification-spec=')) {
      options.verificationSpecFile = requireInlineValue(arg, '--verification-spec');
      continue;
    }
    if (arg === '--verification-plan') {
      options.verificationPlanId = requireValue(args, ++index, '--verification-plan');
      continue;
    }
    if (arg === '--provisioning-connection') {
      options.provisioningConnectionId = requireValue(args, ++index, '--provisioning-connection');
      continue;
    }
    if (arg.startsWith('--provisioning-connection=')) {
      options.provisioningConnectionId = requireInlineValue(arg, '--provisioning-connection');
      continue;
    }
    if (arg === '--sending-connection') {
      options.sendingConnectionId = requireValue(args, ++index, '--sending-connection');
      continue;
    }
    if (arg.startsWith('--sending-connection=')) {
      options.sendingConnectionId = requireInlineValue(arg, '--sending-connection');
      continue;
    }
    if (arg === '--from-local-part') {
      options.fromLocalPart = requireValue(args, ++index, '--from-local-part');
      continue;
    }
    if (arg.startsWith('--from-local-part=')) {
      options.fromLocalPart = requireInlineValue(arg, '--from-local-part');
      continue;
    }
    if (arg === '--email-delivery-approval') {
      options.emailDeliveryApprovalId = requireValue(args, ++index, '--email-delivery-approval');
      continue;
    }
    if (arg === '--email-delivery-plan') {
      options.emailDeliveryPlanId = requireValue(args, ++index, '--email-delivery-plan');
      continue;
    }
    if (arg.startsWith('--email-delivery-plan=')) {
      options.emailDeliveryPlanId = requireInlineValue(arg, '--email-delivery-plan');
      continue;
    }
    if (arg.startsWith('--email-delivery-approval=')) {
      options.emailDeliveryApprovalId = requireInlineValue(arg, '--email-delivery-approval');
      continue;
    }
    if (arg === '--email-delivery-run') {
      options.emailDeliveryRunId = requireValue(args, ++index, '--email-delivery-run');
      continue;
    }
    if (arg.startsWith('--email-delivery-run=')) {
      options.emailDeliveryRunId = requireInlineValue(arg, '--email-delivery-run');
      continue;
    }
    if (arg.startsWith('--verification-plan=')) {
      options.verificationPlanId = requireInlineValue(arg, '--verification-plan');
      continue;
    }
    if (arg === '--phase') {
      options.verificationPhase = requireValue(args, ++index, '--phase');
      continue;
    }
    if (arg === '--steps') {
      options.rollbackStepIds = requireValue(args, ++index, '--steps');
      continue;
    }
    if (arg.startsWith('--steps=')) {
      options.rollbackStepIds = requireInlineValue(arg, '--steps');
      continue;
    }
    if (arg.startsWith('--phase=')) {
      options.verificationPhase = requireInlineValue(arg, '--phase');
      continue;
    }
    if (arg === '--migration-plan') {
      options.migrationPlanId = requireValue(args, ++index, '--migration-plan');
      continue;
    }
    if (arg.startsWith('--migration-plan=')) {
      options.migrationPlanId = requireInlineValue(arg, '--migration-plan');
      continue;
    }
    if (arg === '--backup-evidence') {
      options.backupEvidenceId = requireValue(args, ++index, '--backup-evidence');
      continue;
    }
    if (arg.startsWith('--backup-evidence=')) {
      options.backupEvidenceId = requireInlineValue(arg, '--backup-evidence');
      continue;
    }
    if (arg === '--preflight') {
      options.sandboxPreflightId = requireValue(args, ++index, '--preflight');
      continue;
    }
    if (arg === '--sandbox-profile') {
      options.sandboxProfileId = requireValue(args, ++index, '--sandbox-profile');
      continue;
    }
    if (arg.startsWith('--sandbox-profile=')) {
      options.sandboxProfileId = requireInlineValue(arg, '--sandbox-profile');
      continue;
    }
    if (arg === '--approval') {
      options.approvalId = requireValue(args, ++index, '--approval');
      continue;
    }
    if (arg.startsWith('--approval=')) {
      options.approvalId = requireInlineValue(arg, '--approval');
      continue;
    }
    if (arg === '--database-runtime-profile') {
      options.databaseRuntimeProfileId = requireValue(args, ++index, '--database-runtime-profile');
      continue;
    }
    if (arg.startsWith('--database-runtime-profile=')) {
      options.databaseRuntimeProfileId = requireInlineValue(arg, '--database-runtime-profile');
      continue;
    }
    if (arg === '--database-host') {
      options.databaseHosts.push(requireValue(args, ++index, '--database-host'));
      continue;
    }
    if (arg === '--acceptance-run') {
      options.acceptanceRunIds.push(requireValue(args, ++index, '--acceptance-run'));
      continue;
    }
    if (arg.startsWith('--acceptance-run=')) {
      options.acceptanceRunIds.push(requireInlineValue(arg, '--acceptance-run'));
      continue;
    }
    if (arg === '--acceptance-provider') {
      options.acceptanceProviders.push(requireValue(args, ++index, '--acceptance-provider'));
      continue;
    }
    if (arg.startsWith('--acceptance-provider=')) {
      options.acceptanceProviders.push(requireInlineValue(arg, '--acceptance-provider'));
      continue;
    }
    if (arg === '--acceptance-suite') {
      options.acceptanceSuiteId = requireValue(args, ++index, '--acceptance-suite');
      continue;
    }
    if (arg.startsWith('--acceptance-suite=')) {
      options.acceptanceSuiteId = requireInlineValue(arg, '--acceptance-suite');
      continue;
    }
    if (arg === '--acceptance-suite-ref') {
      options.acceptanceSuiteRefs.push(requireValue(args, ++index, '--acceptance-suite-ref'));
      continue;
    }
    if (arg.startsWith('--acceptance-suite-ref=')) {
      options.acceptanceSuiteRefs.push(requireInlineValue(arg, '--acceptance-suite-ref'));
      continue;
    }
    if (arg === '--cleanup-owner') {
      options.cleanupOwner = requireValue(args, ++index, '--cleanup-owner');
      continue;
    }
    if (arg.startsWith('--cleanup-owner=')) {
      options.cleanupOwner = requireInlineValue(arg, '--cleanup-owner');
      continue;
    }
    if (arg === '--cleanup-deadline') {
      options.cleanupDeadline = requireValue(args, ++index, '--cleanup-deadline');
      continue;
    }
    if (arg.startsWith('--cleanup-deadline=')) {
      options.cleanupDeadline = requireInlineValue(arg, '--cleanup-deadline');
      continue;
    }
    if (arg === '--cleanup-spec') {
      options.cleanupSpecFile = requireValue(args, ++index, '--cleanup-spec');
      continue;
    }
    if (arg.startsWith('--cleanup-spec=')) {
      options.cleanupSpecFile = requireInlineValue(arg, '--cleanup-spec');
      continue;
    }
    if (arg.startsWith('--database-host=')) {
      options.databaseHosts.push(requireInlineValue(arg, '--database-host'));
      continue;
    }
    if (arg.startsWith('--preflight=')) {
      options.sandboxPreflightId = requireInlineValue(arg, '--preflight');
      continue;
    }
    if (arg === '--launch-config') {
      options.launchConfigurationId = requireValue(args, ++index, '--launch-config');
      continue;
    }
    if (arg === '--rollback-approval') {
      options.rollbackApprovalId = requireValue(args, ++index, '--rollback-approval');
      continue;
    }
    if (arg.startsWith('--rollback-approval=')) {
      options.rollbackApprovalId = requireInlineValue(arg, '--rollback-approval');
      continue;
    }
    if (arg === '--rollback-plan') {
      options.rollbackPlanId = requireValue(args, ++index, '--rollback-plan');
      continue;
    }
    if (arg.startsWith('--rollback-plan=')) {
      options.rollbackPlanId = requireInlineValue(arg, '--rollback-plan');
      continue;
    }
    if (arg === '--dns-change-set') {
      options.dnsChangeSetId = requireValue(args, ++index, '--dns-change-set');
      continue;
    }
    if (arg.startsWith('--dns-change-set=')) {
      options.dnsChangeSetId = requireInlineValue(arg, '--dns-change-set');
      continue;
    }
    if (arg.startsWith('--launch-config=')) {
      options.launchConfigurationId = requireInlineValue(arg, '--launch-config');
      continue;
    }
    if (arg.startsWith('--actions-file=')) {
      options.actionsFile = requireInlineValue(arg, '--actions-file');
      continue;
    }
    if (arg === '--resource-prefix') {
      options.resourcePrefix = requireValue(args, ++index, '--resource-prefix');
      continue;
    }
    if (arg.startsWith('--resource-prefix=')) {
      options.resourcePrefix = requireInlineValue(arg, '--resource-prefix');
      continue;
    }
    if (arg === '--allowed-domain') {
      options.allowedDomains.push(requireValue(args, ++index, '--allowed-domain'));
      continue;
    }
    if (arg === '--protected-domain') {
      options.protectedDomains.push(requireValue(args, ++index, '--protected-domain'));
      continue;
    }
    if (arg.startsWith('--allowed-domain=')) {
      options.allowedDomains.push(requireInlineValue(arg, '--allowed-domain'));
      continue;
    }
    if (arg.startsWith('--protected-domain=')) {
      options.protectedDomains.push(requireInlineValue(arg, '--protected-domain'));
      continue;
    }
    if (arg === '--max-provider-mutations') {
      options.maxProviderMutations = parsePositiveInteger(
        requireValue(args, ++index, '--max-provider-mutations'), '--max-provider-mutations'
      );
      continue;
    }
    if (arg.startsWith('--max-provider-mutations=')) {
      options.maxProviderMutations = parsePositiveInteger(
        requireInlineValue(arg, '--max-provider-mutations'), '--max-provider-mutations'
      );
      continue;
    }
    if (arg.startsWith('--graph=')) {
      options.graphId = requireInlineValue(arg, '--graph');
      continue;
    }
    if (arg === '--nodes') {
      options.nodeIds = requireValue(args, ++index, '--nodes');
      continue;
    }
    if (arg.startsWith('--nodes=')) {
      options.nodeIds = requireInlineValue(arg, '--nodes');
      continue;
    }
    if (arg === '--expires-at') {
      options.expiresAt = requireValue(args, ++index, '--expires-at');
      continue;
    }
    if (arg.startsWith('--expires-at=')) {
      options.expiresAt = requireInlineValue(arg, '--expires-at');
      continue;
    }
    if (arg === '--approved-by') {
      options.approvedBy = requireValue(args, ++index, '--approved-by');
      continue;
    }
    if (arg === '--secret-ref') {
      options.secretRefs.push(requireValue(args, ++index, '--secret-ref'));
      continue;
    }
    if (arg.startsWith('--secret-ref=')) {
      options.secretRefs.push(requireInlineValue(arg, '--secret-ref'));
      continue;
    }
    if (arg === '--from-project') {
      options.connectionSourceProjectId = requireValue(args, ++index, '--from-project');
      continue;
    }
    if (arg.startsWith('--from-project=')) {
      options.connectionSourceProjectId = requireInlineValue(arg, '--from-project');
      continue;
    }
    if (arg === '--from-connection') {
      options.connectionSourceId = requireValue(args, ++index, '--from-connection');
      continue;
    }
    if (arg.startsWith('--from-connection=')) {
      options.connectionSourceId = requireInlineValue(arg, '--from-connection');
      continue;
    }
    if (arg === '--scope') {
      options.connectionScope = requireValue(args, ++index, '--scope');
      continue;
    }
    if (arg.startsWith('--scope=')) {
      options.connectionScope = requireInlineValue(arg, '--scope');
      continue;
    }
    if (arg === '--expected-version') {
      options.expectedVersion = parsePositiveInteger(requireValue(args, ++index, '--expected-version'), '--expected-version');
      continue;
    }
    if (arg === '--recipe') {
      options.recipeId = requireValue(args, ++index, '--recipe');
      continue;
    }
    if (arg.startsWith('--recipe=')) {
      options.recipeId = requireInlineValue(arg, '--recipe');
      continue;
    }
    if (arg === '--secret-backend') {
      options.secretBackend = requireValue(args, ++index, '--secret-backend');
      continue;
    }
    if (arg.startsWith('--secret-backend=')) {
      options.secretBackend = requireInlineValue(arg, '--secret-backend');
      continue;
    }
    if (arg === '--bootstrap-plan') {
      options.bootstrapPlanId = requireValue(args, ++index, '--bootstrap-plan');
      continue;
    }
    if (arg === '--owner') {
      options.sessionOwner = requireValue(args, ++index, '--owner');
      continue;
    }
    if (arg.startsWith('--owner=')) {
      options.sessionOwner = requireInlineValue(arg, '--owner');
      continue;
    }
    if (arg === '--deadline') {
      options.sessionDeadline = requireValue(args, ++index, '--deadline');
      continue;
    }
    if (arg.startsWith('--deadline=')) {
      options.sessionDeadline = requireInlineValue(arg, '--deadline');
      continue;
    }
    if (arg.startsWith('--bootstrap-plan=')) {
      options.bootstrapPlanId = requireInlineValue(arg, '--bootstrap-plan');
      continue;
    }
    if (arg === '--handoff-phase') {
      options.handoffPhase = requireValue(args, ++index, '--handoff-phase');
      continue;
    }
    if (arg.startsWith('--handoff-phase=')) {
      options.handoffPhase = requireInlineValue(arg, '--handoff-phase');
      continue;
    }
    if (arg === '--handoff-owner') {
      options.handoffOwner = requireValue(args, ++index, '--handoff-owner');
      continue;
    }
    if (arg.startsWith('--handoff-owner=')) {
      options.handoffOwner = requireInlineValue(arg, '--handoff-owner');
      continue;
    }
    if (arg === '--handoff-deadline') {
      options.handoffDeadline = requireValue(args, ++index, '--handoff-deadline');
      continue;
    }
    if (arg.startsWith('--handoff-deadline=')) {
      options.handoffDeadline = requireInlineValue(arg, '--handoff-deadline');
      continue;
    }
    if (arg === '--handoff-spec') {
      options.handoffSpecFile = requireValue(args, ++index, '--handoff-spec');
      continue;
    }
    if (arg === '--candidate-evidence') {
      options.candidateEvidenceId = requireValue(args, ++index, '--candidate-evidence');
      continue;
    }
    if (arg.startsWith('--candidate-evidence=')) {
      options.candidateEvidenceId = requireInlineValue(arg, '--candidate-evidence');
      continue;
    }
    if (arg === '--cutover-handoff') {
      options.cutoverHandoffId = requireValue(args, ++index, '--cutover-handoff');
      continue;
    }
    if (arg.startsWith('--cutover-handoff=')) {
      options.cutoverHandoffId = requireInlineValue(arg, '--cutover-handoff');
      continue;
    }
    if (arg === '--cutover-attestation') {
      options.cutoverAttestationId = requireValue(args, ++index, '--cutover-attestation');
      continue;
    }
    if (arg.startsWith('--cutover-attestation=')) {
      options.cutoverAttestationId = requireInlineValue(arg, '--cutover-attestation');
      continue;
    }
    if (arg === '--production-evidence') {
      options.productionEvidenceId = requireValue(args, ++index, '--production-evidence');
      continue;
    }
    if (arg.startsWith('--production-evidence=')) {
      options.productionEvidenceId = requireInlineValue(arg, '--production-evidence');
      continue;
    }
    if (arg.startsWith('--handoff-spec=')) {
      options.handoffSpecFile = requireInlineValue(arg, '--handoff-spec');
      continue;
    }
    if (arg.startsWith('--expected-version=')) {
      options.expectedVersion = parsePositiveInteger(requireInlineValue(arg, '--expected-version'), '--expected-version');
      continue;
    }
    if (arg.startsWith('--approved-by=')) {
      options.approvedBy = requireInlineValue(arg, '--approved-by');
      continue;
    }
    if (arg.startsWith('--home=')) {
      options.home = requireInlineValue(arg, '--home');
      continue;
    }
    if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length);
      continue;
    }
    if (arg === '--target') {
      options.target = requireValue(args, ++index, '--target');
      options.targetExplicit = true;
      continue;
    }
    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length);
      options.targetExplicit = true;
      continue;
    }
    if (arg === '--provider') {
      options.provider = requireValue(args, ++index, '--provider');
      options.providerExplicit = true;
      continue;
    }
    if (arg === '--provider-mode') {
      options.providerMode = requireValue(args, ++index, '--provider-mode');
      continue;
    }
    if (arg.startsWith('--provider-mode=')) {
      options.providerMode = requireInlineValue(arg, '--provider-mode');
      continue;
    }
    if (arg.startsWith('--provider=')) {
      options.provider = arg.slice('--provider='.length);
      options.providerExplicit = true;
      continue;
    }
    if (arg === '--preset') {
      options.preset = requireValue(args, ++index, '--preset');
      continue;
    }
    if (arg.startsWith('--preset=')) {
      options.preset = arg.slice('--preset='.length);
      continue;
    }
    if (arg === '--repo') {
      options.repo = requireValue(args, ++index, '--repo');
      continue;
    }
    if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length);
      continue;
    }
    if (arg === '--domain') {
      options.domain = requireValue(args, ++index, '--domain');
      continue;
    }
    if (arg.startsWith('--domain=')) {
      options.domain = arg.slice('--domain='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (command === 'help') {
      if (options.helpCommand) {
        throw new Error('help accepts at most one command.');
      }
      if (!COMMANDS.has(arg)) {
        throw new Error(`Unknown command: ${arg}`);
      }
      options.helpCommand = arg;
      continue;
    }

    if (command === 'project') {
      if (!options.projectAction) {
        if (!PROJECT_ACTIONS.has(arg)) {
          throw new Error(`Unknown project action: ${arg}`);
        }
        options.projectAction = arg;
        continue;
      }
      if (options.projectId) {
        throw new Error(`project ${options.projectAction} accepts at most one project id.`);
      }
      options.projectId = arg;
      continue;
    }

    if (command === 'analyze') {
      if (options.projectId) {
        throw new Error('analyze accepts exactly one project id.');
      }
      options.projectId = arg;
      continue;
    }

    if (command === 'artifact') {
      if (!options.artifactAction) {
        if (!ARTIFACT_ACTIONS.has(arg)) {
          throw new Error(`Unknown artifact action: ${arg}`);
        }
        options.artifactAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.artifactId) {
        throw new Error(`artifact ${options.artifactAction} accepts at most one artifact id.`);
      }
      options.artifactId = arg;
      continue;
    }

    if (command === 'import') {
      if (options.importAction) {
        throw new Error(`import ${options.importAction} does not accept positional arguments.`);
      }
      if (!IMPORT_ACTIONS.has(arg)) {
        throw new Error(`Unknown import action: ${arg}`);
      }
      options.importAction = arg;
      continue;
    }

    if (command === 'launch') {
      if (!options.launchAction) {
        if (!LAUNCH_ACTIONS.has(arg)) throw new Error(`Unknown launch action: ${arg}`);
        options.launchAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.launchAction === 'resume') {
        if (options.runId) throw new Error('launch resume accepts exactly one run id.');
        options.runId = arg;
        continue;
      }
      if (options.graphId) throw new Error(`launch ${options.launchAction} accepts at most one graph id.`);
      options.graphId = arg;
      continue;
    }

    if (command === 'approval') {
      if (!options.approvalAction) {
        if (!APPROVAL_ACTIONS.has(arg)) throw new Error(`Unknown approval action: ${arg}`);
        options.approvalAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.approvalId) throw new Error(`approval ${options.approvalAction} accepts at most one approval id.`);
      options.approvalId = arg;
      continue;
    }

    if (command === 'provider') {
      if (!options.providerAction) {
        if (!PROVIDER_ACTIONS.has(arg)) throw new Error(`Unknown provider action: ${arg}`);
        options.providerAction = arg;
        continue;
      }
      if (options.providerCatalogId) throw new Error(`provider ${options.providerAction} accepts at most one provider id.`);
      options.providerCatalogId = arg;
      continue;
    }

    if (command === 'secret') {
      if (!options.secretAction) {
        if (!SECRET_ACTIONS.has(arg)) throw new Error(`Unknown secret action: ${arg}`);
        options.secretAction = arg;
        continue;
      }
      if (options.secretRef) throw new Error(`secret ${options.secretAction} accepts exactly one Secret Ref.`);
      options.secretRef = arg;
      continue;
    }

    if (command === 'connection') {
      if (!options.connectionAction) {
        if (!CONNECTION_ACTIONS.has(arg)) throw new Error(`Unknown connection action: ${arg}`);
        options.connectionAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.connectionId) throw new Error(`connection ${options.connectionAction} accepts at most one connection id.`);
      options.connectionId = arg;
      continue;
    }

    if (command === 'recipe') {
      if (!options.recipeAction) {
        if (!RECIPE_ACTIONS.has(arg)) throw new Error(`Unknown recipe action: ${arg}`);
        options.recipeAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.recipeId) throw new Error(`recipe ${options.recipeAction} accepts at most one recipe id.`);
      options.recipeId = arg;
      continue;
    }

    if (command === 'bootstrap-plan') {
      if (!options.bootstrapPlanAction) {
        if (!BOOTSTRAP_PLAN_ACTIONS.has(arg)) throw new Error(`Unknown bootstrap-plan action: ${arg}`);
        options.bootstrapPlanAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.bootstrapPlanId) throw new Error(`bootstrap-plan ${options.bootstrapPlanAction} accepts at most one plan id.`);
      options.bootstrapPlanId = arg;
      continue;
    }

    if (command === 'first-launch') {
      if (!options.firstLaunchAction) {
        if (!FIRST_LAUNCH_ACTIONS.has(arg)) throw new Error(`Unknown first-launch action: ${arg}`);
        options.firstLaunchAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.sessionId) throw new Error(`first-launch ${options.firstLaunchAction} accepts at most one session id.`);
      options.sessionId = arg;
      continue;
    }

    if (command === 'human-handoff') {
      if (!options.humanHandoffAction) {
        if (!HUMAN_HANDOFF_ACTIONS.has(arg)) throw new Error(`Unknown human-handoff action: ${arg}`);
        options.humanHandoffAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (!options.handoffId) {
        options.handoffId = arg;
        continue;
      }
      if (options.humanHandoffAction === 'show' && !options.handoffAttestationId) {
        options.handoffAttestationId = arg;
        continue;
      }
      throw new Error(`human-handoff ${options.humanHandoffAction} accepts no additional positional arguments.`);
    }

    if (command === 'manifest') {
      if (!options.manifestAction) {
        if (!MANIFEST_ACTIONS.has(arg)) throw new Error(`Unknown manifest action: ${arg}`);
        options.manifestAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.recipeId) throw new Error(`manifest ${options.manifestAction} accepts at most one recipe id.`);
      options.recipeId = arg;
      continue;
    }

    if (command === 'launch-config') {
      if (!options.launchConfigAction) {
        if (!LAUNCH_CONFIG_ACTIONS.has(arg)) throw new Error(`Unknown launch-config action: ${arg}`);
        options.launchConfigAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.launchConfigurationId) throw new Error(`launch-config ${options.launchConfigAction} accepts at most one configuration id.`);
      options.launchConfigurationId = arg;
      continue;
    }

    if (command === 'dns-change') {
      if (!options.dnsChangeAction) {
        if (!DNS_CHANGE_ACTIONS.has(arg)) throw new Error(`Unknown dns-change action: ${arg}`);
        options.dnsChangeAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.dnsChangeSetId) throw new Error(`dns-change ${options.dnsChangeAction} accepts at most one change set id.`);
      options.dnsChangeSetId = arg;
      continue;
    }

    if (command === 'candidate') {
      if (!options.candidateAction) {
        if (!CANDIDATE_ACTIONS.has(arg)) throw new Error(`Unknown candidate action: ${arg}`);
        options.candidateAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      throw new Error(`candidate ${options.candidateAction} accepts only one project id.`);
    }

    if (command === 'verification') {
      if (!options.verificationAction) {
        if (!VERIFICATION_ACTIONS.has(arg)) throw new Error(`Unknown verification action: ${arg}`);
        options.verificationAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.verificationPlanId) throw new Error(`verification ${options.verificationAction} accepts at most one plan id.`);
      options.verificationPlanId = arg;
      continue;
    }

    if (command === 'email-delivery') {
      if (!options.emailDeliveryAction) {
        if (!EMAIL_DELIVERY_ACTIONS.has(arg)) throw new Error(`Unknown email-delivery action: ${arg}`);
        options.emailDeliveryAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (['show', 'approve', 'apply'].includes(options.emailDeliveryAction)) {
        if (options.emailDeliveryPlanId) throw new Error(`email-delivery ${options.emailDeliveryAction} accepts one plan id.`);
        options.emailDeliveryPlanId = arg;
        continue;
      }
      if (['approval', 'revoke'].includes(options.emailDeliveryAction)) {
        if (options.emailDeliveryApprovalId) throw new Error(`email-delivery ${options.emailDeliveryAction} accepts one approval id.`);
        options.emailDeliveryApprovalId = arg;
        continue;
      }
      if (['resume', 'run'].includes(options.emailDeliveryAction)) {
        if (options.emailDeliveryRunId) throw new Error(`email-delivery ${options.emailDeliveryAction} accepts one run id.`);
        options.emailDeliveryRunId = arg;
        continue;
      }
      throw new Error(`email-delivery ${options.emailDeliveryAction} accepts no additional positional arguments.`);
    }

    if (command === 'rollback') {
      if (!options.rollbackAction) {
        if (!ROLLBACK_ACTIONS.has(arg)) throw new Error(`Unknown rollback action: ${arg}`);
        options.rollbackAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (['approval', 'revoke'].includes(options.rollbackAction)) {
        if (options.rollbackApprovalId) throw new Error(`rollback ${options.rollbackAction} accepts at most one approval id.`);
        options.rollbackApprovalId = arg;
        continue;
      }
      if (options.rollbackAction === 'resume') {
        if (options.runId) throw new Error('rollback resume accepts exactly one run id.');
        options.runId = arg;
        continue;
      }
      if (options.rollbackPlanId) throw new Error(`rollback ${options.rollbackAction} accepts at most one plan id.`);
      options.rollbackPlanId = arg;
      continue;
    }

    if (command === 'migration-plan') {
      if (!options.migrationPlanAction) {
        if (!MIGRATION_PLAN_ACTIONS.has(arg)) throw new Error(`Unknown migration-plan action: ${arg}`);
        options.migrationPlanAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.migrationPlanId) throw new Error(`migration-plan ${options.migrationPlanAction} accepts at most one plan id.`);
      options.migrationPlanId = arg;
      continue;
    }

    if (command === 'backup-evidence') {
      if (!options.backupEvidenceAction) {
        if (!BACKUP_EVIDENCE_ACTIONS.has(arg)) throw new Error(`Unknown backup-evidence action: ${arg}`);
        options.backupEvidenceAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.backupEvidenceId) throw new Error(`backup-evidence ${options.backupEvidenceAction} accepts at most one evidence id.`);
      options.backupEvidenceId = arg;
      continue;
    }

    if (command === 'database-runtime') {
      if (!options.databaseRuntimeAction) {
        if (!DATABASE_RUNTIME_ACTIONS.has(arg)) throw new Error(`Unknown database-runtime action: ${arg}`);
        options.databaseRuntimeAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.databaseRuntimeProfileId) {
        throw new Error(`database-runtime ${options.databaseRuntimeAction} accepts at most one profile id.`);
      }
      options.databaseRuntimeProfileId = arg;
      continue;
    }

    if (command === 'acceptance-suite') {
      if (!options.acceptanceSuiteAction) {
        if (!ACCEPTANCE_SUITE_ACTIONS.has(arg)) throw new Error(`Unknown acceptance-suite action: ${arg}`);
        options.acceptanceSuiteAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.acceptanceSuiteId) {
        throw new Error(`acceptance-suite ${options.acceptanceSuiteAction} accepts at most one suite id.`);
      }
      options.acceptanceSuiteId = arg;
      continue;
    }

    if (command === 'acceptance-portfolio') {
      if (!options.acceptancePortfolioAction) {
        if (!ACCEPTANCE_PORTFOLIO_ACTIONS.has(arg)) {
          throw new Error(`Unknown acceptance-portfolio action: ${arg}`);
        }
        options.acceptancePortfolioAction = arg;
        continue;
      }
      if (options.acceptancePortfolioId) {
        throw new Error(`acceptance-portfolio ${options.acceptancePortfolioAction} accepts at most one portfolio id.`);
      }
      options.acceptancePortfolioId = arg;
      continue;
    }

    if (command === 'acceptance-cleanup') {
      if (!options.acceptanceCleanupAction) {
        if (!ACCEPTANCE_CLEANUP_ACTIONS.has(arg)) throw new Error(`Unknown acceptance-cleanup action: ${arg}`);
        options.acceptanceCleanupAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (!options.cleanupPlanId) {
        options.cleanupPlanId = arg;
        continue;
      }
      if (options.acceptanceCleanupAction === 'show' && !options.cleanupAttestationId) {
        options.cleanupAttestationId = arg;
        continue;
      }
      throw new Error(`acceptance-cleanup ${options.acceptanceCleanupAction} accepts no additional positional arguments.`);
    }

    if (command === 'adapter-plan') {
      if (!options.adapterPlanAction) {
        if (!ADAPTER_PLAN_ACTIONS.has(arg)) throw new Error(`Unknown adapter-plan action: ${arg}`);
        options.adapterPlanAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.adapterPlanId) throw new Error(`adapter-plan ${options.adapterPlanAction} accepts at most one plan id.`);
      options.adapterPlanId = arg;
      continue;
    }

    if (command === 'source-patch') {
      if (!options.sourcePatchAction) {
        if (!SOURCE_PATCH_ACTIONS.has(arg)) throw new Error(`Unknown source-patch action: ${arg}`);
        options.sourcePatchAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.sourcePatchId) {
        throw new Error(`source-patch ${options.sourcePatchAction} accepts at most one proposal id.`);
      }
      options.sourcePatchId = arg;
      continue;
    }

    if (command === 'sandbox') {
      if (!options.sandboxAction) {
        if (!SANDBOX_ACTIONS.has(arg)) throw new Error(`Unknown sandbox action: ${arg}`);
        options.sandboxAction = arg;
        continue;
      }
      if (!options.projectId) {
        options.projectId = arg;
        continue;
      }
      if (options.sandboxProfileId) throw new Error(`sandbox ${options.sandboxAction} accepts at most one profile id.`);
      options.sandboxProfileId = arg;
      continue;
    }

    options.root = path.resolve(process.cwd(), arg);
  }

  if (!V2_COMMANDS.has(options.command)) {
    options.root = path.resolve(options.root);
  }
  if (options.help) {
    return options;
  }

  validateCrossCommandOptions(options);
  validateV2Options(options);

  validateProviderOptions(options);
  validateSecretOptions(options);

  if (options.execute && !options.yes) {
    throw new Error('Real execution requires --execute --yes. Omit --execute for the default dry run.');
  }
  if (options.outFile && !['diff', 'handoff', 'review'].includes(options.command)) {
    throw new Error('--out is only supported by diff, handoff, and review.');
  }
  if (options.requireReviewFile && options.command !== 'apply') {
    throw new Error('--require-review is only supported by apply.');
  }
  if (options.requireDiffFile && options.command !== 'apply') {
    throw new Error('--require-diff is only supported by apply.');
  }
  if ((options.latestRun || options.runId) && options.command !== 'runs' &&
      !(options.command === 'launch' && options.launchAction === 'resume') &&
      !(options.command === 'sandbox' && options.sandboxAction === 'resume') &&
      !(options.command === 'sandbox' && options.sandboxAction === 'report') &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume') &&
      !(options.command === 'rollback' && options.rollbackAction === 'resume')) {
    throw new Error('--latest and --run are only supported by runs or explicit resume/report workflows.');
  }
  if (options.limit !== 10 && options.command !== 'runs') {
    throw new Error('--limit is only supported by runs.');
  }
  if (options.latestRun && options.runId) {
    throw new Error('Use either --latest or --run, not both.');
  }

  return options;
}

function validateCrossCommandOptions(options) {
  const isRealProviderLaunch = options.command === 'launch' &&
    ['apply', 'resume'].includes(options.launchAction) && options.providerMode === 'real';
  if (
    options.command !== 'connection' &&
    (options.secretRefs.length > 0 || options.connectionScope || options.expectedVersion ||
      options.connectionSourceProjectId || options.connectionSourceId)
  ) {
    throw new Error('--secret-ref, --scope, --expected-version, --from-project, and --from-connection are only supported by connection commands.');
  }
  if (!['recipe', 'bootstrap-plan', 'manifest'].includes(options.command) && options.recipeId) {
    throw new Error('--recipe and recipe ids are only supported by recipe/bootstrap-plan/manifest commands.');
  }
  if (options.secretBackend && !['bootstrap-plan', 'first-launch'].includes(options.command)) {
    throw new Error('--secret-backend is only supported by bootstrap-plan create or first-launch start.');
  }
  if (options.secretBackend && !['env', 'keychain'].includes(options.secretBackend)) {
    throw new Error('--secret-backend must be env or keychain.');
  }
  if ((options.bootstrapPlanAction || options.bootstrapPlanId) && !['bootstrap-plan', 'human-handoff'].includes(options.command)) {
    throw new Error('Provider Bootstrap Plan options and ids are only supported by bootstrap-plan/human-handoff.');
  }
  if ((options.firstLaunchAction || options.sessionId || options.sessionOwner || options.sessionDeadline) && options.command !== 'first-launch') {
    throw new Error('First Launch Session options and ids are only supported by first-launch.');
  }
  if ((options.cutoverHandoffId || options.cutoverAttestationId || options.productionEvidenceId) &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume')) {
    throw new Error('Cutover Handoff, Attestation, and Production Evidence ids are only supported by first-launch resume.');
  }
  if ((options.humanHandoffAction || options.handoffId || options.handoffAttestationId || options.handoffPhase ||
       options.handoffOwner || options.handoffDeadline || options.handoffSpecFile ||
       (options.candidateEvidenceId && !(options.command === 'first-launch' && options.firstLaunchAction === 'resume'))) &&
      options.command !== 'human-handoff') {
    throw new Error('Human Handoff options and ids are only supported by human-handoff.');
  }
  if (!(options.command === 'artifact' && options.artifactAction === 'build') && options.artifactOutputDirs.length > 0) {
    throw new Error('--artifact-output is only supported by artifact build.');
  }
  if (!(options.command === 'launch' && ['apply', 'resume'].includes(options.launchAction)) && options.providerMode) {
    throw new Error('--provider-mode is only supported by launch apply/resume.');
  }
  if (options.providerMode && !['fixture', 'real'].includes(options.providerMode)) {
    throw new Error('--provider-mode must be fixture or real.');
  }
  if (options.command !== 'adapter-plan' && options.actionsFile) {
    throw new Error('--actions-file is only supported by adapter-plan create.');
  }
  if (options.command !== 'source-patch' && (options.patchFile || options.patchReason)) {
    throw new Error('--patch-file and --patch-reason are only supported by source-patch create.');
  }
  if (!(options.command === 'launch-config' ||
      (options.command === 'first-launch' && options.firstLaunchAction === 'resume')) && options.settingsFile) {
    throw new Error('--settings-file is only supported by launch-config create or first-launch resume.');
  }
  if (options.command !== 'migration-plan' && options.migrationSpecFile) {
    throw new Error('--migration-spec is only supported by migration-plan create.');
  }
  if (options.command !== 'verification' && (
    options.verificationSpecFile || options.verificationPhase ||
    (options.verificationPlanId &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume') &&
      options.command !== 'email-delivery')
  )) {
    throw new Error('--verification-spec, --verification-plan, --phase, and Verification Plan ids are only supported by verification commands.');
  }
  if (options.command !== 'email-delivery' &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume') &&
      (options.emailDeliveryPlanId || options.emailDeliveryApprovalId)) {
    throw new Error('Email Delivery Plan and Approval ids are only supported by email-delivery or first-launch resume.');
  }
  if (options.command !== 'email-delivery' &&
      (options.provisioningConnectionId || options.sendingConnectionId || options.fromLocalPart)) {
    throw new Error('Email Delivery Plan, Approval, and Connection options are only supported by email-delivery.');
  }
  if (options.emailDeliveryRunId &&
      options.command !== 'email-delivery' &&
      !(options.command === 'verification' && options.verificationAction === 'run') &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume')) {
    throw new Error('--email-delivery-run is only supported by email-delivery, verification run, or first-launch resume.');
  }
  if (options.command !== 'rollback' &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume') &&
      (options.rollbackPlanId || options.rollbackApprovalId)) {
    throw new Error('Rollback Plan and Approval ids are only supported by rollback commands or first-launch resume.');
  }
  if (options.command !== 'rollback' && options.rollbackStepIds) {
    throw new Error('--steps is only supported by rollback commands.');
  }
  if (!['migration-plan', 'adapter-plan', 'database-runtime'].includes(options.command) &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume') &&
      options.migrationPlanId) {
    throw new Error('--migration-plan and Database Migration Plan ids are only supported by migration-plan/adapter-plan commands.');
  }
  if (!['launch-config', 'dns-change', 'candidate', 'verification', 'email-delivery', 'rollback', 'migration-plan', 'adapter-plan', 'database-runtime'].includes(options.command) && options.launchConfigurationId) {
    throw new Error('--launch-config and Launch Configuration ids are only supported by launch-config/dns-change/candidate/verification/rollback/migration-plan/adapter-plan commands.');
  }
  if (!['dns-change', 'adapter-plan'].includes(options.command) && options.dnsChangeSetId) {
    throw new Error('--dns-change-set and DNS ChangeSet ids are only supported by dns-change/adapter-plan commands.');
  }
  if (options.acceptanceOnly && !(options.command === 'dns-change' && options.dnsChangeAction === 'create')) {
    throw new Error('--acceptance-only is only supported by dns-change create.');
  }
  if (!(options.command === 'candidate' ||
      (options.command === 'verification' && options.verificationAction === 'run') ||
      (options.command === 'email-delivery' && ['apply', 'resume'].includes(options.emailDeliveryAction))) && options.allowNetwork) {
    throw new Error('--allow-network is only supported by candidate verify, verification run, and email-delivery apply/resume.');
  }
  if (options.probeSecrets && !(options.command === 'sandbox' && options.sandboxAction === 'preflight')) {
    throw new Error('--probe-secrets is only supported by sandbox preflight.');
  }
  if (options.accountEnvironment && !(options.command === 'sandbox' && options.sandboxAction === 'create')) {
    throw new Error('--account-environment is only supported by sandbox create.');
  }
  if (options.accountEnvironment && options.accountEnvironment !== 'test') {
    throw new Error('--account-environment must be test.');
  }
  if (options.allowSandboxNetwork && !(options.command === 'sandbox' && ['apply', 'resume'].includes(options.sandboxAction))) {
    throw new Error('--allow-sandbox-network is only supported by sandbox apply/resume.');
  }
  if (options.allowProviderNetwork && !isRealProviderLaunch) {
    throw new Error('--allow-provider-network is only supported by launch apply/resume with --provider-mode real.');
  }
  if (options.allowRollbackNetwork && !(options.command === 'rollback' && ['apply', 'resume'].includes(options.rollbackAction))) {
    throw new Error('--allow-rollback-network is only supported by rollback apply/resume.');
  }
  if (options.allowDatabaseRestore && !(options.command === 'rollback' && ['apply', 'resume'].includes(options.rollbackAction))) {
    throw new Error('--allow-database-restore is only supported by rollback apply/resume.');
  }
  if (options.allowDatabaseMigration &&
      !(options.command === 'sandbox' && ['apply', 'resume'].includes(options.sandboxAction)) &&
      !isRealProviderLaunch) {
    throw new Error('--allow-database-migration is only supported by sandbox apply/resume or launch real-provider execution.');
  }
  if (options.sandboxPreflightId && !(
    (options.command === 'sandbox' && ['apply', 'resume'].includes(options.sandboxAction)) ||
    (options.command === 'first-launch' && options.firstLaunchAction === 'resume') ||
    isRealProviderLaunch
  )) {
    throw new Error('--preflight is only supported by sandbox apply/resume, launch real-provider execution, or first-launch resume.');
  }
  if (options.sandboxProfileId && !(
    options.command === 'sandbox' ||
    (options.command === 'first-launch' && options.firstLaunchAction === 'resume') ||
    isRealProviderLaunch
  )) {
    throw new Error('--sandbox-profile is only supported by launch real-provider execution or first-launch resume; sandbox commands use the profile id positionally.');
  }
  if (options.approvalId && !(
    options.command === 'approval' ||
    (options.command === 'first-launch' && options.firstLaunchAction === 'resume')
  )) {
    throw new Error('--approval is only supported by first-launch resume; approval commands use the approval id positionally.');
  }
  if (!['adapter-plan', 'backup-evidence', 'database-runtime', 'sandbox'].includes(options.command) &&
      !isRealProviderLaunch && options.adapterPlanId) {
    throw new Error('--adapter-plan and Adapter Plan ids are only supported by adapter-plan/backup-evidence/sandbox commands or launch real-provider execution.');
  }
  if (!['backup-evidence', 'adapter-plan', 'database-runtime'].includes(options.command) &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume') &&
      options.backupEvidenceId) {
    throw new Error('Backup Evidence ids are only supported by backup-evidence/adapter-plan commands.');
  }
  if (options.databaseRuntimeProfileId && !['database-runtime', 'sandbox'].includes(options.command) &&
      !isRealProviderLaunch &&
      !(options.command === 'rollback' && ['apply', 'resume'].includes(options.rollbackAction)) &&
      !(options.command === 'verification' && options.verificationAction === 'run') &&
      !(options.command === 'first-launch' && options.firstLaunchAction === 'resume')) {
    throw new Error('--database-runtime-profile and Database Runtime Profile ids are only supported by database-runtime/sandbox commands, verification run, rollback apply/resume, launch real-provider execution, or first-launch resume.');
  }
  if (options.databaseHosts.length > 0 &&
      !(options.command === 'database-runtime' && options.databaseRuntimeAction === 'create')) {
    throw new Error('--database-host is only supported by database-runtime create.');
  }
  if (options.acceptanceRunIds.length > 0 && options.command !== 'acceptance-suite') {
    throw new Error('--acceptance-run is only supported by acceptance-suite.');
  }
  if (options.acceptanceProviders.length > 0 &&
      !['acceptance-suite', 'acceptance-portfolio', 'adapter-plan'].includes(options.command)) {
    throw new Error('--acceptance-provider is only supported by acceptance-suite/acceptance-portfolio or adapter-plan generate.');
  }
  if (options.acceptanceSuiteRefs.length > 0 && options.command !== 'acceptance-portfolio') {
    throw new Error('--acceptance-suite-ref is only supported by acceptance-portfolio.');
  }
  if (options.acceptanceSuiteId && !['acceptance-suite', 'acceptance-cleanup'].includes(options.command)) {
    throw new Error('--acceptance-suite and Acceptance Suite ids are only supported by acceptance-suite/acceptance-cleanup.');
  }
  if ((options.cleanupOwner || options.cleanupDeadline || options.cleanupSpecFile ||
       options.cleanupPlanId || options.cleanupAttestationId) && options.command !== 'acceptance-cleanup') {
    throw new Error('Cleanup options and ids are only supported by acceptance-cleanup.');
  }
  if (
    options.command !== 'sandbox' &&
    (options.resourcePrefix || options.allowedDomains.length > 0 || options.protectedDomains.length > 0 ||
      options.allowPaidResources || options.maxProviderMutations)
  ) {
    throw new Error('Sandbox scope and budget options are only supported by sandbox create.');
  }
}

function validateProviderOptions(options) {
  if (options.command !== 'provider') return;
  if (!options.providerAction) throw new Error('provider requires an action: list, show, or guide.');
  if (options.providerAction === 'list' && options.providerCatalogId) {
    throw new Error('provider list does not accept a provider id.');
  }
  if (['show', 'guide'].includes(options.providerAction) && !options.providerCatalogId) {
    throw new Error(`provider ${options.providerAction} requires a provider id.`);
  }
  if (
    options.home || options.repo || options.projectId || options.name || options.yes || options.execute ||
    options.includeArchived || options.refreshSource || options.graphId || options.nodeIds ||
    options.expiresAt || options.approvedBy
  ) {
    throw new Error('provider only accepts its action, optional provider id, and --json.');
  }
}

function validateSecretOptions(options) {
  if (options.command !== 'secret') {
    if (options.secretAction || options.secretRef || options.fromStdin || options.overwriteSecret) {
      throw new Error('--stdin, --overwrite, and Secret capture arguments are only supported by secret capture.');
    }
    return;
  }
  if (options.secretAction !== 'capture') throw new Error('secret requires the capture action.');
  if (!options.secretRef) throw new Error('secret capture requires a keychain:// Secret Ref.');
  if (!options.fromStdin || !options.yes) throw new Error('secret capture requires --stdin --yes.');
  if (!/^keychain:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(options.secretRef)) {
    throw new Error('secret capture currently requires keychain://service/account.');
  }
  if (
    options.home || options.repo || options.projectId || options.name || options.execute ||
    options.includeArchived || options.refreshSource || options.graphId || options.nodeIds ||
    options.expiresAt || options.approvedBy || options.providerExplicit || options.probeAuth
  ) {
    throw new Error('secret capture accepts only one keychain Ref, --stdin, --yes, optional --overwrite, and --json.');
  }
}

function validateV2Options(options) {
  if (!V2_COMMANDS.has(options.command)) {
    if (options.home) throw new Error('--home is only supported by V2 external-control commands.');
    if (options.projectId) throw new Error('--id is only supported by project add and import legacy.');
    if (options.includeArchived) throw new Error('--all is only supported by project list/show.');
    if (options.refreshSource) throw new Error('--refresh-source is only supported by project update.');
    if (options.graphId || options.nodeIds || options.expiresAt || options.approvedBy) {
      throw new Error('Approval and graph options are only supported by V2 launch/approval commands.');
    }
    return;
  }

  if (options.command === 'analyze') {
    if (!options.projectId) throw new Error('analyze requires a project id.');
    if (options.includeArchived || options.refreshSource || options.repo || options.name) {
      throw new Error('analyze only accepts a project id, --home, and --json.');
    }
    return;
  }

  if (options.command === 'artifact') {
    if (!options.artifactAction) throw new Error('artifact requires an action: create, build, vercel, list, show, or verify.');
    if (!options.projectId) throw new Error(`artifact ${options.artifactAction} requires a project id.`);
    if (options.repo || options.name || options.includeArchived || options.refreshSource) {
      throw new Error('artifact only accepts its action, project id, optional artifact id, build options, --home, and --json.');
    }
    if (['show', 'verify'].includes(options.artifactAction) && !options.artifactId) {
      throw new Error(`artifact ${options.artifactAction} requires an artifact id.`);
    }
    if (['create', 'build', 'vercel', 'list'].includes(options.artifactAction) && options.artifactId) {
      throw new Error(`artifact ${options.artifactAction} does not accept an artifact id.`);
    }
    if (options.artifactAction !== 'build' && (options.execute || options.yes || options.force || options.artifactOutputDirs.length > 0)) {
      throw new Error('--execute, --yes, --force, and --artifact-output are only supported by artifact build.');
    }
    if (options.artifactAction === 'build') {
      if (options.force && !options.execute) throw new Error('artifact build --force requires --execute --yes.');
      if (
        options.allowProviderMutations || options.allowCostMutations || options.allowProviderDeletes ||
        options.probeAuth || options.unsafeRevealSecrets || options.targetExplicit || options.providerExplicit ||
        options.domain || options.preset !== 'detected'
      ) {
        throw new Error('artifact build does not accept provider, domain, probe, or unsafe secret options.');
      }
    }
    return;
  }

  if (options.command === 'import') {
    if (!options.importAction) throw new Error('import requires an action: legacy.');
    if (!options.repo) throw new Error('import legacy requires --repo.');
    if (
      options.includeArchived ||
      options.refreshSource ||
      options.force ||
      !options.save ||
      options.dryRun ||
      options.execute ||
      options.yes ||
      options.allowProviderMutations ||
      options.allowCostMutations ||
      options.allowProviderDeletes ||
      options.probeAuth ||
      options.unsafeRevealSecrets ||
      options.latestRun ||
      options.runId ||
      options.limit !== 10 ||
      options.expectPlan ||
      options.requireReviewFile ||
      options.requireDiffFile ||
      options.outFile ||
      options.domain ||
      options.targetExplicit ||
      options.providerExplicit ||
      options.preset !== 'detected'
    ) {
      throw new Error('import legacy only accepts --repo, --id, --name, --home, and --json.');
    }
    return;
  }

  if (options.command === 'launch') {
    if (!options.launchAction) throw new Error('launch requires an action: plan, list, show, apply, or resume.');
    if (!options.projectId) throw new Error(`launch ${options.launchAction} requires a project id.`);
    if (options.repo || options.name || options.includeArchived || options.refreshSource || options.nodeIds || options.expiresAt || options.approvedBy) {
      throw new Error('launch only accepts its action, project id, optional graph id, --home, and --json.');
    }
    if (!['show', 'apply'].includes(options.launchAction) && options.graphId) {
      throw new Error(`launch ${options.launchAction} does not accept a graph id.`);
    }
    if (options.launchAction === 'resume' && !options.runId) throw new Error('launch resume requires a run id.');
    if (options.launchAction !== 'resume' && options.runId) throw new Error(`launch ${options.launchAction} does not accept a run id.`);
    if (!['apply', 'resume'].includes(options.launchAction) && (options.execute || options.yes)) {
      throw new Error('--execute and --yes are only supported by launch apply/resume.');
    }
    if (options.providerMode === 'real') {
      if (!options.execute || !options.yes || !options.allowProviderNetwork || !options.allowProviderMutations) {
        throw new Error('launch real-provider execution requires --execute --yes --allow-provider-network --allow-provider-mutations.');
      }
      if (!options.adapterPlanId || !options.sandboxProfileId || !options.sandboxPreflightId) {
        throw new Error('launch real-provider execution requires --adapter-plan, --sandbox-profile, and --preflight.');
      }
      if (options.launchAction === 'apply' && !options.graphId) {
        throw new Error('launch apply real-provider execution requires an explicit graph id.');
      }
      if (Boolean(options.databaseRuntimeProfileId) !== Boolean(options.allowDatabaseMigration)) {
        throw new Error('launch real-provider execution requires --database-runtime-profile and --allow-database-migration together.');
      }
      if (options.allowProviderDeletes) {
        throw new Error('launch real-provider execution does not support --allow-provider-deletes.');
      }
    }
    return;
  }

  if (options.command === 'approval') {
    if (!options.approvalAction) throw new Error('approval requires an action: create, list, show, or revoke.');
    if (!options.projectId) throw new Error(`approval ${options.approvalAction} requires a project id.`);
    if (options.repo || options.name || options.includeArchived || options.refreshSource || options.execute || options.runId) {
      throw new Error('approval accepts only its action options, --home, --yes, and --json.');
    }
    if (options.approvalAction === 'create') {
      if (!options.graphId) throw new Error('approval create requires --graph.');
      if (!options.nodeIds) throw new Error('approval create requires --nodes.');
      if (!options.expiresAt) throw new Error('approval create requires --expires-at.');
      if (options.approvalId) throw new Error('approval create does not accept an approval id.');
      return;
    }
    if (options.approvalAction === 'list') {
      if (options.approvalId || options.graphId || options.nodeIds || options.expiresAt || options.approvedBy || options.yes) {
        throw new Error('approval list only accepts a project id, --home, and --json.');
      }
      return;
    }
    if (!options.approvalId) throw new Error(`approval ${options.approvalAction} requires an approval id.`);
    if (options.graphId || options.nodeIds || options.expiresAt) {
      throw new Error(`approval ${options.approvalAction} does not accept graph, node, or expiration options.`);
    }
    if (options.approvalAction === 'show' && (options.yes || options.approvedBy)) {
      throw new Error('approval show only accepts project id, approval id, --home, and --json.');
    }
    return;
  }

  if (options.command === 'connection') {
    if (!options.connectionAction) throw new Error('connection requires an action: add, copy, list, show, update, remove, check, or probe.');
    if (!options.projectId) throw new Error(`connection ${options.connectionAction} requires a project id.`);
    if (options.repo || options.name || options.refreshSource || options.graphId || options.nodeIds || options.expiresAt || options.approvedBy || options.execute) {
      throw new Error('connection accepts only its action options, --home, --all, --yes, and --json.');
    }
    if (options.connectionAction === 'add') {
      if (!options.connectionId) throw new Error('connection add requires a connection id.');
      if (!options.providerExplicit) throw new Error('connection add requires --provider.');
      if (options.secretRefs.length === 0) throw new Error('connection add requires at least one --secret-ref.');
      if (options.expectedVersion || options.includeArchived || options.yes || options.connectionSourceProjectId || options.connectionSourceId) {
        throw new Error('connection add does not accept --expected-version, --from-project, --from-connection, --all, or --yes.');
      }
      return;
    }
    if (options.connectionAction === 'copy') {
      if (!options.connectionId) throw new Error('connection copy requires a target connection id.');
      if (!options.connectionSourceProjectId || !options.connectionSourceId) {
        throw new Error('connection copy requires --from-project and --from-connection.');
      }
      if (!options.expectedVersion) throw new Error('connection copy requires the source --expected-version.');
      if (options.providerExplicit || options.secretRefs.length || options.connectionScope || options.includeArchived || options.yes || options.probeAuth) {
        throw new Error('connection copy only accepts target project/id, source project/id, --expected-version, --home, and --json.');
      }
      return;
    }
    if (options.connectionAction === 'list') {
      if (options.connectionId || options.providerExplicit || options.secretRefs.length || options.connectionScope || options.expectedVersion || options.yes || options.connectionSourceProjectId || options.connectionSourceId) {
        throw new Error('connection list only accepts a project id, --home, --all, and --json.');
      }
      return;
    }
    if (!options.connectionId) throw new Error(`connection ${options.connectionAction} requires a connection id.`);
    if (options.connectionAction === 'update') {
      if (!options.expectedVersion) throw new Error('connection update requires --expected-version.');
      if (!options.providerExplicit && options.secretRefs.length === 0 && !options.connectionScope) {
        throw new Error('connection update requires --provider, --secret-ref, or --scope.');
      }
      if (options.includeArchived || options.yes || options.connectionSourceProjectId || options.connectionSourceId) {
        throw new Error('connection update does not accept --from-project, --from-connection, --all, or --yes.');
      }
      return;
    }
    if (options.connectionAction === 'remove') {
      if (!options.expectedVersion) throw new Error('connection remove requires --expected-version.');
      if (options.providerExplicit || options.secretRefs.length || options.connectionScope || options.includeArchived || options.connectionSourceProjectId || options.connectionSourceId) {
        throw new Error('connection remove only accepts project id, connection id, --expected-version, --yes, --home, and --json.');
      }
      return;
    }
    if (options.connectionAction === 'probe') {
      if (!options.probeAuth) throw new Error('connection probe requires --probe-auth.');
      if (options.providerExplicit || options.secretRefs.length || options.connectionScope || options.expectedVersion || options.yes || options.includeArchived || options.connectionSourceProjectId || options.connectionSourceId) {
        throw new Error('connection probe only accepts project id, connection id, --probe-auth, --home, and --json.');
      }
      return;
    }
    if (options.probeAuth) throw new Error('--probe-auth is only supported by connection probe.');
    if (options.providerExplicit || options.secretRefs.length || options.connectionScope || options.expectedVersion || options.yes || options.connectionSourceProjectId || options.connectionSourceId) {
      throw new Error(`connection ${options.connectionAction} only accepts project id, connection id, --home, --all, and --json.`);
    }
    return;
  }

  if (options.command === 'recipe') {
    if (!options.recipeAction) throw new Error('recipe requires an action: plan, list, or show.');
    if (!options.projectId) throw new Error(`recipe ${options.recipeAction} requires a project id.`);
    if (
      options.repo || options.name || options.providerExplicit || options.includeArchived || options.refreshSource ||
      options.graphId || options.nodeIds || options.expiresAt || options.approvedBy || options.execute || options.yes ||
      options.secretRefs.length || options.connectionScope || options.expectedVersion || options.probeAuth
    ) {
      throw new Error('recipe only accepts its action, project id, optional recipe id, --home, and --json.');
    }
    if (options.recipeAction !== 'show' && options.recipeId) throw new Error(`recipe ${options.recipeAction} does not accept a recipe id.`);
    return;
  }

  if (options.command === 'bootstrap-plan') {
    if (!options.bootstrapPlanAction) throw new Error('bootstrap-plan requires an action: create or show.');
    if (!options.projectId) throw new Error(`bootstrap-plan ${options.bootstrapPlanAction} requires a project id.`);
    if (
      options.repo || options.name || options.providerExplicit || options.includeArchived || options.refreshSource ||
      options.graphId || options.nodeIds || options.expiresAt || options.approvedBy || options.execute || options.yes ||
      options.secretRefs.length || options.connectionScope || options.expectedVersion || options.probeAuth
    ) {
      throw new Error('bootstrap-plan only accepts its action, project id, optional plan/recipe id, --secret-backend, --home, and --json.');
    }
    if (options.bootstrapPlanAction === 'create') {
      if (options.bootstrapPlanId) throw new Error('bootstrap-plan create does not accept a plan id.');
      return;
    }
    if (!options.bootstrapPlanId) throw new Error('bootstrap-plan show requires a plan id.');
    if (options.recipeId || options.secretBackend) {
      throw new Error('bootstrap-plan show does not accept --recipe or --secret-backend.');
    }
    return;
  }

  if (options.command === 'first-launch') {
    if (!options.firstLaunchAction) throw new Error('first-launch requires an action: start, status, or resume.');
    if (!options.projectId) throw new Error(`first-launch ${options.firstLaunchAction} requires a project id.`);
    if (
      options.repo || options.name || options.providerExplicit || options.includeArchived || options.refreshSource ||
      options.graphId || options.nodeIds || options.expiresAt || options.approvedBy || options.execute || options.yes ||
      options.secretRefs.length || options.connectionScope || options.expectedVersion || options.probeAuth ||
      options.bootstrapPlanId || options.humanHandoffAction || options.handoffId || options.handoffAttestationId ||
      options.handoffPhase || options.handoffOwner || options.handoffDeadline || options.handoffSpecFile
    ) {
      throw new Error('first-launch accepts only its action, project/session id, start options, --home, and --json.');
    }
    if (options.firstLaunchAction === 'start') {
      if (options.sessionId) throw new Error('first-launch start does not accept a session id.');
      if (!options.sessionOwner || !options.sessionDeadline) {
        throw new Error('first-launch start requires --owner and --deadline.');
      }
      if (options.settingsFile || options.sandboxProfileId || options.approvalId || options.sandboxPreflightId ||
          options.runId || options.migrationPlanId || options.backupEvidenceId ||
          options.databaseRuntimeProfileId || options.verificationPlanId || options.candidateEvidenceId ||
          options.cutoverHandoffId || options.cutoverAttestationId || options.productionEvidenceId ||
          options.rollbackPlanId || options.rollbackApprovalId || options.emailDeliveryPlanId ||
          options.emailDeliveryApprovalId || options.emailDeliveryRunId) {
        throw new Error('first-launch start does not accept candidate-stage control ids.');
      }
      return;
    }
    if (!options.sessionId) throw new Error(`first-launch ${options.firstLaunchAction} requires a session id.`);
    if (options.firstLaunchAction === 'status') {
      if (options.sessionOwner || options.sessionDeadline || options.secretBackend || options.settingsFile ||
          options.sandboxProfileId || options.approvalId || options.sandboxPreflightId || options.runId ||
          options.migrationPlanId || options.backupEvidenceId || options.databaseRuntimeProfileId ||
          options.verificationPlanId || options.candidateEvidenceId || options.cutoverHandoffId ||
          options.cutoverAttestationId || options.productionEvidenceId || options.rollbackPlanId ||
          options.rollbackApprovalId || options.emailDeliveryPlanId || options.emailDeliveryApprovalId ||
          options.emailDeliveryRunId) {
        throw new Error('first-launch status does not accept start, settings, or candidate-stage control options.');
      }
      return;
    }
    if (options.sessionOwner || options.secretBackend) {
      throw new Error('first-launch resume does not accept --owner or --secret-backend.');
    }
    return;
  }

  if (options.command === 'human-handoff') {
    if (!options.humanHandoffAction) throw new Error('human-handoff requires an action: create, attest, or show.');
    if (!options.projectId) throw new Error(`human-handoff ${options.humanHandoffAction} requires a project id.`);
    if (
      options.repo || options.name || options.providerExplicit || options.includeArchived || options.refreshSource ||
      options.graphId || options.nodeIds || options.expiresAt || options.execute || options.secretRefs.length ||
      options.connectionScope || options.expectedVersion || options.probeAuth || options.secretBackend
    ) throw new Error('human-handoff accepts only handoff control options, --approved-by/--yes for attest, --home, and --json.');
    if (options.humanHandoffAction === 'create') {
      if (!options.bootstrapPlanId || !options.handoffPhase || !options.handoffOwner || !options.handoffDeadline) {
        throw new Error('human-handoff create requires --bootstrap-plan --handoff-phase --handoff-owner --handoff-deadline.');
      }
      if (options.handoffId || options.handoffAttestationId || options.handoffSpecFile || options.approvedBy || options.yes) {
        throw new Error('human-handoff create does not accept ids, --handoff-spec, --approved-by, or --yes.');
      }
      if (!['bootstrap', 'configuration', 'cutover'].includes(options.handoffPhase)) {
        throw new Error('--handoff-phase must be bootstrap, configuration, or cutover.');
      }
      if (options.handoffPhase === 'cutover' && !options.candidateEvidenceId) {
        throw new Error('human-handoff create --handoff-phase cutover requires --candidate-evidence.');
      }
      if (options.handoffPhase !== 'cutover' && options.candidateEvidenceId) {
        throw new Error('--candidate-evidence is only supported by the cutover handoff phase.');
      }
      return;
    }
    if (!options.handoffId) throw new Error(`human-handoff ${options.humanHandoffAction} requires a handoff id.`);
    if (options.bootstrapPlanId || options.handoffPhase || options.handoffOwner || options.handoffDeadline || options.candidateEvidenceId) {
      throw new Error(`human-handoff ${options.humanHandoffAction} does not accept bootstrap, phase, owner, or deadline options.`);
    }
    if (options.humanHandoffAction === 'attest') {
      if (options.handoffAttestationId) throw new Error('human-handoff attest does not accept an attestation id.');
      if (!options.handoffSpecFile || !options.approvedBy || !options.yes) {
        throw new Error('human-handoff attest requires --handoff-spec --approved-by --yes.');
      }
      return;
    }
    if (options.handoffSpecFile || options.approvedBy || options.yes) {
      throw new Error('human-handoff show does not accept --handoff-spec, --approved-by, or --yes.');
    }
    return;
  }

  if (options.command === 'manifest') {
    if (!options.manifestAction) throw new Error('manifest requires an action: create or show.');
    if (!options.projectId) throw new Error(`manifest ${options.manifestAction} requires a project id.`);
    if (
      options.repo || options.name || options.providerExplicit || options.includeArchived || options.refreshSource ||
      options.graphId || options.nodeIds || options.expiresAt || options.approvedBy || options.execute || options.yes ||
      options.secretRefs.length || options.connectionScope || options.expectedVersion || options.probeAuth
    ) {
      throw new Error('manifest only accepts its action, project id, optional recipe id, --home, and --json.');
    }
    if (options.manifestAction === 'show' && options.recipeId) throw new Error('manifest show does not accept a recipe id.');
    return;
  }

  if (options.command === 'launch-config') {
    if (!options.launchConfigAction) throw new Error('launch-config requires an action: create or show.');
    if (!options.projectId) throw new Error(`launch-config ${options.launchConfigAction} requires a project id.`);
    if (!options.graphId) throw new Error(`launch-config ${options.launchConfigAction} requires --graph.`);
    if (hasControlOnlyConflict(options) || options.approvedBy || options.execute || options.yes) {
      throw new Error('launch-config only accepts its action, project id, optional configuration id, --graph, --settings-file, --home, and --json.');
    }
    if (options.launchConfigAction === 'create') {
      if (!options.settingsFile) throw new Error('launch-config create requires --settings-file.');
      if (options.launchConfigurationId) throw new Error('launch-config create does not accept a configuration id.');
      return;
    }
    if (!options.launchConfigurationId) throw new Error('launch-config show requires a configuration id.');
    if (options.settingsFile) throw new Error('launch-config show does not accept --settings-file.');
    return;
  }

  if (options.command === 'dns-change') {
    if (!options.dnsChangeAction) throw new Error('dns-change requires an action: create or show.');
    if (!options.projectId) throw new Error(`dns-change ${options.dnsChangeAction} requires a project id.`);
    if (!options.graphId) throw new Error(`dns-change ${options.dnsChangeAction} requires --graph.`);
    if (!options.launchConfigurationId) throw new Error(`dns-change ${options.dnsChangeAction} requires --launch-config.`);
    if (hasControlOnlyConflict(options) || options.approvedBy || options.execute || options.yes || options.settingsFile) {
      throw new Error('dns-change only accepts its action, project id, optional change set id, --graph, --launch-config, --acceptance-only, --home, and --json.');
    }
    if (options.dnsChangeAction === 'create') {
      if (options.dnsChangeSetId) throw new Error('dns-change create does not accept a change set id.');
      return;
    }
    if (!options.dnsChangeSetId) throw new Error('dns-change show requires a change set id.');
    if (options.acceptanceOnly) throw new Error('dns-change show does not accept --acceptance-only.');
    return;
  }

  if (options.command === 'candidate') {
    if (!options.candidateAction) throw new Error('candidate requires action: verify.');
    if (!options.projectId) throw new Error('candidate verify requires a project id.');
    if (!options.graphId) throw new Error('candidate verify requires --graph.');
    if (!options.launchConfigurationId) throw new Error('candidate verify requires --launch-config.');
    if (!options.allowNetwork || !options.yes) throw new Error('candidate verify requires --allow-network --yes.');
    if (hasControlOnlyConflict(options) || options.approvedBy || options.execute || options.settingsFile || options.dnsChangeSetId) {
      throw new Error('candidate verify only accepts project id, --graph, --launch-config, --allow-network, --yes, --home, and --json.');
    }
    return;
  }

  if (options.command === 'verification') {
    if (!options.verificationAction) throw new Error('verification requires an action: create, show, or run.');
    if (!options.projectId) throw new Error(`verification ${options.verificationAction} requires a project id.`);
    if (!options.graphId) throw new Error(`verification ${options.verificationAction} requires --graph.`);
    if (!options.launchConfigurationId) throw new Error(`verification ${options.verificationAction} requires --launch-config.`);
    if (hasControlOnlyConflict(options) || options.approvedBy || options.execute || options.settingsFile ||
      options.dnsChangeSetId || options.actionsFile || options.migrationSpecFile) {
      throw new Error('verification only accepts its action, project id, optional plan id, --graph, --launch-config, --verification-spec, --verification-plan, --phase, --allow-network, --yes, --home, and --json.');
    }
    if (options.verificationAction === 'create') {
      if (!options.verificationSpecFile) throw new Error('verification create requires --verification-spec.');
      if (options.verificationPlanId || options.verificationPhase || options.emailDeliveryRunId || options.allowNetwork || options.yes) {
        throw new Error('verification create does not accept a plan id, Delivery Run, --phase, --allow-network, or --yes.');
      }
      return;
    }
    if (!options.verificationPlanId) throw new Error(`verification ${options.verificationAction} requires a plan id or --verification-plan.`);
    if (options.verificationSpecFile) throw new Error(`verification ${options.verificationAction} does not accept --verification-spec.`);
    if (options.verificationAction === 'show') {
      if (options.verificationPhase || options.emailDeliveryRunId || options.databaseRuntimeProfileId || options.allowNetwork || options.yes) {
        throw new Error('verification show does not accept --phase, --email-delivery-run, --allow-network, or --yes.');
      }
      return;
    }
    if (!['candidate', 'production'].includes(options.verificationPhase)) {
      throw new Error('verification run requires --phase candidate or --phase production.');
    }
    if (!options.allowNetwork || !options.yes) throw new Error('verification run requires --allow-network --yes.');
    if (options.emailDeliveryRunId && options.verificationPhase !== 'production') {
      throw new Error('--email-delivery-run is only valid for production verification.');
    }
    if (options.databaseRuntimeProfileId && options.verificationPhase !== 'production') {
      throw new Error('--database-runtime-profile is only valid for production verification.');
    }
    return;
  }

  if (options.command === 'email-delivery') {
    validateEmailDeliveryOptions(options);
    return;
  }

  if (options.command === 'rollback') {
    if (!options.rollbackAction) {
      throw new Error('rollback requires an action: create, show, approve, list-approvals, approval, revoke, apply, or resume.');
    }
    if (!options.projectId) throw new Error(`rollback ${options.rollbackAction} requires a project id.`);
    const executing = ['apply', 'resume'].includes(options.rollbackAction);
    const commonConflict = options.force || options.allowCostMutations || options.allowProviderDeletes ||
      options.probeAuth || options.probeSecrets || options.unsafeRevealSecrets || options.providerExplicit ||
      options.targetExplicit || options.providerMode || options.repo || options.name || options.domain ||
      options.artifactId || options.artifactOutputDirs.length > 0 || options.importAction || options.launchAction ||
      options.approvalAction || options.approvalId || options.nodeIds || options.providerAction ||
      options.providerCatalogId || options.connectionAction || options.connectionId || options.secretRefs.length > 0 ||
      options.connectionScope || options.expectedVersion || options.recipeAction || options.recipeId ||
      options.manifestAction || options.includeArchived || options.refreshSource || options.latestRun ||
      options.expectPlan || options.requireReviewFile || options.requireDiffFile || options.outFile ||
      options.settingsFile || options.dnsChangeSetId || options.actionsFile || options.migrationSpecFile ||
      options.allowNetwork || options.allowSandboxNetwork;
    if (commonConflict) {
      throw new Error('rollback accepts only its action-specific control options, --home, and --json.');
    }
    if (!executing && (options.execute || options.allowRollbackNetwork || options.allowProviderMutations || options.runId)) {
      throw new Error('rollback execution flags and Run ids are only accepted by rollback apply/resume.');
    }
    if (executing && Boolean(options.databaseRuntimeProfileId) !== Boolean(options.allowDatabaseRestore)) {
      throw new Error('rollback database execution requires --allow-database-restore and --database-runtime-profile together.');
    }
    if (options.rollbackAction === 'list-approvals') {
      if (options.rollbackPlanId || options.rollbackApprovalId || options.rollbackStepIds || options.graphId ||
        options.launchConfigurationId || options.expiresAt || options.approvedBy || options.yes) {
        throw new Error('rollback list-approvals only accepts a project id, --home, and --json.');
      }
      return;
    }
    if (!options.launchConfigurationId) throw new Error(`rollback ${options.rollbackAction} requires --launch-config.`);
    if (options.rollbackAction === 'resume') {
      if (!options.runId) throw new Error('rollback resume requires a run id.');
      if (options.graphId || options.rollbackPlanId || options.rollbackApprovalId || options.rollbackStepIds ||
        options.expiresAt || options.approvedBy) {
        throw new Error('rollback resume derives Graph, Plan, and Approval from the Run and does not accept those options.');
      }
      if (!options.execute || !options.yes || !options.allowRollbackNetwork || !options.allowProviderMutations) {
        throw new Error('rollback resume requires --execute --yes --allow-rollback-network --allow-provider-mutations.');
      }
      return;
    }
    if (!options.graphId) throw new Error(`rollback ${options.rollbackAction} requires --graph.`);
    if (options.rollbackAction === 'apply') {
      if (!options.rollbackPlanId) throw new Error('rollback apply requires a plan id.');
      if (!options.rollbackApprovalId) throw new Error('rollback apply requires --rollback-approval.');
      if (options.rollbackStepIds || options.expiresAt || options.approvedBy || options.runId) {
        throw new Error('rollback apply does not accept step, expiration, actor, or Run options.');
      }
      if (!options.execute || !options.yes || !options.allowRollbackNetwork || !options.allowProviderMutations) {
        throw new Error('rollback apply requires --execute --yes --allow-rollback-network --allow-provider-mutations.');
      }
      return;
    }
    if (options.rollbackAction === 'create') {
      if (options.rollbackPlanId || options.rollbackApprovalId || options.rollbackStepIds || options.expiresAt || options.approvedBy || options.yes) {
        throw new Error('rollback create does not accept plan, approval, step, expiration, actor, or confirmation options.');
      }
      return;
    }
    if (options.rollbackAction === 'show') {
      if (!options.rollbackPlanId) throw new Error('rollback show requires a plan id.');
      if (options.rollbackApprovalId || options.rollbackStepIds || options.expiresAt || options.approvedBy || options.yes) {
        throw new Error('rollback show only accepts project id, plan id, --graph, --launch-config, --home, and --json.');
      }
      return;
    }
    if (options.rollbackAction === 'approve') {
      if (!options.rollbackPlanId) throw new Error('rollback approve requires a plan id.');
      if (!options.rollbackStepIds) throw new Error('rollback approve requires --steps.');
      if (!options.expiresAt) throw new Error('rollback approve requires --expires-at.');
      if (!options.yes) throw new Error('rollback approve requires --yes.');
      if (options.rollbackApprovalId) throw new Error('rollback approve does not accept an approval id.');
      return;
    }
    if (!options.rollbackApprovalId) throw new Error(`rollback ${options.rollbackAction} requires an approval id.`);
    if (options.rollbackPlanId || options.rollbackStepIds || options.expiresAt) {
      throw new Error(`rollback ${options.rollbackAction} does not accept plan, step, or expiration options.`);
    }
    if (options.rollbackAction === 'approval' && (options.yes || options.approvedBy)) {
      throw new Error('rollback approval does not accept --yes or --approved-by.');
    }
    if (options.rollbackAction === 'revoke' && !options.yes) throw new Error('rollback revoke requires --yes.');
    return;
  }

  if (options.command === 'migration-plan') {
    if (!options.migrationPlanAction) throw new Error('migration-plan requires an action: create or show.');
    if (!options.projectId) throw new Error(`migration-plan ${options.migrationPlanAction} requires a project id.`);
    if (!options.graphId) throw new Error(`migration-plan ${options.migrationPlanAction} requires --graph.`);
    if (!options.launchConfigurationId) throw new Error(`migration-plan ${options.migrationPlanAction} requires --launch-config.`);
    if (hasControlOnlyConflict(options) || options.approvedBy || options.execute || options.yes ||
      options.settingsFile || options.dnsChangeSetId || options.actionsFile) {
      throw new Error('migration-plan only accepts its action, project id, optional plan id, --graph, --launch-config, --migration-spec, --home, and --json.');
    }
    if (options.migrationPlanAction === 'create') {
      if (!options.migrationSpecFile) throw new Error('migration-plan create requires --migration-spec.');
      if (options.migrationPlanId) throw new Error('migration-plan create does not accept a plan id.');
      return;
    }
    if (!options.migrationPlanId) throw new Error('migration-plan show requires a plan id.');
    if (options.migrationSpecFile) throw new Error('migration-plan show does not accept --migration-spec.');
    return;
  }

  if (options.command === 'adapter-plan') {
    if (!options.adapterPlanAction) throw new Error('adapter-plan requires an action: create, generate, or show.');
    if (!options.projectId) throw new Error(`adapter-plan ${options.adapterPlanAction} requires a project id.`);
    if (!options.graphId) throw new Error(`adapter-plan ${options.adapterPlanAction} requires --graph.`);
    if (hasControlOnlyConflict(options) || options.approvedBy || options.settingsFile) {
      throw new Error('adapter-plan only accepts its action, project id, optional plan id, --graph, stage inputs, --acceptance-provider, --actions-file, --home, and --json.');
    }
    if (options.adapterPlanAction === 'generate') {
      if (!options.launchConfigurationId) throw new Error('adapter-plan generate requires --launch-config.');
      if (options.actionsFile || options.adapterPlanId || options.yes || options.execute ||
        (options.dnsChangeSetId && (options.migrationPlanId || options.backupEvidenceId)) ||
        (options.backupEvidenceId && !options.migrationPlanId)) {
        throw new Error('adapter-plan generate accepts DNS stage or Migration stage; --backup-evidence also requires --migration-plan.');
      }
      return;
    }
    if (options.acceptanceProviders.length > 0) {
      throw new Error(`adapter-plan ${options.adapterPlanAction} does not accept --acceptance-provider.`);
    }
    if (options.dnsChangeSetId) throw new Error(`adapter-plan ${options.adapterPlanAction} does not accept --dns-change-set.`);
    if (options.launchConfigurationId) throw new Error(`adapter-plan ${options.adapterPlanAction} does not accept --launch-config.`);
    if (options.migrationPlanId) throw new Error(`adapter-plan ${options.adapterPlanAction} does not accept --migration-plan.`);
    if (options.backupEvidenceId) throw new Error(`adapter-plan ${options.adapterPlanAction} does not accept --backup-evidence.`);
    if (options.adapterPlanAction === 'create') {
      if (!options.actionsFile) throw new Error('adapter-plan create requires --actions-file.');
      if (options.adapterPlanId) throw new Error('adapter-plan create does not accept a plan id.');
      if (options.yes || options.execute) throw new Error('adapter-plan create is plan-only and does not accept --execute or --yes.');
      return;
    }
    if (!options.adapterPlanId) throw new Error('adapter-plan show requires a plan id.');
    if (options.actionsFile || options.yes || options.execute) {
      throw new Error('adapter-plan show only accepts project id, plan id, --graph, --home, and --json.');
    }
    return;
  }

  if (options.command === 'source-patch') {
    if (!options.sourcePatchAction) throw new Error('source-patch requires an action: create or show.');
    if (!options.projectId) throw new Error(`source-patch ${options.sourcePatchAction} requires a project id.`);
    if (hasControlOnlyConflict(options) || options.graphId || options.approvedBy || options.execute || options.yes ||
        options.settingsFile || options.actionsFile || options.launchConfigurationId || options.dnsChangeSetId ||
        options.migrationPlanId || options.backupEvidenceId) {
      throw new Error('source-patch only accepts its action, project id, optional proposal id, --patch-file, --patch-reason, --home, and --json.');
    }
    if (options.sourcePatchAction === 'create') {
      if (!options.patchFile || !options.patchReason) {
        throw new Error('source-patch create requires --patch-file and --patch-reason.');
      }
      if (options.sourcePatchId) throw new Error('source-patch create does not accept a proposal id.');
      return;
    }
    if (!options.sourcePatchId) throw new Error('source-patch show requires a proposal id.');
    if (options.patchFile || options.patchReason) {
      throw new Error('source-patch show does not accept --patch-file or --patch-reason.');
    }
    return;
  }

  if (options.command === 'backup-evidence') {
    if (!options.backupEvidenceAction) throw new Error('backup-evidence requires an action: create or show.');
    if (!options.projectId) throw new Error(`backup-evidence ${options.backupEvidenceAction} requires a project id.`);
    if (!options.graphId) throw new Error(`backup-evidence ${options.backupEvidenceAction} requires --graph.`);
    if (!options.adapterPlanId) throw new Error(`backup-evidence ${options.backupEvidenceAction} requires --adapter-plan.`);
    if (hasControlOnlyConflict(options) || options.approvedBy || options.execute || options.yes ||
      options.settingsFile || options.dnsChangeSetId || options.actionsFile || options.launchConfigurationId ||
      options.migrationPlanId || options.migrationSpecFile) {
      throw new Error('backup-evidence only accepts its action, project id, optional evidence id, --graph, --adapter-plan, --home, and --json.');
    }
    if (options.backupEvidenceAction === 'create') {
      if (options.backupEvidenceId) throw new Error('backup-evidence create does not accept an evidence id.');
      return;
    }
    if (!options.backupEvidenceId) throw new Error('backup-evidence show requires an evidence id.');
    return;
  }

  if (options.command === 'database-runtime') {
    if (!options.databaseRuntimeAction) {
      throw new Error('database-runtime requires an action: create, show, or revoke.');
    }
    if (!options.projectId) throw new Error(`database-runtime ${options.databaseRuntimeAction} requires a project id.`);
    if (!options.graphId) throw new Error(`database-runtime ${options.databaseRuntimeAction} requires --graph.`);
    if (!options.adapterPlanId) throw new Error(`database-runtime ${options.databaseRuntimeAction} requires --adapter-plan.`);
    if (hasControlOnlyConflict(options) || options.execute || options.allowDatabaseMigration ||
        options.sandboxProfileId || options.sandboxPreflightId || options.accountEnvironment ||
        options.resourcePrefix || options.allowedDomains.length || options.allowPaidResources ||
        options.maxProviderMutations) {
      throw new Error('database-runtime only accepts its action, project id, optional profile id, --graph, --adapter-plan, --database-host, --expires-at, --approved-by, --yes, --home, and --json.');
    }
    if (options.databaseRuntimeAction === 'create') {
      if (options.databaseRuntimeProfileId) throw new Error('database-runtime create does not accept a profile id.');
      if (options.databaseHosts.length === 0) throw new Error('database-runtime create requires --database-host.');
      if (!options.expiresAt) throw new Error('database-runtime create requires --expires-at.');
      if (!options.approvedBy) throw new Error('database-runtime create requires --approved-by.');
      if (!options.yes) throw new Error('database-runtime create requires --yes.');
      return;
    }
    if (!options.databaseRuntimeProfileId) {
      throw new Error(`database-runtime ${options.databaseRuntimeAction} requires a profile id.`);
    }
    if (options.databaseHosts.length || options.expiresAt) {
      throw new Error(`database-runtime ${options.databaseRuntimeAction} does not accept database host or expiration options.`);
    }
    if (options.databaseRuntimeAction === 'show' && (options.yes || options.approvedBy)) {
      throw new Error('database-runtime show does not accept --yes or --approved-by.');
    }
    if (options.databaseRuntimeAction === 'revoke' && !options.yes) {
      throw new Error('database-runtime revoke requires --yes.');
    }
    if (options.databaseRuntimeAction === 'revoke' && !options.approvedBy) {
      throw new Error('database-runtime revoke requires --approved-by.');
    }
    return;
  }

  if (options.command === 'acceptance-suite') {
    if (!options.acceptanceSuiteAction) {
      throw new Error('acceptance-suite requires an action: readiness, create, or show.');
    }
    if (!options.projectId) throw new Error(`acceptance-suite ${options.acceptanceSuiteAction} requires a project id.`);
    if (hasControlOnlyConflict(options) || options.graphId || options.adapterPlanId ||
        options.databaseRuntimeProfileId || options.databaseHosts.length || options.expiresAt ||
        options.approvedBy || options.yes || options.execute || options.allowDatabaseMigration) {
      throw new Error('acceptance-suite only accepts its action, project id, optional suite id, --acceptance-run, --acceptance-provider, --home, and --json.');
    }
    if (options.acceptanceSuiteAction === 'readiness') {
      if (options.acceptanceSuiteId || options.acceptanceRunIds.length) {
        throw new Error('acceptance-suite readiness accepts provider filters but not suite or run ids.');
      }
      return;
    }
    if (options.acceptanceSuiteAction === 'create') {
      if (options.acceptanceSuiteId) throw new Error('acceptance-suite create does not accept a suite id.');
      if (options.acceptanceRunIds.length === 0) throw new Error('acceptance-suite create requires --acceptance-run.');
      return;
    }
    if (!options.acceptanceSuiteId) throw new Error('acceptance-suite show requires a suite id.');
    if (options.acceptanceRunIds.length || options.acceptanceProviders.length) {
      throw new Error('acceptance-suite show does not accept run or provider options.');
    }
    return;
  }

  if (options.command === 'acceptance-portfolio') {
    if (!options.acceptancePortfolioAction) {
      throw new Error('acceptance-portfolio requires an action: create or show.');
    }
    if (hasControlOnlyConflict(options) || options.projectId || options.graphId || options.adapterPlanId ||
        options.acceptanceRunIds.length || options.acceptanceSuiteId || options.databaseRuntimeProfileId ||
        options.databaseHosts.length || options.expiresAt || options.approvedBy || options.yes ||
        options.execute || options.allowDatabaseMigration) {
      throw new Error('acceptance-portfolio only accepts its action, optional portfolio id, --acceptance-suite-ref, --acceptance-provider, --home, and --json.');
    }
    if (options.acceptancePortfolioAction === 'create') {
      if (options.acceptancePortfolioId) {
        throw new Error('acceptance-portfolio create does not accept a portfolio id.');
      }
      if (options.acceptanceSuiteRefs.length === 0) {
        throw new Error('acceptance-portfolio create requires --acceptance-suite-ref.');
      }
      return;
    }
    if (!options.acceptancePortfolioId) {
      throw new Error('acceptance-portfolio show requires a portfolio id.');
    }
    if (options.acceptanceSuiteRefs.length || options.acceptanceProviders.length) {
      throw new Error('acceptance-portfolio show does not accept Suite references or provider options.');
    }
    return;
  }

  if (options.command === 'acceptance-cleanup') {
    if (!options.acceptanceCleanupAction) {
      throw new Error('acceptance-cleanup requires an action: create, attest, or show.');
    }
    if (!options.projectId) {
      throw new Error(`acceptance-cleanup ${options.acceptanceCleanupAction} requires a project id.`);
    }
    if (hasControlOnlyConflict(options) || options.graphId || options.adapterPlanId ||
        options.acceptanceRunIds.length || options.acceptanceProviders.length || options.expiresAt ||
        options.execute || options.allowDatabaseMigration || options.databaseRuntimeProfileId) {
      throw new Error('acceptance-cleanup accepts only cleanup control options, --approved-by/--yes for attest, --home, and --json.');
    }
    if (options.acceptanceCleanupAction === 'create') {
      if (options.cleanupPlanId || options.cleanupAttestationId || options.cleanupSpecFile || options.approvedBy || options.yes) {
        throw new Error('acceptance-cleanup create does not accept plan/attestation ids, a cleanup spec, or attestation approval options.');
      }
      if (!options.acceptanceSuiteId || !options.cleanupOwner || !options.cleanupDeadline) {
        throw new Error('acceptance-cleanup create requires --acceptance-suite --cleanup-owner --cleanup-deadline.');
      }
      return;
    }
    if (!options.cleanupPlanId) {
      throw new Error(`acceptance-cleanup ${options.acceptanceCleanupAction} requires a cleanup plan id.`);
    }
    if (options.acceptanceSuiteId || options.cleanupOwner || options.cleanupDeadline) {
      throw new Error(`acceptance-cleanup ${options.acceptanceCleanupAction} does not accept suite, owner, or deadline options.`);
    }
    if (options.acceptanceCleanupAction === 'attest') {
      if (options.cleanupAttestationId) throw new Error('acceptance-cleanup attest does not accept an attestation id.');
      if (!options.cleanupSpecFile || !options.approvedBy || !options.yes) {
        throw new Error('acceptance-cleanup attest requires --cleanup-spec --approved-by --yes.');
      }
      return;
    }
    if (options.cleanupSpecFile || options.approvedBy || options.yes) {
      throw new Error('acceptance-cleanup show does not accept a cleanup spec or attestation approval options.');
    }
    return;
  }

  if (options.command === 'sandbox') {
    if (!options.sandboxAction) throw new Error('sandbox requires an action: create, show, preflight, apply, resume, report, or revoke.');
    if (!options.projectId) throw new Error(`sandbox ${options.sandboxAction} requires a project id.`);
    if (!options.graphId) throw new Error(`sandbox ${options.sandboxAction} requires --graph.`);
    if (!options.adapterPlanId) throw new Error(`sandbox ${options.sandboxAction} requires --adapter-plan.`);
    if (!['apply', 'resume', 'report'].includes(options.sandboxAction) && hasControlOnlyConflict(options)) {
      throw new Error('sandbox does not accept repository, provider execution, secret, or legacy deployment options.');
    }
    if (options.sandboxAction === 'create') {
      if (options.sandboxProfileId) throw new Error('sandbox create does not accept a profile id.');
      if (!options.resourcePrefix) throw new Error('sandbox create requires --resource-prefix.');
      if (!options.expiresAt) throw new Error('sandbox create requires --expires-at.');
      if (!options.maxProviderMutations) throw new Error('sandbox create requires --max-provider-mutations.');
      if (!options.yes) throw new Error('sandbox create requires --yes.');
      if (options.execute || options.databaseRuntimeProfileId || options.allowDatabaseMigration) {
        throw new Error('sandbox create does not execute provider actions or accept Database Runtime options.');
      }
      if (options.approvedBy) throw new Error('sandbox create does not accept --approved-by.');
      return;
    }
    if (!options.sandboxProfileId) throw new Error(`sandbox ${options.sandboxAction} requires a profile id.`);
    const hasCreateOnlyOption = options.resourcePrefix || options.allowedDomains.length || options.protectedDomains.length ||
      options.allowPaidResources || options.maxProviderMutations || options.expiresAt || options.accountEnvironment;
    if (options.sandboxAction === 'revoke') {
      if (!options.yes) throw new Error('sandbox revoke requires --yes.');
      if (hasCreateOnlyOption || options.execute || options.databaseRuntimeProfileId || options.allowDatabaseMigration) {
        throw new Error('sandbox revoke only accepts project id, profile id, --graph, --adapter-plan, --yes, --approved-by, --home, and --json.');
      }
      return;
    }
    if (options.sandboxAction === 'preflight') {
      if (hasCreateOnlyOption || options.yes || options.execute || options.approvedBy || options.allowDatabaseMigration) {
        throw new Error('sandbox preflight accepts an optional --database-runtime-profile but never an execution authorization flag.');
      }
      return;
    }
    if (['apply', 'resume'].includes(options.sandboxAction)) {
      if (!options.sandboxPreflightId) throw new Error(`sandbox ${options.sandboxAction} requires --preflight.`);
      if (!options.execute || !options.yes || !options.allowSandboxNetwork || !options.allowProviderMutations) {
        throw new Error(`sandbox ${options.sandboxAction} requires --execute --yes --allow-sandbox-network --allow-provider-mutations.`);
      }
      if (Boolean(options.databaseRuntimeProfileId) !== Boolean(options.allowDatabaseMigration)) {
        throw new Error(`sandbox ${options.sandboxAction} requires --database-runtime-profile and --allow-database-migration together.`);
      }
      if (options.sandboxAction === 'resume' && !options.runId) throw new Error('sandbox resume requires --run.');
      if (options.sandboxAction === 'apply' && options.runId) throw new Error('sandbox apply does not accept --run.');
      if (hasCreateOnlyOption || options.approvedBy || options.allowProviderDeletes || options.providerMode ||
          options.probeAuth || options.probeSecrets || options.unsafeRevealSecrets || options.latestRun) {
        throw new Error(`sandbox ${options.sandboxAction} contains unsupported execution options.`);
      }
      return;
    }
    if (options.sandboxAction === 'report') {
      if (!options.runId) throw new Error('sandbox report requires --run.');
      if (hasControlOnlyConflict({ ...options, runId: '' }) || hasCreateOnlyOption ||
          options.sandboxPreflightId || options.yes || options.execute ||
          options.approvedBy || options.allowSandboxNetwork || options.allowProviderMutations ||
          options.allowCostMutations || options.allowDatabaseMigration || options.databaseRuntimeProfileId ||
          options.probeSecrets || options.latestRun) {
        throw new Error('sandbox report only accepts project id, profile id, --graph, --adapter-plan, --run, --home, and --json.');
      }
      return;
    }
    if (hasCreateOnlyOption || options.yes || options.execute || options.approvedBy ||
        options.databaseRuntimeProfileId || options.allowDatabaseMigration) {
      throw new Error('sandbox show only accepts project id, profile id, --graph, --adapter-plan, --home, and --json.');
    }
    return;
  }

  if (!options.projectAction) throw new Error('project requires an action: add, list, show, update, or remove.');
  if (options.projectAction === 'add') {
    if (!options.repo) throw new Error('project add requires --repo.');
    if (options.includeArchived || options.refreshSource) {
      throw new Error('project add does not support --all or --refresh-source.');
    }
    return;
  }
  if (options.projectAction === 'list') {
    if (options.projectId || options.repo || options.name || options.refreshSource) {
      throw new Error('project list only accepts --home, --all, and --json.');
    }
    return;
  }
  if (!options.projectId) throw new Error(`project ${options.projectAction} requires a project id.`);
  if (options.projectAction === 'show') {
    if (options.repo || options.name || options.refreshSource) {
      throw new Error('project show only accepts a project id, --home, --all, and --json.');
    }
    return;
  }
  if (options.projectAction === 'update') {
    if (options.includeArchived) throw new Error('project update does not support --all.');
    if (!options.repo && !options.name && !options.refreshSource) {
      throw new Error('project update requires --repo, --name, or --refresh-source.');
    }
    return;
  }
  if (options.projectAction === 'remove') {
    if (options.repo || options.name || options.includeArchived || options.refreshSource) {
      throw new Error('project remove only accepts a project id, --home, --yes, and --json.');
    }
  }
}

function hasControlOnlyConflict(options) {
  return Boolean(
    options.force || options.allowProviderMutations || options.allowCostMutations || options.allowProviderDeletes ||
    options.allowProviderNetwork ||
    options.probeAuth || options.unsafeRevealSecrets || options.providerExplicit || options.targetExplicit ||
    options.providerMode || options.repo || options.name || options.domain || options.artifactId ||
    options.artifactOutputDirs.length || options.importAction || options.launchAction || options.approvalAction ||
    options.approvalId || options.nodeIds || options.providerAction || options.providerCatalogId ||
    options.connectionAction || options.connectionId || options.secretRefs.length || options.connectionScope ||
    options.expectedVersion || options.recipeAction || options.recipeId || options.bootstrapPlanAction ||
    options.bootstrapPlanId || options.secretBackend || options.humanHandoffAction || options.handoffId ||
    options.handoffAttestationId || options.handoffPhase || options.handoffOwner || options.handoffDeadline ||
    options.handoffSpecFile || options.candidateEvidenceId || options.manifestAction ||
    options.includeArchived || options.refreshSource || options.latestRun || options.runId || options.expectPlan ||
    options.requireReviewFile || options.requireDiffFile || options.outFile
  );
}

function validateEmailDeliveryOptions(options) {
  if (!options.emailDeliveryAction) {
    throw new Error('email-delivery requires an action: create, show, approve, approval, revoke, apply, resume, or run.');
  }
  if (!options.projectId) throw new Error(`email-delivery ${options.emailDeliveryAction} requires a project id.`);
  const unrelated = Boolean(
    options.force || options.allowProviderDeletes || options.probeAuth || options.probeSecrets ||
    options.unsafeRevealSecrets || options.providerExplicit || options.targetExplicit || options.providerMode ||
    options.repo || options.name || options.domain || options.artifactId || options.artifactOutputDirs.length ||
    options.importAction || options.launchAction || options.approvalAction || options.approvalId || options.nodeIds ||
    options.providerAction || options.providerCatalogId || options.secretAction || options.secretRef || options.fromStdin ||
    options.overwriteSecret || options.connectionAction || options.connectionId || options.secretRefs.length ||
    options.connectionScope || options.expectedVersion || options.recipeAction || options.recipeId ||
    options.bootstrapPlanAction || options.bootstrapPlanId || options.secretBackend || options.firstLaunchAction ||
    options.sessionId || options.sessionOwner || options.sessionDeadline || options.humanHandoffAction ||
    options.handoffId || options.handoffAttestationId || options.handoffPhase || options.handoffOwner ||
    options.handoffDeadline || options.handoffSpecFile || options.candidateEvidenceId || options.cutoverHandoffId ||
    options.cutoverAttestationId || options.productionEvidenceId || options.manifestAction || options.launchConfigAction ||
    options.settingsFile || options.dnsChangeAction || options.dnsChangeSetId || options.candidateAction ||
    options.verificationAction || options.verificationSpecFile || options.verificationPhase || options.rollbackAction ||
    options.rollbackPlanId || options.rollbackApprovalId || options.rollbackStepIds || options.migrationPlanAction ||
    options.migrationPlanId || options.migrationSpecFile || options.backupEvidenceAction || options.backupEvidenceId ||
    options.adapterPlanAction || options.adapterPlanId || options.actionsFile || options.sandboxAction ||
    options.sandboxProfileId || options.sandboxPreflightId || options.accountEnvironment || options.resourcePrefix ||
    options.allowedDomains.length || options.allowPaidResources || options.allowSandboxNetwork ||
    options.allowRollbackNetwork || options.allowDatabaseRestore || options.allowDatabaseMigration ||
    options.databaseRuntimeAction || options.databaseRuntimeProfileId || options.databaseHosts.length ||
    options.acceptanceSuiteAction || options.acceptanceSuiteId || options.acceptanceRunIds.length ||
    options.acceptanceProviders.length || options.acceptanceCleanupAction || options.cleanupPlanId ||
    options.cleanupAttestationId || options.cleanupOwner || options.cleanupDeadline || options.cleanupSpecFile ||
    options.maxProviderMutations || options.includeArchived || options.refreshSource || options.latestRun || options.runId ||
    options.expectPlan || options.requireReviewFile || options.requireDiffFile || options.outFile
  );
  if (unrelated) throw new Error('email-delivery accepts only its action-specific control options, --home, and --json.');

  const action = options.emailDeliveryAction;
  const executing = ['apply', 'resume'].includes(action);
  if (!executing && (options.execute || options.allowNetwork || options.allowProviderMutations || options.allowCostMutations)) {
    throw new Error('Email Delivery execution flags are only accepted by apply/resume.');
  }
  if (action !== 'create' && (
    options.graphId || options.launchConfigurationId || options.verificationPlanId ||
    options.provisioningConnectionId || options.sendingConnectionId || options.fromLocalPart
  )) {
    throw new Error('Graph, configuration, verification, and Connection options are only accepted by email-delivery create.');
  }
  if (action === 'create') {
    if (!options.graphId || !options.launchConfigurationId || !options.verificationPlanId ||
        !options.provisioningConnectionId || !options.sendingConnectionId) {
      throw new Error('email-delivery create requires --graph, --launch-config, --verification-plan, --provisioning-connection, and --sending-connection.');
    }
    if (options.emailDeliveryPlanId || options.emailDeliveryApprovalId || options.emailDeliveryRunId ||
        options.expiresAt || options.approvedBy || options.yes) {
      throw new Error('email-delivery create is plan-only and does not accept control ids, approval fields, or --yes.');
    }
    return;
  }
  if (action === 'show') {
    if (!options.emailDeliveryPlanId) throw new Error('email-delivery show requires a plan id.');
    if (options.emailDeliveryApprovalId || options.emailDeliveryRunId || options.expiresAt || options.approvedBy || options.yes) {
      throw new Error('email-delivery show only accepts project id, plan id, --home, and --json.');
    }
    return;
  }
  if (action === 'approve') {
    if (!options.emailDeliveryPlanId || !options.expiresAt || !options.approvedBy || !options.yes) {
      throw new Error('email-delivery approve requires a plan id, --expires-at, --approved-by, and --yes.');
    }
    if (options.emailDeliveryApprovalId || options.emailDeliveryRunId) {
      throw new Error('email-delivery approve does not accept Approval or Run ids.');
    }
    return;
  }
  if (action === 'approval' || action === 'revoke') {
    if (!options.emailDeliveryApprovalId) throw new Error(`email-delivery ${action} requires an approval id.`);
    if (options.emailDeliveryPlanId || options.emailDeliveryRunId || options.expiresAt) {
      throw new Error(`email-delivery ${action} does not accept Plan, Run, or expiration options.`);
    }
    if (action === 'approval' && (options.approvedBy || options.yes)) {
      throw new Error('email-delivery approval does not accept --approved-by or --yes.');
    }
    if (action === 'revoke' && (!options.approvedBy || !options.yes)) {
      throw new Error('email-delivery revoke requires --approved-by --yes.');
    }
    return;
  }
  if (action === 'apply') {
    if (!options.emailDeliveryPlanId || !options.emailDeliveryApprovalId) {
      throw new Error('email-delivery apply requires a plan id and --email-delivery-approval.');
    }
    if (options.emailDeliveryRunId || options.expiresAt || options.approvedBy) {
      throw new Error('email-delivery apply does not accept Run, expiration, or actor options.');
    }
  } else if (action === 'resume') {
    if (!options.emailDeliveryRunId) throw new Error('email-delivery resume requires a run id.');
    if (options.emailDeliveryPlanId || options.expiresAt || options.approvedBy) {
      throw new Error('email-delivery resume derives its Plan from the Run and only accepts an optional replacement Approval.');
    }
  } else {
    if (!options.emailDeliveryRunId) throw new Error('email-delivery run requires a run id.');
    if (options.emailDeliveryPlanId || options.emailDeliveryApprovalId || options.expiresAt || options.approvedBy || options.yes) {
      throw new Error('email-delivery run only accepts project id, run id, --home, and --json.');
    }
    return;
  }
  if (!options.execute || !options.yes || !options.allowNetwork ||
      !options.allowProviderMutations || !options.allowCostMutations) {
    throw new Error(`email-delivery ${action} requires --execute --yes --allow-network --allow-provider-mutations --allow-cost-mutations.`);
  }
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function requireInlineValue(arg, flag) {
  const value = arg.slice(`${flag}=`.length);
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return number;
}
