export const PRODUCTION_ENV_RSYNC_INCLUDES = ['.env.example'];
export const PRODUCTION_ENV_RSYNC_EXCLUDES = ['.env', '.env.*'];
export const STAGED_RUNTIME_ENV_PATH = '.agentmesh-deploy/runtime.env.next';

export function productionEnvActivationCommand(appDir) {
  const staged = STAGED_RUNTIME_ENV_PATH;
  const merged = '.agentmesh-deploy/runtime.env.merged';
  const next = '.env.agentmesh-next';
  const preserveUnmanaged =
    `awk -F= ${shellQuote('FILENAME == ARGV[1] { managed[$1]=1; next } !($1 in managed)')} ` +
    `${shellQuote(staged)} .env > ${shellQuote(merged)}`;

  return [
    'set -e',
    `cd ${shellQuote(appDir)}`,
    'umask 077',
    `test -f ${shellQuote(staged)}`,
    [
      'if [ -f .env ]',
      'then cp -p .env .env.previous',
      'chmod 600 .env.previous',
      preserveUnmanaged,
      `else : > ${shellQuote(merged)}`,
      'fi',
    ].join('; '),
    `cat ${shellQuote(staged)} >> ${shellQuote(merged)}`,
    `install -m 600 ${shellQuote(merged)} ${shellQuote(next)}`,
    `mv -f ${shellQuote(next)} .env`,
    `rm -f ${shellQuote(staged)} ${shellQuote(merged)}`,
  ].join('; ');
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}
