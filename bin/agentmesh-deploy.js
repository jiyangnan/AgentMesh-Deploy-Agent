#!/usr/bin/env node

import { main } from '../src/cli.js';

const argv = process.argv.slice(2);

main(argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (argv.includes('--json')) {
    console.error(JSON.stringify({
      status: 'error',
      error: {
        code: typeof error?.code === 'string' ? error.code : 'COMMAND_FAILED',
        message,
      },
    }, null, 2));
    process.exit(1);
  }
  console.error(`\nagentmesh-deploy failed:\n${message}`);
  process.exit(1);
});
