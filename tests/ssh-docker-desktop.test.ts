import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerDesktopSpec, SshDockerDesktopConnector } from '../src/server/ssh-docker-desktop.ts';
import { DockerApiError, sshArguments, sshDockerConfig, type DockerApi, type DesktopTunnel } from '../src/server/ssh-docker-client.ts';
import { desktopAgentEngineIds } from '../src/server/desktop-agent-kernels.ts';

const environment = {
  NODE_ENV: 'production', DOTS_COMPUTER_BACKEND: 'ssh-docker', DOTS_DOCKER_INSTANCE_ID: 'test-instance',
  DOTS_LINUX_DESKTOP_TOKEN_SECRET: 'test-desktop-signing-key-more-than-32-characters',
  DOTS_LINUX_DESKTOP_IMAGE: 'coke-dots-linux-desktop:sha-' + 'a'.repeat(40), DOTS_PI_ENABLED: '1',
};

async function withEnvironment(run: () => Promise<void>) {
  const values: Record<string, string | undefined> = { ...environment, DOTS_AGENT_KERNELS_JSON: undefined,
    DOTS_LINUX_DESKTOP_PROXY_BRIDGE: undefined, DOTS_INCIDENT_GITHUB_TENANT_ID: undefined };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { await run(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

class FakeDocker implements DockerApi {
  containers = new Map<string, any>();
  networks = new Map<string, any>();
  volumes = new Map<string, any>();
  calls: Array<{ method: string; path: string; body?: any }> = [];
  version = '29.1.3';
  imageInstalled = true;
  nextId = 1;
  async request<T>(method: string, path: string, body?: any): Promise<T> {
    this.calls.push({ method, path, body });
    if (path === '/version') return { Version: this.version, Os: 'linux' } as T;
    if (path.startsWith('/images/')) { if (!this.imageInstalled) throw new DockerApiError(404); return {} as T; }
    if (path === '/networks/create') {
      this.networks.set(body.Name, { ...body, Containers: {} }); return { Id: body.Name } as T;
    }
    if (path === '/volumes/create') { this.volumes.set(body.Name, { ...body, Options: null }); return body as T; }
    if (path.startsWith('/containers/create')) {
      const name = path.split('name=')[1];
      this.containers.set(name, { Id: 'container-' + this.nextId++, Config: body, HostConfig: body.HostConfig, State: { Running: false },
        Mounts: [{ Type: 'volume', Name: body.HostConfig.Mounts[0].Source, Destination: '/workspace', RW: true }],
        NetworkSettings: { Networks: { [body.HostConfig.NetworkMode]: {} }, Ports: Object.fromEntries([8082, 6080, 8083].map((port, index) => [port + '/tcp', [{ HostIp: '127.0.0.1', HostPort: String(20000 + index) }]])) } });
      return { Id: this.containers.get(name).Id } as T;
    }
    if (path.endsWith('/start')) {
      const container = [...this.containers.values()].find(value => path.includes(value.Id));
      assert(container); container.State.Running = true; return undefined as T;
    }
    const name = path.split('/')[2];
    const source = path.startsWith('/containers/') ? this.containers : path.startsWith('/networks/') ? this.networks : this.volumes;
    if (!source.has(name)) throw new DockerApiError(404);
    return source.get(name) as T;
  }
}

function connectorFor(api: FakeDocker) {
  const tunnels: Array<DesktopTunnel & { stopped: boolean }> = [];
  const connector = new SshDockerDesktopConnector({ host: 'test-host' }, api, async (_config, ports) => {
    assert.equal(ports.length, 3);
    const tunnel = { ports: [31001, 31002, 31003], stopped: false, alive() { return !this.stopped; }, async close() { this.stopped = true; } };
    tunnels.push(tunnel); return tunnel;
  }, async () => {});
  return { connector, tunnels };
}

test('Docker spec isolates instances and workspaces without publishing CDP or mounting host resources', () => {
  const alpha = dockerDesktopSpec('alpha;$(untrusted)', environment);
  const beta = dockerDesktopSpec('beta', environment);
  const other = dockerDesktopSpec('alpha;$(untrusted)', { ...environment, DOTS_DOCKER_INSTANCE_ID: 'other-instance' });
  assert.notEqual(alpha.name, beta.name);
  assert.notEqual(alpha.name, other.name);
  assert.notEqual(alpha.workerToken, beta.workerToken);
  assert.notEqual(alpha.workerToken, alpha.agentToken);
  assert.deepEqual(alpha, dockerDesktopSpec('alpha;$(untrusted)', environment));
  assert.match(alpha.name, /^dots-test-instance-[a-f0-9]+$/);
  assert.deepEqual(alpha.body.HostConfig.Mounts, [{ Type: 'volume', Source: alpha.volume, Target: '/workspace' }]);
  assert.deepEqual(Object.keys(alpha.body.HostConfig.PortBindings), ['8082/tcp', '6080/tcp', '8083/tcp']);
  assert(Object.values(alpha.body.HostConfig.PortBindings).every(entries => entries[0].HostIp === '127.0.0.1'));
  assert.equal(alpha.body.HostConfig.NetworkMode, alpha.network);
  assert.equal(alpha.body.HostConfig.Privileged, false);
  assert.deepEqual(alpha.body.HostConfig.CapDrop, ['ALL']);
  assert(!JSON.stringify(alpha.body).includes(environment.DOTS_LINUX_DESKTOP_TOKEN_SECRET));
  assert.deepEqual(desktopAgentEngineIds(environment), ['pi']);
  assert.throws(() => dockerDesktopSpec('alpha', { ...environment, DOTS_LINUX_DESKTOP_IMAGE: 'image:latest' }), /固定镜像/);
  assert.throws(() => dockerDesktopSpec('alpha', { ...environment, DOTS_DOCKER_INSTANCE_ID: '../other' }));
});

test('SSH configuration rejects command injection and preserves SSH-config ports and host verification', () => {
  const config = sshDockerConfig({ DOTS_DOCKER_SSH_HOST: 'dots-debian' });
  const args = sshArguments(config);
  assert(!args.includes('-p'), 'The SSH config alias may define a non-default port');
  assert(args.includes('StrictHostKeyChecking=yes'));
  assert(args.includes('BatchMode=yes'));
  assert(args.includes('ForwardAgent=no'));
  for (const host of ['', '-oProxyCommand=evil', 'host;command', 'user@host $(command)', 'host\ncommand']) {
    assert.throws(() => sshDockerConfig({ DOTS_DOCKER_SSH_HOST: host }));
  }
  assert.equal(sshDockerConfig({ DOTS_DOCKER_SSH_HOST: 'user@debian', DOTS_DOCKER_SSH_PORT: '2222' }).port, 2222);
  assert.throws(() => sshDockerConfig({ DOTS_DOCKER_SSH_HOST: 'host', DOTS_DOCKER_SSH_PORT: '0' }));
});

test('connect provisions once, restart reuses storage, close only stops its tunnel', () => withEnvironment(async () => {
  const api = new FakeDocker();
  const first = connectorFor(api);
  const connection = await first.connector.connect('alpha');
  const spec = dockerDesktopSpec('alpha');
  assert.equal(connection.workerToken, spec.workerToken);
  assert.equal(api.containers.size, 1); assert.equal(api.networks.size, 1); assert.equal(api.volumes.size, 1);
  assert.equal(await first.connector.connect('alpha'), connection);
  assert.equal(await first.connector.reconcile('alpha'), false);
  await first.connector.close();
  assert.equal(first.tunnels[0].stopped, true);
  const second = connectorFor(api);
  assert.equal((await second.connector.connect('alpha')).workerToken, connection.workerToken);
  assert.equal(api.calls.filter(call => call.path.startsWith('/containers/create')).length, 1);
  assert.equal(api.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(api.containers.get(spec.name).State.Running, true);
  await assert.rejects(second.connector.connect('beta'), /不能跨工作区/);
  await second.connector.close();
}));

test('stopped desktop resumes, external recreation and SSH loss trigger reconnection', () => withEnvironment(async () => {
  const api = new FakeDocker();
  const { connector, tunnels } = connectorFor(api);
  await connector.connect('alpha');
  const spec = dockerDesktopSpec('alpha');
  api.containers.get(spec.name).State.Running = false;
  await connector.reconcile('alpha');
  assert.equal(api.containers.get(spec.name).State.Running, true);
  api.containers.delete(spec.name);
  assert.equal(await connector.reconcile('alpha'), true);
  assert.equal(api.volumes.size, 1, 'Recreating a container preserves its original workspace volume');
  await connector.close();
  await connector.connect('alpha');
  tunnels.at(-1)!.stopped = true;
  assert.equal(await connector.reconcile('alpha'), true);
  await connector.connect('alpha');
  assert.equal(tunnels.length, 3);
  await connector.close();
}));

test('unrelated resource collisions and changed configurations fail without overwriting or removing anything', () => withEnvironment(async () => {
  for (const kind of ['network', 'volume', 'container']) {
    const api = new FakeDocker();
    const spec = dockerDesktopSpec('alpha');
    if (kind === 'network') api.networks.set(spec.network, { Labels: {} });
    if (kind === 'volume') api.volumes.set(spec.volume, { Labels: {} });
    if (kind === 'container') api.containers.set(spec.name, { Config: { Labels: {} } });
    await assert.rejects(connectorFor(api).connector.connect('alpha'), /不属于当前实例/);
    assert.equal(api.calls.some(call => call.method !== 'GET'), false);
  }
  const api = new FakeDocker();
  const first = connectorFor(api).connector;
  await first.connect('alpha'); await first.close();
  process.env.DOTS_DOCKER_CPUS = '3';
  const before = api.calls.length;
  try {
    await assert.rejects(connectorFor(api).connector.connect('alpha'), /配置已改变/);
    assert.equal(api.calls.slice(before).some(call => call.method !== 'GET'), false);
  } finally { delete process.env.DOTS_DOCKER_CPUS; }
}));

test('foreign network members, public port bindings and old Docker versions are rejected', () => withEnvironment(async () => {
  const api = new FakeDocker();
  const spec = dockerDesktopSpec('alpha');
  const first = connectorFor(api).connector;
  await first.connect('alpha'); await first.close();
  api.networks.get(spec.network).Containers.foreign = { Name: 'another-workspace' };
  await assert.rejects(connectorFor(api).connector.connect('alpha'), /隔离要求/);
  api.networks.get(spec.network).Containers = {};
  api.containers.get(spec.name).NetworkSettings.Ports['6080/tcp'][0].HostIp = '0.0.0.0';
  await assert.rejects(connectorFor(api).connector.connect('alpha'), /127.0.0.1/);
  const old = new FakeDocker(); old.version = '27.5.0';
  await assert.rejects(connectorFor(old).connector.connect('alpha'), /Docker Engine 28/);
  assert.equal(old.calls.some(call => call.method !== 'GET'), false);
  const missing = new FakeDocker(); missing.imageInstalled = false;
  await assert.rejects(connectorFor(missing).connector.connect('alpha'), /尚未安装指定/);
  assert.equal(missing.calls.some(call => call.method !== 'GET'), false);
}));

test('readiness failure closes the SSH tunnel while preserving the provisioned desktop', () => withEnvironment(async () => {
  const api = new FakeDocker(); let closed = false;
  const connector = new SshDockerDesktopConnector({ host: 'test-host' }, api, async () => ({
    ports: [31001, 31002, 31003], alive: () => true, close: async () => { closed = true; },
  }), async () => { throw new Error('Renderer not ready'); });
  await assert.rejects(connector.connect('alpha'), /Renderer not ready/);
  assert.equal(closed, true);
  assert.equal(api.containers.size, 1);
  assert.equal(api.calls.some(call => call.method === 'DELETE'), false);
}));

test('container network, mount or privilege drift is rejected even with matching ownership labels', () => withEnvironment(async () => {
  for (const mutate of [
    (container: any) => { container.NetworkSettings.Networks.other = {}; },
    (container: any) => { container.Mounts[0].Name = 'other-workspace-volume'; },
    (container: any) => { container.HostConfig.Privileged = true; },
  ]) {
    const api = new FakeDocker();
    const connector = connectorFor(api).connector;
    await connector.connect('alpha'); await connector.close();
    mutate(api.containers.get(dockerDesktopSpec('alpha').name));
    const before = api.calls.length;
    await assert.rejects(connector.connect('alpha'), /隔离要求/);
    assert.equal(api.calls.slice(before).some(call => call.method !== 'GET'), false);
  }
}));
