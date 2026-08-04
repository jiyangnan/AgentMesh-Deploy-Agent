import fs from 'node:fs';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

const GLOBAL_HELP = `AgentMesh Deploy

Usage:
  agentmesh-deploy help [command]
  agentmesh-deploy <command> --help
  agentmesh-deploy project add --repo path-or-url [--id project-id] [--name display-name] [--home path] [--json]
  agentmesh-deploy project list [--all] [--home path] [--json]
  agentmesh-deploy project show project-id [--all] [--home path] [--json]
  agentmesh-deploy project update project-id [--repo path-or-url] [--name display-name] [--refresh-source] [--home path] [--json]
  agentmesh-deploy project remove project-id --yes [--home path] [--json]
  agentmesh-deploy analyze project-id [--home path] [--json]
  agentmesh-deploy artifact create project-id [--home path] [--json]
  agentmesh-deploy artifact build project-id [--artifact-output relative-dir] [--home path] [--json]
  agentmesh-deploy artifact build project-id --execute --yes [--force] [--artifact-output relative-dir] [--home path] [--json]
  agentmesh-deploy artifact vercel project-id [--home path] [--json]
  agentmesh-deploy artifact list project-id [--home path] [--json]
  agentmesh-deploy artifact show project-id artifact-id [--home path] [--json]
  agentmesh-deploy artifact verify project-id artifact-id [--home path] [--json]
  agentmesh-deploy import legacy --repo path [--id project-id] [--name display-name] [--home path] [--json]
  agentmesh-deploy launch plan project-id [--home path] [--json]
  agentmesh-deploy launch list project-id [--home path] [--json]
  agentmesh-deploy launch show project-id [graph-id] [--home path] [--json]
  agentmesh-deploy launch apply project-id [graph-id] [--home path] [--json]
  agentmesh-deploy launch apply project-id [graph-id] --execute --yes --provider-mode fixture --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy launch apply project-id graph-id --execute --yes --provider-mode real --adapter-plan adapter-plan-id --sandbox-profile sandbox-profile-id --preflight sandbox-preflight-id --allow-provider-network --allow-provider-mutations [--database-runtime-profile profile-id --allow-database-migration] [--allow-cost-mutations] [--home path] [--json]
  agentmesh-deploy launch resume project-id run-id [--home path] [--json]
  agentmesh-deploy launch resume project-id run-id --execute --yes --provider-mode fixture --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy launch resume project-id run-id --execute --yes --provider-mode real --adapter-plan adapter-plan-id --sandbox-profile sandbox-profile-id --preflight sandbox-preflight-id --allow-provider-network --allow-provider-mutations [--database-runtime-profile profile-id --allow-database-migration] [--allow-cost-mutations] [--home path] [--json]
  agentmesh-deploy approval create project-id --graph graph-id --nodes node-a,node-b --expires-at timestamp --yes [--home path] [--json]
  agentmesh-deploy approval list project-id [--home path] [--json]
  agentmesh-deploy approval show project-id approval-id [--home path] [--json]
  agentmesh-deploy approval revoke project-id approval-id --yes [--home path] [--json]
  agentmesh-deploy provider list [--json]
  agentmesh-deploy provider show provider-id [--json]
  agentmesh-deploy provider guide provider-id [--json]
  agentmesh-deploy secret capture keychain://service/account --stdin --yes [--overwrite] [--json]
  agentmesh-deploy connection add project-id connection-id --provider provider-id --secret-ref ENV=secret-ref [--scope scope] [--home path] [--json]
  agentmesh-deploy connection copy target-project-id target-connection-id --from-project source-project-id --from-connection source-connection-id --expected-version n [--home path] [--json]
  agentmesh-deploy connection list project-id [--all] [--home path] [--json]
  agentmesh-deploy connection show project-id connection-id [--all] [--home path] [--json]
  agentmesh-deploy connection update project-id connection-id --expected-version n [--provider provider-id] [--secret-ref ENV=secret-ref] [--scope scope] [--home path] [--json]
  agentmesh-deploy connection remove project-id connection-id --expected-version n --yes [--home path] [--json]
  agentmesh-deploy connection check project-id connection-id [--home path] [--json]
  agentmesh-deploy connection probe project-id connection-id --probe-auth [--home path] [--json]
  agentmesh-deploy recipe plan project-id [--home path] [--json]
  agentmesh-deploy recipe list project-id [--home path] [--json]
  agentmesh-deploy recipe show project-id [recipe-id] [--home path] [--json]
  agentmesh-deploy bootstrap-plan create project-id [--recipe recipe-id] [--secret-backend env|keychain] [--home path] [--json]
  agentmesh-deploy bootstrap-plan show project-id bootstrap-plan-id [--home path] [--json]
  agentmesh-deploy first-launch start project-id --owner actor --deadline timestamp [--secret-backend env|keychain] [--home path] [--json]
  agentmesh-deploy first-launch status project-id first-launch-id [--home path] [--json]
  agentmesh-deploy first-launch resume project-id first-launch-id [--deadline timestamp] [--settings-file settings.json] [--sandbox-profile sandbox-id] [--approval approval-id] [--preflight preflight-id] [--run run-id] [--migration-plan migration-plan-id] [--backup-evidence evidence-id] [--database-runtime-profile profile-id] [--verification-plan plan-id] [--candidate-evidence evidence-id] [--cutover-handoff handoff-id] [--cutover-attestation attestation-id] [--email-delivery-plan plan-id] [--email-delivery-approval approval-id] [--email-delivery-run run-id] [--production-evidence evidence-id] [--rollback-plan plan-id] [--rollback-approval approval-id] [--home path] [--json]
  agentmesh-deploy human-handoff create project-id --bootstrap-plan bootstrap-plan-id --handoff-phase bootstrap|configuration --handoff-owner actor --handoff-deadline timestamp [--home path] [--json]
  agentmesh-deploy human-handoff create project-id --bootstrap-plan bootstrap-plan-id --handoff-phase cutover --candidate-evidence product-verification-id --handoff-owner actor --handoff-deadline timestamp [--home path] [--json]
  agentmesh-deploy human-handoff attest project-id human-handoff-id --handoff-spec results.json --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy human-handoff show project-id human-handoff-id [human-attestation-id] [--home path] [--json]
  agentmesh-deploy manifest create project-id [--recipe recipe-id] [--home path] [--json]
  agentmesh-deploy manifest show project-id [--home path] [--json]
  agentmesh-deploy launch-config create project-id --graph graph-id --settings-file settings.json [--home path] [--json]
  agentmesh-deploy launch-config show project-id launch-config-id --graph graph-id [--home path] [--json]
  agentmesh-deploy dns-change create project-id --graph graph-id --launch-config launch-config-id [--acceptance-only] [--home path] [--json]
  agentmesh-deploy dns-change show project-id dns-change-set-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy candidate verify project-id --graph graph-id --launch-config launch-config-id --allow-network --yes [--home path] [--json]
  agentmesh-deploy verification create project-id --graph graph-id --launch-config launch-config-id --verification-spec spec.json [--home path] [--json]
  agentmesh-deploy verification show project-id verification-plan-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy verification run project-id verification-plan-id --graph graph-id --launch-config launch-config-id --phase candidate|production [--database-runtime-profile profile-id] [--email-delivery-run run-id] --allow-network --yes [--home path] [--json]
  agentmesh-deploy email-delivery create project-id --graph graph-id --launch-config launch-config-id --verification-plan plan-id --provisioning-connection connection-id --sending-connection connection-id [--from-local-part verification] [--home path] [--json]
  agentmesh-deploy email-delivery show project-id email-delivery-plan-id [--home path] [--json]
  agentmesh-deploy email-delivery approve project-id email-delivery-plan-id --expires-at timestamp --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy email-delivery approval project-id email-delivery-approval-id [--home path] [--json]
  agentmesh-deploy email-delivery revoke project-id email-delivery-approval-id --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy email-delivery apply project-id email-delivery-plan-id --email-delivery-approval approval-id --execute --yes --allow-network --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy email-delivery resume project-id email-delivery-run-id [--email-delivery-approval replacement-approval-id] --execute --yes --allow-network --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy email-delivery run project-id email-delivery-run-id [--home path] [--json]
  agentmesh-deploy rollback create project-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy rollback show project-id rollback-plan-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy rollback approve project-id rollback-plan-id --graph graph-id --launch-config launch-config-id --steps dns.restore --expires-at timestamp --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy rollback list-approvals project-id [--home path] [--json]
  agentmesh-deploy rollback approval project-id rollback-approval-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy rollback revoke project-id rollback-approval-id --graph graph-id --launch-config launch-config-id --yes [--approved-by actor] [--home path] [--json]
  agentmesh-deploy rollback apply project-id rollback-plan-id --graph graph-id --launch-config launch-config-id --rollback-approval rollback-approval-id --execute --yes --allow-rollback-network --allow-provider-mutations [--allow-database-restore --database-runtime-profile profile-id] [--home path] [--json]
  agentmesh-deploy rollback resume project-id rollback-run-id --launch-config launch-config-id --execute --yes --allow-rollback-network --allow-provider-mutations [--allow-database-restore --database-runtime-profile profile-id] [--home path] [--json]
  agentmesh-deploy migration-plan create project-id --graph graph-id --launch-config launch-config-id --migration-spec spec.json [--home path] [--json]
  agentmesh-deploy migration-plan show project-id migration-plan-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy database-runtime create project-id --graph graph-id --adapter-plan adapter-plan-id --database-host host --expires-at timestamp --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy database-runtime show project-id database-runtime-profile-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]
  agentmesh-deploy database-runtime revoke project-id database-runtime-profile-id --graph graph-id --adapter-plan adapter-plan-id --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy acceptance-suite readiness project-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy acceptance-suite create project-id --acceptance-run run-id [--acceptance-run run-id...] [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy acceptance-suite show project-id acceptance-suite-id [--home path] [--json]
  agentmesh-deploy acceptance-portfolio create --acceptance-suite-ref project-id:acceptance-suite-id [--acceptance-suite-ref project-id:acceptance-suite-id...] [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy acceptance-portfolio show acceptance-portfolio-id [--home path] [--json]
  agentmesh-deploy acceptance-cleanup create project-id --acceptance-suite suite-id --cleanup-owner actor --cleanup-deadline timestamp [--home path] [--json]
  agentmesh-deploy acceptance-cleanup attest project-id cleanup-plan-id --cleanup-spec dispositions.json --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy acceptance-cleanup show project-id cleanup-plan-id [cleanup-attestation-id] [--home path] [--json]
  agentmesh-deploy source-patch create project-id --patch-file change.patch --patch-reason reason [--home path] [--json]
  agentmesh-deploy source-patch show project-id source-patch-id [--home path] [--json]
  agentmesh-deploy backup-evidence create project-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]
  agentmesh-deploy backup-evidence show project-id backup-evidence-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]
  agentmesh-deploy adapter-plan create project-id --graph graph-id --actions-file actions.json [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id --dns-change-set dns-change-set-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id --migration-plan migration-plan-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id --migration-plan migration-plan-id --backup-evidence backup-evidence-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan show project-id adapter-plan-id --graph graph-id [--home path] [--json]
  agentmesh-deploy sandbox create project-id --graph graph-id --adapter-plan adapter-plan-id --resource-prefix prefix --max-provider-mutations n --expires-at timestamp --yes [--account-environment test] [--allow-paid-resources] [--allowed-domain domain] [--protected-domain domain] [--home path] [--json]
  agentmesh-deploy sandbox show project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]
  agentmesh-deploy sandbox preflight project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id [--database-runtime-profile profile-id] [--probe-secrets] [--home path] [--json]
  agentmesh-deploy sandbox apply project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --preflight sandbox-preflight-id --execute --yes --allow-sandbox-network --allow-provider-mutations [--database-runtime-profile profile-id --allow-database-migration] [--allow-cost-mutations] [--home path] [--json]
  agentmesh-deploy sandbox resume project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --preflight sandbox-preflight-id --run run-id --execute --yes --allow-sandbox-network --allow-provider-mutations [--allow-cost-mutations] [--home path] [--json]
  agentmesh-deploy sandbox report project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --run run-id [--home path] [--json]
  agentmesh-deploy sandbox revoke project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --yes [--approved-by actor] [--home path] [--json]
  agentmesh-deploy init [path] [--name app-name] [--preset detected|saas] [--force]
  agentmesh-deploy onboard [path] [--name app-name] [--preset detected|saas] [--force] [--json]
  agentmesh-deploy detect [path] [--json]
  agentmesh-deploy validate [path] [--json]
  agentmesh-deploy schema
  agentmesh-deploy plan [path] [--json] [--no-save]
  agentmesh-deploy doctor [path] [--json] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]
  agentmesh-deploy prepare [path] [--json] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]
  agentmesh-deploy review [path] [--json] [--out file] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]
  agentmesh-deploy handoff [path] [--json] [--out file] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]
  agentmesh-deploy preview [path] [--json] [--unsafe-reveal-secrets]
  agentmesh-deploy diff [path] [--json] [--out file] [--unsafe-reveal-secrets]
  agentmesh-deploy runs [path] [--json] [--latest|--run id] [--limit n]
  agentmesh-deploy secrets [path] [--json]
  agentmesh-deploy apply [path] [--dry-run] [--expect-plan fingerprint] [--require-review file] [--require-diff file]
  agentmesh-deploy apply [path] --execute --yes [--expect-plan fingerprint] [--require-review file] [--require-diff file]
  agentmesh-deploy apply [path] --execute --yes --allow-provider-mutations [--allow-cost-mutations] [--expect-plan fingerprint] [--require-review file] [--require-diff file]
  agentmesh-deploy status [path] [--json] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]
  agentmesh-deploy destroy [path] [--dry-run]

Aliases:
  amd <command>

Notes:
  project, analyze, artifact, import, launch, approval, secret, connection, recipe, bootstrap-plan, first-launch, human-handoff, manifest, launch-config, candidate, verification, email-delivery, rollback, dns-change, migration-plan, source-patch, backup-evidence, adapter-plan, and sandbox are independent-control commands; they never require deployment state inside product repositories.
  analyze detects an isolated checkout of the registered commit and verifies the local source stayed unchanged.
  artifact create exports only the locked Git tree into a content-addressed immutable source archive.
  artifact build defaults to a plan; --execute --yes runs only in an isolated locked-commit checkout with a minimal credential-free environment.
  artifact vercel creates an immutable file manifest and content-addressed blobs without calling Vercel.
  import legacy reads a V1 sidecar once and writes only external V2 control records and migration evidence.
  launch plan creates an immutable deterministic graph without executing provider actions.
  launch apply/resume default to V2 dry-run; explicit fixture execution exercises Graph/State/Run recovery without real provider calls.
  --provider-mode real is the generic provider entrypoint and delegates to the same Profile, Approval, Preflight, budget, fixed-host network, and mutation gates as sandbox apply/resume.
  provider guide prints official-document-driven bootstrap steps without reading or storing secret values.
  connection stores only external Secret Refs and uses optimistic versions for update/archive.
  recipe plan selects a provider combination from external analysis without calling provider APIs.
  bootstrap-plan compiles project-specific credential guidance and current Connection readiness without reading secret values or calling providers.
  manifest create writes native V2 deployment intent and initial state only to the external control plane.
  launch-config captures reviewed business decisions and Secret Refs without secret values.
  dns-change merges only a verified candidate target and scoped email DNS Intent; it does not call DNS providers.
  candidate verify makes one unauthenticated exact-host HTTPS request and stores immutable release evidence.
  verification creates a two-phase product contract and records HTTPS/API/auth/database/email/rollback results without response bodies or secret values.
  rollback create derives an immutable recovery plan from failed production verification and exact DNS/database evidence; it performs no mutation.
  migration-plan reads only committed SQL from an isolated checkout, classifies risk, and executes no SQL.
  backup-evidence derives immutable proof from Schema/Snapshot receipts and performs no provider mutation.
  adapter-plan generate compiles provider methods and bindings from Launch Configuration; create remains an expert JSON entrypoint.
  Database stages additionally bind the immutable Migration Plan and never persist raw Schema JSON or SQL.
  sandbox creates expiring scope and preflight evidence; launch --provider-mode real reuses that authorization boundary instead of bypassing it.
  AGENTMESH_DEPLOY_HOME defaults to ~/.agentmesh-deploy and can be overridden with --home.
  project remove archives the registration; it does not delete the product repository or provider resources.
  apply and destroy default to dry-run.
  real command execution requires --execute --yes.
  --expect-plan refuses apply when the current plan fingerprint has changed.
  --require-review refuses apply unless a saved review artifact matches the current plan.
  --require-diff refuses apply unless a saved diff artifact matches current managed file changes.
  provider-side Cloudflare/GitHub/DigitalOcean/Porkbun mutations also require --allow-provider-mutations.
  cost-incurring provider mutations such as domain registration and droplet creation also require --allow-cost-mutations.
  onboard attaches or refreshes the local sidecar and prepares handoff evidence.
  doctor --probe-auth runs read-only provider authentication probes.
  prepare refreshes default review, diff, and handoff artifacts for a receiving agent.
  review is read-only and summarizes readiness, secrets, runs, drift, and next actions.
  review --out writes the packet to an explicit JSON file without mutating state.
  handoff --out writes the dossier to an explicit JSON file.
  preview redacts .env and .env.production values unless --unsafe-reveal-secrets is passed.
  diff is read-only and reports managed file changes with secret values redacted by default.
  runs is read-only and inspects local .agentmesh-deploy/runs artifacts.
  secrets is read-only and reports secret keys/sources without values.
  provider-side deletes are still blocked unless a future destroy executor enables them.

Command-specific help:
  agentmesh-deploy help apply
  agentmesh-deploy status --help`;

