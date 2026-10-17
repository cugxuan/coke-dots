import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { controlPlaneNetwork, isAllowedOrigin, isLocalRequest, type RequestBoundaryConfig } from '../src/server/request-boundary.ts';

const config: RequestBoundaryConfig = {
  port: 4317,
  publicOrigin: 'https://codex.cokeagent.com',
  publicHost: 'codex.cokeagent.com',
  trustedProxyToken: 'proxy-secret-for-test-only',
};

function request({
  remoteAddress = '127.0.0.1',
  host = '127.0.0.1:4317',
  origin,
  proxyToken,
  method = 'GET',
  url = '/',
}: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  proxyToken?: string;
  method?: string;
  url?: string;
} = {}) {
  const headers: Record<string, string> = { host };
  if (origin !== undefined) headers.origin = origin;
  if (proxyToken !== undefined) headers['x-dots-proxy-token'] = proxyToken;
  return {
    socket: { remoteAddress },
    headers,
    method,
    url,
  } as unknown as IncomingMessage;
}

test('allows direct loopback requests and local browser origins', () => {
  assert.equal(isLocalRequest(request(), '/', config), true);
  assert.equal(isLocalRequest(request({ host: 'localhost:5173', origin: 'http://localhost:5173' }), '/', config), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:4317', config), true);
});

test('allows the configured public domain only through loopback with the proxy token', () => {
  const publicRequest = request({
    host: 'codex.cokeagent.com',
    origin: 'https://codex.cokeagent.com',
    proxyToken: config.trustedProxyToken,
  });
  assert.equal(isLocalRequest(publicRequest, '/', config), true);
  assert.equal(isAllowedOrigin('https://codex.cokeagent.com', config), true);
});

test('rejects public-host requests with a missing or incorrect proxy token', () => {
  assert.equal(isLocalRequest(request({ host: 'codex.cokeagent.com' }), '/', config), false);
  assert.equal(isLocalRequest(request({ host: 'codex.cokeagent.com', proxyToken: 'wrong' }), '/', config), false);
});

test('does not trust the proxy header from non-loopback peers or on another host', () => {
  assert.equal(isLocalRequest(request({ remoteAddress: '203.0.113.8', host: 'codex.cokeagent.com', proxyToken: config.trustedProxyToken }), '/', config), false);
  assert.equal(isLocalRequest(request({ host: 'evil.example', proxyToken: config.trustedProxyToken }), '/', config), false);
});

test('restricts browser origins to the configured public origin and local dev ports', () => {
  assert.equal(isAllowedOrigin('https://evil.example', config), false);
  assert.equal(isAllowedOrigin('https://codex.cokeagent.com.attacker.example', config), false);
  assert.equal(isAllowedOrigin('https://codex.cokeagent.com/path', config), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:9999', config), false);
  assert.equal(isLocalRequest(request({ host: 'codex.cokeagent.com', proxyToken: config.trustedProxyToken, origin: 'https://evil.example' }), '/', config), false);
});

test('keeps OAuth callback exceptions behind the trusted public proxy boundary', () => {
  assert.equal(isLocalRequest(request({
    host: 'codex.cokeagent.com',
    proxyToken: config.trustedProxyToken,
    origin: 'https://accounts.google.com',
    method: 'GET',
    url: '/auth/google/callback',
  }), '/auth/google/callback', config), true);
  assert.equal(isLocalRequest(request({
    host: 'codex.cokeagent.com',
    origin: 'https://accounts.google.com',
    method: 'GET',
    url: '/auth/google/callback',
  }), '/auth/google/callback', config), false);
});

const lanConfig: RequestBoundaryConfig = { port: 4317, lanOrigin: 'http://192.168.31.195:4317', lanCidr: '192.168.31.0/24' };

test('LAN listening requires an explicit private origin and matching subnet', () => {
  assert.equal(controlPlaneNetwork({}).host, '127.0.0.1');
  const environment = { DOTS_BIND_HOST: '0.0.0.0', DOTS_LAN_ORIGIN: lanConfig.lanOrigin, DOTS_LAN_CIDR: lanConfig.lanCidr };
  const network = controlPlaneNetwork(environment);
  assert.equal(network.host, '0.0.0.0');
  assert.equal(network.boundary.lanOrigin, lanConfig.lanOrigin);
  assert.equal(network.boundary.lanCidr, lanConfig.lanCidr);
  assert.equal(controlPlaneNetwork({ ...environment, DOTS_BIND_HOST: '192.168.31.195' }).host, '192.168.31.195');
  assert.throws(() => controlPlaneNetwork({ DOTS_BIND_HOST: '0.0.0.0' }), /explicit LAN/);
  assert.throws(() => controlPlaneNetwork({ DOTS_LAN_ORIGIN: lanConfig.lanOrigin }), /both/);
  assert.throws(() => controlPlaneNetwork({ DOTS_LAN_CIDR: lanConfig.lanCidr }), /both/);
  for (const origin of ['http://203.0.113.10:4317', 'http://example.com:4317', 'http://192.168.31.195:9999', 'http://192.168.31.195:4317/path', 'http://user:pass@192.168.31.195:4317']) {
    assert.throws(() => controlPlaneNetwork({ ...environment, DOTS_LAN_ORIGIN: origin }), /DOTS_LAN_ORIGIN/);
  }
  for (const cidr of ['0.0.0.0/0', '192.168.31.0/0', '192.168.31.0/33', '192.168.31.0/15', '192.168.32.0/24', '10.0.0.0/7', 'not-a-subnet']) {
    assert.throws(() => controlPlaneNetwork({ ...environment, DOTS_LAN_CIDR: cidr }), /DOTS_LAN_CIDR/);
  }
  assert.throws(() => controlPlaneNetwork({ ...environment, DOTS_BIND_HOST: '203.0.113.1' }), /DOTS_BIND_HOST/);
});

test('LAN HTTP and WebSocket requests allow only the configured host, origin and peers', () => {
  const client = { remoteAddress: '192.168.31.42', host: '192.168.31.195:4317', origin: lanConfig.lanOrigin };
  for (const path of ['/', '/api/auth/local/login', '/api/computer/novnc/websockify']) {
    assert.equal(isLocalRequest(request({ ...client, url: path }), path, lanConfig), true);
  }
  assert.equal(isAllowedOrigin(lanConfig.lanOrigin!, lanConfig), true);
  assert.equal(isLocalRequest(request({ ...client, remoteAddress: '::ffff:192.168.31.42' }), '/', lanConfig), true);
  assert.equal(isLocalRequest(request({ ...client, remoteAddress: '127.0.0.1' }), '/', lanConfig), true);
  assert.equal(isLocalRequest(request({ ...client, origin: undefined }), '/', lanConfig), true);
  assert.equal(isLocalRequest(request(), '/', lanConfig), true);
  assert.equal(isLocalRequest(request(client), '/', config), false, 'LAN remains disabled without explicit configuration');
  for (const remoteAddress of ['192.168.32.42', '172.24.0.2', '203.0.113.2', '::ffff:203.0.113.2', '2001:db8::1']) {
    assert.equal(isLocalRequest(request({ ...client, remoteAddress, proxyToken: config.trustedProxyToken }), '/', lanConfig), false);
  }
  for (const host of ['evil.example:4317', '127.0.0.1:4317', '192.168.31.195:9999', '192.168.31.196:4317']) {
    assert.equal(isLocalRequest(request({ ...client, host }), '/', lanConfig), false);
  }
  for (const origin of ['https://evil.example', 'http://192.168.31.196:4317', 'http://192.168.31.195:9999', 'http://127.0.0.1:4317', 'null']) {
    assert.equal(isLocalRequest(request({ ...client, origin }), '/', lanConfig), false);
  }
  assert.equal(isLocalRequest(request({ ...client, origin: 'null' }), '/api/artifact-preview/task/ticket/file', lanConfig), true);
  assert.equal(isAllowedOrigin('http://192.168.31.195:9999', lanConfig), false);
});

test('LAN subnet checks handle RFC1918 boundaries without allowing wider public ranges', () => {
  for (const [lanOrigin, lanCidr, allowed, denied] of [
    ['http://10.0.0.1:4317', '10.0.0.0/8', '10.255.255.254', '11.0.0.1'],
    ['http://172.16.0.1:4317', '172.16.0.0/12', '172.31.255.254', '172.32.0.1'],
    ['http://192.168.0.1:4317', '192.168.0.0/16', '192.168.255.254', '192.169.0.1'],
  ]) {
    const { boundary } = controlPlaneNetwork({ DOTS_LAN_ORIGIN: lanOrigin, DOTS_LAN_CIDR: lanCidr });
    const client = { host: new URL(lanOrigin).host, origin: lanOrigin };
    assert.equal(isLocalRequest(request({ ...client, remoteAddress: allowed }), '/', boundary), true);
    assert.equal(isLocalRequest(request({ ...client, remoteAddress: denied }), '/', boundary), false);
  }
});
