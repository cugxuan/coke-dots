import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopConnection, DesktopConnector } from './linux-desktop-computer.ts';
import { desktopAgentKernels } from './desktop-agent-kernels.ts';
import { configuredDesktopImage } from './desktop-runtime-config.ts';
import { DockerApiError, SshDockerClient, openDesktopTunnel, sshDockerConfig, type DesktopTunnel, type DockerApi, type SshConfig } from './ssh-docker-client.ts';

const ports = [8082, 6080, 8083];
const specLabel = 'com.coke-dots.spec';
type Labels = Record<string, string>;
interface Network { Labels?: Labels; Driver?: string; Internal?: boolean; Options?: Record<string, string>; Containers?: Record<string, { Name: string }> }
interface Volume { Labels?: Labels; Driver?: string; Options?: Record<string, string> | null }
interface Container {
  Id: string;
  Config: { Labels?: Labels; User: string };
  HostConfig: { Privileged: boolean; NetworkMode: string; CapAdd?: string[] | null; CapDrop?: string[]; SecurityOpt?: string[]; PidMode?: string; IpcMode?: string };
  Mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }>;
  State: { Running: boolean; Paused?: boolean; Restarting?: boolean };
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>; Networks: Record<string, unknown> };
}

export function dockerDesktopSpec(tenantId: string, environment: NodeJS.ProcessEnv = process.env) {
  const instance = environment.DOTS_DOCKER_INSTANCE_ID?.trim() || 'coke-dots';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) throw new Error('DOTS_DOCKER_INSTANCE_ID 必须是至多 32 字符的小写字母、数字或连字符');
  const secret = environment.DOTS_LINUX_DESKTOP_TOKEN_SECRET || '';
  if (secret.length < 32) throw new Error('Linux 云电脑需要配置至少 32 字符的 DOTS_LINUX_DESKTOP_TOKEN_SECRET');
  if (environment.DOTS_LINUX_DESKTOP_PROXY_BRIDGE === '1') throw new Error('SSH Docker 模式不使用 Mac Docker Desktop 代理桥；请关闭 DOTS_LINUX_DESKTOP_PROXY_BRIDGE');
  if (environment.DOTS_INCIDENT_GITHUB_TENANT_ID === tenantId) throw new Error('SSH Docker 模式尚未配置事故修复专用 Git 凭据代理，不能启用此租户的自动提交场景');
  const image = configuredDesktopImage(environment.NODE_ENV, environment.DOTS_LINUX_DESKTOP_IMAGE);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image)) throw new Error('云电脑镜像地址无效');
  const tenantHash = createHash('sha256').update(instance).update('\0').update(tenantId).digest('hex');
  const name = 'dots-' + instance + '-' + tenantHash.slice(0, 24);
  const network = name + '-net';
  const volume = name + '-data';
  const labels = { 'com.coke-dots.managed-by': 'coke-dots', 'com.coke-dots.instance': instance, 'com.coke-dots.tenant': tenantHash };
  const workerToken = createHmac('sha256', secret).update('docker-worker:' + tenantHash).digest('base64url');
  const agentToken = createHmac('sha256', secret).update('docker-agent:' + tenantHash).digest('base64url');
  const kernels = desktopAgentKernels(environment);
  const nanoCpus = Number(environment.DOTS_DOCKER_CPUS || 2) * 1_000_000_000;
  const memory = Number(environment.DOTS_DOCKER_MEMORY_MB || 4096) * 1024 * 1024;
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus < 100_000_000 || nanoCpus > 64_000_000_000
    || !Number.isSafeInteger(memory) || memory < 512 * 1024 * 1024 || memory > 256 * 1024 ** 3) throw new Error('Docker 云电脑 CPU 或内存限制无效');
  const body = {
    Image: image, User: '1000:1000', WorkingDir: '/workspace',
    Env: [
      'LINUX_DESKTOP_WORKER_TOKEN=' + workerToken, 'DOTS_AGENT_RUNTIME_TOKEN=' + agentToken,
      'COKE_DESKTOP_VNC_AUTH_MODE=gateway', 'COKE_DESKTOP_RESOLUTION=1440x900',
      'COKE_DESKTOP_CHROME_NO_SANDBOX=' + (environment.DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX === '1' ? '1' : '0'),
      'DOTS_DESKTOP_AGENT_ADAPTERS=' + Object.keys(kernels).join(','),
      'DOTS_AGENT_KERNELS_JSON=' + JSON.stringify(kernels),
    ],
    ExposedPorts: Object.fromEntries(ports.map(port => [port + '/tcp', {}])),
    HostConfig: {
      NetworkMode: network,
      Mounts: [{ Type: 'volume', Source: volume, Target: '/workspace' }],
      PortBindings: Object.fromEntries(ports.map(port => [port + '/tcp', [{ HostIp: '127.0.0.1', HostPort: '' }]])),
      RestartPolicy: { Name: 'unless-stopped' }, Privileged: false,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      Memory: memory, NanoCpus: nanoCpus, PidsLimit: 512, ShmSize: 512 * 1024 * 1024,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=536870912,mode=1777' },
      LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { name, network, volume, labels, workerToken, agentToken, image,
    body: { ...body, Labels: { ...labels, [specLabel]: fingerprint } } };
}

/** One isolated container/network/volume per workspace, managed only through SSH. */
export class SshDockerDesktopConnector implements DesktopConnector {
  private tunnel: DesktopTunnel | null = null;
  private current: DesktopConnection | null = null;
  private containerId: string | null = null;
  private remotePorts: number[] = [];
  private tenantId: string | null = null;

  constructor(
    private readonly config?: SshConfig,
    private api?: DockerApi,
    private readonly makeTunnel = openDesktopTunnel,
    private readonly waitReady = waitDesktopReady,
  ) {}

  async connect(tenantId: string): Promise<DesktopConnection> {
    this.bindTenant(tenantId);
    if (this.current && this.tunnel?.alive()) return this.current;
    await this.close();
    const { container, spec } = await this.ensureDesktop(tenantId);
    const remotePorts = desktopPublishedPorts(container);
    const tunnel = await this.makeTunnel(this.config || sshDockerConfig(), remotePorts);
    this.tunnel = tunnel;
    const connection = {
      workerUrl: new URL('http://127.0.0.1:' + tunnel.ports[0]),
      novncUrl: new URL('http://127.0.0.1:' + tunnel.ports[1]),
      agentUrl: new URL('http://127.0.0.1:' + tunnel.ports[2]),
      workerToken: spec.workerToken, agentToken: spec.agentToken,
    };
    try {
      await this.waitReady(connection, tunnel);
      this.containerId = container.Id;
      this.remotePorts = remotePorts;
      this.current = connection;
      return connection;
    } catch (error) { await this.close(); throw error; }
  }

  async reconcile(tenantId: string) {
    this.bindTenant(tenantId);
    if (!this.current || !this.tunnel?.alive()) return true;
    const { container } = await this.ensureDesktop(tenantId);
    return container.Id !== this.containerId || desktopPublishedPorts(container).some((port, index) => port !== this.remotePorts[index]);
  }

  async close() {
    const tunnel = this.tunnel;
    this.tunnel = null; this.current = null; this.containerId = null;
    await tunnel?.close();
    // Containers keep running; volumes are never automatically removed.
  }

  private bindTenant(tenantId: string) {
    if (this.tenantId !== null && this.tenantId !== tenantId) throw new Error('云电脑连接不能跨工作区复用');
    this.tenantId = tenantId;
  }

  private async ensureDesktop(tenantId: string) {
    this.api ||= new SshDockerClient(this.config || sshDockerConfig());
    const spec = dockerDesktopSpec(tenantId);
    const version = await this.api.request<{ Version: string; Os: string }>('GET', '/version');
    if (version.Os !== 'linux' || !(Number(version.Version.split('.')[0]) >= 28)) throw new Error('SSH 云电脑需要 Debian 上的 Docker Engine 28 或更高版本');
    // Inspect ownership before making any changes. Never adopt unrelated resources.
    let container = await this.inspect<Container>('/containers/' + spec.name + '/json');
    const network = await this.inspect<Network>('/networks/' + spec.network);
    const volume = await this.inspect<Volume>('/volumes/' + spec.volume);
    if (container) {
      assertOwned(container.Config.Labels, spec.labels);
      if (container.Config.Labels?.[specLabel] !== spec.body.Labels[specLabel]) {
        throw new Error('云电脑配置已改变。请先结束该工作区任务，再按部署文档重建其容器；数据卷会保留。');
      }
      assertContainerIsolation(container, spec);
    }
    if (network) {
      assertOwned(network.Labels, spec.labels);
      if (network.Driver !== 'bridge' || network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'nat'
        || Object.values(network.Containers || {}).some(item => item.Name !== spec.name)) throw new Error('云电脑网络不满足工作区隔离要求');
    }
    if (volume) {
      assertOwned(volume.Labels, spec.labels);
      if (volume.Driver !== 'local' || Object.keys(volume.Options || {}).length) throw new Error('云电脑数据卷必须是独立的本地 Docker 卷');
    }
    // Image installation/pull is an explicit deployment step, not a side effect of a task.
    if (!await this.inspect('/images/' + encodeURIComponent(spec.image) + '/json')) throw new Error('远端尚未安装指定的云电脑镜像。请先运行 Docker 镜像构建或加载步骤。');
    if (!network) {
      await this.createOrVerify('/networks/create', {
        Name: spec.network, Driver: 'bridge', CheckDuplicate: true, Internal: false, Labels: spec.labels,
        Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'nat', 'com.docker.network.bridge.host_binding_ipv4': '127.0.0.1' },
      }, '/networks/' + spec.network, spec.labels);
    }
    if (!volume) await this.createOrVerify('/volumes/create', { Name: spec.volume, Driver: 'local', Labels: spec.labels }, '/volumes/' + spec.volume, spec.labels);
    if (!container) {
      try { await this.api.request('POST', '/containers/create?name=' + spec.name, spec.body); }
      catch (error) { if (!(error instanceof DockerApiError && error.status === 409)) throw error; }
      container = await this.api.request<Container>('GET', '/containers/' + spec.name + '/json');
      assertOwned(container.Config.Labels, spec.labels);
      if (container.Config.Labels?.[specLabel] !== spec.body.Labels[specLabel]) throw new Error('已有同名云电脑使用不同配置，未启动或覆盖');
      assertContainerIsolation(container, spec);
    }
    if (container.State.Paused || container.State.Restarting) throw new Error('远端云电脑已暂停或正在重启，请检查其状态后重试');
    if (!container.State.Running) {
      try { await this.api.request('POST', '/containers/' + container.Id + '/start'); }
      catch (error) { if (!(error instanceof DockerApiError && error.status === 304)) throw error; }
      container = await this.api.request<Container>('GET', '/containers/' + spec.name + '/json');
    }
    if (!container.State.Running) throw new Error('远端云电脑未能启动');
    desktopPublishedPorts(container);
    return { container, spec };
  }

  private async inspect<T = unknown>(path: string): Promise<T | null> {
    try { return await this.api!.request<T>('GET', path); }
    catch (error) { if (error instanceof DockerApiError && error.status === 404) return null; throw error; }
  }

  private async createOrVerify(path: string, body: unknown, inspectPath: string, labels: Labels) {
    try { await this.api!.request('POST', path, body); }
    catch (error) { if (!(error instanceof DockerApiError && error.status === 409)) throw error; }
    const created = await this.api!.request<{ Labels?: Labels }>('GET', inspectPath);
    assertOwned(created.Labels, labels);
  }
}