const COMMAND_HELP = new Map([
  ['project', `AgentMesh Deploy: project

Usage:
  agentmesh-deploy project add --repo path-or-url [--id project-id] [--name display-name] [--home path] [--json]
  agentmesh-deploy project list [--all] [--home path] [--json]
  agentmesh-deploy project show project-id [--all] [--home path] [--json]
  agentmesh-deploy project update project-id [--repo path-or-url] [--name display-name] [--refresh-source] [--home path] [--json]
  agentmesh-deploy project remove project-id --yes [--home path] [--json]

Purpose:
  Manage independent V2 project registrations outside product repositories.

Safety:
  Product repositories remain read-only.
  Local sources are bound to an immutable Git commit.
  The control home must be physically separate from the source repository.
  remove performs a recoverable logical archive and never deletes provider resources.`],

  ['analyze', `AgentMesh Deploy: analyze

Usage:
  agentmesh-deploy analyze project-id [--home path] [--json]

Purpose:
  Detect a registered project from an isolated checkout of its locked Git commit.

Writes:
  <home>/projects/<id>/analysis.json
  <home>/projects/<id>/runs/<run-id>.json
  <home>/workspaces/<id>/<run-id>/

Safety:
  The product repository is fingerprinted before and after the operation.
  No sidecar, workflow, environment file, Git index, branch, remote, or commit is changed.`],

  ['artifact', `AgentMesh Deploy: artifact

Usage:
  agentmesh-deploy artifact create project-id [--home path] [--json]
  agentmesh-deploy artifact build project-id [--artifact-output relative-dir] [--home path] [--json]
  agentmesh-deploy artifact build project-id --execute --yes [--force] [--artifact-output relative-dir] [--home path] [--json]
  agentmesh-deploy artifact vercel project-id [--home path] [--json]
  agentmesh-deploy artifact list project-id [--home path] [--json]
  agentmesh-deploy artifact show project-id artifact-id [--home path] [--json]
  agentmesh-deploy artifact verify project-id artifact-id [--home path] [--json]

Purpose:
  Plan, build, and inspect immutable source, runtime, and Vercel file-manifest artifacts from a registered Commit Snapshot.

Safety:
  create archives only the locked Git tree and never executes product scripts.
  vercel copies only regular files from the locked Git tree into external content-addressed blobs; it rejects symlinks, submodules, traversal, and tracked secrets.
  build is plan-only by default; --execute --yes is required before product install/build scripts run.
  executed builds use a detached isolated checkout, remove its origin remote, and receive no inherited credential variables.
  --artifact-output accepts repeatable safe relative output directories without writing configuration to the product repository.
  tracked .env, private-key, credential, and V1 runtime-state paths block artifact creation.
  verify recalculates SHA-256 and size before an artifact can be trusted.
  all files remain under AGENTMESH_DEPLOY_HOME; product repositories stay read-only.`],

  ['import', `AgentMesh Deploy: import

Usage:
  agentmesh-deploy import legacy --repo path [--id project-id] [--name display-name] [--home path] [--json]

Purpose:
  Import a V1 .agentmesh-deploy Manifest and State into the independent V2 control plane.

Migration rules:
  The source repository is local, read-only, and fingerprinted before and after import.
  Completed steps become succeeded V2 nodes; provider resources and facts become stale until reverified.
  Legacy run bodies and approvals are not copied, and prior approvals are explicitly invalidated.
  Repeating the exact import is idempotent; different ownership or source commits fail with a conflict.

Writes:
  <home>/projects/<id>/manifest.json
  <home>/projects/<id>/state.json
  <home>/projects/<id>/evidence/import-<id>.json
  <home>/projects/<id>/runs/import-<id>.json`],

  ['launch', `AgentMesh Deploy: launch

Usage:
  agentmesh-deploy launch plan project-id [--home path] [--json]
  agentmesh-deploy launch list project-id [--home path] [--json]
  agentmesh-deploy launch show project-id [graph-id] [--home path] [--json]
  agentmesh-deploy launch apply project-id [graph-id] [--home path] [--json]
  agentmesh-deploy launch apply project-id [graph-id] --execute --yes --provider-mode fixture --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy launch apply project-id graph-id --execute --yes --provider-mode real --adapter-plan adapter-plan-id --sandbox-profile sandbox-profile-id --preflight sandbox-preflight-id --allow-provider-network --allow-provider-mutations [--database-runtime-profile profile-id --allow-database-migration] [--allow-cost-mutations] [--home path] [--json]
  agentmesh-deploy launch resume project-id run-id [--home path] [--json]
  agentmesh-deploy launch resume project-id run-id --execute --yes --provider-mode fixture --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy launch resume project-id run-id --execute --yes --provider-mode real --adapter-plan adapter-plan-id --sandbox-profile sandbox-profile-id --preflight sandbox-preflight-id --allow-provider-network --allow-provider-mutations [--database-runtime-profile profile-id --allow-database-migration] [--allow-cost-mutations] [--home path] [--json]

Purpose:
  Build and inspect immutable LaunchGraph plans from external V2 Manifest and State contracts.

Planning rules:
  plan validates Project, Manifest, State, Source Ref, graph topology, statuses, and fingerprint.
  identical semantic inputs reuse the same graph id and immutable graph file.
  imported stale provider facts require reverification and never silently authorize a mutation.
  plan executes zero provider mutations and keeps the product repository read-only.
  apply/resume default to dry-run approval and node-readiness evaluation.
  explicit fixture mode executes the Graph against an external simulated provider store and persists State/Evidence/Run revisions.
  fixture provider/cost nodes retain the same mutation and budget flags as future real execution.
  --provider-mode real executes native provider adapters only through an active Sandbox Profile and current Preflight Evidence.
  real-provider Runs remain providerMode=sandbox so acceptance reports can prove the exact isolation and transport boundary.

Writes:
  <home>/projects/<id>/graphs/<graph-id>.json
  <home>/projects/<id>/graph.json
  <home>/projects/<id>/runs/launch-plan-<graph-id>.json`],

  ['approval', `AgentMesh Deploy: approval

Usage:
  agentmesh-deploy approval create project-id --graph graph-id --nodes node-a,node-b --expires-at timestamp --yes [--approved-by actor] [--home path] [--json]
  agentmesh-deploy approval list project-id [--home path] [--json]
  agentmesh-deploy approval show project-id approval-id [--home path] [--json]
  agentmesh-deploy approval revoke project-id approval-id --yes [--approved-by actor] [--home path] [--json]

Purpose:
  Create and inspect immutable, expiring approval scopes bound to one project and graph fingerprint.

Safety:
  create and revoke require explicit --yes confirmation.
  node scope can include only graph nodes that declare an approval policy; use --nodes all for all such nodes.
  expired, revoked, cross-project, or stale-graph approvals never authorize a run.
  revocation writes a separate tombstone and never overwrites the original approval.`],

  ['provider', `AgentMesh Deploy: provider

Usage:
  agentmesh-deploy provider list [--json]
  agentmesh-deploy provider show provider-id [--json]
  agentmesh-deploy provider guide provider-id [--json]

Purpose:
  Inspect provider automation capabilities and credential bootstrap guidance for AI agents.

Safety:
  Catalog commands are local and read-only.
  Guides identify which account, MFA, billing, terms, and token steps require a human.
  Output contains environment variable names and Secret Ref guidance, never credential values.
  A guide does not authenticate, create resources, incur cost, or authorize provider mutations.`],

  ['secret', `AgentMesh Deploy: secret

Usage:
  agentmesh-deploy secret capture keychain://service/account --stdin --yes [--overwrite] [--json]

Purpose:
  Capture one provider credential from stdin into the native macOS Keychain without placing the value in argv, environment variables, logs, or control files.

Safety:
  capture requires --stdin --yes and accepts no raw secret argument.
  the destination must be writable and empty; replacing an existing value additionally requires --overwrite.
  input is limited to 64 KiB and reaches security add-generic-password through child-process stdin only.
  output contains only the Secret Ref and status, never the value, length, digest, subprocess output, or credential-derived metadata.
  this command performs no provider request or product repository write.`],

  ['connection', `AgentMesh Deploy: connection

Usage:
  agentmesh-deploy connection add project-id connection-id --provider provider-id --secret-ref ENV=secret-ref [--scope scope] [--home path] [--json]
  agentmesh-deploy connection copy target-project-id target-connection-id --from-project source-project-id --from-connection source-connection-id --expected-version n [--home path] [--json]
  agentmesh-deploy connection list project-id [--all] [--home path] [--json]
  agentmesh-deploy connection show project-id connection-id [--all] [--home path] [--json]
  agentmesh-deploy connection update project-id connection-id --expected-version n [--provider provider-id] [--secret-ref ENV=secret-ref] [--scope scope] [--home path] [--json]
  agentmesh-deploy connection remove project-id connection-id --expected-version n --yes [--home path] [--json]
  agentmesh-deploy connection check project-id connection-id [--home path] [--json]
  agentmesh-deploy connection probe project-id connection-id --probe-auth [--home path] [--json]

Purpose:
  Manage project-scoped provider credential metadata in the external control plane.
  copy reuses only validated Secret Refs and scope across projects; the target is always unverified.

Safety:
  Secret values are rejected; refs must use env://, keychain://, op://, or secret://.
  copy requires the exact source version and never inherits identity, capabilities, or provider Probe evidence.
  provider-specific credential names and one-of/all-of rules are validated from the catalog.
  update and remove require expectedVersion; remove is a local logical archive and does not revoke provider credentials.
  check reports only present, missing, or not-probed and never returns a credential value.
  probe requires --probe-auth, executes provider-specific read-only identity and scope checks, and persists only a sanitized summary.`],

  ['recipe', `AgentMesh Deploy: recipe

Usage:
  agentmesh-deploy recipe plan project-id [--home path] [--json]
  agentmesh-deploy recipe list project-id [--home path] [--json]
  agentmesh-deploy recipe show project-id [recipe-id] [--home path] [--json]

Purpose:
  Select and inspect a deterministic provider strategy from a registered project's external analysis.

Planning rules:
  framework and environment-key signals determine runtime, database, auth, email, domain, and delivery requirements.
  the recipe reports deterministic provider alternatives, applicability, tradeoffs, missing/unverified connections, and decisions that require a human.
  price fields remain unknown until a live read-only pricing probe; the planner never invents a cost or claims budget qualification.
  planning performs zero provider mutations and keeps immutable recipe history by fingerprint.`],

  ['bootstrap-plan', `AgentMesh Deploy: bootstrap-plan

Usage:
  agentmesh-deploy bootstrap-plan create project-id [--recipe recipe-id] [--secret-backend env|keychain] [--home path] [--json]
  agentmesh-deploy bootstrap-plan show project-id bootstrap-plan-id [--home path] [--json]

Purpose:
  Compile one immutable, project-specific provider credential onboarding plan from the current LaunchRecipe and provider catalog.

Planning rules:
  the plan deduplicates providers across registrar, DNS, runtime, database, email, and delivery roles.
  each provider includes human-only account steps, credential choices and scopes, official documentation, Secret Refs, and exact connection add/check/probe argv.
  show revalidates the bound Project, Commit, Recipe, Plan fingerprint, and current Connection readiness.

Safety:
  create/show never reads credential values, probes a provider, performs a provider mutation, or writes the product repository.
  account signup, MFA, terms, billing, and provider-side token creation remain human-only.
  keychain refs are native to macOS; use --secret-backend env on other platforms.`],

  ['human-handoff', `AgentMesh Deploy: human-handoff

Usage:
  agentmesh-deploy human-handoff create project-id --bootstrap-plan bootstrap-plan-id --handoff-phase bootstrap|configuration --handoff-owner actor --handoff-deadline timestamp [--home path] [--json]
  agentmesh-deploy human-handoff create project-id --bootstrap-plan bootstrap-plan-id --handoff-phase cutover --candidate-evidence product-verification-id --handoff-owner actor --handoff-deadline timestamp [--home path] [--json]
  agentmesh-deploy human-handoff attest project-id human-handoff-id --handoff-spec results.json --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy human-handoff show project-id human-handoff-id [human-attestation-id] [--home path] [--json]

Purpose:
  Turn provider onboarding and launch decisions that require a person into immutable, resumable HumanHandoff tasks and separate human attestations.

Safety:
  tasks are derived from the bound ProviderBootstrapPlan, Provider Catalog, and LaunchRecipe rather than arbitrary browser instructions.
  account signup, MFA, CAPTCHA, legal terms, billing, OAuth, domain purchase, and production cutover remain human-controlled.
  attestations must cover every task; any blocked result keeps the handoff blocked and cannot be rewritten into completion.
  reasons must contain no secret-like value, and human attestation is never treated as provider API verification.
  create/attest/show execute zero browser actions, network requests, provider mutations, or product repository writes.`],

  ['first-launch', `AgentMesh Deploy: first-launch

Usage:
  agentmesh-deploy first-launch start project-id --owner actor --deadline timestamp [--secret-backend env|keychain] [--home path] [--json]
  agentmesh-deploy first-launch status project-id first-launch-id [--home path] [--json]
  agentmesh-deploy first-launch resume project-id first-launch-id [--deadline timestamp] [--settings-file settings.json] [--sandbox-profile sandbox-id] [--approval approval-id] [--preflight preflight-id] [--run run-id] [--migration-plan migration-plan-id] [--backup-evidence evidence-id] [--database-runtime-profile profile-id] [--verification-plan plan-id] [--candidate-evidence evidence-id] [--cutover-handoff handoff-id] [--cutover-attestation attestation-id] [--email-delivery-plan plan-id] [--email-delivery-approval approval-id] [--email-delivery-run run-id] [--production-evidence evidence-id] [--rollback-plan plan-id] [--rollback-approval approval-id] [--home path] [--json]

Purpose:
  Start and resume one project-level first-launch workflow without making the product repository a deployment sidecar.
  Candidate Profile, Approval, and Preflight ids are adopted only after exact graph, plan, scope, owner, and expiry validation.

Safety:
  start creates only external Recipe, Bootstrap Plan, Bootstrap HumanHandoff, and FirstLaunchSession objects.
  status revalidates every bound fingerprint and returns exact next actions without network access.
  resume may create Connection metadata and, after Configuration Attestation, local Manifest/Artifact/Graph/Configuration objects; it never reads secrets or probes providers.
  candidate execution and production cutover remain later dedicated phases and cannot be approved through this local control workflow.`],

  ['manifest', `AgentMesh Deploy: manifest

Usage:
  agentmesh-deploy manifest create project-id [--recipe recipe-id] [--home path] [--json]
  agentmesh-deploy manifest show project-id [--home path] [--json]

Purpose:
  Create or inspect a native external DeploymentManifest V2 and initial DeploymentState V2.

Safety:
  create consumes external analysis and an immutable recipe; it never writes the product repository.
  an existing Manifest or State is never overwritten, including a V1 import result.
  provider connections are referenced by readiness metadata, never embedded credential values.
  creation performs zero provider mutations and binds the contract to the locked Source Commit.`],

  ['adapter-plan', `AgentMesh Deploy: adapter-plan

Usage:
  agentmesh-deploy adapter-plan create project-id --graph graph-id --actions-file actions.json [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id --dns-change-set dns-change-set-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id --migration-plan migration-plan-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan generate project-id --graph graph-id --launch-config launch-config-id --migration-plan migration-plan-id --backup-evidence backup-evidence-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy adapter-plan show project-id adapter-plan-id --graph graph-id [--home path] [--json]

Purpose:
  Generate, create, or inspect an immutable AdapterExecutionPlan bound to a LaunchGraph and ready ProviderConnections.

Safety:
  the actions file is read-only, must be regular JSON, and is limited to 1 MiB.
  --acceptance-provider creates a provider-scoped plan for real-account acceptance, retaining only the requested provider actions and required action-binding dependencies.
  provider-scoped generation reports incomplete Graph prerequisites and never treats a different provider's failure as target-provider coverage.
  provider methods must match the exact Graph node operation/resource type and registered Plan/Execute pair.
  raw secrets, delete methods, executor gates, malformed Secret Refs, and unsafe result bindings are rejected.
  database inspect/backup/migrate actions require an exact external DatabaseMigrationPlan ID and fingerprint.
  create performs zero provider calls and writes only under AGENTMESH_DEPLOY_HOME.`],

  ['backup-evidence', `AgentMesh Deploy: backup-evidence

Usage:
  agentmesh-deploy backup-evidence create project-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]
  agentmesh-deploy backup-evidence show project-id backup-evidence-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]

Purpose:
  Create or inspect immutable pre-migration backup proof derived from Adapter receipts.

Safety:
  evidence requires succeeded candidate, Schema inspection, Snapshot creation/operation, and exact Snapshot verification.
  adjacent Intent and Receipt fingerprints are revalidated; raw Schema, SQL, and secret values are not persisted.
  create performs zero provider calls and writes only under AGENTMESH_DEPLOY_HOME.`],

  ['launch-config', `AgentMesh Deploy: launch-config

Usage:
  agentmesh-deploy launch-config create project-id --graph graph-id --settings-file settings.json [--home path] [--json]
  agentmesh-deploy launch-config show project-id launch-config-id --graph graph-id [--home path] [--json]

Purpose:
  Create or inspect immutable reviewed launch decisions bound to Project, Recipe, and LaunchGraph.

Safety:
  settings accept domain, runtime, database, email, budget, and Secret Ref decisions but never raw tokens or passwords.
  provider identities are derived from the immutable Recipe and cannot be silently replaced by the settings file.
  create performs zero provider calls and writes only under AGENTMESH_DEPLOY_HOME.`],

  ['dns-change', `AgentMesh Deploy: dns-change

Usage:
  agentmesh-deploy dns-change create project-id --graph graph-id --launch-config launch-config-id [--acceptance-only] [--home path] [--json]
  agentmesh-deploy dns-change show project-id dns-change-set-id --graph graph-id --launch-config launch-config-id [--home path] [--json]

Purpose:
  Create an immutable production-cutover or provider-acceptance exact-record-set change package.
  --acceptance-only creates an email-only package for isolated Cloudflare + Resend provider acceptance.

Safety:
  production-cutover creation requires current candidate.deploy and candidate.verify Graph evidence.
  acceptance-only requires current Resend Domain evidence, an exact Provider ID, and an isolated email subdomain.
  it can only compile with both --acceptance-provider cloudflare and --acceptance-provider resend and is rejected by First Launch cutover.
  web records may replace one exact record set after approval; email records are create-only and remain below the approved sending subdomain.
  root MX, CNAME conflicts, duplicate identities, out-of-scope email names, and tampering are rejected.
  create performs zero provider calls and never modifies the product repository.`],

  ['candidate', `AgentMesh Deploy: candidate

Usage:
  agentmesh-deploy candidate verify project-id --graph graph-id --launch-config launch-config-id --allow-network --yes [--home path] [--json]

Purpose:
  Verify the temporary candidate release before any production DNS change is generated.

Safety:
  the URL comes only from current Graph candidate.deploy State; arbitrary user URLs are not accepted.
  verification allows one unauthenticated root HTTPS GET to the exact candidate host with redirects disabled.
  production hosts, URL credentials, custom ports, query/fragment, localhost, private IPs, cookies, and response bodies are rejected or ignored.
  success writes immutable external Evidence and advances only candidate.verify; it never modifies the product repository.`],

  ['verification', `AgentMesh Deploy: verification

Usage:
  agentmesh-deploy verification create project-id --graph graph-id --launch-config launch-config-id --verification-spec spec.json [--home path] [--json]
  agentmesh-deploy verification show project-id verification-plan-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy verification run project-id verification-plan-id --graph graph-id --launch-config launch-config-id --phase candidate|production [--database-runtime-profile profile-id] [--email-delivery-run run-id] --allow-network --yes [--home path] [--json]

Purpose:
  Define and execute immutable candidate and production product acceptance checks.

Safety:
  candidate targets come only from current Graph State; production targets come only from LaunchConfiguration.
  HTTP checks use exact-origin HTTPS GET/HEAD with redirects disabled and never persist response bodies or cookies.
  database, real-login, and rollback checks require explicit runtime capabilities or remain failed/needs-human; production email delivery may adopt one succeeded exact-match Email Delivery Run.
  only a fully passed candidate phase can authorize a new DNS ChangeSet; all results remain bound to Project, Graph, Configuration, and Plan.`],

  ['email-delivery', `AgentMesh Deploy: email-delivery

Usage:
  agentmesh-deploy email-delivery create project-id --graph graph-id --launch-config launch-config-id --verification-plan plan-id --provisioning-connection connection-id --sending-connection connection-id [--from-local-part verification] [--home path] [--json]
  agentmesh-deploy email-delivery show project-id email-delivery-plan-id [--home path] [--json]
  agentmesh-deploy email-delivery approve project-id email-delivery-plan-id --expires-at timestamp --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy email-delivery approval project-id email-delivery-approval-id [--home path] [--json]
  agentmesh-deploy email-delivery revoke project-id email-delivery-approval-id --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy email-delivery apply project-id email-delivery-plan-id --email-delivery-approval approval-id --execute --yes --allow-network --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy email-delivery resume project-id email-delivery-run-id [--email-delivery-approval replacement-approval-id] --execute --yes --allow-network --allow-provider-mutations --allow-cost-mutations [--home path] [--json]
  agentmesh-deploy email-delivery run project-id email-delivery-run-id [--home path] [--json]

Purpose:
  Send one production verification email and persist a resumable, privacy-safe delivery receipt for Product Verification.

Safety:
  create performs no network request and binds current Graph, Configuration, Verification Plan, verified Resend domain evidence, and two exact ready Connections.
  apply requires a dedicated short-lived Approval and explicit network, provider mutation, and cost gates; the recipient comes only from a Secret Ref.
  a domain-scoped Sending Access key sends with a deterministic Idempotency-Key; a separate Full Access key reads delivery status.
  Run, Intent, Receipt, logs, and output never persist the recipient or credential values; run is read-only and resume is safe after interruption.`],

  ['rollback', `AgentMesh Deploy: rollback

Usage:
  agentmesh-deploy rollback create project-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy rollback show project-id rollback-plan-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy rollback approve project-id rollback-plan-id --graph graph-id --launch-config launch-config-id --steps dns.restore --expires-at timestamp --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy rollback list-approvals project-id [--home path] [--json]
  agentmesh-deploy rollback approval project-id rollback-approval-id --graph graph-id --launch-config launch-config-id [--home path] [--json]
  agentmesh-deploy rollback revoke project-id rollback-approval-id --graph graph-id --launch-config launch-config-id --yes [--approved-by actor] [--home path] [--json]
  agentmesh-deploy rollback apply project-id rollback-plan-id --graph graph-id --launch-config launch-config-id --rollback-approval rollback-approval-id --execute --yes --allow-rollback-network --allow-provider-mutations [--allow-database-restore --database-runtime-profile profile-id] [--home path] [--json]
  agentmesh-deploy rollback resume project-id rollback-run-id --launch-config launch-config-id --execute --yes --allow-rollback-network --allow-provider-mutations [--allow-database-restore --database-runtime-profile profile-id] [--home path] [--json]

Purpose:
  Derive, approve, execute, resume, and inspect immutable recovery work after failed production product verification.

Safety:
  create requires current failed ProductVerificationEvidence plus the exact Cloudflare DNS ChangeSet and adjacent apply Intent/Receipt.
  one captured previous Web record becomes restore-exact; a first-launch record with no predecessor requires human deletion because automatic DELETE is disabled.
  additive database migrations are retained; reversible migrations require a Down runtime; destructive or unknown migrations require verified backup restore.
  rollback approval is separate from launch/DNS/migration approval, binds exact ready steps for at most 24 hours, and uses an immutable revocation tombstone.
  apply/resume require a dedicated active approval plus explicit rollback-network and provider-mutation gates.
  Plans containing database.rollback additionally require --allow-database-restore, an active --database-runtime-profile, and an Approval covering that exact step.
  each mutation is journaled with immutable Intent/Receipt artifacts and resumed without blind replay.
  create/show/approve/list/revoke make zero network, provider, or database mutations; every action keeps the product repository unchanged.`],

  ['migration-plan', `AgentMesh Deploy: migration-plan

Usage:
  agentmesh-deploy migration-plan create project-id --graph graph-id --launch-config launch-config-id --migration-spec spec.json [--home path] [--json]
  agentmesh-deploy migration-plan show project-id migration-plan-id --graph graph-id --launch-config launch-config-id [--home path] [--json]

Purpose:
  Classify committed PostgreSQL migrations into additive, reversible, destructive, or unknown risk before any database access.

Safety:
  SQL paths come from a small JSON spec and are read only from the registered locked commit in an isolated checkout.
  raw SQL and database credentials are never persisted; the plan stores file/statement hashes and structured classifications only.
  reversible changes require a committed Down file; destructive and unknown changes require backup evidence and approval.
  explicit transaction control, mixed transaction modes, secret-bearing SQL, traversal, symlinks, and tampering are blocked.
  create and show execute zero SQL statements, make zero provider calls, and never modify the product repository.`],

  ['database-runtime', `AgentMesh Deploy: database-runtime

Usage:
  agentmesh-deploy database-runtime create project-id --graph graph-id --adapter-plan adapter-plan-id --database-host host --expires-at timestamp --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy database-runtime show project-id database-runtime-profile-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]
  agentmesh-deploy database-runtime revoke project-id database-runtime-profile-id --graph graph-id --adapter-plan adapter-plan-id --approved-by actor --yes [--home path] [--json]

Purpose:
  Bind one Neon Migration Apply plan to an exact database connection Secret Ref, public host allowlist, Backup Evidence, and short-lived SQL execution authorization.

Safety:
  creation is control-plane only and never resolves the database Secret Ref or connects to PostgreSQL.
  profiles expire within 24 hours, are immutable, and may be revoked with an append-only tombstone.
  runtime execution reopens SQL from the locked commit, combines Neon structural inspection with an in-database ownership Ledger, and commits migrations plus Ledger ownership in one transaction.
  connection values stay in process environment only; public execution remains limited to sandbox apply/resume with a separate Graph approval and --allow-database-migration.`],

  ['acceptance-suite', `AgentMesh Deploy: acceptance-suite

Usage:
  agentmesh-deploy acceptance-suite readiness project-id [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy acceptance-suite create project-id --acceptance-run run-id [--acceptance-run run-id...] [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy acceptance-suite show project-id acceptance-suite-id [--home path] [--json]

Purpose:
  Check provider account and Connection readiness, then aggregate qualified Sandbox Runs into one immutable provider-capability acceptance gate.

Safety:
  every Run, Graph, Adapter Plan, Sandbox Acceptance Report, and fingerprint is reopened and integrity checked.
  only passed test-account reports using native fixed-host CLI transport contribute capability coverage.
  one trivial mutation cannot qualify a provider; every provider must cover its required public Adapter methods across one or more Runs.
  readiness performs zero network requests, reads no Secret values, and distinguishes initial Sandbox readiness from deferred completion requirements.
  readiness/create/show perform zero provider mutations and never modify the product repository.`],

  ['acceptance-portfolio', `AgentMesh Deploy: acceptance-portfolio

Usage:
  agentmesh-deploy acceptance-portfolio create --acceptance-suite-ref project-id:acceptance-suite-id [--acceptance-suite-ref project-id:acceptance-suite-id...] [--acceptance-provider provider] [--home path] [--json]
  agentmesh-deploy acceptance-portfolio show acceptance-portfolio-id [--home path] [--json]

Purpose:
  Assemble passed project-level Provider Acceptance Suites into one immutable release-level provider certification portfolio.

Safety:
  project-level Suite, Commit, Run, Graph, Adapter Plan, Report, and fingerprint bindings remain authoritative and are never weakened or copied across projects.
  every source Suite must already be passed; create/show dynamically reopen each source and reject stale, missing, incomplete, or tampered evidence.
  the portfolio records the validating package version and the critical capability-contract fingerprint, then derives provider coverage from qualified source Suites only.
  create/show perform zero network requests, read no Secret values, execute zero provider mutations, and never modify product repositories.`],

  ['acceptance-cleanup', `AgentMesh Deploy: acceptance-cleanup

Usage:
  agentmesh-deploy acceptance-cleanup create project-id --acceptance-suite suite-id --cleanup-owner actor --cleanup-deadline timestamp [--home path] [--json]
  agentmesh-deploy acceptance-cleanup attest project-id cleanup-plan-id --cleanup-spec dispositions.json --approved-by actor --yes [--home path] [--json]
  agentmesh-deploy acceptance-cleanup show project-id cleanup-plan-id [cleanup-attestation-id] [--home path] [--json]

Purpose:
  Derive an immutable human cleanup handoff from all provider mutations in an Acceptance Suite and record complete human disposition evidence.

Safety:
  every source Suite, Run, Adapter Plan, Intent, and Receipt is reopened and integrity checked.
  managed, adopted, DNS, deployment, API Key, and unknown mutations remain visibly distinct; opaque mutations cannot disappear.
  attestations must cover every cleanup item and record retained/deleted/restored/no-action status, reason, review time, and applicable cost stop time.
  this command never calls providers and never deletes resources; attestation is explicitly human evidence, not provider verification.`],

  ['source-patch', `AgentMesh Deploy: source-patch

Usage:
  agentmesh-deploy source-patch create project-id --patch-file change.patch --patch-reason reason [--home path] [--json]
  agentmesh-deploy source-patch show project-id source-patch-id [--home path] [--json]

Purpose:
  Store a bounded unified diff as an immutable external proposal when deployment readiness requires a product-code change.

Safety:
  create validates UTF-8 text, safe repository-relative paths, secret absence, and immutable content integrity without modifying the product repository.
  authentication, account, database, migration, dependency, lockfile, and deployment-workflow paths are explicitly risk flagged.
  proposals always require repository-owner review; automatic apply is disabled and this CLI exposes no apply, commit, or push action.
  create/show perform zero network requests and zero provider mutations.`],

  ['sandbox', `AgentMesh Deploy: sandbox

Usage:
  agentmesh-deploy sandbox create project-id --graph graph-id --adapter-plan adapter-plan-id --resource-prefix prefix --max-provider-mutations n --expires-at timestamp --yes [--account-environment test] [--allow-paid-resources] [--allowed-domain domain] [--protected-domain domain] [--home path] [--json]
  agentmesh-deploy sandbox show project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id [--home path] [--json]
  agentmesh-deploy sandbox preflight project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id [--database-runtime-profile profile-id] [--probe-secrets] [--home path] [--json]
  agentmesh-deploy sandbox apply project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --preflight sandbox-preflight-id --execute --yes --allow-sandbox-network --allow-provider-mutations [--database-runtime-profile profile-id --allow-database-migration] [--allow-cost-mutations] [--home path] [--json]
  agentmesh-deploy sandbox resume project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --preflight sandbox-preflight-id --run run-id --execute --yes --allow-sandbox-network --allow-provider-mutations [--database-runtime-profile profile-id --allow-database-migration] [--allow-cost-mutations] [--home path] [--json]
  agentmesh-deploy sandbox report project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --run run-id [--home path] [--json]
  agentmesh-deploy sandbox revoke project-id sandbox-profile-id --graph graph-id --adapter-plan adapter-plan-id --yes [--approved-by actor] [--home path] [--json]

Purpose:
  Create or inspect an immutable, expiring SandboxExecutionProfile and generate short-lived SandboxPreflightEvidence for a validated Adapter Plan.

Safety:
  the profile binds Project, Graph, Plan, Connections, provider API hosts, resource prefix, domains, cost permission, and mutation budget.
  protected domains are an explicit deny-list and cannot overlap allowed domains or appear in Resend/Cloudflare actions.
  lifetime is at most seven days and creation requires --yes; cost nodes additionally require --allow-paid-resources.
  revoke appends a Tombstone without modifying the immutable Profile.
  preflight checks Connection versions, Secret availability, Graph approvals, runtime capabilities, and mutation budget without network access.
  --probe-secrets may read non-environment Secret Stores into memory for presence checks; values are never persisted or printed.
  apply/resume require a still-current ready Preflight, recheck all authorization facts, and bind Profile plus Preflight fingerprints into every Run revision.
  report revalidates the immutable Run and every Adapter Receipt; only a user-declared test account plus the native CLI fixed-host transport can pass.
  injected-test and unrecorded transports always produce not-qualified reports even when their Runs succeed.
  the dedicated Sandbox path and launch --provider-mode real share all execution/network/mutation/cost gates; neither path can authorize provider deletes.`],

  ['init', `AgentMesh Deploy: init

Usage:
  agentmesh-deploy init [path] [--name app-name] [--preset detected|saas] [--force]

Purpose:
  Create the deployment contract for a product repository.

Writes:
  .agentmesh-deploy/manifest.json
  .agentmesh-deploy/state.json
  .agentmesh-deploy/RUNBOOK.md
  .gitignore deployment-safe rules

  Notes:
  --force refreshes the manifest while preserving same-app state.
  Init is protected by the deployment lock.`],

  ['onboard', `AgentMesh Deploy: onboard

Usage:
  agentmesh-deploy onboard [path] [--name app-name] [--preset detected|saas] [--force] [--json]

Purpose:
  Attach the deployment sidecar to a product repo and prepare AI handoff evidence.

Writes:
  .agentmesh-deploy/manifest.json when missing or --force is used
  .agentmesh-deploy/state.json when missing
  .agentmesh-deploy/RUNBOOK.md
  .gitignore deployment-safe rules
  .agentmesh-deploy/diffs/latest.json
  .agentmesh-deploy/reviews/latest.json
  .agentmesh-deploy/handoffs/latest.json

Agent flow:
  Run onboard --json when a normal SaaS repo is ready to be handed to a deployment agent.
  If a manifest already exists, onboard reuses it unless --force is passed.
  Use returned nextActions and suggestedCommands before apply.

Notes:
  onboard writes local sidecar files and evidence only; it does not mutate provider resources.
  --force follows init semantics: refresh the manifest while preserving same-app state.`],

  ['detect', `AgentMesh Deploy: detect

Usage:
  agentmesh-deploy detect [path] [--json]

Purpose:
  Inspect the product repo for package manager, frameworks, scripts, env keys, and Cloudflare hints.

Notes:
  detect is read-only.
  Use --json when another agent needs machine-readable project facts.`],

  ['validate', `AgentMesh Deploy: validate

Usage:
  agentmesh-deploy validate [path] [--json]

Purpose:
  Validate .agentmesh-deploy/manifest.json against the bundled contract.

Notes:
  Invalid manifests block plan, preview, apply, and destroy.
  status, review, doctor, and handoff still report fix-manifest guidance.`],

  ['schema', `AgentMesh Deploy: schema

Usage:
  agentmesh-deploy schema

Purpose:
  Print the bundled deploy-manifest.v1 JSON Schema.

Notes:
  Use this before editing a manifest manually.`],

  ['plan', `AgentMesh Deploy: plan

Usage:
  agentmesh-deploy plan [path] [--json] [--no-save]

Purpose:
  Build the idempotent deployment plan from manifest + state.

Notes:
  Saved plans are recorded under .agentmesh-deploy/runs/.
  Every valid plan includes a stable fingerprint for --expect-plan.
  --no-save avoids mutating local run history.`],

  ['doctor', `AgentMesh Deploy: doctor

Usage:
  agentmesh-deploy doctor [path] [--json] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]

Purpose:
  Report deployment readiness and next actions.

Checks:
  manifest issues, local tools, Git identity, tracked sensitive files, deployment locks,
  provider auth probes, state recovery hints, env readiness, policy gates, unsupported actions.

Notes:
  --probe-auth runs read-only provider authentication probes.
  --allow-provider-mutations lets doctor model the readiness of provider-mutation steps; it does not mutate providers.
  --allow-cost-mutations additionally models cost-incurring actions such as domain registration and droplet creation.`],

  ['prepare', `AgentMesh Deploy: prepare

Usage:
  agentmesh-deploy prepare [path] [--json] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]

Purpose:
  Refresh the default AI handoff evidence artifacts in one command.

Writes:
  .agentmesh-deploy/diffs/latest.json
  .agentmesh-deploy/reviews/latest.json
  .agentmesh-deploy/handoffs/latest.json

Agent flow:
  Run prepare --json before handing a product repo to another agent.
  Then use the returned suggested apply command or the saved handoff artifact.

Notes:
  prepare writes local artifacts only; it does not mutate provider resources.
  It writes diff before review, then handoff, so approvalArtifacts report current evidence when the manifest is valid.`],

  ['status', `AgentMesh Deploy: status

Usage:
  agentmesh-deploy status [path] [--json] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]

Purpose:
  Produce the compact continuation snapshot for a deployment agent.

Includes:
  validation, readiness, planFingerprint, plan summary, state summary, doctor,
  approvalArtifacts freshness, applyDecision, nextActions, and suggestedCommands.

Agent flow:
  Start ordinary product handoff with onboard --json, then use status --json for continuation.
  If nextActions includes refresh-approval-artifacts, run prepare --json first.
  Use applyDecision to determine whether gated dry-run apply is ready, blocked,
  or whether real execute still needs provider or cost mutation approval.
  Use suggestedCommands for the exact gated dry-run or explicit apply commands.`],

  ['review', `AgentMesh Deploy: review

Usage:
  agentmesh-deploy review [path] [--json] [--out file] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]

Purpose:
  Build the read-only pre-apply approval packet.

Includes:
  validation, readiness, planFingerprint, secret summary, run summary,
  managed file drift, blocking reasons, applyDecision, nextActions, and suggestedCommands.

Notes:
  review never prints secret values.
  --out writes approval evidence, commonly .agentmesh-deploy/reviews/latest.json.
  apply can require that packet with --require-review <file>.`],

  ['diff', `AgentMesh Deploy: diff

Usage:
  agentmesh-deploy diff [path] [--json] [--out file] [--unsafe-reveal-secrets]

Purpose:
  Show the managed file changes apply would write.

Notes:
  .env and .env.production values are redacted by default.
  --out writes audit evidence, commonly .agentmesh-deploy/diffs/latest.json.
  apply can require that packet with --require-diff <file>.
  Use --unsafe-reveal-secrets only with explicit approval.`],

  ['handoff', `AgentMesh Deploy: handoff

Usage:
  agentmesh-deploy handoff [path] [--json] [--out file] [--probe-auth] [--allow-provider-mutations] [--allow-cost-mutations]

Purpose:
  Build the full AI transfer dossier.

Includes:
  validation, full plan, doctor, state summary, approvalArtifacts freshness,
  applyDecision, merged nextActions, and suggestedCommands.

Notes:
  --out writes a local dossier, commonly .agentmesh-deploy/handoffs/latest.json.
  Use this when another agent or a future session must continue the deployment.`],

  ['preview', `AgentMesh Deploy: preview

Usage:
  agentmesh-deploy preview [path] [--json] [--unsafe-reveal-secrets]

Purpose:
  Print the full generated content for managed files.

Notes:
  Secret-bearing env values are redacted by default.
  Use diff when you only need an audit packet of changes.`],

  ['runs', `AgentMesh Deploy: runs

Usage:
  agentmesh-deploy runs [path] [--json] [--latest|--run id] [--limit n]

Purpose:
  Inspect local run history and saved run artifacts.

Notes:
  Use runs --latest after a failed plan/apply to recover the failed step and captured outputs.
  Run artifacts are constrained to .agentmesh-deploy/runs/.`],

  ['secrets', `AgentMesh Deploy: secrets

Usage:
  agentmesh-deploy secrets [path] [--json]

Purpose:
  Report required deployment secret keys, consumers, source locations, and presence.

Notes:
  secrets is read-only and never prints secret values.`],

  ['apply', `AgentMesh Deploy: apply

Usage:
  agentmesh-deploy apply [path] [--json] [--dry-run] [--expect-plan fingerprint] [--require-review file] [--require-diff file]
  agentmesh-deploy apply [path] --execute --yes [--expect-plan fingerprint] [--require-review file] [--require-diff file]
  agentmesh-deploy apply [path] --execute --yes --allow-provider-mutations [--allow-cost-mutations] [--expect-plan fingerprint] [--require-review file] [--require-diff file]

Purpose:
  Execute the current plan, dry-run by default.

Safety gates:
  --expect-plan refuses apply when the regenerated plan fingerprint changed.
  --require-review requires a saved review artifact for the current plan.
  --require-diff requires a saved managed-file diff artifact for the current managed file changes.
  --execute --yes is required for real local command execution.
  --allow-provider-mutations is additionally required for provider mutations.
  --allow-cost-mutations is additionally required for cost-incurring provider mutations.

Recommended agent flow:
  status --json
  prepare --json
  apply --json --require-review .agentmesh-deploy/reviews/latest.json --require-diff .agentmesh-deploy/diffs/latest.json --expect-plan <fingerprint>`],

  ['destroy', `AgentMesh Deploy: destroy

Usage:
  agentmesh-deploy destroy [path] [--dry-run]

Purpose:
  Show the deletion plan.

Notes:
  destroy defaults to dry-run.
  Real provider-side delete execution is intentionally disabled in v0.1.`],

  ['help', `AgentMesh Deploy: help

Usage:
  agentmesh-deploy help [command]
  agentmesh-deploy <command> --help

Purpose:
  Print global or command-specific help.`],

  ['version', `AgentMesh Deploy: version

Usage:
  agentmesh-deploy version

Purpose:
  Print the CLI version.`],
]);

