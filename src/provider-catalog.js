import { operationError } from './errors.js';

const PROVIDERS = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    roles: ['registrar', 'dns', 'runtime', 'database', 'storage'],
    interfaces: ['cli', 'rest-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [{ id: 'api-token', env: 'CLOUDFLARE_API_TOKEN', scope: 'specific-zone-dns' }],
      contextEnv: ['CLOUDFLARE_ACCOUNT_ID'],
      bootstrapContext: [
        { env: 'CLOUDFLARE_ACCOUNT_ID', requirement: 'required', source: 'account-overview-api-or-workers-account-details' },
      ],
      tokenType: 'user-api-token',
      requiredPermissions: ['Zone / Zone / Read', 'Zone / DNS / Edit'],
      resourceScope: 'Include / Specific zone / <现有 Zone 名称>',
      identityProbe: [
        'GET https://api.cloudflare.com/client/v4/user/tokens/verify 验证 User API Token',
        'GET /client/v4/zones?name=<zone>&account.id=<account-id> 并要求唯一精确匹配',
        'GET /client/v4/zones/<zone-id>/dns_records 并要求返回可读取的记录数组',
      ],
      secretStorage: 'env-or-secret-store',
    },
    bootstrapSteps: [
      '用户注册 Cloudflare，完成邮箱、MFA、条款和需要的计费初始化。',
      'DNS 首次上线创建 User API Token，权限只选 Zone / Zone / Read 与 Zone / DNS / Edit，Zone Resources 只 Include 目标现有 Zone。',
      '从 Account Home > Overview > API 或 Workers & Pages > Account details 复制 CLOUDFLARE_ACCOUNT_ID，并把它和 Token 分别保存为 Secret Ref。',
      'Agent 依次验证 Token、按 Account ID 和 Zone 名精确读取唯一 Zone、再读取该 Zone 的 DNS Record 列表；仅 /user/tokens/verify 成功不算 Scope 验证。',
      '本轮 DNS Token 不授予 Account 写、Workers、Registrar、D1、R2、KV 或其他 Zone；需要这些能力时另建最小权限 Connection。',
      '域名购买、生产 DNS、收费资源和删除动作分别等待对应 Approval。',
    ],
    capabilities: {
      read: ['identity', 'accounts', 'zones', 'dns', 'workers', 'd1', 'r2', 'kv', 'registrar'],
      write: ['zone', 'dns', 'worker', 'd1', 'r2', 'kv', 'domain-registration'],
      async: ['zone-activation', 'dns', 'worker-deployment'],
    },
    humanOnly: ['account-signup', 'mfa', 'billing', 'terms', 'api-token-creation', 'domain-purchase-confirmation'],
    docs: [
      'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
      'https://developers.cloudflare.com/fundamentals/api/reference/template/',
      'https://developers.cloudflare.com/api/resources/zones/methods/list/',
      'https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/',
      'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/',
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    roles: ['source', 'delivery', 'secrets'],
    interfaces: ['cli', 'rest-api', 'graphql-api', 'github-app'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [
        { id: 'cli-token', env: 'GH_TOKEN', scope: 'user-or-organization' },
        { id: 'github-app', env: 'GITHUB_APP_PRIVATE_KEY', scope: 'installation', preferredForHosted: true },
      ],
      identityProbe: ['gh', 'auth', 'status'],
      secretStorage: 'env-os-keychain-or-app-vault',
    },
    bootstrapSteps: [
      '本地用户完成 gh auth login；托管 Agent 优先安装最小权限 GitHub App。',
      'Agent 执行只读身份、仓库和 Actions Secret Metadata 探测。',
      '产品仓库默认只读；需要修改代码时只生成外部 Patch/PR，不能直接改 Branch、Index 或 Remote。',
      '创建仓库、设置 Actions Secret、触发 Workflow 或 Push 都需要 Graph Node Approval。',
    ],
    capabilities: {
      read: ['identity', 'repositories', 'branches', 'commits', 'actions', 'secret-metadata'],
      write: ['repository', 'pull-request', 'actions-secret', 'workflow-dispatch'],
      async: ['actions-run', 'check-run'],
    },
    humanOnly: ['account-signup', 'mfa', 'organization-policy', 'app-installation', 'pat-creation'],
    docs: ['https://cli.github.com/manual/gh_auth_login', 'https://docs.github.com/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps'],
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    roles: ['runtime', 'dns', 'database', 'storage'],
    interfaces: ['cli', 'rest-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [{ id: 'api-token', env: 'DIGITALOCEAN_ACCESS_TOKEN', scope: 'account-token' }],
      identityProbe: ['doctl', 'account', 'get', '--output', 'json'],
      secretStorage: 'env-or-os-keychain',
    },
    bootstrapSteps: [
      '用户注册 DigitalOcean，完成 MFA、条款、支付方式和项目归属。',
      '创建 API Token 并保存 DIGITALOCEAN_ACCESS_TOKEN Secret Ref。',
      'Agent 先读取 Account、Project、Region、Size、SSH Key 和资源清单。',
      'Droplet、Managed Database 等收费 Create 必须绑定预算 Approval；SSH 私钥使用独立 Secret Ref。',
    ],
    capabilities: {
      read: ['account', 'projects', 'regions', 'sizes', 'ssh-keys', 'droplets', 'domains', 'databases'],
      write: ['ssh-key', 'droplet', 'domain', 'dns', 'database', 'volume'],
      async: ['droplet', 'database', 'domain'],
    },
    humanOnly: ['account-signup', 'mfa', 'billing', 'terms', 'api-token-creation'],
    docs: ['https://docs.digitalocean.com/reference/doctl/how-to/install/', 'https://docs.digitalocean.com/reference/api/create-personal-access-token/'],
  },
  {
    id: 'porkbun',
    name: 'Porkbun',
    roles: ['registrar', 'dns'],
    interfaces: ['rest-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [
        { id: 'api-key', env: 'PORKBUN_API_KEY', scope: 'account' },
        { id: 'secret-api-key', env: 'PORKBUN_SECRET_API_KEY', scope: 'account' },
      ],
      mode: 'all',
      identityProbe: ['POST', 'https://api.porkbun.com/api/json/v3/ping'],
      secretStorage: 'env-or-secret-store',
    },
    bootstrapSteps: [
      '用户注册 Porkbun，完成邮箱、MFA、条款和支付方式。',
      '在 Account API Access 创建 API Key/Secret Key，并为目标域名启用 API Access。',
      '两项凭证分别保存为 Secret Ref，Agent 先调用 Ping 和只读域名/DNS 查询。',
      '域名购买必须确认可用性、非 Premium、价格上限、联系人和条款；最终购买由费用 Approval 控制。',
    ],
    capabilities: {
      read: ['identity', 'domain-pricing', 'domains', 'nameservers', 'dns'],
      write: ['domain-registration', 'nameservers', 'dns'],
      async: ['domain-registration', 'nameserver-propagation'],
    },
    humanOnly: ['account-signup', 'mfa', 'billing', 'terms', 'api-access-enable', 'domain-purchase-confirmation'],
    docs: ['https://porkbun.com/api/json/v3/documentation'],
  },
  {
    id: 'railway',
    name: 'Railway',
    roles: ['runtime', 'database'],
    interfaces: ['cli', 'graphql-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [
        {
          id: 'workspace-token',
          env: 'RAILWAY_API_TOKEN',
          scope: 'account-or-workspace',
          useFor: ['projects.create', 'projects.list', 'environments.manage', 'multi-project-operations'],
        },
        {
          id: 'project-token',
          env: 'RAILWAY_TOKEN',
          scope: 'single-project-environment',
          useFor: ['deployments.create', 'variables.upsert', 'service-deployment-operations'],
        },
      ],
      contextEnv: ['RAILWAY_WORKSPACE_ID'],
      bootstrapContext: [
        {
          env: 'RAILWAY_WORKSPACE_ID',
          requirement: 'deferred',
          source: 'required-only-for-workspace-token-copy-active-workspace-id',
        },
      ],
      mutuallyExclusiveEnv: ['RAILWAY_API_TOKEN', 'RAILWAY_TOKEN'],
      identityProbe: [
        'Account RAILWAY_API_TOKEN: railway whoami --json',
        'Workspace RAILWAY_API_TOKEN + RAILWAY_WORKSPACE_ID: GraphQL workspace(workspaceId) { id name }',
        'RAILWAY_TOKEN: GraphQL projectToken { projectId environmentId }',
      ],
      secretStorage: 'env-or-os-keychain',
    },
    bootstrapSteps: [
      '用户注册 Railway 并完成邮箱、MFA、条款和计费初始化。',
      '首次创建项目或管理多个项目时，在 Account Settings > Tokens 创建 Account/Workspace Token。',
      '只部署一个既有项目的指定环境时，在项目设置中创建 Project Token。',
      '把二者之一保存为 Secret Ref；不得同时设置 RAILWAY_API_TOKEN 和 RAILWAY_TOKEN。',
      'Workspace Token 还要用命令面板的 Copy Active Workspace ID 提供 RAILWAY_WORKSPACE_ID Context Ref。',
      'Agent 对 Account Token 执行 railway whoami --json；对 Workspace/Project Token 分别调用只读 workspace/projectToken Scope Probe。',
      '首次创建使用 API Token，先 Read Project，再认领默认 Candidate Environment；Service 创建时绑定已验证 GitHub Repository 和不可变候选 Branch，创建后重新读取 Source 与 Repo Trigger，变量继续单独规划。',
    ],
    capabilities: {
      read: ['identity', 'projects', 'environments', 'services', 'deployments', 'variables-metadata', 'domains'],
      write: ['project', 'environment', 'service', 'deployment', 'variables', 'domain', 'database', 'volume'],
      async: ['deployment', 'domain'],
    },
    humanOnly: ['account-signup', 'mfa', 'billing', 'terms', 'token-creation'],
    docs: [
      'https://docs.railway.com/cli/login',
      'https://docs.railway.com/cli',
      'https://docs.railway.com/integrations/api',
      'https://docs.railway.com/integrations/api/manage-projects',
      'https://docs.railway.com/integrations/api/manage-environments',
      'https://docs.railway.com/integrations/api/manage-services',
      'https://docs.railway.com/integrations/api/manage-deployments',
      'https://docs.railway.com/integrations/api/manage-variables',
    ],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    roles: ['runtime', 'dns', 'registrar', 'delivery'],
    interfaces: ['cli', 'rest-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [{ id: 'access-token', env: 'VERCEL_TOKEN', scope: 'personal-or-team' }],
      contextEnv: ['VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'],
      bootstrapContext: [
        { env: 'VERCEL_ORG_ID', requirement: 'required', source: 'team-id-or-dashboard-team-slug' },
        { env: 'VERCEL_PROJECT_ID', requirement: 'deferred', source: 'project-create-result' },
      ],
      identityProbe: [
        'GET /v2/teams/{teamId} when VERCEL_ORG_ID starts with team_',
        'GET /v2/teams?limit=100 and exact slug match otherwise',
      ],
      secretStorage: 'env-or-secret-store',
    },
    bootstrapSteps: [
      '用户注册 Vercel，选择个人或 Team Scope，并完成 MFA、条款和计费初始化。',
      '在 Account Settings > Tokens 创建 Access Token，并把 Token 保存为 Secret Ref。',
      '首次接入把 Team ID 或 Dashboard URL 中的 Team slug 保存为 VERCEL_ORG_ID；VERCEL_PROJECT_ID 在项目创建后补齐，避免在产品仓库生成 .vercel 链接目录。',
      'Agent 使用 REST API Bearer Header 精确读取 Team ID/slug 和项目，不把 Token 放入命令参数或日志。',
      '部署先创建 Candidate URL；只有验证和 production-dns Approval 通过后才 Promote/绑定生产域名。',
    ],
    capabilities: {
      read: ['identity', 'teams', 'projects', 'deployments', 'domains', 'dns', 'environment-metadata'],
      write: ['project', 'deployment', 'environment-variable', 'domain', 'dns', 'alias', 'promotion'],
      async: ['deployment', 'domain-verification', 'certificate'],
    },
    humanOnly: ['account-signup', 'mfa', 'billing', 'terms', 'token-creation', 'domain-purchase-confirmation'],
    docs: [
      'https://vercel.com/docs/cli/global-options',
      'https://vercel.com/docs/rest-api',
      'https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name',
      'https://vercel.com/docs/rest-api/projects/create-a-new-project',
      'https://vercel.com/docs/rest-api/deployments/create-a-new-deployment',
      'https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url',
      'https://vercel.com/docs/rest-api/deployments/upload-deployment-files',
      'https://vercel.com/docs/rest-api/deployments/list-deployments',
      'https://vercel.com/docs/cli/deploying-from-cli',
    ],
  },
  {
    id: 'resend',
    name: 'Resend',
    roles: ['email'],
    interfaces: ['cli', 'rest-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [
        { id: 'provisioning-key', env: 'RESEND_API_KEY', scope: 'full-access', useFor: ['domains', 'api-keys'] },
        { id: 'sending-key', env: 'RESEND_SENDING_API_KEY', scope: 'sending-access', useFor: ['email.send'] },
      ],
      identityProbe: [
        '使用 RESEND_API_KEY 调用 GET https://api.resend.com/domains?limit=1',
        '成功读取 Domain List 才能证明初始化 Key 具备 Full Access；Sending Access 不满足要求',
      ],
      secretStorage: 'env-or-os-keychain',
      revokeBootstrapAfter: 'domain-verified-and-sending-key-created',
    },
    bootstrapSteps: [
      '用户注册 Resend 并在 Dashboard 创建 Full Access API Key；该首次 Key 必须由人创建。',
      '把 Full Access Key 保存为 RESEND_API_KEY Secret Ref；Agent 先只读调用 GET /domains?limit=1，确认它能管理 Domain，而不是只验证 Key 格式。',
      'Agent 为发信子域名创建 Domain，读取 SPF/DKIM/Tracking DNS Intent 并交给统一 DNS Plan。',
      'DNS 写入和传播后触发 verify；验证是异步动作，可轮询或等待 domain.verified Webhook。',
      '域名通过后创建 domain-scoped sending_access Key；Key 值仅返回一次，立即写入 Secret Store。',
      '原生 macOS CLI 可把准确 keychain://service/account 作为可写目标；op:// 默认只读，团队 Store 必须配置可写 Backend。',
      'Secret Store 必须先预检可写且目标为空；Create 响应不确定或捕获失败时禁止自动重建。',
      '运行时改用 RESEND_SENDING_API_KEY；完成发送验证后，再由独立审批撤销 Full Access 初始化 Key。',
    ],
    capabilities: {
      read: ['identity', 'domains', 'domain-dns-records', 'emails', 'api-key-metadata'],
      write: ['domain', 'domain-verification', 'api-key', 'email', 'webhook'],
      async: ['domain-verification', 'email-delivery'],
    },
    humanOnly: ['account-signup', 'mfa', 'terms', 'initial-api-key-creation', 'domain-claim'],
    docs: [
      'https://resend.com/docs/ai-onboarding',
      'https://resend.com/docs/cli',
      'https://resend.com/docs/api-reference/introduction',
      'https://resend.com/docs/api-reference/pagination',
      'https://resend.com/docs/api-reference/domains/create-domain',
      'https://resend.com/docs/api-reference/domains/get-domain',
      'https://resend.com/docs/api-reference/domains/list-domains',
      'https://resend.com/docs/api-reference/domains/verify-domain',
      'https://resend.com/docs/api-reference/api-keys/create-api-key',
      'https://resend.com/docs/api-reference/api-keys/list-api-keys',
      'https://resend.com/docs/api-reference/emails/send-email',
      'https://resend.com/docs/api-reference/emails/retrieve-email',
      'https://resend.com/docs/webhooks/event-types',
      'https://resend.com/docs/dashboard/api-keys/introduction',
      'https://resend.com/docs/knowledge-base/setting-up-resend-for-multi-tenants',
    ],
  },
  {
    id: 'neon',
    name: 'Neon',
    roles: ['database'],
    interfaces: ['cli', 'rest-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [{ id: 'api-key', env: 'NEON_API_KEY', scope: 'personal-organization-or-project' }],
      identityProbe: ['GET', 'https://console.neon.tech/api/v2/auth'],
      secretStorage: 'env-or-secret-store',
    },
    bootstrapSteps: [
      '用户注册 Neon，进入个人或组织的 API Keys 页面创建 Key，并保存为 NEON_API_KEY Secret Ref；Agent 不代替用户完成账号、MFA、条款或计费。',
      '创建 Connection 时明确 scope：personal、organization、organization:<org-id> 或 project:<project-id>；个人 Key 访问组织 Project 时必须提供准确 org_id。',
      'Agent 使用 Authorization: Bearer Header 和 GET /auth 做只读身份探测；Project 枚举与创建另行要求准确的 org_id，Project Scope Key 只能操作已验证的单一 Project。',
      '创建 Project 或候选 Branch 前固定 Region、PostgreSQL Version、Compute 上下限和 Suspend Timeout，并等待 Provider + Cost Approval。',
      '连接 URI 目标优先使用原生 macOS keychain://service/account；op:// 默认只读，未配置可写 Backend 时 Preflight 会阻断。',
      'Secret Sink 必须在任何 Neon API 调用前确认 exact destination 可写；连接 URI 只进入 Sink，State 只保存 Project/Branch/Endpoint/Operation ID。',
      '异步 Operation 必须轮询到 finished/skipped；423、429 和 5xx 按稳定错误语义处理，非幂等 Create 响应丢失时先精确对账且禁止盲目重放。',
    ],
    capabilities: {
      read: ['projects', 'branches', 'databases', 'roles', 'endpoints', 'operations'],
      write: ['project', 'branch', 'database', 'role', 'endpoint'],
      async: ['project', 'branch', 'endpoint', 'operation'],
    },
    humanOnly: ['account-signup', 'mfa', 'billing', 'terms', 'api-key-creation'],
    docs: [
      'https://api-docs.neon.tech/reference/authentication',
      'https://api-docs.neon.tech/reference/getauthdetails',
      'https://api-docs.neon.tech/reference/listprojects',
      'https://api-docs.neon.tech/reference/createproject',
      'https://api-docs.neon.tech/reference/listprojectbranches',
      'https://api-docs.neon.tech/reference/createprojectbranch',
      'https://api-docs.neon.tech/reference/getconnectionuri',
      'https://api-docs.neon.tech/reference/getprojectoperation',
      'https://neon.com/docs/manage/orgs-api',
      'https://neon.com/cli',
    ],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    roles: ['database', 'auth', 'storage', 'functions'],
    interfaces: ['cli', 'management-api'],
    credentialContract: {
      bootstrapRequiresHuman: true,
      options: [
        { id: 'personal-access-token', env: 'SUPABASE_ACCESS_TOKEN', scope: 'user-privileges' },
        { id: 'oauth', env: 'SUPABASE_OAUTH_ACCESS_TOKEN', scope: 'explicit-oauth-scopes', preferredForHosted: true },
      ],
      contextEnv: ['SUPABASE_PROJECT_ID', 'SUPABASE_DB_PASSWORD'],
      bootstrapContext: [
        { env: 'SUPABASE_PROJECT_ID', requirement: 'deferred', source: 'project-create-result' },
        { env: 'SUPABASE_DB_PASSWORD', requirement: 'required', source: 'human-or-agent-generated-secret' },
      ],
      identityProbe: [
        'GET https://api.supabase.com/v1/projects',
        'GET https://api.supabase.com/v1/organizations',
      ],
      secretStorage: 'env-or-secret-store',
    },
    bootstrapSteps: [
      '本地 CLI 用户在 Account Tokens 页面人工创建 PAT；Hosted Agent 优先使用 OAuth2，并申请 organizations:read、projects:read/write、secrets:read/write 等实际所需最小 Scope。',
      '将 PAT 或 OAuth Access Token 保存为 Secret Ref；PAT 继承用户权限，不能输出、写入产品仓库或作为运行时项目 Key。',
      '用户先确认现有 Organization 与计费归属。Agent 精确读取 Organization Slug，并通过 organization-scoped 分页接口查找 Project。',
      'Project 创建前调用 available-regions 验证实时区域容量，固定实例规格和 high_availability=false，并等待 Provider + Cost Approval。',
      '数据库密码必须先由用户或 Agent 生成强随机值并保存为 SUPABASE_DB_PASSWORD Secret Ref；创建后 Management API 不能修改该密码。',
      '数据库密码 Source 与连接/Runtime Key Sink 必须使用不同 Ref；macOS 原生写入目标可使用 keychain://service/account，op:// 默认只读。',
      '连接 URI 在 Project 与所需服务 ACTIVE_HEALTHY 后组合，只写 Secret Sink；Project Ref、状态和 Secret Ref 才能进入 State。',
      '运行时优先使用 publishable + secret API Key；reveal=true 必须使用独立 Secret Read Approval，两个 Key 原子写入同一个 Runtime Credential Bundle。',
      '数据库迁移、Auth/Storage 配置、Branch Push/Merge、Project 更新/删除必须使用独立 Graph 节点和审批，不得被 Project Create 隐式触发。',
      'Auth 迁移必须单独处理用户数据、密码兼容、OAuth Callback、JWT/Session 和真实登录验收；不得用匿名首页或 Project Health 代替。',
    ],
    capabilities: {
      read: ['organizations', 'projects', 'available-regions', 'service-health', 'api-key-metadata', 'backups', 'migration-list', 'functions', 'secrets-metadata'],
      write: ['project', 'project-api-key', 'database-migration', 'function', 'secret', 'auth-config', 'storage-config'],
      async: ['project', 'service-health', 'backup-restore', 'migration'],
    },
    humanOnly: ['account-signup', 'mfa', 'billing', 'terms', 'pat-creation', 'oauth-consent', 'destructive-migration-approval'],
    docs: [
      'https://supabase.com/docs/reference/api/getting-started',
      'https://api.supabase.com/api/v1',
      'https://api.supabase.com/api/v1-json',
      'https://supabase.com/docs/guides/integrations/supabase-for-platforms',
      'https://supabase.com/docs/guides/platform/regions',
      'https://supabase.com/docs/guides/deployment/managing-environments',
      'https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration',
    ],
  },
];