function assertOwned(actual: Labels | undefined, expected: Labels) {
  if (Object.entries(expected).some(([key, value]) => actual?.[key] !== value)) throw new Error('同名 Docker 资源不属于当前实例和工作区，未接管或修改');
}

function assertContainerIsolation(container: Container, spec: ReturnType<typeof dockerDesktopSpec>) {
  const host = container.HostConfig;
  const networks = Object.keys(container.NetworkSettings.Networks || {});
  const mounts = container.Mounts || [];
  if (container.Config.User !== '1000:1000' || host.Privileged || host.CapAdd?.length || !host.CapDrop?.includes('ALL')
    || !host.SecurityOpt?.some(value => value === 'no-new-privileges' || value === 'no-new-privileges:true')
    || host.NetworkMode !== spec.network || networks.length !== 1 || networks[0] !== spec.network
    || (host.PidMode && host.PidMode !== 'private') || (host.IpcMode && host.IpcMode !== 'private')
    || mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== spec.volume
    || mounts[0].Destination !== '/workspace' || !mounts[0].RW) {
    throw new Error('云电脑容器的用户、权限、网络或数据卷不满足工作区隔离要求');
  }
}

function desktopPublishedPorts(container: Container) {
  const mappings = container.NetworkSettings.Ports || {};
  if (Object.entries(mappings).some(([key, values]) => values?.length && !ports.some(port => key === port + '/tcp'))) throw new Error('云电脑存在未授权的端口映射');
  return ports.map(port => {
    const entries = mappings[port + '/tcp'];
    const value = Number(entries?.[0]?.HostPort);
    if (entries?.length !== 1 || entries[0].HostIp !== '127.0.0.1' || !Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error('云电脑端口必须仅绑定远端 127.0.0.1');
    }
    return value;
  });
}