export function buildHelpPayload(command = '') {
  const selectedCommand = command && COMMAND_HELP.has(command) ? command : '';
  const text = selectedCommand ? COMMAND_HELP.get(selectedCommand) : GLOBAL_HELP;
  const sections = parseHelpSections(text);
  const payload = {
    kind: selectedCommand ? 'command-help' : 'global-help',
    command: selectedCommand || undefined,
    commands: selectedCommand ? undefined : [...COMMAND_HELP.keys()],
    aliases: ['amd'],
    usages: sections.usage || [],
    sections,
    text,
  };
  if (sections.purpose?.length) {
    payload.purpose = sections.purpose.join(' ');
  }
  return payload;
}

export function printHelp(command = '') {
  console.log(buildHelpPayload(command).text);
}

function parseHelpSections(text) {
  const sections = {};
  let currentSection = '';
  for (const line of text.split('\n')) {
    const section = line.match(/^([A-Za-z][A-Za-z -]*):$/);
    if (section) {
      currentSection = camelCase(section[1]);
      sections[currentSection] = [];
      continue;
    }
    if (!currentSection) continue;
    const value = normalizeHelpLine(line);
    if (value) {
      sections[currentSection].push(value);
    }
  }
  return sections;
}

function normalizeHelpLine(line) {
  return line.trim().replace(/^- /, '');
}

