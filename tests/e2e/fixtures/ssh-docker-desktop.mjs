// Transport fixture only: real Agent runtime, simulated browser/desktop HTTP services.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

spawn(process.execPath, ['/opt/coke-dots/agent-runtime.mjs'], { stdio: 'inherit' });
let owner = 'agent';
let url = 'about:blank';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  const request = new URL(req.url, 'http://127.0.0.1');
  if (request.pathname === '/readyz') return json(res, 200, { ok: true });
  if (req.headers.authorization !== 'Bearer ' + process.env.LINUX_DESKTOP_WORKER_TOKEN) return json(res, 401, { error: 'unauthorized' });
  let body = {};
  if (req.method === 'POST') { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString()); }
  if (request.pathname === '/v1/control') { if (body.owner) owner = body.owner; return json(res, 200, { owner }); }
  if (request.pathname === '/v1/commands') { if (body.url) url = body.url; return json(res, 200, { ok: true }); }
  if (request.pathname === '/v1/state') return json(res, 200, { ready: true, owner, url, title: 'SSH Docker test fixture' });
  const taskId = request.searchParams.get('taskId') || '';
  if (!/^[a-f0-9-]{36}$/.test(taskId)) return json(res, 404, { error: 'not found' });
  try {
    const bytes = await readFile('/workspace/tasks/' + taskId + '/marker.txt');
    if (request.pathname === '/v1/artifacts') return json(res, 200, { artifacts: [{ path: 'marker.txt', name: 'marker.txt', mediaType: 'text/plain', size: bytes.length, previewable: true }] });
    if (request.pathname === '/v1/artifact' && request.searchParams.get('path') === 'marker.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-dots-artifact-name': 'marker.txt', 'x-dots-artifact-previewable': 'true' }); return res.end(bytes);
    }
  } catch { /* Missing file stays missing in another workspace. */ }
  return json(res, 404, { error: 'not found' });
}).listen(8082, '0.0.0.0');
http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Transport fixture</title>'); }).listen(6080, '0.0.0.0');
