import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  for (const name of ['.env.local', '.env']) {
    const p = path.join(__dirname, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      // .env.local/.env should take precedence during local development.
      process.env[key] = val;
    }
  }
}

loadEnv();

const publicDir = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else headers.set(k, v);
    }
    const request = new Request(`http://localhost${url.pathname}`, {
      method: 'POST',
      headers,
      body: body.length ? body : undefined,
    });
    try {
      const response = await handler(request);
      const buf = Buffer.from(await response.arrayBuffer());
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.writeHead(response.status);
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: '*zucht* Lokaal: handler gaf de geest.' }));
    }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Claudezak lokaal: http://localhost:${PORT}/`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠ Zet ANTHROPIC_API_KEY in .env.local (anders werkt chat niet).');
  }
});