function camelCase(value) {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((part, index) => (index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`))
    .join('');
}

export function printVersion() {
  console.log(PACKAGE_VERSION);
}

export function printProjectResult(report) {
  if (report.kind === 'project-list') {
    console.log(`Projects: ${report.count}`);
    for (const project of report.projects) {
      console.log(`- ${project.id}: ${project.name} [${project.status}] @ ${project.source.commit}`);
    }
    console.log(`Control home: ${report.home}`);
    return;
  }
  const project = report.project;
  console.log(`Project: ${project.id}`);
  console.log(`Name: ${project.name}`);
  console.log(`Status: ${project.status}`);
  console.log(`Source: ${project.source.locator}`);
  console.log(`Commit: ${project.source.commit}`);
  if (report.repositoryGuard) console.log(`Repository guard: ${report.repositoryGuard.status}`);
  console.log(`Control home: ${report.home}`);
}

export function printProjectAnalysis(analysis) {
  console.log(`Project: ${analysis.projectId}`);
  console.log(`Run: ${analysis.runId}`);
  console.log(`Locked commit: ${analysis.sourceRef.lockedCommit}`);
  console.log(`Source drift: ${analysis.sourceRef.drifted ? 'yes' : 'no'}`);
  console.log(`Repository guard: ${analysis.repositoryGuard.status}`);
  console.log(`Workspace: ${analysis.workspace.paths.root}`);
  printDetection(analysis.detection);
}

export function printArtifactResult(report) {
  if (report.kind === 'runtime-artifact-plan') {
    console.log(`Runtime artifact plan: ${report.status}`);
    console.log(`Project: ${report.projectId}`);
    console.log(`Fingerprint: ${report.plan.fingerprint}`);
    console.log(`Commands: ${report.plan.commands.map((argv) => argv.join(' ')).join(' -> ') || '(none)'}`);
    console.log(`Outputs: ${report.plan.outputRoots.join(', ') || '(none)'}`);
    console.log(`Blockers: ${report.plan.blockers.join(', ') || '(none)'}`);
    console.log(`Repository guard: ${report.repositoryGuard.status}`);
    return;
  }
  if (report.kind === 'artifact-list') {
    console.log(`Artifacts: ${report.count}`);
    for (const artifact of report.artifacts) {
      console.log(`- ${artifact.id}: ${artifact.kind} / ${artifact.size} bytes @ ${artifact.sourceRef.commit}`);
    }
    return;
  }
  const artifact = report.artifact;
  console.log(`Artifact: ${artifact.id}`);
  console.log(`Project: ${artifact.projectId}`);
  console.log(`Commit: ${artifact.sourceRef.commit}`);
  console.log(`Format: ${artifact.format}`);
  console.log(`Size: ${artifact.size} bytes`);
  console.log(`File: ${artifact.file}`);
  if (['artifact-created', 'runtime-artifact-built', 'vercel-file-manifest-created'].includes(report.kind)) {
    console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
    console.log(`Repository guard: ${report.repositoryGuard.status}`);
  }
  if (report.kind === 'runtime-artifact-built') {
    console.log(`Build plan: ${report.plan.fingerprint}`);
    console.log(`Outputs: ${artifact.outputRoots.join(', ')}`);
    console.log(`Run file: ${report.runFile}`);
  }
  if (report.kind === 'vercel-file-manifest-created') {
    console.log(`Files: ${artifact.files.length}`);
    console.log(`Payload: ${artifact.totalFileBytes} bytes`);
    console.log(`Run file: ${report.runFile}`);
  }
  if (report.kind === 'artifact-verification') console.log(`Verification: ${report.status}`);
}

export function printLegacyImport(report) {
  console.log(`Project: ${report.projectId}`);
  console.log(`Import: ${report.importId}`);
  console.log(`Status: ${report.status}`);
  console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`Plan equivalence: ${report.planEquivalence.status}`);
  console.log(`Completed steps: ${report.migrated.completedSteps}`);
  console.log(`Resources: ${report.migrated.resources}`);
  console.log(`Stale facts: ${report.staleFacts}`);
  console.log(`Approvals invalidated: ${report.approvalsInvalidated ? 'yes' : 'no'}`);
  console.log(`Repository guard: ${report.repositoryGuard.status}`);
  console.log(`Evidence: ${report.evidenceFile}`);
  console.log(`Control home: ${report.home}`);
}

export function printLaunchResult(report) {
  if (report.kind === 'launch-graph-list') {
    console.log(`Launch graphs: ${report.count}`);
    for (const graph of report.graphs) {
      console.log(`- ${graph.id}: ${graph.fingerprint} (${graph.summary.total} nodes)`);
    }
    console.log(`Control home: ${report.home}`);
    return;
  }
  const graph = report.graph;
  console.log(`Graph: ${graph.id}`);
  console.log(`Project: ${graph.projectId}`);
  console.log(`Fingerprint: ${graph.fingerprint}`);
  console.log(`Nodes: ${graph.summary.total}`);
  console.log(`Ready: ${graph.summary.ready || 0}`);
  console.log(`Planned: ${graph.summary.planned || 0}`);
  console.log(`Succeeded: ${graph.summary.succeeded || 0}`);
  console.log(`Requires approval: ${graph.summary.requiresApproval}`);
  console.log(`Requires reverification: ${graph.summary.requiresReverification}`);
  if (report.kind === 'launch-plan') {
    console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
    console.log(`Provider mutations executed: ${report.providerMutationsExecuted}`);
    console.log(`Repository guard: ${report.repositoryGuard.status}`);
  }
  if (report.kind === 'launch-run') {
    console.log(`Run: ${report.run.id}`);
    console.log(`Run revision: ${report.run.revision}`);
    console.log(`Run status: ${report.run.status}`);
    console.log(`Mode: ${report.run.mode}`);
    console.log(`Provider mutations executed: ${report.providerMutationsExecuted}`);
    console.log(`Repository guard: ${report.repositoryGuard.status}`);
    console.log(`Run file: ${report.runFile}`);
  }
  console.log(`Graph file: ${report.graphFile}`);
  console.log(`Control home: ${report.home}`);
}

export function printApprovalResult(report) {
  if (report.kind === 'approval-list') {
    console.log(`Approvals: ${report.count}`);
    for (const approval of report.approvals) {
      console.log(`- ${approval.id}: ${approval.effectiveStatus} @ ${approval.graphId}`);
    }
    console.log(`Control home: ${report.home}`);
    return;
  }
  console.log(`Approval: ${report.approval.id}`);
  console.log(`Project: ${report.approval.projectId}`);
  console.log(`Graph: ${report.approval.graphId}`);
  console.log(`Nodes: ${report.approval.nodeIds.join(', ')}`);
  console.log(`Expires: ${report.approval.expiresAt}`);
  if (report.effectiveStatus) console.log(`Effective status: ${report.effectiveStatus}`);
  if (report.operation === 'revoke') console.log(`Revoked: ${report.revocation.revokedAt}`);
  console.log(`Control home: ${report.home}`);
}

export function printProviderResult(report) {
  if (report.kind === 'provider-list') {
    console.log(`Providers: ${report.count}`);
    for (const provider of report.providers) {
      console.log(`- ${provider.id}: ${provider.roles.join(', ')} via ${provider.interfaces.join(', ')}`);
    }
    return;
  }
  if (report.kind === 'provider-guide') {
    console.log(`Provider: ${report.name} (${report.providerId})`);
    console.log('Bootstrap:');
    report.steps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
    console.log(`Identity probe: ${report.verification.identityProbe.join(' ')}`);
    console.log(`Human-only: ${report.automationBoundary.humanMust.join(', ')}`);
    return;
  }
  const provider = report.provider;
  console.log(`Provider: ${provider.name} (${provider.id})`);
  console.log(`Roles: ${provider.roles.join(', ')}`);
  console.log(`Interfaces: ${provider.interfaces.join(', ')}`);
  console.log(`Credential env: ${provider.credentialContract.options.map((option) => option.env).join(', ')}`);
  console.log(`Human-only: ${provider.humanOnly.join(', ')}`);
}

export function printSecretCaptureResult(report) {
  console.log(`Secret capture: ${report.status}`);
  console.log(`Destination: ${report.ref}`);
  console.log(`Backend: ${report.backend}`);
  console.log(`Overwritten: ${report.overwritten ? 'yes' : 'no'}`);
  console.log('Secret value exposed: no');
  console.log(`Provider mutations executed: ${report.providerMutationsExecuted}`);
}

export function printConnectionResult(report) {
  if (report.kind === 'connection-list') {
    console.log(`Connections: ${report.count}`);
    for (const connection of report.connections) {
      console.log(`- ${connection.id}: ${connection.provider} [${connection.status}] v${connection.version}`);
    }
    console.log(`Control home: ${report.home}`);
    return;
  }
  if (report.kind === 'connection-readiness') {
    console.log(`Connection: ${report.connectionId}`);
    console.log(`Provider: ${report.provider}`);
    console.log(`Readiness: ${report.status}`);
    for (const ref of report.refs) console.log(`- ${ref.name}: ${ref.status} (${ref.source})`);
    return;
  }
  const connection = report.connection;
  console.log(`Connection: ${connection.id}`);
  console.log(`Project: ${connection.projectId}`);
  console.log(`Provider: ${connection.provider}`);
  console.log(`Auth method: ${connection.authMethod}`);
  console.log(`Scope: ${connection.scope}`);
  console.log(`Status: ${connection.status}`);
  console.log(`Version: ${connection.version}`);
  if (report.recovery?.status && report.recovery.status !== 'not-required') {
    console.log(`Recovery: ${report.recovery.status} (${report.recovery.errorCode})`);
    for (const action of report.recovery.nextActions) console.log(`- ${action.kind}: ${action.instruction}`);
  }
  if (connection.copiedFrom) {
    console.log(`Copied from: ${connection.copiedFrom.projectId}/${connection.copiedFrom.connectionId} v${connection.copiedFrom.version}`);
  }
  console.log(`Secret refs: ${Object.keys(connection.secretRefs).join(', ')}`);
  console.log(`Control home: ${report.home}`);
}

export function printRecipeResult(report) {
  if (report.kind === 'recipe-list') {
    console.log(`Recipes: ${report.count}`);
    for (const recipe of report.recipes) console.log(`- ${recipe.id}: ${recipe.fingerprint}`);
    console.log(`Control home: ${report.home}`);
    return;
  }
  const recipe = report.recipe;
  console.log(`Recipe: ${recipe.id}`);
  console.log(`Project: ${recipe.projectId}`);
  console.log(`Fingerprint: ${recipe.fingerprint}`);
  console.log(`Providers: ${Object.entries(recipe.providers).filter(([, value]) => value).map(([role, provider]) => `${role}=${provider}`).join(', ')}`);
  console.log(`Alternatives: ${(recipe.alternatives || []).map((item) => `${item.role}=${item.provider}:${item.applicability}`).join(', ') || 'none'}`);
  console.log(`Connections: ${recipe.requiredConnections.map((item) => `${item.provider}:${item.status}`).join(', ')}`);
  console.log(`Cost: ${recipe.cost.status} (${recipe.cost.selectionStatus || 'not-budget-qualified'})`);
  if (report.kind === 'recipe-plan') {
    console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
    console.log(`Repository guard: ${report.repositoryGuard.status}`);
  }
  console.log(`Recipe file: ${report.recipeFile}`);
  console.log(`Control home: ${report.home}`);
}

export function printProviderBootstrapPlanResult(report) {
  const plan = report.plan;
  console.log(`Bootstrap plan: ${plan.id}`);
  console.log(`Project: ${plan.projectId}`);
  console.log(`Recipe: ${plan.recipeRef.id}`);
  console.log(`Secret backend: ${plan.secretBackend}`);
  console.log(`Effective status: ${report.effectiveStatus}`);
  console.log(`Providers: ${plan.providers.length}`);
  for (const provider of plan.providers) {
    const readiness = report.readiness.find((item) => item.providerId === provider.providerId);
    console.log(`- ${provider.name} (${provider.roles.join(', ')}): ${readiness.status}`);
    console.log(`  Connection: ${readiness.connectionId}`);
    console.log(`  Credential: ${provider.credentialOptions.filter((item) => item.selected).map((item) => `${item.env} [${item.scope}]`).join(', ')}`);
    console.log(`  Add argv: ${JSON.stringify(provider.commands.add.argv)}`);
  }
  console.log(`Provider mutations executed: ${report.providerMutationsExecuted}`);
  console.log(`Provider probes executed: ${report.providerProbesExecuted}`);
  console.log(`Secret values read: ${report.secretValuesRead ? 'yes' : 'no'}`);
  console.log(`Repository guard: ${report.repositoryGuard.status}`);
  console.log(`Plan file: ${report.planFile}`);
  console.log(`Control home: ${report.home}`);
}

export function printHumanHandoffResult(report) {
  const handoff = report.handoff;
  console.log(`Human handoff: ${handoff.id}`);
  console.log(`Project: ${handoff.projectId}`);
  console.log(`Phase: ${handoff.phase}`);
  console.log(`Owner: ${handoff.owner}`);
  console.log(`Deadline: ${handoff.deadline}`);
  console.log(`Tasks: ${handoff.tasks.length}`);
  for (const task of handoff.tasks) {
    console.log(`- ${task.id}: ${task.title}${task.providerId ? ` [${task.providerId}]` : ''}`);
  }
  if (report.attestation) {
    console.log(`Attestation: ${report.attestation.id}`);
    console.log(`Attestation status: ${report.attestation.status}`);
    console.log(`Verification basis: ${report.attestation.verificationBasis}`);
  }
  console.log(`Browser actions executed: ${report.browserActionsExecuted}`);
  console.log(`Provider mutations executed: ${report.providerMutationsExecuted}`);
  console.log(`Handoff file: ${report.handoffFile}`);
  console.log(`Control home: ${report.home}`);
}

export function printFirstLaunchSessionResult(report) {
  console.log(`First launch session: ${report.session.id}`);
  console.log(`Project: ${report.projectId}`);
  console.log(`Operation: ${report.operation}`);
  console.log(`Effective status: ${report.effectiveStatus}`);
  console.log(`Bootstrap handoff: ${report.session.bootstrapHandoffRef.id}`);
  console.log(`Bootstrap attestation: ${report.bootstrapAttestation?.id || '(pending)'}`);
  console.log(`Connections: ${report.bootstrapReadiness.map((item) => `${item.providerId}:${item.status}`).join(', ')}`);
  if (report.connectionsCreated) console.log(`Connections created: ${report.connectionsCreated.length}`);
  console.log(`Next actions: ${report.nextActions.map((item) => item.kind).join(', ') || '(none)'}`);
  console.log(`Provider probes executed: ${report.providerProbesExecuted}`);
  console.log(`Provider mutations executed: ${report.providerMutationsExecuted}`);
  console.log(`Session file: ${report.sessionFile}`);
  console.log(`Control home: ${report.home}`);
}

export function printManifestV2Result(report) {
  const manifest = report.manifest;
  console.log(`Manifest: ${manifest.projectId}`);
  console.log(`Fingerprint: ${manifest.fingerprint || '(legacy import)'}`);
  console.log(`Source commit: ${manifest.sourceRef.commit}`);
  if (manifest.recipeRef) console.log(`Recipe: ${manifest.recipeRef.id}`);
  if (report.operation === 'create') {
    console.log(`State file: ${report.stateFile}`);
    console.log(`Repository guard: ${report.repositoryGuard.status}`);
  }
  console.log(`Manifest file: ${report.manifestFile}`);
  console.log(`Control home: ${report.home}`);
}

export function printAdapterPlanResult(report) {
  const plan = report.plan;
  if (!plan) {
    console.log(`Adapter plan generation: ${report.status}`);
    console.log(`Project: ${report.projectId}`);
    console.log(`Compiled actions: ${report.compilation?.summary?.actionCount || 0}`);
    for (const item of report.compilation?.deferredNodes || []) console.log(`- Deferred ${item.nodeId}: ${item.reason}`);
    return;
  }
  console.log(`Adapter plan: ${plan.id}`);
  console.log(`Project: ${plan.projectId}`);
  console.log(`Graph: ${plan.graphId}`);
  console.log(`Fingerprint: ${plan.fingerprint}`);
  console.log(`Actions: ${plan.actions.length}`);
  if (report.compilation?.acceptanceScope) {
    console.log(`Acceptance providers: ${report.compilation.acceptanceScope.requestedProviders.join(', ')}`);
    console.log(`Included providers: ${report.compilation.acceptanceScope.includedProviders.join(', ')}`);
  }
  if (['create', 'generate'].includes(report.operation)) console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  if (report.compilation) console.log(`Coverage: ${report.compilation.compiledNodes.length} compiled, ${report.compilation.deferredNodes.length} deferred`);
  console.log(`File: ${report.planFile}`);
}

export function printSourcePatchResult(report) {
  const proposal = report.proposal;
  console.log(`Source patch proposal: ${proposal.id}`);
  console.log(`Project: ${proposal.projectId}`);
  console.log(`Source commit: ${proposal.sourceRef.commit}`);
  console.log(`Files: ${proposal.patch.fileCount}`);
  console.log(`Risk flags: ${proposal.patch.riskFlags.join(', ') || 'none'}`);
  console.log(`Repository owner approval: required`);
  console.log(`Automatic apply: disabled`);
  console.log(`Fingerprint: ${proposal.fingerprint}`);
  if (report.sourceStatus) console.log(`Source status: ${report.sourceStatus}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`Patch: ${report.patchFile}`);
  console.log(`Proposal: ${report.proposalFile}`);
}

export function printLaunchConfigurationResult(report) {
  const configuration = report.configuration;
  console.log(`Launch configuration: ${configuration.id}`);
  console.log(`Project: ${configuration.projectId}`);
  console.log(`Graph: ${configuration.graphId}`);
  console.log(`Fingerprint: ${configuration.fingerprint}`);
  console.log(`Domain: ${configuration.domain.apex}`);
  console.log(`Runtime: ${configuration.runtime.provider}`);
  console.log(`Database: ${configuration.database.provider || '(none)'}`);
  console.log(`Email: ${configuration.email.provider || '(none)'}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`File: ${report.configurationFile}`);
}

export function printDnsChangeSetResult(report) {
  const changeSet = report.changeSet;
  console.log(`DNS change set: ${changeSet.id}`);
  console.log(`Project: ${changeSet.projectId}`);
  console.log(`Graph: ${changeSet.graphId}`);
  console.log(`Scope: ${changeSet.scope || 'production-cutover'}`);
  console.log(`Zone: ${changeSet.zoneName}`);
  console.log(`Records: ${changeSet.records.length}`);
  console.log(`Fingerprint: ${changeSet.fingerprint}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`File: ${report.changeSetFile}`);
}

export function printCandidateVerificationResult(report) {
  const evidence = report.evidence;
  console.log(`Candidate verification: ${evidence.id}`);
  console.log(`Project: ${evidence.projectId}`);
  console.log(`URL: ${evidence.url}`);
  console.log(`Status: ${evidence.statusCode}`);
  console.log(`Fingerprint: ${evidence.fingerprint}`);
  console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`Evidence: ${report.evidenceFile}`);
}

