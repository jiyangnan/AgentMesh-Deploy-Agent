import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.argv[2] ?? 'site');
const analyticsWebsiteId = 'dde37bb1-f07e-4a10-a349-719b4149923b';
const mainWebsiteId = '1a85e912-04b3-4ad9-a1f2-15416d15311f';
const pages = new Map([
  ['index.html', { lang: 'en', pricingUrl: 'https://agentmesh360.com/app/#pricing' }],
  ['zh/index.html', { lang: 'zh-CN', pricingUrl: 'https://agentmesh360.com/app/?lang=zh-CN#pricing' }],
  ['en/index.html', { lang: 'en', pricingUrl: 'https://agentmesh360.com/app/#pricing' }],
  ['ja/index.html', { lang: 'ja', pricingUrl: 'https://agentmesh360.com/app/?lang=ja#pricing' }],
  ['ko/index.html', { lang: 'ko', pricingUrl: 'https://agentmesh360.com/app/?lang=ko#pricing' }],
]);
const requiredFiles = [
  ...pages.keys(),
  'assets/site.css',
  'assets/site.js',
  'assets/deploy-control-plane.png',
  'favicon.svg',
  'llms.txt',
  'robots.txt',
  'sitemap.xml',
  'seo.css',
  'guides/ai-deployment-agent/index.html',
  'guides/approval-gated-devops/index.html',
];

function fail(message) {
  throw new Error(`site contract failed: ${message}`);
}

for (const relative of requiredFiles) {
  if (!fs.existsSync(path.join(root, relative))) fail(`missing ${relative}`);
}

if (fs.existsSync(path.join(root, 'CNAME'))) fail('CNAME is forbidden; production is served by shared Caddy');

for (const [relative, { lang, pricingUrl }] of pages) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const requirements = [
    `<html lang="${lang}"`,
    'data-product-contract="independent-deploy-agent-v1"',
    'data-release="v0.2.1"',
    'data-boundary="agent"',
    'data-boundary="human"',
    'https://deploy.agentmesh360.com/',
    'https://github.com/jiyangnan/AgentMesh-Deploy-Agent',
    'https://analytics.agentmesh360.com/script.js',
    `data-website-id="${analyticsWebsiteId}"`,
    'data-domains="deploy.agentmesh360.com"',
    '/assets/deploy-control-plane.png',
    '/favicon.svg?v=product-mark-v1',
    '/assets/site.js',
    'data-agent-handoff',
    'data-copy-prompt',
    'data-agent-prompt',
    'data-purchase-cta',
    pricingUrl,
    'pass-note',
    'Vercel',
    'Railway',
    'Neon',
    'Supabase',
    'Cloudflare',
    'Resend',
  ];
  for (const requirement of requirements) {
    if (!source.includes(requirement)) fail(`${relative} is missing ${requirement}`);
  }
  if (!source.includes('class="btn btn-primary" data-purchase-cta')) {
    fail(`${relative} does not make pass purchase the primary hero action`);
  }
  if (!source.includes('class="btn btn-secondary" href="https://github.com/jiyangnan/AgentMesh-Deploy-Agent"')) {
    fail(`${relative} does not demote the GitHub hero action`);
  }
  if (source.includes(mainWebsiteId)) fail(`${relative} reuses the AgentMesh Main analytics website ID`);
  if (/data-product-contract="[^"]*sidecar/i.test(source)) fail(`${relative} reintroduces a sidecar contract`);
}

const llms = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');
for (const requirement of ['read-only sources by default', 'external Control Home', 'exact human authorization']) {
  if (!llms.includes(requirement)) fail(`llms.txt is missing ${requirement}`);
}

const guideLanding = fs.readFileSync(path.join(root, 'zh/index.html'), 'utf8');
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
for (const route of ['/guides/ai-deployment-agent/', '/guides/approval-gated-devops/']) {
  const guide = fs.readFileSync(path.join(root, route, 'index.html'), 'utf8');
  const canonical = `https://deploy.agentmesh360.com${route}`;
  if (!guideLanding.includes(`href="${route}"`)) fail(`zh/index.html is missing guide link ${route}`);
  if (!guide.includes(`rel="canonical" href="${canonical}"`)) fail(`${route} is missing its canonical URL`);
  if (!guide.includes('type="application/ld+json"')) fail(`${route} is missing JSON-LD`);
  if (!sitemap.includes(`<loc>${canonical}</loc>`)) fail(`sitemap.xml is missing ${canonical}`);
}

const css = fs.readFileSync(path.join(root, 'assets/site.css'), 'utf8');
if (!css.includes('.nav-cta { background: transparent;')) {
  fail('GitHub navigation CTA must not use the primary dark fill');
}

const png = fs.readFileSync(path.join(root, 'assets/deploy-control-plane.png'));
if (png.length < 10_000 || png.subarray(1, 4).toString('ascii') !== 'PNG') fail('architecture image is not a valid production asset');

const favicon = fs.readFileSync(path.join(root, 'favicon.svg'), 'utf8');
if (!favicon.includes('#191B19') || !favicon.includes('AgentMesh Deploy')) {
  fail('favicon.svg is not the AgentMesh Deploy product mark');
}

console.log(`Validated AgentMesh Deploy site contract at ${root}`);
