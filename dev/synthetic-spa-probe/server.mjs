import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function responseFor(method, host, requestPath) {
  if (host !== '127.0.0.1:18765' || method !== 'GET') return { status: 403, body: 'DENIED' };
  const file = requestPath === '/top' || requestPath === '/watch?v=fixture' ? 'index.html' : requestPath === '/page.js' ? 'page.js' : null;
  if (!file) return { status: 404, body: 'NOT_FOUND' };
  return { status: 200, body: fs.readFileSync(new URL('./site/' + file, import.meta.url)), type: file.endsWith('.js') ? 'text/javascript' : 'text/html' };
}
export function createServer() {
  return http.createServer((req, res) => {
    const r = responseFor(req.method, req.headers.host, req.url);
    res.writeHead(r.status, { 'Content-Type': (r.type || 'text/plain') + '; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(r.body);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.on('error', () => { console.error('LOCAL_SERVER_UNAVAILABLE_STOP'); process.exitCode = 1; });
  server.listen(18765, '127.0.0.1', () => console.log('LOCAL_PROBE_READY'));
}