export function printProductVerificationResult(report) {
  const plan = report.plan;
  console.log(`Product verification plan: ${plan.id}`);
  console.log(`Project: ${plan.projectId}`);
  console.log(`Graph: ${plan.graphId}`);
  console.log(`Checks: ${plan.checks.length}`);
  console.log(`Fingerprint: ${plan.fingerprint}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  if (report.evidence) {
    console.log(`Phase: ${report.evidence.phase}`);
    console.log(`Status: ${report.evidence.status}`);
    console.log(`Passed: ${report.evidence.checks.filter((check) => check.status === 'passed').length}`);
    console.log(`Needs human: ${report.evidence.checks.filter((check) => check.status === 'needs-human').length}`);
    console.log(`Evidence: ${report.evidenceFile}`);
  } else {
    console.log(`File: ${report.planFile}`);
  }
}

export function printEmailDeliveryPlanResult(report) {
  const plan = report.plan;
  console.log(`Email delivery plan: ${plan.id}`);
  console.log(`Project: ${plan.projectId}`);
  console.log(`Graph: ${plan.graphId}`);
  console.log(`Verification plan: ${plan.verificationPlanId}`);
  console.log(`Domain: ${plan.emailDomain.name}`);
  console.log(`Provisioning connection: ${plan.provisioningConnection.id}`);
  console.log(`Sending connection: ${plan.sendingConnection.id}`);
  console.log(`Sender: ${plan.fromLocalPart}@${plan.emailDomain.name}`);
  console.log(`Fingerprint: ${plan.fingerprint}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`File: ${report.planFile}`);
}

