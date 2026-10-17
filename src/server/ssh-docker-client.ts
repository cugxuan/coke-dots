import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

export interface SshConfig {
  host: string;
  port?: number;
  identityFile?: string;
  knownHostsFile?: string;
}

export function sshDockerConfig(environment: NodeJS.ProcessEnv = process.env): SshConfig {
  const host = environment.DOTS_DOCKER_SSH_HOST?.trim() || '';
  // Destination is operator configuration, never a task/model-provided string.
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,252}$/.test(host)) throw new Error('请配置有效的 DOTS_DOCKER_SSH_HOST（SSH 别名或 user@host）');
  const port = environment.DOTS_DOCKER_SSH_PORT ? Number(environment.DOTS_DOCKER_SSH_PORT) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('DOTS_DOCKER_SSH_PORT 无效');
  return { host, port, identityFile: environment.DOTS_DOCKER_SSH_IDENTITY_FILE?.trim() || undefined, knownHostsFile: environment.DOTS_DOCKER_SSH_KNOWN_HOSTS_FILE?.trim() || undefined };
}

export function sshArguments(config: SshConfig): string[] {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'LogLevel=ERROR',
    ...(config.port ? ['-p', String(config.port)] : []), ...(config.identityFile ? ['-i', config.identityFile] : []),
    ...(config.knownHostsFile ? ['-o', 'UserKnownHostsFile=' + config.knownHostsFile] : [])];
}

export class DockerApiError extends Error {
  constructor(readonly status: number) { super('远端 Docker 请求失败（HTTP ' + status + '）。请检查 Docker 权限、镜像及资源状态。'); }
}

export interface DockerApi {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

/** Docker's HTTP protocol over SSH stdio. No public Docker API, shell interpolation or secret argv. */
export class SshDockerClient implements DockerApi {
  constructor(private readonly config: SshConfig) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const child = spawn('ssh', [...sshArguments(this.config), '-o', 'ClearAllForwardings=yes', this.config.host,
      'docker --host unix:///var/run/docker.sock system dial-stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
    // Node's HTTP client accepts a Duplex transport; SSH handles liveness/timeouts.
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = request({ method, host: 'docker', path: '/v1.47' + path,
        createConnection: () => stream,
        headers: { connection: 'close', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) req.destroy(new Error('Docker response too large'));
          else chunks.push(chunk);
        });
        res.on('error', () => fail());
        res.on('end', () => {
          cleanup();
          const status = res.statusCode || 500;
          if (status < 200 || status >= 300) return reject(new DockerApiError(status));
          try { resolve((size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined) as T); }
          catch { reject(new Error('远端 Docker 返回了无效响应。')); }
        });
      });
      const timeout = setTimeout(() => req.destroy(new Error('Docker SSH timeout')), 30_000);
      function cleanup() { clearTimeout(timeout); stream.destroy(); child.kill(); }
      function fail() { cleanup(); reject(new Error('无法通过 SSH 访问 Docker。请检查主机指纹、SSH 密钥和远端 Docker socket 权限。')); }
      child.once('error', () => req.destroy(new Error('SSH unavailable')));
      req.once('error', fail);
      req.end(payload);
    });
  }
}

export interface DesktopTunnel {
  ports: number[];
  alive(): boolean;
  close(): Promise<void>;
}

export async function openDesktopTunnel(config: SshConfig, remotePorts: number[]): Promise<DesktopTunnel> {
  const localPorts = await reservePorts(remotePorts.length);
  const forwardArgs = remotePorts.flatMap((remotePort, index) => ['-L', '127.0.0.1:' + localPorts[index] + ':127.0.0.1:' + remotePort]);
  const child = spawn('ssh', [...sshArguments(config), '-o', 'ExitOnForwardFailure=yes', '-N', ...forwardArgs, config.host], { stdio: 'ignore' });
  let failed = false;
  child.once('error', () => { failed = true; });
  const tunnel: DesktopTunnel = {
    ports: localPorts,
    alive: () => !failed && child.exitCode === null && child.signalCode === null,
    close: () => stopProcess(child),
  };
  // The caller waits for browser, Worker and Agent readiness through this tunnel.
  return tunnel;
}

async function reservePorts(count: number) {
  const listeners: Server[] = [];
  try {
    const ports: number[] = [];
    for (let i = 0; i < count; i++) {
      const server = createServer(); listeners.push(server);
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('无法分配 SSH 隧道端口');
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(listeners.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), delay(1000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