async function waitDesktopReady(connection: DesktopConnection, tunnel: DesktopTunnel) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!tunnel.alive()) throw new Error('SSH 桌面隧道已断开。请检查主机连接及端口转发权限。');
    try {
      const worker = await fetch(new URL('/readyz', connection.workerUrl), { headers: { authorization: 'Bearer ' + connection.workerToken }, signal: AbortSignal.timeout(3000) });
      const ready = await worker.json() as { ready?: boolean; ok?: boolean };
      const agent = await fetch(new URL('/healthz', connection.agentUrl), { signal: AbortSignal.timeout(3000) });
      const status = await agent.json() as { runtime?: string };
      const state = await fetch(new URL('/v1/state', connection.workerUrl), { headers: { authorization: 'Bearer ' + connection.workerToken }, signal: AbortSignal.timeout(3000) });
      await state.body?.cancel();
      const view = await fetch(new URL('/vnc.html', connection.novncUrl), { signal: AbortSignal.timeout(3000) });
      await view.body?.cancel();
      if (worker.ok && (ready.ready || ready.ok) && state.ok && agent.ok && status.runtime === 'dots-agent-runtime' && view.ok) return;
    } catch { /* Chromium can take time to initialize on first boot. */ }
    await delay(1000);
  }
  throw new Error('SSH 云电脑未在 180 秒内就绪。请检查桌面、Chromium、Worker 和 Agent 日志。');
}
