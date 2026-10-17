import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerApiError, openDesktopTunnel, SshDockerClient } from '../src/server/ssh-docker-client.ts';

// A local byte-stream SSH substitute exercises the actual HTTP parser and tunnel process
// lifecycle without touching a developer's SSH account or Docker daemon.
const sshFixture = `#!/usr/bin/env node
const net = require('node:net');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOTS_TEST_SSH_ARGS, JSON.stringify(args) + '\\n');
if (args.includes('-N')) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-L') continue;
    const [host, port, target, targetPort] = args[++i].split(':');
    net.createServer(client => {
      const socket = net.connect(Number(targetPort), target);
      client.pipe(socket); socket.pipe(client);
      socket.on('error', () => client.destroy()); client.on('error', () => socket.destroy());
      client.on('close', () => socket.destroy());
    }).listen(Number(port), host);
  }
} else {
  const socket = net.connect(Number(process.env.DOTS_TEST_DOCKER_HTTP_PORT), '127.0.0.1');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('error', () => process.exit(1));
}
`;

test('Docker requests use SSH stdio, hide error bodies and never put credentials in command arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dots-ssh-client-'));
  const keys = ['PATH', 'DOTS_TEST_SSH_ARGS', 'DOTS_TEST_DOCKER_HTTP_PORT'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const received: { url?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    if (req.url?.endsWith('/denied')) { res.writeHead(403); return res.end(JSON.stringify({ message: 'private-error-content' })); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const argvPath = join(root, 'argv.jsonl');
  let tunnel: Awaited<ReturnType<typeof openDesktopTunnel>> | undefined;
  try {
    await writeFile(join(root, 'ssh'), sshFixture, { mode: 0o700 });
    process.env.PATH = root + ':' + process.env.PATH;
    process.env.DOTS_TEST_SSH_ARGS = argvPath;
    process.env.DOTS_TEST_DOCKER_HTTP_PORT = String(address.port);
    const config = { host: 'fixture-debian', port: 2222 };
    const api = new SshDockerClient(config);
    assert.deepEqual(await api.request('POST', '/containers/create', { Env: ['TOKEN=stdin-only-test-value'] }), { ok: true });
    assert.equal(received[0].url, '/v1.47/containers/create');
    assert.equal(JSON.parse(received[0].body).Env[0], 'TOKEN=stdin-only-test-value');
    await assert.rejects(api.request('GET', '/denied'), error => {
      assert(error instanceof DockerApiError);
      assert.equal(error.status, 403);
      assert(!error.message.includes('private-error-content'));
      return true;
    });
    tunnel = await openDesktopTunnel(config, [address.port, address.port, address.port]);
    const deadline = Date.now() + 5000;
    let response: Response | undefined;
    while (Date.now() < deadline && !response) {
      try { response = await fetch('http://127.0.0.1:' + tunnel.ports[0], { signal: AbortSignal.timeout(1000) }); }
      catch { await delay(20); }
    }
    assert(response?.ok); await response.body?.cancel();
    assert.equal(tunnel.alive(), true);
    await tunnel.close();
    assert.equal(tunnel.alive(), false);
    const commands: string[][] = (await readFile(argvPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert(commands.every(args => args.includes('StrictHostKeyChecking=yes') && args.includes('ForwardAgent=no')));
    assert(commands.every(args => !JSON.stringify(args).includes('stdin-only-test-value')));
    assert(commands[0].includes('docker --host unix:///var/run/docker.sock system dial-stdio'));
    assert(commands.find(args => args.includes('-N'))?.includes('ExitOnForwardFailure=yes'));
  } finally {
    await tunnel?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
