import fs from 'node:fs';
import path from 'node:path';

const output = path.resolve('dist');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.resolve('public/index.html'), path.join(output, 'index.html'));
fs.writeFileSync(path.join(output, 'health.json'), `${JSON.stringify({ status: 'ok' })}\n`, 'utf8');