export function printEmailDeliveryApprovalResult(report) {
  const approval = report.approval;
  console.log(`Email delivery approval: ${approval.id}`);
  console.log(`Project: ${approval.projectId}`);
  console.log(`Plan: ${approval.emailDeliveryPlanId}`);
  console.log(`Limit: ${approval.limits.maxEmails} email, ${approval.limits.maxRecipients} recipient`);
  console.log(`Expires: ${approval.expiresAt}`);
  console.log(`Status: ${report.effectiveStatus || (report.operation === 'revoke' ? 'revoked' : 'active')}`);
  console.log(`Fingerprint: ${approval.fingerprint}`);
  if (report.operation === 'revoke') console.log(`Revocation: ${report.revocationFile}`);
  else console.log(`File: ${report.approvalFile}`);
}

export function printEmailDeliveryRunResult(report) {
  const run = report.run;
  console.log(`Email delivery run: ${run.id}`);
  console.log(`Operation: ${report.operation}`);
  console.log(`Project: ${run.projectId}`);
  console.log(`Plan: ${run.emailDeliveryPlanId}`);
  console.log(`Approval: ${run.approvalId}`);
  console.log(`Status: ${report.status}`);
  console.log(`Send: ${run.send.status}`);
  console.log(`Delivery: ${run.delivery.status}`);
  if (run.delivery.lastEvent) console.log(`Last event: ${run.delivery.lastEvent}`);
  if (run.delivery.nextPollAt) console.log(`Next poll: ${run.delivery.nextPollAt}`);
  console.log(`Provider mutations: ${report.providerMutationsExecuted}`);
  console.log(`Network requests: ${report.networkRequestsExecuted}`);
  console.log(`Run revision: ${run.revision}`);
  console.log(`Run file: ${report.runFile}`);
}

export function printRollbackPlanResult(report) {
  const plan = report.plan;
  console.log(`Rollback plan: ${plan.id}`);
  console.log(`Project: ${plan.projectId}`);
  console.log(`Graph: ${plan.graphId}`);
  console.log(`Status: ${plan.status}`);
  console.log(`DNS strategy: ${plan.dns.strategy}`);
  console.log(`Database strategy: ${plan.database.strategy}`);
  console.log(`Blockers: ${plan.blockers.length}`);
  console.log(`Fingerprint: ${plan.fingerprint}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`File: ${report.planFile}`);
}

export function printRollbackApprovalResult(report) {
  if (report.operation === undefined && Array.isArray(report.approvals)) {
    console.log(`Rollback approvals: ${report.count}`);
    for (const approval of report.approvals) {
      console.log(`${approval.id} ${approval.effectiveStatus} ${approval.stepIds.join(',')}`);
    }
    return;
  }
  const approval = report.approval;
  console.log(`Rollback approval: ${approval.id}`);
  console.log(`Project: ${approval.projectId}`);
  console.log(`Plan: ${approval.rollbackPlanId}`);
  console.log(`Steps: ${approval.stepIds.join(', ')}`);
  console.log(`Expires: ${approval.expiresAt}`);
  console.log(`Status: ${report.effectiveStatus || (report.operation === 'revoke' ? 'revoked' : 'active')}`);
  console.log(`Fingerprint: ${approval.fingerprint}`);
  if (report.operation === 'revoke') console.log(`Revocation: ${report.revocationFile}`);
  else console.log(`File: ${report.approvalFile}`);
}

export function printRollbackRunResult(report) {
  console.log(`Rollback run: ${report.run.id}`);
  console.log(`Operation: ${report.operation}`);
  console.log(`Project: ${report.projectId}`);
  console.log(`Plan: ${report.run.rollbackPlanId}`);
  console.log(`Approval: ${report.run.approvalId}`);
  console.log(`Status: ${report.status}`);
  console.log(`DNS restore: ${report.run.stepStates['dns.restore'].status}`);
  console.log(`Route verification: ${report.run.stepStates['verification.repeat'].status}`);
  console.log(`Provider mutations: ${report.providerMutationsExecuted}`);
  console.log(`Database mutations: ${report.databaseMutationsExecuted}`);
  console.log(`Network requests: ${report.networkRequestsExecuted}`);
  if (report.humanIntervention) {
    console.log(`Human intervention: required`);
    console.log(`Original failure evidence: ${report.humanIntervention.originalFailureEvidenceId}`);
    console.log(`Rollback failure: ${report.humanIntervention.rollbackStepId} ${report.humanIntervention.rollbackErrorCode}`);
  }
  console.log(`Run revision: ${report.run.revision}`);
  console.log(`Run file: ${report.runFile}`);
}

export function printMigrationPlanResult(report) {
  const plan = report.plan;
  console.log(`Migration plan: ${plan.id}`);
  console.log(`Project: ${plan.projectId}`);
  console.log(`Graph: ${plan.graphId}`);
  console.log(`Provider: ${plan.provider}`);
  console.log(`Classification: ${plan.summary.classification}`);
  console.log(`Migrations: ${plan.summary.migrationCount}`);
  console.log(`Statements: ${plan.summary.statementCount}`);
  console.log(`Status: ${plan.status}`);
  console.log(`Backup required: ${plan.requirements.backupRequired ? 'yes' : 'no'}`);
  console.log(`Approval required: ${plan.requirements.approvalRequired ? 'yes' : 'no'}`);
  console.log(`Fingerprint: ${plan.fingerprint}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`File: ${report.planFile}`);
}

export function printBackupEvidenceResult(report) {
  const evidence = report.evidence;
  console.log(`Backup evidence: ${evidence.id}`);
  console.log(`Project: ${evidence.projectId}`);
  console.log(`Graph: ${evidence.graphId}`);
  console.log(`Migration plan: ${evidence.migrationPlanId}`);
  console.log(`Provider: ${evidence.provider}`);
  console.log(`Backup: ${evidence.backup.resource.providerId}`);
  console.log(`Schema fingerprint: ${evidence.schemaInspection.schemaFingerprint}`);
  console.log(`Status: ${evidence.status}`);
  console.log(`Restore tested: ${evidence.verification.restoreTested ? 'yes' : 'no'}`);
  console.log(`Fingerprint: ${evidence.fingerprint}`);
  if (report.operation === 'create') console.log(`Reused: ${report.reused ? 'yes' : 'no'}`);
  console.log(`File: ${report.evidenceFile}`);
}

export function printSandboxResult(report) {
  if (report.kind === 'sandbox-acceptance-report') {
    const evidence = report.report;
    console.log(`Sandbox acceptance: ${evidence.id}`);
    console.log(`Status: ${evidence.status}`);
    console.log(`Project: ${evidence.projectId}`);
    console.log(`Run: ${evidence.runId} revision ${evidence.runRevision}`);
    console.log(`Account environment: ${evidence.accountEnvironment} (${evidence.accountEnvironmentBasis})`);
    console.log(`Transport: ${evidence.transportProvenance}`);
    console.log(`Providers: ${evidence.providers.join(', ')}`);
    console.log(`Provider mutations: ${evidence.providerMutationsExecuted}`);
    console.log(`Receipts: ${evidence.receiptCount}`);
    printList('Failed checks', evidence.checks.filter((item) => item.status === 'failed')
      .map((item) => `${item.code}: ${item.message}`));
    console.log(`File: ${report.reportFile}`);
    return;
  }
  if (report.kind === 'sandbox-launch-run') {
    console.log(`Sandbox run: ${report.run.id}`);
    console.log(`Operation: ${report.operation}`);
    console.log(`Status: ${report.status}`);
    console.log(`Project: ${report.projectId}`);
    console.log(`Profile: ${report.sandboxProfileId}`);
    console.log(`Preflight: ${report.sandboxPreflightId}`);
    console.log(`Adapter plan: ${report.adapterPlan.id}`);
    console.log(`Transport: ${report.transportProvenance || 'unrecorded'}`);
    console.log(`Provider mutations: ${report.providerMutationsExecuted}`);
    console.log(`Run revision: ${report.run.revision}`);
    console.log(`Run file: ${report.runFile}`);
    return;
  }
  if (report.evidence) {
    const evidence = report.evidence;
    console.log(`Sandbox preflight: ${evidence.id}`);
    console.log(`Project: ${evidence.projectId}`);
    console.log(`Profile: ${evidence.sandboxProfileId}`);
    console.log(`Adapter plan: ${evidence.adapterPlanId}`);
    console.log(`Status: ${evidence.status}`);
    console.log(`Connections: ${evidence.connectionChecks.filter((item) => item.status === 'ready').length}/${evidence.connectionChecks.length} ready`);
    console.log(`Approvals: ${evidence.approvalChecks.filter((item) => item.status === 'ready').length}/${evidence.approvalChecks.length} ready`);
    console.log(`Runtime capabilities: ${evidence.runtimeChecks.filter((item) => item.status === 'ready').length}/${evidence.runtimeChecks.length} ready`);
    console.log(`Mutation budget: ${evidence.mutationBudget.estimated}/${evidence.mutationBudget.maximum}`);
    console.log(`Valid until: ${evidence.validUntil}`);
    printList('Blockers', evidence.blockers.map((item) => `${item.code} ${item.scope}: ${item.message}`));
    console.log(`File: ${report.evidenceFile}`);
    return;
  }
  const profile = report.profile;
  console.log(`Sandbox profile: ${profile.id}`);
  console.log(`Project: ${profile.projectId}`);
  console.log(`Adapter plan: ${profile.adapterPlanId}`);
  console.log(`Providers: ${profile.providers.join(', ')}`);
  console.log(`API hosts: ${profile.apiHosts.join(', ')}`);
  console.log(`Account environment: ${profile.accountEnvironment || 'unspecified'}`);
  console.log(`Resource prefix: ${profile.resourcePrefix}`);
  console.log(`Mutation budget: ${profile.estimatedProviderMutations}/${profile.maxProviderMutations}`);
  console.log(`Expires: ${profile.expiresAt}`);
  console.log(`Effective status: ${report.effectiveStatus || 'active'}`);
  console.log(`File: ${report.profileFile}`);
}

export function printDatabaseRuntimeResult(report) {
  const profile = report.profile;
  console.log(`Database runtime profile: ${profile.id}`);
  console.log(`Status: ${report.effectiveStatus}`);
  console.log(`Project: ${profile.projectId}`);
  console.log(`Provider: ${profile.provider}`);
  console.log(`Provider project/branch: ${profile.providerProjectId}/${profile.branchId}`);
  console.log(`Database: ${profile.databaseName}`);
  console.log(`Allowed hosts: ${profile.allowedHosts.join(', ')}`);
  console.log(`Migration plan: ${profile.migrationPlanId}`);
  console.log(`Backup evidence: ${profile.backupEvidenceId}`);
  console.log(`Expires at: ${profile.expiresAt}`);
  console.log(`File: ${report.profileFile}`);
}

export function printProviderAcceptanceSuiteResult(report) {
  if (report.kind === 'provider-acceptance-readiness') {
    console.log(`Provider acceptance readiness: ${report.status}`);
    console.log(`Project: ${report.projectId}`);
    console.log(`Initial Sandbox: ${report.summary.providersReadyForInitialSandbox}/${report.summary.totalProviders} providers ready`);
    console.log(`Complete acceptance: ${report.summary.providersReadyForCompleteAcceptance}/${report.summary.totalProviders} providers ready`);
    for (const item of report.providers) {
      console.log(`${item.provider}: initial=${item.initialStatus}, completion=${item.completionStatus}`);
      for (const connection of item.connections) {
        console.log(`  ${connection.id}: ${connection.status}${connection.connectionId ? ` (${connection.connectionId})` : ''}`);
      }
    }
    if (report.blockers.length > 0) {
      console.log('Blockers:');
      for (const blocker of report.blockers) {
        console.log(`- ${blocker.provider}/${blocker.requirementId}: ${blocker.code}`);
      }
    }
    return;
  }
  const suite = report.suite;
  console.log(`Provider acceptance suite: ${suite.id}`);
  console.log(`Status: ${suite.status}`);
  console.log(`Project: ${suite.projectId}`);
  console.log(`Runs: ${suite.sources.length}`);
  for (const item of suite.coverage) {
    console.log(`${item.provider}: ${item.status}`);
    if (item.missingMethods.length > 0) console.log(`  Missing: ${item.missingMethods.join(', ')}`);
  }
  console.log(`File: ${report.suiteFile}`);
}

