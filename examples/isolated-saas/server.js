import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.PORT || 3000);
const index = fs.readFileSync(path.resolve('dist/index.html'));

http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}\n');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(index);
}).listen(port, '0.0.0.0');
