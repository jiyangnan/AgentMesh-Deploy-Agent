import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, constants } from 'node:zlib';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('gzip-helper requires input and output paths.');

await pipeline(
  fs.createReadStream(input),
  createGzip({ level: constants.Z_BEST_COMPRESSION, mtime: 0 }),
  fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }),
);