export function printProviderAcceptancePortfolioResult(report) {
  const portfolio = report.portfolio;
  console.log(`Provider acceptance portfolio: ${portfolio.id}`);
  console.log(`Status: ${portfolio.status}`);
  console.log(`Validation release: ${portfolio.validationRelease.packageName}@${portfolio.validationRelease.packageVersion}`);
  console.log(`Projects: ${report.sourceProjectsRevalidated.join(', ')}`);
  console.log(`Suites: ${portfolio.sources.length}`);
  for (const item of portfolio.coverage) {
    console.log(`${item.provider}: ${item.status}`);
    if (item.missingMethods.length > 0) console.log(`  Missing: ${item.missingMethods.join(', ')}`);
  }
  console.log(`File: ${report.portfolioFile}`);
}

export function printAcceptanceCleanupResult(report) {
  if (report.attestation) {
    console.log(`Cleanup attestation: ${report.attestation.id}`);
    console.log(`Status: ${report.attestation.status}`);
    console.log(`Plan: ${report.attestation.cleanupPlanId}`);
    console.log(`Actor: ${report.attestation.actor}`);
    console.log(`Dispositions: ${report.attestation.dispositions.length}`);
    console.log(`Verification basis: ${report.attestation.verificationBasis}`);
    console.log(`Provider deletes executed: ${report.providerDeletesExecuted}`);
    console.log(`File: ${report.attestationFile}`);
    return;
  }
  const plan = report.plan;
  console.log(`Cleanup plan: ${plan.id}`);
  console.log(`Status: ${plan.status}`);
  console.log(`Project: ${plan.projectId}`);
  console.log(`Acceptance suite: ${plan.acceptanceSuiteId}`);
  console.log(`Owner: ${plan.cleanupOwner}`);
  console.log(`Deadline: ${plan.cleanupDeadline}`);
  console.log(`Resources: ${plan.resources.length}`);
  console.log(`Unresolved mutations: ${plan.unresolvedMutations.length}`);
  console.log(`Provider mutations accounted: ${plan.providerMutationCount}`);
  console.log(`Provider deletes executed: ${report.providerDeletesExecuted}`);
  console.log(`File: ${report.planFile}`);
}

export function printDetection(detection) {
  console.log(`Project: ${detection.appName}`);
  console.log(`Package manager: ${detection.packageManager}`);
  console.log(`Frameworks: ${detection.frameworks.join(', ') || '(none)'}`);
  console.log(`Env keys: ${detection.envKeys.join(', ') || '(none)'}`);
  console.log(`Build: ${detection.commands.build || '(none)'}`);
  console.log(`Deploy: ${detection.commands.deploy || '(none)'}`);
}

export function printPlan(plan) {
  console.log(`Plan: ${plan.id}`);
  if (plan.fingerprint) {
    console.log(`Fingerprint: ${plan.fingerprint}`);
  }
  console.log(`App: ${plan.appId}`);
  console.log(`Target: ${plan.target?.provider || 'local'} / ${plan.target?.type || 'unknown'}`);
  console.log(`Steps: ${plan.summary.pending} pending, ${plan.summary.skipped} skipped, ${plan.summary.total} total`);
  for (const [index, step] of plan.steps.entries()) {
    const marker = step.status === 'skipped' ? '-' : `${index + 1}.`;
    const suffix = step.reason ? ` (${step.reason})` : '';
    console.log(`${marker} ${step.title}${suffix}`);
    printActions(step.actions || [], '   ');
  }
  if (plan.disabledResources?.length) {
    console.log('\nDisabled resources:');
    for (const resource of plan.disabledResources) {
      console.log(`- ${resource.id}: ${resource.type} (${resource.reason})`);
    }
  }
}

export function printDoctor(report) {
  console.log(`Doctor: ${report.status}`);
  console.log(`App: ${report.appId}`);
  console.log(`Target: ${report.target?.provider || 'local'} / ${report.target?.type || 'unknown'}`);
  console.log(`Pending steps: ${report.pendingSteps}`);
  console.log(`Skipped steps: ${report.skippedSteps}`);
  if (report.planFingerprint) {
    console.log(`Plan fingerprint: ${report.planFingerprint}`);
  }
  if (report.verifyTarget) {
    console.log(`Verify target: ${report.verifyTarget}`);
  }

  printList('Required tools', report.requiredTools);
  printList('Missing tools', report.missingTools);
  printList('Tracked sensitive files', report.trackedSensitiveFiles);
  printList('Missing Git identity', report.missingGitIdentity);
  if (report.deploymentLock) {
    console.log(
      `Deployment lock: ${report.deploymentLock.status} ${report.deploymentLock.command} pid ${report.deploymentLock.pid || 'unknown'}`
    );
  }
  printList(
    'Provider auth checks',
    report.providerAuthChecks?.map((check) => formatProviderAuthCheck(check))
  );
  printList(
    'Manifest issues',
    report.manifestIssues?.map((issue) => formatManifestIssue(issue))
  );
  printList(
    'State issues',
    report.stateIssues?.map((issue) => `${issue.stepId}: ${issue.reason}`)
  );
  printList(
    'Managed file drift',
    report.managedFileDrift?.map((file) => `${file.path}: ${file.status}`)
  );
  printList('Missing env', report.missingEnv);
  printList(
    'Policy blocked actions',
    report.policyBlocked.map((action) => `${action.stepId}: ${action.effect}`)
  );
  printList(
    'Unsupported actions',
    report.unsupportedActions.map((action) => `${action.stepId}: ${action.effect}`)
  );
  printList(
    'Secret sources',
    report.secretSources.map((secret) => `${secret.secret} from ${secret.source} (${secret.output})`)
  );
  printList(
    'Next actions',
    report.nextActions.map((action) => formatNextAction(action))
  );
}

export function printValidation(validation) {
  console.log(`Manifest: ${validation.status}`);
  console.log(`Errors: ${validation.errors}`);
  console.log(`Warnings: ${validation.warnings}`);
  printList(
    'Issues',
    validation.issues.map((issue) => formatManifestIssue(issue))
  );
}

export function printHandoff(handoff) {
  console.log(`Handoff: ${handoff.readinessStatus}`);
  console.log(`App: ${handoff.appId}`);
  console.log(`Target: ${handoff.target?.provider || 'local'} / ${handoff.target?.type || 'unknown'}`);
  console.log(
    `Validation: ${handoff.validation?.status || 'unknown'} (${handoff.validation?.errors || 0} errors, ${handoff.validation?.warnings || 0} warnings)`
  );
  console.log(
    `Plan: ${handoff.plan.summary?.pending || 0} pending, ${handoff.plan.summary?.skipped || 0} skipped, ${handoff.plan.summary?.total || 0} total`
  );
  if (handoff.state) {
    console.log(`State resources: ${handoff.state.resources.length}`);
    if (handoff.state.github.repoUrl) {
      console.log(`GitHub repo: ${handoff.state.github.repoUrl}`);
    }
    if (handoff.state.deploymentUrl) {
      console.log(`Deployment URL: ${handoff.state.deploymentUrl}`);
    }
    if (handoff.state.lastRun) {
      console.log(
        `Last run: ${handoff.state.lastRun.id} ${handoff.state.lastRun.command} ${handoff.state.lastRun.status}`
      );
    }
  }
  printList(
    'Approval artifacts',
    formatApprovalArtifacts(handoff.approvalArtifacts)
  );
  printList('Apply decision', formatApplyDecision(handoff.applyDecision));
  printList(
    'Next actions',
    (handoff.nextActions || handoff.doctor.nextActions || []).map((action) => formatNextAction(action))
  );
  printList(
    'Command contracts',
    (handoff.commandContracts || []).map((contract) => formatCommandContract(contract))
  );
  printList(
    'Suggested commands',
    handoff.suggestedCommands.map((command) => `${command.id}: ${command.argv.join(' ')}`)
  );
}

export function printPrepare(report) {
  console.log(`Prepare: ${report.status}`);
  console.log(`App: ${report.appId}`);
  console.log(`Target: ${report.target?.provider || 'local'} / ${report.target?.type || 'unknown'}`);
  console.log(
    `Validation: ${report.validation?.status || 'unknown'} (${report.validation?.errors || 0} errors, ${report.validation?.warnings || 0} warnings)`
  );
  if (report.planFingerprint) {
    console.log(`Plan fingerprint: ${report.planFingerprint}`);
  }
  printList(
    'Written artifacts',
    Object.values(report.artifacts || {}).map((artifact) => formatPreparedArtifact(artifact))
  );
  printList(
    'Approval artifacts',
    formatApprovalArtifacts(report.approvalArtifacts)
  );
  printList('Apply decision', formatApplyDecision(report.applyDecision));
  printList(
    'Next actions',
    (report.nextActions || []).map((action) => formatNextAction(action))
  );
  printList(
    'Command contracts',
    (report.commandContracts || []).map((contract) => formatCommandContract(contract))
  );
  printList(
    'Suggested commands',
    (report.suggestedCommands || []).map((command) => `${command.id}: ${command.argv.join(' ')}`)
  );
}

export function printOnboard(report) {
  console.log(`Onboard: ${report.readinessStatus}`);
  console.log(`Sidecar: ${report.sidecar?.status || 'unknown'}`);
  console.log(`App: ${report.appId}`);
  console.log(`Target: ${report.target?.provider || 'local'} / ${report.target?.type || 'unknown'}`);
  console.log(
    `Validation: ${report.validation?.status || 'unknown'} (${report.validation?.errors || 0} errors, ${report.validation?.warnings || 0} warnings)`
  );
  if (report.status?.planFingerprint) {
    console.log(`Plan fingerprint: ${report.status.planFingerprint}`);
  }
  printList(
    'Sidecar files',
    Object.entries(report.sidecar?.files || {}).map(([id, file]) => `${id}: ${file}`)
  );
  printList(
    'Written artifacts',
    Object.values(report.artifacts || {}).map((artifact) => formatPreparedArtifact(artifact))
  );
  printList(
    'Approval artifacts',
    formatApprovalArtifacts(report.approvalArtifacts)
  );
  printList('Apply decision', formatApplyDecision(report.applyDecision));
  printList(
    'Next actions',
    (report.nextActions || []).map((action) => formatNextAction(action))
  );
  printList(
    'Suggested commands',
    (report.suggestedCommands || []).map((command) => `${command.id}: ${command.argv.join(' ')}`)
  );
}

export function printReview(review) {
  console.log(`Review: ${review.reviewStatus}`);
  console.log(`App: ${review.appId}`);
  console.log(`Target: ${review.target?.provider || 'local'} / ${review.target?.type || 'unknown'}`);
  console.log(
    `Validation: ${review.validation?.status || 'unknown'} (${review.validation?.errors || 0} errors, ${review.validation?.warnings || 0} warnings)`
  );
  if (review.planFingerprint) {
    console.log(`Plan fingerprint: ${review.planFingerprint}`);
  }
  console.log(
    `Readiness: ${review.readiness?.pendingSteps || 0} pending, ${review.readiness?.skippedSteps || 0} skipped`
  );
  if (review.readiness?.verifyTarget) {
    console.log(`Verify target: ${review.readiness.verifyTarget}`);
  }
  if (review.secretSummary) {
    console.log(
      `Secrets: ${review.secretSummary.total} total, ${review.secretSummary.missingShellEnv.length} missing shell env, ${review.secretSummary.missingManagedEnv.length} missing managed env`
    );
  } else {
    console.log('Secrets: unavailable');
  }
  if (review.runSummary?.latest) {
    const latest = review.runSummary.latest;
    console.log(`Latest run: ${latest.id} ${latest.command} ${latest.mode} ${latest.status}`);
    if (latest.failedStep) {
      console.log(`Failed step: ${latest.failedStep.stepId}`);
    }
    if (latest.file) {
      console.log(`Run artifact: .agentmesh-deploy/${latest.file}`);
    }
  } else {
    console.log(`Runs: ${review.runSummary?.total || 0}`);
  }
  printList(
    'Managed file drift',
    review.managedFileDrift?.map((file) => `${file.path}: ${file.status}`)
  );
  printList('Blocking reasons', review.blockingReasons);
  printList(
    'Next actions',
    (review.nextActions || []).map((action) => formatNextAction(action))
  );
  printList('Apply decision', formatApplyDecision(review.applyDecision));
  printList(
    'Command contracts',
    (review.commandContracts || []).map((contract) => formatCommandContract(contract))
  );
  printList(
    'Suggested commands',
    (review.suggestedCommands || []).map((command) => `${command.id}: ${command.argv.join(' ')}`)
  );
}

export function printManagedFileDiff(report) {
  console.log(`Managed file diff: ${report.summary.changed} changed, ${report.summary.current} current, ${report.summary.total} total`);
  console.log(`App: ${report.appId}`);
  console.log(`Target: ${report.target?.provider || 'local'} / ${report.target?.type || 'unknown'}`);
  if (report.planFingerprint) {
    console.log(`Plan fingerprint: ${report.planFingerprint}`);
  }
  if (report.summary.redacted) {
    console.log(`Redacted files: ${report.summary.redacted}`);
  }

  for (const file of report.files || []) {
    console.log(`\n--- ${file.path}: ${file.status}${file.redacted ? ' (redacted)' : ''} ---`);
    if (file.valueOnlySecretChange) {
      console.log(file.redactionNote);
      continue;
    }
    if (file.diff) {
      process.stdout.write(file.diff);
    }
  }
}

export function printRuns(report) {
  console.log(`Runs: ${report.runs.length}`);
  console.log(`App: ${report.appId || '(unknown)'}`);
  if (!report.runs.length) {
    return;
  }
  for (const run of report.runs) {
    const counts = run.resultCounts ? ` ${formatResultCounts(run.resultCounts)}` : '';
    const failed = run.failedStep ? ` failed=${run.failedStep.stepId}` : '';
    console.log(
      `- ${run.id}: ${run.command || 'unknown'} ${run.mode || 'unknown'} ${run.status || 'unknown'} ${run.createdAt || ''}${counts}${failed}`.trim()
    );
  }
  if (report.selectedRun) {
    const selected = report.selectedRun;
    console.log(`Selected run: ${selected.artifact?.id || selected.id || '(unknown)'} ${selected.status}`);
    if (selected.file) {
      console.log(`Run artifact: .agentmesh-deploy/${selected.file}`);
    }
    if (selected.error) {
      console.log(`Error: ${selected.error}`);
    }
    if (selected.artifact) {
      console.log(`Command: ${selected.artifact.command || 'unknown'}`);
      console.log(`Mode: ${selected.artifact.mode || 'unknown'}`);
      console.log(`Status: ${selected.artifact.status || 'unknown'}`);
      if (selected.artifact.plan?.fingerprint) {
        console.log(`Plan fingerprint: ${selected.artifact.plan.fingerprint}`);
      }
      console.log(`Results: ${formatResultCounts(countRunResults(selected.artifact.results || []))}`);
      const failed = (selected.artifact.results || []).find((result) => result.status === 'failed');
      if (failed) {
        console.log(`Failed step: ${failed.stepId}`);
        if (failed.error) {
          console.log(`Failure: ${failed.error}`);
        }
      }
    }
  }
}

export function printSecrets(report) {
  console.log(`Secrets: ${report.secrets.length}`);
  console.log(`App: ${report.appId || '(unknown)'}`);
  printList('Missing shell env', report.missingShellEnv);
  printList(
    'Missing managed env',
    report.missingManagedEnv.map((secret) => `${secret.file}:${secret.key}`)
  );
  printList('Missing state', report.missingState || []);
  for (const secret of report.secrets) {
    const location = secretLocation(secret);
    const present = secret.present ? 'present' : 'missing';
    console.log(`- ${secret.key}: ${secret.consumer} from ${location} (${present})`);
  }
}