export function listProviderCatalog() {
  return {
    kind: 'provider-list',
    count: PROVIDERS.length,
    providers: PROVIDERS.map(summary),
  };
}

export function showProviderCatalog(providerId) {
  return { kind: 'provider', provider: providerById(providerId) };
}

export function providerBootstrapGuide(providerId) {
  const provider = providerById(providerId);
  return {
    kind: 'provider-guide',
    providerId: provider.id,
    name: provider.name,
    automationBoundary: {
      agentCan: [...provider.capabilities.read, ...provider.capabilities.write],
      humanMust: provider.humanOnly,
    },
    credentialContract: provider.credentialContract,
    steps: provider.bootstrapSteps,
    verification: {
      identityProbe: provider.credentialContract.identityProbe,
      mutationAllowed: false,
      next: '保存外部 Connection Secret Ref 后执行只读 Probe。',
    },
    docs: provider.docs,
  };
}

export function providerById(providerId) {
  const provider = PROVIDERS.find((item) => item.id === providerId);
  if (!provider) throw operationError('NOT_FOUND', `Provider is not in the V2 catalog: ${providerId}`);
  return structuredClone(provider);
}

function summary(provider) {
  return {
    id: provider.id,
    name: provider.name,
    roles: provider.roles,
    interfaces: provider.interfaces,
    credentialEnv: provider.credentialContract.options.map((option) => option.env),
  };
}
