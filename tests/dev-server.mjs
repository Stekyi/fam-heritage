// Local QA server: serves ./public and runs the real Netlify Functions against an in-memory Postgres
// seeded with the validated family data. Usage: node tests/dev-server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDatabase, makeToken } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8899;
const pg = await freshDatabase();
await makeToken(pg, '11111', 'Demo contributor one');
await makeToken(pg, '22222', 'Demo contributor two');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, '');
    let mod;
    try { mod = await import(`../netlify/functions/${name}.mjs`); } catch { res.writeHead(404); return res.end('{"error":"not found"}'); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const out = await mod.handler({ httpMethod: req.method, queryStringParameters: Object.fromEntries(url.searchParams), headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    res.writeHead(out.statusCode, out.headers);
    return res.end(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
  }
  let file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Family Heritage QA server on http://localhost:${port}  (tokens 11111, 22222; admin secret: ${process.env.ADMIN_SECRET})`));