export function printActions(actions, indent = '', writeLine = console.log) {
  for (const action of actions) {
    if (action.type === 'command') {
      writeLine(`${indent}$ ${formatActionCommand(action.command)}  # ${action.effect}`);
      if (action.stdinFromEnv) {
        writeLine(`${indent}  stdin: env ${action.stdinFromEnv}`);
      }
      if (action.stdinFromManagedEnvFile) {
        writeLine(
          `${indent}  stdin: ${action.stdinFromManagedEnvFile.file}:${action.stdinFromManagedEnvFile.key}`
        );
      }
      if (action.stdinFromState) {
        writeLine(`${indent}  stdin: state.${action.stdinFromState.path}`);
      }
      if (action.redactOutput) {
        writeLine(`${indent}  output: redacted in console and run artifacts`);
      }
      continue;
    }
    if (action.type === 'provider-auth-check') {
      writeLine(`${indent}$ ${formatActionCommand(action.displayCommand || action.command)}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'env-check') {
      writeLine(`${indent}check env ${action.keys.join(', ')}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'env-any-check') {
      writeLine(`${indent}check env any of ${action.keys.join(', ')}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'tool-check') {
      writeLine(`${indent}check tools ${action.tools.join(', ')}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'ssh-key-check') {
      const sources = [
        action.identityFileEnv || 'AGENTMESH_DEPLOY_SSH_KEY_PATH',
        action.privateKeyEnv || 'AGENTMESH_DEPLOY_SSH_PRIVATE_KEY',
        action.publicKeyEnv,
      ].filter(Boolean);
      writeLine(`${indent}check SSH key material from ${sources.join(', ')}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'cloudflare-resource') {
      writeLine(
        `${indent}$ ${formatActionCommand(action.listCommand)}  # check for existing ${action.resource.type} ${action.resource.name}`
      );
      writeLine(
        `${indent}$ ${formatActionCommand(action.createCommand)}  # create only when missing`
      );
      continue;
    }
    if (action.type === 'digitalocean-droplet') {
      writeLine(
        `${indent}ensure DigitalOcean droplet ${action.dropletName || '<name>'} in ${action.region || '<region>'}  # ${action.effect}`
      );
      continue;
    }
    if (action.type === 'digitalocean-ssh-key') {
      writeLine(
        `${indent}ensure DigitalOcean SSH key ${action.keyName || '<name>'} from ${action.sshKeysEnv || '<ssh-key-ids-env>'} or ${action.publicKeyEnv || '<public-key-env>'}  # ${action.effect}`
      );
      continue;
    }
    if (action.type === 'cloudflare-dns-record') {
      writeLine(
        `${indent}ensure Cloudflare ${action.recordType || 'A'} record ${action.name || '<name>'} -> ${action.value || `state.${action.valueStatePath || '<target>'}`}  # ${action.effect}`
      );
      continue;
    }
    if (action.type === 'cloudflare-zone') {
      writeLine(
        `${indent}ensure Cloudflare zone ${action.zoneName || '<zone>'}  # ${action.effect}`
      );
      continue;
    }
    if (action.type === 'cloudflare-domain-registration') {
      writeLine(
        `${indent}register Cloudflare Registrar domain ${action.root || '<domain>'} with max $${action.maxCostUsd || '<cap>'}  # ${action.effect}`
      );
      continue;
    }
    if (action.type === 'porkbun-domain-registration') {
      writeLine(
        `${indent}register Porkbun domain ${action.root || '<domain>'} with max $${action.maxCostUsd || '<cap>'}  # ${action.effect}`
      );
      continue;
    }
    if (action.type === 'porkbun-nameservers') {
      writeLine(
        `${indent}bind Porkbun nameservers for ${action.root || '<domain>'} from state.${action.nameserversStatePath || '<nameservers>'}  # ${action.effect}`
      );
      continue;
    }
    if (action.type === 'git-tracked-check') {
      writeLine(`${indent}check git tracked sensitive files  # ${action.effect}`);
      continue;
    }
    if (action.type === 'git-identity-check') {
      writeLine(`${indent}check git identity  # ${action.effect}`);
      continue;
    }
    if (action.type === 'github-repo') {
      const [viewCommand, createCommand] = action.commands || [];
      if (viewCommand) {
        writeLine(`${indent}$ ${formatActionCommand(viewCommand)}  # check repository and capture URL`);
      }
      if (createCommand) {
        writeLine(`${indent}$ ${formatActionCommand(createCommand)}  # create only when repository is missing`);
      }
      continue;
    }
    if (action.type === 'github-secret') {
      writeLine(
        `${indent}$ gh secret set ${quoteArg(action.key || action.secret || '<secret>')} --repo <github-repo>  # ${action.effect}`
      );
      if (action.stdinFromEnv) {
        writeLine(`${indent}  stdin: env ${action.stdinFromEnv}`);
      }
      if (action.stdinFromManagedEnvFile) {
        writeLine(
          `${indent}  stdin: ${action.stdinFromManagedEnvFile.file}:${action.stdinFromManagedEnvFile.key}`
        );
      }
      if (action.stdinFromState) {
        writeLine(`${indent}  stdin: state.${action.stdinFromState.path}`);
      }
      if (action.redactOutput) {
        writeLine(`${indent}  output: redacted in console and run artifacts`);
      }
      continue;
    }
    if (action.type === 'git-commit-if-changed') {
      writeLine(`${indent}$ git status --porcelain  # check for changes before commit`);
      writeLine(`${indent}$ ${formatActionCommand(action.command)}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'git-init-if-missing') {
      writeLine(`${indent}$ git rev-parse --is-inside-work-tree  # check local Git repository`);
      writeLine(`${indent}$ git init  # ${action.effect}`);
      continue;
    }
    if (action.type === 'git-remote-ensure') {
      const remote = action.remote || 'origin';
      writeLine(`${indent}$ git remote get-url ${remote}  # check Git remote`);
      writeLine(`${indent}$ git remote add ${remote} <github-repo-url>  # ${action.effect}`);
      continue;
    }
    if (action.type === 'file') {
      writeLine(`${indent}write ${action.path}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'ssh-command') {
      writeLine(
        `${indent}$ ssh -p ${action.port || 22} ${action.user || 'root'}@${action.host || `state.${action.hostStatePath || '<host>'}`} ${quoteArg(action.remoteCommand || '<remote-command>')}  # ${action.effect}${formatSshIdentityHint(action)}${formatRetryHint(action)}`
      );
      continue;
    }
    if (action.type === 'rsync-to-host') {
      const deleteFlag = action.delete === false ? '' : ' --delete';
      const destinationSuffix = action.destinationIsFile ? '' : '/';
      writeLine(
        `${indent}$ rsync -az${deleteFlag} ${action.source || './'} ${action.user || 'root'}@${action.host || `state.${action.hostStatePath || '<host>'}`}:${action.destination || '<destination>'}${destinationSuffix}  # ${action.effect}${formatSshIdentityHint(action)}${formatRetryHint(action)}`
      );
      continue;
    }
    if (action.type === 'http-check') {
      writeLine(`${indent}GET ${formatHttpTarget(action)}  # ${action.effect}`);
      continue;
    }
    if (action.type === 'manual') {
      writeLine(`${indent}manual: ${action.effect}`);
    }
  }
}

function secretLocation(secret) {
  if (secret.source === 'shell-env') return `env:${secret.key}`;
  if (secret.source === 'state') return `state.${secret.path}`;
  return `${secret.file}:${secret.key}`;
}

function formatActionCommand(command) {
  if (Array.isArray(command)) {
    return command.map(quoteArg).join(' ');
  }
  return String(command);
}

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatHttpTarget(action) {
  if (action.url) return action.url;
  if (action.urlStatePath) return `state.${action.urlStatePath}`;
  return '<url>';
}

function formatProviderAuthCheck(check) {
  const suffix = check.error ? ` - ${check.error}` : '';
  return `${check.provider}: ${check.status} (${check.command})${suffix}`;
}

export function printStatus(state) {
  const report = isStatusReport(state) ? state : null;
  const summary = report?.state || state;

  console.log(`App: ${report?.appId || summary?.appId || '(unknown)'}`);
  if (report) {
    console.log(`Readiness: ${report.readinessStatus}`);
    console.log(
      `Validation: ${report.validation?.status || 'unknown'} (${report.validation?.errors || 0} errors, ${report.validation?.warnings || 0} warnings)`
    );
    if (report.planFingerprint) {
      console.log(`Plan fingerprint: ${report.planFingerprint}`);
    }
    if (report.planSummary) {
      console.log(
        `Plan: ${report.planSummary.pending || 0} pending, ${report.planSummary.skipped || 0} skipped, ${report.planSummary.total || 0} total`
      );
    }
    if (report.doctor?.verifyTarget) {
      console.log(`Verify target: ${report.doctor.verifyTarget}`);
    }
    if (report.doctor?.deploymentLock) {
      const lock = report.doctor.deploymentLock;
      console.log(
        `Deployment lock: ${lock.status} ${lock.command} pid ${lock.pid || 'unknown'}`
      );
    }
    printList(
      'Managed file drift',
      report.doctor?.managedFileDrift?.map((file) => `${file.path}: ${file.status}`)
    );
    printList(
      'Approval artifacts',
      formatApprovalArtifacts(report.approvalArtifacts)
    );
    printList('Apply decision', formatApplyDecision(report.applyDecision));
  }

  if (!summary) {
    printList(
      'Next actions',
      (report?.nextActions || []).map((action) => formatNextAction(action))
    );
    printList(
      'Command contracts',
      (report?.commandContracts || []).map((contract) => formatCommandContract(contract))
    );
    return;
  }

  console.log(`Completed steps: ${summary.completedSteps.length}`);
  const resources = Array.isArray(summary.resources)
    ? summary.resources.map((resource) => [resource.id, resource])
    : Object.entries(summary.resources || {});
  console.log(`Resources: ${resources.length}`);
  for (const [id, resource] of resources) {
    console.log(`- ${id}: ${resource.type} ${resource.name || resource.providerId || ''}`.trim());
  }
  if (summary.github?.repoUrl) {
    console.log(`GitHub repo: ${summary.github.repoUrl}`);
  }
  if (summary.deploymentUrl) {
    console.log(`Deployment URL: ${summary.deploymentUrl}`);
  }
  const lastRun = summary.lastRun || summary.runs?.at(-1);
  if (lastRun) {
    console.log(`Last run: ${lastRun.id} ${lastRun.command} ${lastRun.mode} ${lastRun.status}`);
    if (lastRun.resultCounts) {
      console.log(`Last run results: ${formatResultCounts(lastRun.resultCounts)}`);
    }
    if (lastRun.failedStep) {
      const label = lastRun.failedStep.stepTitle
        ? `${lastRun.failedStep.stepId} (${lastRun.failedStep.stepTitle})`
        : lastRun.failedStep.stepId;
      console.log(`Failed step: ${label}`);
      if (lastRun.failedStep.error) {
        console.log(`Failure: ${lastRun.failedStep.error}`);
      }
    }
    if (lastRun.file) {
      console.log(`Run artifact: .agentmesh-deploy/${lastRun.file}`);
    }
  }
  if (report) {
    printList(
      'Next actions',
      (report.nextActions || []).map((action) => formatNextAction(action))
    );
    printList(
      'Command contracts',
      (report.commandContracts || []).map((contract) => formatCommandContract(contract))
    );
    printList(
      'Suggested commands',
      (report.suggestedCommands || []).map((command) => `${command.id}: ${command.argv.join(' ')}`)
    );
  }
}

function isStatusReport(value) {
  return Boolean(value && typeof value === 'object' && value.validation && value.doctor && 'state' in value);
}

function formatApprovalArtifacts(artifacts) {
  if (!artifacts) return [];
  return ['review', 'diff']
    .filter((key) => artifacts[key])
    .map((key) => {
      const artifact = artifacts[key];
      const suffix = artifact.error ? ` - ${artifact.error}` : '';
      return `${key}: ${artifact.status} (${artifact.rootRelativeFile})${suffix}`;
    });
}

function formatApplyDecision(decision) {
  if (!decision) return [];

  const lines = [
    `dry-run: ${decision.dryRun?.status || 'unknown'}${formatMaybeCommand(decision.dryRun?.command)}`,
    `execute: ${decision.execute?.status || 'unknown'}${formatMaybeCommand(decision.execute?.command)}`,
  ];

  if (decision.execute?.requiredApprovals?.length) {
    lines.push(`approvals: ${decision.execute.requiredApprovals.join(', ')}`);
  }
  if (decision.dryRun?.blockers?.length) {
    lines.push(`blockers: ${decision.dryRun.blockers.map((blocker) => blocker.id).join(', ')}`);
  }
  if (decision.recommendedNextAction) {
    lines.push(`next: ${decision.recommendedNextAction}`);
  }

  return lines;
}

function formatMaybeCommand(command) {
  return command?.length ? ` (${command.join(' ')})` : '';
}

function formatSshIdentityHint(action) {
  const fields = [];
  if (action.identityFileEnv) fields.push(`keyPathEnv=${action.identityFileEnv}`);
  if (action.privateKeyEnv) fields.push(`privateKeyEnv=${action.privateKeyEnv}`);
  return fields.length ? `; ssh identity ${fields.join(' ')}` : '';
}

function formatRetryHint(action) {
  if (!action.maxAttempts || Number(action.maxAttempts) <= 1) return '';
  const parts = [`maxAttempts=${action.maxAttempts}`];
  if (action.retryDelayMs !== undefined) parts.push(`delayMs=${action.retryDelayMs}`);
  if (action.retryExitCodes?.length) parts.push(`exitCodes=${action.retryExitCodes.join(',')}`);
  return `; retry ${parts.join(' ')}`;
}

function formatResultCounts(counts) {
  return ['completed', 'failed', 'skipped', 'dry-run']
    .filter((key) => counts[key])
    .map((key) => `${key}=${counts[key]}`)
    .join(', ') || `total=${counts.total || 0}`;
}

function countRunResults(results) {
  const counts = { total: results.length };
  for (const result of results) {
    const status = result.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function printList(title, values) {
  if (!values?.length) {
    console.log(`${title}: none`);
    return;
  }
  console.log(`${title}:`);
  for (const value of values) {
    console.log(`- ${value}`);
  }
}

function formatNextAction(action) {
  const details = [];
  if (action.tools?.length) details.push(`tools: ${action.tools.join(', ')}`);
  if (action.env?.length) details.push(`env: ${action.env.join(', ')}`);
  if (action.files?.length) details.push(`files: ${formatDetailItems(action.files)}`);
  if (action.config?.length) details.push(`config: ${action.config.join(', ')}`);
  if (action.flags?.length) details.push(`flags: ${action.flags.join(' ')}`);
  if (action.stepIds?.length) details.push(`steps: ${action.stepIds.join(', ')}`);
  if (action.issues?.length) details.push(`issues: ${action.issues.length}`);
  if (action.artifacts?.length) {
    details.push(
      `artifacts: ${action.artifacts
        .map((artifact) => `${artifact.id}=${artifact.status}`)
        .join(', ')}`
    );
  }
  const suffix = details.length ? ` (${details.join('; ')})` : '';
  return `${action.id}: ${action.title}${suffix}`;
}

function formatCommandContract(contract) {
  return `${contract.id}: ${contract.argv.join(' ')}`;
}

function formatPreparedArtifact(artifact) {
  const suffix = artifact.reason ? ` - ${artifact.reason}` : '';
  return `${artifact.id}: ${artifact.status} (${artifact.rootRelativeFile})${suffix}`;
}

function formatDetailItems(items) {
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      return item?.path || item?.file || item?.id || String(item);
    })
    .join(', ');
}

function formatManifestIssue(issue) {
  return `[${issue.severity}] ${issue.path} ${issue.code}: ${issue.message}`;
}
