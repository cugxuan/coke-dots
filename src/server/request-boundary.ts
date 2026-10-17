import { timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { IncomingMessage } from 'node:http';

export interface RequestBoundaryConfig {
  port: number;
  publicOrigin?: string;
  publicHost?: string;
  trustedProxyToken?: string;
  lanOrigin?: string;
  lanCidr?: string;
}

const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function controlPlaneNetwork(environment: NodeJS.ProcessEnv = process.env) {
  const port = Number(environment.DOTS_PORT || 4317);
  const host = environment.DOTS_BIND_HOST?.trim() || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DOTS_PORT must be a port between 1 and 65535');
  const lanOrigin = environment.DOTS_LAN_ORIGIN?.trim() || '';
  const lanCidr = environment.DOTS_LAN_CIDR?.trim() || '';
  if (Boolean(lanOrigin) !== Boolean(lanCidr)) throw new Error('Set both DOTS_LAN_ORIGIN and DOTS_LAN_CIDR for LAN access');
  const origin = configuredLanOrigin(lanOrigin);
  if (lanOrigin && (!origin || Number(origin.port || 80) !== port)) throw new Error('DOTS_LAN_ORIGIN must be an HTTP origin with a private IPv4 address and DOTS_PORT');
  if (lanCidr && (!privateSubnet(lanCidr) || !inLanSubnet(origin!.hostname, lanCidr))) throw new Error('DOTS_LAN_CIDR must be a private IPv4 subnet containing the LAN origin');
  if (host !== '127.0.0.1' && (!origin || !['0.0.0.0', origin.hostname].includes(host))) {
    throw new Error('DOTS_BIND_HOST requires explicit LAN origin/subnet configuration for non-loopback listening');
  }
  const boundary: RequestBoundaryConfig = {
    port, lanOrigin: origin?.origin, lanCidr: lanCidr || undefined,
    publicOrigin: environment.DOTS_PUBLIC_ORIGIN,
    publicHost: environment.DOTS_PUBLIC_HOST,
    trustedProxyToken: environment.DOTS_TRUSTED_PROXY_TOKEN,
  };
  return { host, port, boundary };
}

export function isLocalRequest(req: IncomingMessage, path: string, config: RequestBoundaryConfig) {
  const remote = req.socket.remoteAddress || '';
  const hostname = requestHostname(req.headers.host);
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const localHost = hostname === '127.0.0.1' || hostname === 'localhost';
  const publicHost = configuredPublicHost(config);
  const presentedToken = req.headers['x-dots-proxy-token'];
  const trustedProxy = typeof presentedToken === 'string'
    && constantTimeEqual(presentedToken, config.trustedProxyToken || '');
  const forwardedPublicHost = Boolean(publicHost && trustedProxy && hostname === publicHost);
  const oauthCallback = req.method === 'GET' && path === '/auth/google/callback' && origin === 'https://accounts.google.com';
  const slackCallback = req.method === 'GET' && path === '/auth/slack/callback'
    && ['https://slack.com', 'https://slack-gov.com'].includes(origin);
  const sandboxArtifactPreview = req.method === 'GET' && path.startsWith('/api/artifact-preview/');
  const allowedOrigin = !origin || isAllowedOrigin(origin, config) || oauthCallback || slackCallback
    || (sandboxArtifactPreview && origin === 'null');

  const loopback = loopbackAddresses.has(remote);
  const lan = configuredLanOrigin(config.lanOrigin);
  const lanRequest = lan && config.lanCidr && req.headers.host?.toLowerCase() === lan.host
    && (loopback || inLanSubnet(remote, config.lanCidr));
  const lanOriginAllowed = !origin || origin === lan?.origin || oauthCallback || slackCallback
    || (sandboxArtifactPreview && origin === 'null');
  return Boolean((loopback && (localHost || forwardedPublicHost) && allowedOrigin) || (lanRequest && lanOriginAllowed));
}

export function isAllowedOrigin(value: string, config: RequestBoundaryConfig) {
  try {
    const origin = new URL(value);
    if (origin.origin !== value) return false;
    const allowedPorts = new Set(['5173', String(config.port)]);
    const localOrigin = origin.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(origin.hostname)
      && allowedPorts.has(origin.port);
    const publicOrigin = canonicalPublicOrigin(config.publicOrigin);
    const lanOrigin = configuredLanOrigin(config.lanOrigin)?.origin;
    return localOrigin || Boolean(publicOrigin && origin.origin === publicOrigin)
      || Boolean(lanOrigin && config.lanCidr && origin.origin === lanOrigin);
  } catch {
    return false;
  }
}

function configuredLanOrigin(value: string | undefined): URL | null {
  const canonical = canonicalPublicOrigin(value);
  if (!canonical) return null;
  const origin = new URL(canonical);
  return origin.protocol === 'http:' && privateIPv4(origin.hostname) ? origin : null;
}

function ipv4Number(value: string) {
  return value.split('.').reduce((result, octet) => result * 256 + Number(octet), 0);
}

function privateIPv4(value: string) {
  if (!isIPv4(value)) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function privateSubnet(value: string): { start: number; end: number } | null {
  const match = value.match(/^([^/]+)\/(\d{1,2})$/);
  if (!match || !privateIPv4(match[1])) return null;
  const bits = Number(match[2]);
  if (bits < 8 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(ipv4Number(match[1]) / size) * size;
  const end = start + size - 1;
  const privateRanges = [[0x0a000000, 0x0affffff], [0xac100000, 0xac1fffff], [0xc0a80000, 0xc0a8ffff]];
  return privateRanges.some(([low, high]) => start >= low && end <= high) ? { start, end } : null;
}

function inLanSubnet(remote: string, cidr: string) {
  const address = remote.toLowerCase().replace(/^::ffff:/, '');
  const subnet = privateSubnet(cidr);
  if (!subnet || !isIPv4(address)) return false;
  const value = ipv4Number(address);
  return value >= subnet.start && value <= subnet.end;
}

function requestHostname(value: string | undefined) {
  if (!value) return '';
  try { return new URL(`http://${value}`).hostname.toLowerCase(); }
  catch { return ''; }
}

function configuredPublicHost(config: RequestBoundaryConfig) {
  const host = config.publicHost?.trim().toLowerCase();
  if (host) return host;
  try { return new URL(config.publicOrigin || '').hostname.toLowerCase(); }
  catch { return ''; }
}

function canonicalPublicOrigin(value: string | undefined) {
  if (!value) return '';
  try {
    const origin = new URL(value.trim());
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) return '';
    return origin.origin;
  } catch {
    return '';
  }
}

function constantTimeEqual(left: string, right: string) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
