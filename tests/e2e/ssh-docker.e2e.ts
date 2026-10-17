import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerDesktopSpec } from '../../src/server/ssh-docker-desktop.ts';
import { SshDockerClient } from '../../src/server/ssh-docker-client.ts';

// Opt-in local integration: starts its own loopback sshd and labelled Docker fixtures.
// No developer SSH configuration, real model account or existing container is used.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'dots-ssh-docker-e2e-'));
const instance = 'e2e-' + randomBytes(5).toString('hex');
const image = 'coke-dots-ssh-e2e:' + instance;
const project = resolve('.');
const specs: ReturnType<typeof dockerDesktopSpec>[] = [];
let sshd: ChildProcess | undefined;
let app: ChildProcess | undefined;
let appLogs = '';
const docker = (...args: string[]) => exec('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { timeout: 240_000, maxBuffer: 1024 * 1024 });

async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}

async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

try {
  assert.equal(process.platform, 'linux', 'This local SSH/Docker harness runs on Linux');
  const engineVersion = (await docker('version', '--format', '{{.Server.Version}}')).stdout.trim();
  assert(Number(engineVersion.split('.')[0]) >= 28, 'Docker Engine 28+ is required');
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host-key')]);
  await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'client-key')]);
  const sshPort = await port();
  const appPort = await port();
  const hostPublic = (await readFile(join(root, 'host-key.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  await writeFile(join(root, 'known_hosts'), '[127.0.0.1]:' + sshPort + ' ' + hostPublic + '\n', { mode: 0o600 });
  const dockerBinary = (await exec('which', ['docker'])).stdout.trim();
  const sshdConfig = [
    'ListenAddress 127.0.0.1', 'Port ' + sshPort, 'HostKey ' + join(root, 'host-key'),
    'PidFile ' + join(root, 'sshd.pid'), 'AuthorizedKeysFile ' + join(root, 'client-key.pub'),
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no',
    'PermitRootLogin prohibit-password', 'AllowUsers ' + userInfo().username,
    'AllowTcpForwarding local', 'PermitOpen 127.0.0.1:*', 'AllowAgentForwarding no', 'X11Forwarding no',
    'ForceCommand ' + dockerBinary + ' --host unix:///var/run/docker.sock system dial-stdio',
  ].join('\n') + '\n';
  await writeFile(join(root, 'sshd_config'), sshdConfig, { mode: 0o600 });
  sshd = spawn(process.env.DOTS_TEST_SSHD_BIN || '/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let sshLogs = ''; sshd.stderr?.on('data', chunk => { sshLogs += chunk.toString(); });
  sshd.on('error', error => { sshLogs += error.message; });
  await delay(300);
  assert.equal(sshd.exitCode, null, 'Temporary sshd could not start: ' + sshLogs);

  const sshConfig = { host: userInfo().username + '@127.0.0.1', port: sshPort,
    identityFile: join(root, 'client-key'), knownHostsFile: join(root, 'known_hosts') };
  const api = new SshDockerClient(sshConfig);
  assert.equal((await api.request<{ Version: string }>('GET', '/version')).Version, engineVersion);
  console.log('Verified real SSH authentication and Docker API over stdio');

  const context = join(root, 'image'); await mkdir(context);
  // Build a disposable Node fixture from the local runtime, without pulling a base image.
  const binary = join(context, 'rootfs', 'usr', 'local', 'bin', 'node');
  await mkdir(dirname(binary), { recursive: true });
  await copyFile(process.execPath, binary);
  const dependencies = (await exec('ldd', [process.execPath])).stdout;
  for (const line of dependencies.split('\n')) {
    const library = line.match(/=>\s+(\/\S+)/)?.[1] || line.match(/^\s*(\/\S+)\s+\(/)?.[1];
    if (!library) continue;
    const destination = join(context, 'rootfs', library);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(library, destination);
  }
  await mkdir(join(context, 'workspace'));
  await writeFile(join(context, 'workspace', '.fixture'), 'SSH Docker transport test');
  await copyFile('deploy/linux-desktop/agent-runtime.mjs', join(context, 'agent-runtime.mjs'));
  await copyFile('tests/e2e/fixtures/ssh-docker-desktop.mjs', join(context, 'desktop.mjs'));
  await copyFile('tests/e2e/fixtures/ssh-docker-adapter.mjs', join(context, 'adapter.mjs'));
  await writeFile(join(context, 'Dockerfile'), [
    'FROM scratch', 'COPY rootfs/ /', 'COPY --chown=1000:1000 workspace/ /workspace/',
    'COPY agent-runtime.mjs desktop.mjs adapter.mjs /opt/coke-dots/',
    'ENV PATH=/usr/local/bin HOME=/workspace',
    'USER 1000:1000', 'WORKDIR /workspace',
    'ENTRYPOINT ["node", "/opt/coke-dots/desktop.mjs"]',
  ].join('\n') + '\n');
  console.log('Building the isolated Docker transport fixture');
  await docker('build', '--tag', image, context);
  const emptyEnv = join(root, 'empty.env'); await writeFile(emptyEnv, '');
  const environment = { ...process.env,
    NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_ENV_FILE: emptyEnv, DOTS_PORT: String(appPort),
    DOTS_DATA_DIR: join(root, 'data'), DOTS_COMPUTER_BACKEND: 'ssh-docker', DOTS_DOCKER_INSTANCE_ID: instance,
    DOTS_DOCKER_SSH_HOST: sshConfig.host, DOTS_DOCKER_SSH_PORT: String(sshPort),
    DOTS_DOCKER_SSH_IDENTITY_FILE: sshConfig.identityFile, DOTS_DOCKER_SSH_KNOWN_HOSTS_FILE: sshConfig.knownHostsFile,
    DOTS_LINUX_DESKTOP_TOKEN_SECRET: randomBytes(32).toString('hex'), DOTS_LINUX_DESKTOP_IMAGE: image,
    DOTS_DOCKER_CPUS: '1', DOTS_DOCKER_MEMORY_MB: '512', DOTS_PI_ENABLED: '1',
    DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: 'node', args: ['/opt/coke-dots/adapter.mjs'] } }),
    DOTS_MODEL_SECRET_BACKEND: 'file', DOTS_MODEL_SECRET_FILE: join(root, 'secrets', 'model-api-key'),
    DOTS_MODEL_API_KEY: '', DOTS_KUBECTL: '/kubectl-must-not-be-used', DOTS_KUBECTL_BIN: '/kubectl-must-not-be-used',
    DOTS_KEYCHAIN_SERVICE: 'com.cokepoppy.coke-dots.test-' + instance, DOTS_TEST_KEYRING_DIR: join(root, 'keyring'),
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DOTS_PUBLIC_ORIGIN: '', DOTS_PUBLIC_HOST: '', DOTS_BASE_PATH: '',
    DOTS_LINUX_DESKTOP_PROXY_BRIDGE: '0', DOTS_INCIDENT_GITHUB_TENANT_ID: '', DOTS_DSH_BIN: '',
    SLACK_CLIENT_ID: '', SLACK_CLIENT_SECRET: '', DINGTALK_STREAM_CLIENT_ID: '', DINGTALK_STREAM_CLIENT_SECRET: '',
  };
  const baseUrl = 'http://127.0.0.1:' + appPort;
  async function startApp() {
    app = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout?.on('data', chunk => { appLogs += chunk.toString(); });
    app.stderr?.on('data', chunk => { appLogs += chunk.toString(); });
    const deadline = Date.now() + 30_000;
    for (; Date.now() < deadline;) {
      assert.equal(app.exitCode, null, 'App exited: ' + appLogs);
      try { if ((await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Starting. */ }
      await delay(100);
    }
    throw new Error('App did not start: ' + appLogs);
  }
  await startApp();
  async function login(email: string) {
    const response = await fetch(baseUrl + '/api/auth/e2e/login', { method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    assert.equal(response.status, 200);
    const identity = await response.json() as { tenant: { id: string } };
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    specs.push(dockerDesktopSpec(identity.tenant.id, environment));
    return { ...identity, cookie };
  }
  async function call(cookie: string, path: string, method = 'GET', body?: unknown) {
    const response = await fetch(baseUrl + '/api' + path, { method, headers: { cookie, origin: baseUrl, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert(response.ok, path + ' failed: ' + response.status + ' ' + await (response.ok ? Promise.resolve('') : response.text()));
    return response;
  }
  const alpha = await login('alpha@example.test');
  await call(alpha.cookie, '/model-settings', 'PATCH', { baseUrl: 'https://model.example.test/v1', model: 'fixture-model', apiKey: 'ssh-docker-local-model-test-key' });
  assert.equal(await readFile(environment.DOTS_MODEL_SECRET_FILE, 'utf8'), 'ssh-docker-local-model-test-key');
  await call(alpha.cookie, '/computer/open', 'POST', {});
  const beta = await login('beta@example.test');
  await call(beta.cookie, '/computer/open', 'POST', {});
  const task = await (await call(alpha.cookie, '/tasks', 'POST', { instruction: 'Create a persistent test file in this task workspace', engine: 'pi' })).json() as { id: string };
  let completed = false;
  for (let i = 0; i < 100; i++) {
    const state = await (await call(alpha.cookie, '/state')).json() as any;
    assert.equal(state.modelSettings.secretBackend, 'file');
    assert(!JSON.stringify(state).includes('ssh-docker-local-model-test-key'));
    const current = state.tasks.find((row: any) => row.id === task.id);
    assert.notEqual(current?.status, 'failed', current?.error);
    if (current?.status === 'done') { completed = true; assert.equal(current.agentSessionId, 'fixture-' + task.id); break; }
    await delay(100);
  }
  assert(completed, 'Task did not complete');
  const artifactPath = '/tasks/' + task.id + '/artifacts/content?path=marker.txt';
  assert.match(await (await call(alpha.cookie, artifactPath)).text(), /Persisted by the real Agent runtime/);
  assert.equal((await fetch(baseUrl + '/api' + artifactPath, { headers: { cookie: beta.cookie } })).status, 404);
  assert.notEqual(specs[0].volume, specs[1].volume);
  const alphaInfo: any = await api.request('GET', '/containers/' + specs[0].name + '/json');
  assert(!JSON.stringify(alphaInfo.Config.Env).includes('ssh-docker-local-model-test-key'));
  assert(Object.values(alphaInfo.NetworkSettings.Ports).every((entries: any) => !entries || entries.every((entry: any) => entry.HostIp === '127.0.0.1')));
  await call(alpha.cookie, '/computer/take-over', 'POST', {});
  assert.equal((await (await call(alpha.cookie, '/computer')).json() as any).owner, 'user');
  await call(alpha.cookie, '/computer/return-control', 'POST', {});
  console.log('Verified file credentials, two tenants, remote Agent dispatch, artifacts and takeover');

  await stop(app);
  await api.request('DELETE', '/containers/' + alphaInfo.Id + '?force=true');
  await startApp();
  await call(alpha.cookie, '/computer/open', 'POST', {});
  assert.match(await (await call(alpha.cookie, artifactPath)).text(), /Persisted by the real Agent runtime/);
  const replacement: any = await api.request('GET', '/containers/' + specs[0].name + '/json');
  assert.notEqual(replacement.Id, alphaInfo.Id);
  assert.equal((await (await call(alpha.cookie, '/state')).json() as any).modelSettings.apiKeyStatus, 'available');
  await call(alpha.cookie, '/tasks/' + task.id, 'PATCH', { action: 'resume' });
  let resumed = false;
  for (let i = 0; i < 100; i++) {
    const current = ((await (await call(alpha.cookie, '/state')).json() as any).tasks as any[]).find(row => row.id === task.id);
    assert.notEqual(current?.status, 'failed', current?.error);
    if (current?.status === 'done') { resumed = true; assert.equal(current.agentSessionId, 'fixture-' + task.id); break; }
    await delay(100);
  }
  assert(resumed, 'Task session did not resume after restart');
  assert.match(await (await call(alpha.cookie, artifactPath)).text(), /run 2$/);
  console.log('Verified control-plane restart, container recreation, persistent volume/model credentials and resumed task session');
} finally {
  await stop(app);
  await stop(sshd);
  // Cleanup only exact resources whose labels match this disposable test instance.
  for (const spec of specs) {
    for (const [kind, name, format] of [
      ['container', spec.name, '{{json .Config.Labels}}'], ['network', spec.network, '{{json .Labels}}'], ['volume', spec.volume, '{{json .Labels}}'],
    ]) {
      try {
        const labels = JSON.parse((await docker(kind, 'inspect', '--format', format, name)).stdout);
        assert.equal(labels['com.coke-dots.instance'], instance);
        assert.equal(labels['com.coke-dots.tenant'], spec.labels['com.coke-dots.tenant']);
        await docker(kind, 'rm', ...(kind === 'container' ? ['--force'] : []), name);
      } catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    }
  }
  await docker('image', 'rm', image).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
