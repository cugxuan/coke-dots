// Isolated wall-clock regression: real runtime and native fetch, no live tenant/model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAgentResponse } from '../src/server/agent-progress-stream.ts';

const durationMs = Number(process.env.DOTS_LONG_TASK_MS || 310_000);
if (durationMs < 305_000) throw new Error('The long-task regression must actually exceed five minutes');
const root = await mkdtemp(path.join(tmpdir(), 'dots-long-task-'));
const worker = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"owner":"agent"}'); });
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; };
const workerPort = await listen(worker);
const reservation = createServer(); const runtimePort = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
const adapter = path.join(root, 'adapter.mjs');
await writeFile(adapter, `import {writeFile} from 'node:fs/promises'; let input=''; for await(const c of process.stdin) input+=c; const request=JSON.parse(input); await writeFile('partial-evidence.txt','retained before completion'); if(request.streamProgress) process.stdout.write(JSON.stringify({type:'progress',event:{id:'long-tool',kind:'tool',message:'long-task-fixture',state:'running'}})+'\\n'); await new Promise(r=>setTimeout(r,${durationMs})); const result={status:'done',message:'completed beyond five minutes'}; process.stdout.write(JSON.stringify(request.streamProgress?{type:'result',result}:result)+'\\n');`);
const runtime = spawn(process.execPath, ['deploy/linux-desktop/agent-runtime.mjs'], { env: { ...process.env, DOTS_AGENT_RUNTIME_TOKEN: 'fixture-runtime', LINUX_DESKTOP_WORKER_TOKEN: 'fixture-worker', LINUX_DESKTOP_WORKER_PORT: String(workerPort), DOTS_AGENT_RUNTIME_PORT: String(runtimePort), DOTS_AGENT_WORKSPACE: root, DOTS_DESKTOP_AGENT_ADAPTERS: 'pi', DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: process.execPath, args: [adapter] } }) }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; runtime.stdout.on('data', c => { output += c; }); runtime.stderr.on('data', c => { output += c; });
const started = performance.now();
const legacy = createServer((_req, res) => { const timer = setTimeout(() => res.end('{"status":"done"}'), durationMs); res.on('close', () => clearTimeout(timer)); });
const legacyPort = await listen(legacy);
try {
  for (let n = 0; ; n++) {
    if (n === 100) throw new Error(`Runtime did not start: ${output}`);
    if (await fetch(`http://127.0.0.1:${runtimePort}/healthz`).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const oldResult = fetch(`http://127.0.0.1:${legacyPort}`).then(r => r.text()).then(() => ({ completed: true }), error => ({ completed: false, cause: error.cause?.code, elapsedMs: Math.round(performance.now() - started) }));
  const response = await fetch(`http://127.0.0.1:${runtimePort}/v1/tasks/run`, { method: 'POST', headers: { authorization: 'Bearer fixture-runtime', 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ engine: 'pi', taskId: '11111111-1111-4111-8111-111111111111', cwd: 'tasks/11111111-1111-4111-8111-111111111111', prompt: 'long fixture', modelConfig: { baseUrl: 'https://example.test/v1', model: 'fixture', apiKey: 'fixture' } }) });
  let progressMs;
  const headersMs = Math.round(performance.now() - started);
  console.log(JSON.stringify({ stage: 'stream-started', headersMs, durationMs, node: process.version }));
  const result = await readAgentResponse(response, () => { progressMs ??= Math.round(performance.now() - started); });
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(result.status, 'done'); assert(elapsedMs >= durationMs); assert(headersMs < 3000); assert(progressMs < 3000);
  const previous = await oldResult;
  assert.equal(previous.completed, false); assert.equal(previous.cause, 'UND_ERR_HEADERS_TIMEOUT');
  const evidence = { node: process.version, headersMs, progressMs, elapsedMs, result, legacy: previous };
  await mkdir('artifacts/browser-agent', { recursive: true });
  await writeFile('artifacts/browser-agent/long-task.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  runtime.kill('SIGTERM');
  worker.closeAllConnections(); legacy.closeAllConnections();
  await Promise.all([new Promise(resolve => worker.close(resolve)), new Promise(resolve => legacy.close(resolve))]);
  await rm(root, { recursive: true, force: true });
}
