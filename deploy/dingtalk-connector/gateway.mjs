import { appendBoundedStartupStderr, eventStartupDiagnostic, allowedErrors, publicError, classifyEventStartupFailure, classifyEventStartupCause } from './lib/gateway-errors.mjs';
export { appendBoundedStartupStderr, eventStartupDiagnostic } from './lib/gateway-errors.mjs';
import { parseEncryptionKey, verifyPrincipalTicket } from './lib/gateway-credentials.mjs';
export { parseEncryptionKey, issuePrincipalTicket, verifyPrincipalTicket, sealProfileBytes, openProfileBytes } from './lib/gateway-credentials.mjs';
import { writeEncryptedProfile, restoreEncryptedProfile, chmodPrivate, ensurePrivateStorageRoot, createDocumentWriteOnce } from './lib/gateway-storage.mjs';
import { sanitizeGroups, sanitizeGroupList } from './lib/gateway-groups.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { hostProfileEnvironment, inspectDwsProfile, isolatedEnvironment, parseAuthStatus, prepareProfileRoot, principalKey, resolveDwsClientCredentials, runDwsProcess, selectCurrentProfile, verifyDwsBinary } from './lib/dws-runtime.mjs';
import { createDwsAuthorizationManager } from './lib/dws-authorization-manager.mjs';
import { createDwsDocumentOperations } from './lib/dws-documents.mjs';
import { createDwsCalendarOperations } from './lib/dws-calendar.mjs';
const maxRequestBytes = 32 * 1024;
const maxDocumentRequestBytes = 600 * 1024;

function safeVerificationUrl(raw) {
  try {
    const source = new URL(raw);
    const code = source.searchParams.get('user_code') || source.searchParams.get('userCode');
    if (source.protocol !== 'https:' || source.hostname !== 'login.dingtalk.com' || source.port || source.username || source.password || !code || code.length > 80) return null;
    const url = new URL(`${source.origin}${source.pathname}`);
    url.searchParams.set('user_code', code);
    return { authorizationUrl: url.toString(), userCode: code };
  } catch { return null; }
}

export function hostProfileUserHash(userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 256) throw new Error('CONNECTOR_IDENTITY_REQUIRED');
  return createHash('sha256').update(JSON.stringify(['coke-dots-host-dws-user-v1', userId])).digest('hex');
}

export function createDingtalkConnectorGateway({
  env = process.env,
  binary: configuredBinary,
  verifyBinary = verifyDwsBinary,
  runDws = runDwsProcess,
  spawnProcess = spawn,
  inspectProfile = inspectDwsProfile,
  macTestOnly = false,
} = {}) {
  const allowMacRuntime = macTestOnly || env.DINGTALK_CONNECTOR_ALLOW_MACOS_RUNTIME === '1';
  const localMacRuntime = process.platform === 'darwin' && allowMacRuntime;
  const hostProfile = env.DINGTALK_CONNECTOR_USE_HOST_PROFILE === '1';
  const port = Number(env.DINGTALK_CONNECTOR_PORT || 8789);
  const localDataRoot = path.join(homedir(), 'Library', 'Application Support', 'Coke Dots DWS Local Demo');
  const localDwsBinary = path.join(homedir(), 'Library', 'Application Support', 'Coke Dots Demo', 'tools', 'dws', 'bin', 'dws');
  const hostDwsBinary = path.join(homedir(), '.local', 'bin', 'dws');
  const binary = configuredBinary || env.DINGTALK_CONNECTOR_DWS_BINARY || (localMacRuntime
    ? (hostProfile ? hostDwsBinary : localDwsBinary) : '/usr/local/bin/dws');
  const storageRoot = path.resolve(env.DINGTALK_CONNECTOR_STORAGE_ROOT || (localMacRuntime ? path.join(localDataRoot, 'profiles') : '/var/lib/dws/profiles'));
  const tmpRoot = path.resolve(env.DINGTALK_CONNECTOR_TMP_ROOT || (localMacRuntime ? path.join(tmpdir(), 'coke-dots-dws-local-demo') : '/run/dws'));
  const managedTmpRoot = path.join(tmpRoot, 'coke-dots-dingtalk-connector');
  const serviceToken = String(env.DINGTALK_CONNECTOR_SERVICE_TOKEN || '');
  const ticketSecret = String(env.DINGTALK_CONNECTOR_TICKET_SECRET || '');
  const proxy = env.DINGTALK_CONNECTOR_HTTPS_PROXY || undefined;
  const hostConfigDir = env.DINGTALK_CONNECTOR_DWS_HOST_CONFIG_DIR || path.join(homedir(), '.dws');
  const allowedHostUserHash = String(env.DINGTALK_CONNECTOR_ALLOWED_USER_HASH || '');
  const { clientId: dwsClientId, clientSecret: dwsClientSecret } = resolveDwsClientCredentials(env);
  if (hostProfile && (!localMacRuntime || !path.isAbsolute(hostConfigDir) || !/^[a-f0-9]{64}$/.test(allowedHostUserHash))) {
    throw new Error('DINGTALK_CONNECTOR_CONFIGURATION_INVALID');
  }
  const dwsEnvironment = owner => hostProfile
    ? hostProfileEnvironment({ proxy, clientId: dwsClientId, clientSecret: dwsClientSecret, configDir: hostConfigDir })
    : isolatedEnvironment(owner, { proxy, allowMacRuntime, clientId: dwsClientId, clientSecret: dwsClientSecret });
  const inspectDws = options => inspectProfile({
    ...options, clientId: dwsClientId, clientSecret: dwsClientSecret,
    ...(hostProfile ? { hostProfile: true, hostConfigDir } : {}),
  });
  const masterKey = parseEncryptionKey(env.DINGTALK_CONNECTOR_ENCRYPTION_KEY || '');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || serviceToken.length < 32 || ticketSecret.length < 32) throw new Error('DINGTALK_CONNECTOR_CONFIGURATION_INVALID');
  const usedTicketNonces = new Map();
  const flows = new Map();
  const locks = new Map();
  const activeMonitors = new Map();
  const documents = createDwsDocumentOperations({
    withAuthenticatedProfile: async (principal, work) => {
      if (process.platform !== 'linux' && !(process.platform === 'darwin' && allowMacRuntime)) throw new Error('DWS_GATEWAY_REQUIRES_LINUX');
      const ownerKey = principalKey(principal);
      return withOwnerLock(dwsLockKey(ownerKey), async () => {
        const workspace = await createPrincipalProfileWorkspace(principal, 'documents');
        let restored = false;
        try {
          restored = await restorePrincipalProfile(ownerKey, workspace);
          if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
          await verifyBinary(binary);
          const owner = await prepareProfileRoot(workspace.root, principal);
          const env = dwsEnvironment(owner);
          const call = (args, options = {}) => runDws(binary, [...args, '--format', 'json'], {
            cwd: owner, env, timeoutMs: 60_000, maxBytes: 1024 * 1024, parseJsonOnFailure: true, ...options,
          });
          const profile = selectCurrentProfile(await call(['profile', 'list']));
          if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
          const authStatus = parseAuthStatus(await call(['auth', 'status', '--profile', profile.selector]), profile);
          if (!authStatus.authenticated) throw new Error('DWS_DOC_AUTHORIZATION_REQUIRED');
          return await work({ call, profile, ownerKey });
        } finally {
          if (restored && !hostProfile) await persistPrincipalProfile(ownerKey, workspace).catch(() => undefined);
          await rm(workspace.root, { recursive: true, force: true });
        }
      });
    },
    writeOnce: createDocumentWriteOnce(storageRoot),
  });
  const calendar = createDwsCalendarOperations({
    withAuthenticatedProfile: async (principal, work) => {
      if (process.platform !== 'linux' && !(process.platform === 'darwin' && allowMacRuntime)) throw new Error('DWS_GATEWAY_REQUIRES_LINUX');
      const ownerKey = principalKey(principal);
      return withOwnerLock(dwsLockKey(ownerKey), async () => {
        const workspace = await createPrincipalProfileWorkspace(principal, 'calendar');
        let restored = false;
        try {
          restored = await restorePrincipalProfile(ownerKey, workspace);
          if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
          await verifyBinary(binary);
          const owner = await prepareProfileRoot(workspace.root, principal);
          const env = dwsEnvironment(owner);
          const call = (args, options = {}) => runDws(binary, [...args, '--format', 'json'], {
            cwd: owner, env, timeoutMs: 60_000, maxBytes: 1024 * 1024, parseJsonOnFailure: true, ...options,
          });
          const profile = selectCurrentProfile(await call(['profile', 'list']));
          if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
          const authStatus = parseAuthStatus(await call(['auth', 'status', '--profile', profile.selector]), profile);
          if (!authStatus.authenticated) throw new Error('DWS_DOC_AUTHORIZATION_REQUIRED');
          return await work({ call, profile, ownerKey });
        } finally {
          if (restored && !hostProfile) await persistPrincipalProfile(ownerKey, workspace).catch(() => undefined);
          await rm(workspace.root, { recursive: true, force: true });
        }
      });
    },
  });

  async function initialize() {
    await ensurePrivateStorageRoot(storageRoot);
    await rm(managedTmpRoot, { recursive: true, force: true });
    await mkdir(managedTmpRoot, { recursive: true, mode: 0o700 });
    if (hostProfile) {
      const info = await lstat(hostConfigDir);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
        throw new Error('DINGTALK_CONNECTOR_CONFIGURATION_INVALID');
      }
    }
  }

  function assertHostProfilePrincipal(ticket) {
    if (!hostProfile) return;
    const received = Buffer.from(hostProfileUserHash(ticket.userId), 'hex');
    const expected = Buffer.from(allowedHostUserHash, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error('DWS_HOST_PROFILE_USER_NOT_ALLOWED');
  }

  function ownerPrincipal(ticket) { return { issuer: 'coke-dots', subject: `${ticket.tenantId}:${ticket.userId}` }; }

  async function createProfileWorkspace(ticket, suffix) {
    return createPrincipalProfileWorkspace(ownerPrincipal(ticket), suffix);
  }

  async function createPrincipalProfileWorkspace(principal, suffix) {
    const ownerKey = principalKey(principal);
    const root = await mkdtemp(path.join(managedTmpRoot, `${ownerKey}-${suffix}-`));
    await chmodPrivate(root, 0o700);
    return { ownerKey, root, principal };
  }

  async function restorePrincipalProfile(ownerKey, workspace) {
    if (hostProfile) return true;
    return restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
  }

  async function persistPrincipalProfile(ownerKey, workspace) {
    if (hostProfile) return;
    return writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot });
  }

  async function withOwnerLock(ownerKey, work) {
    const previous = locks.get(ownerKey) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(ownerKey, current);
    await previous;
    try { return await work(); }
    finally { release(); if (locks.get(ownerKey) === current) locks.delete(ownerKey); }
  }

  const dwsLockKey = ownerKey => hostProfile ? 'host-dws-profile' : ownerKey;

  async function status(ticket) {
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const flow = [...flows.values()].find(item => item.ownerKey === ownerKey);
    if (flow) {
      const value = await flow.manager.poll(flow.principal, flow.id);
      if (value.state === 'authorized') await persistFlow(flow);
      else if (['failed', 'cancelled', 'expired'].includes(value.state)) await removeFlow(flow);
      return { id: flow.id, state: value.state, ...(value.authorizationUrl ? safeVerificationUrl(value.authorizationUrl) : {}), ...(value.installation ? { installation: value.installation } : {}), ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}), ...(value.reason ? { reason: value.reason } : {}) };
    }
    if (hostProfile) return withOwnerLock(dwsLockKey(ownerKey), () => inspectDws({ binary, storageRoot, principal: ownerPrincipal(ticket), proxy, allowMacRuntime, verifyBinary }));
    return withOwnerLock(dwsLockKey(ownerKey), async () => {
      const workspace = await createProfileWorkspace(ticket, 'status');
      try {
        const restored = await restorePrincipalProfile(ownerKey, workspace);
        if (!restored) return { state: 'not-installed' };
        const result = await inspectDws({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, allowMacRuntime, verifyBinary });
        if (result.state === 'identity-verified') await persistPrincipalProfile(ownerKey, workspace);
        return result;
      } finally { await rm(workspace.root, { recursive: true, force: true }); }
    });
  }

  async function startAuthorization(ticket) {
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const pending = [...flows.values()].find(item => item.ownerKey === ownerKey);
    if (pending) return publicAuthorization(await pending.manager.poll(pending.principal, pending.id));
    const existing = await status(ticket);
    if (existing.state === 'identity-verified') return { state: 'failed', reason: 'DWS_PROFILE_ALREADY_CONNECTED' };
    const workspace = await createProfileWorkspace(ticket, 'auth');
    try {
      const restored = await restorePrincipalProfile(ownerKey, workspace);
      if (restored && !hostProfile) {
        if (existing.state !== 'expired') throw new Error('DWS_PROFILE_ALREADY_CONNECTED');
        const oldManager = createDwsAuthorizationManager({ binary, storageRoot: workspace.root, proxy, allowMacRuntime, clientId: dwsClientId, clientSecret: dwsClientSecret, verifyBinary, inspect: inspectDws });
        await oldManager.disconnect(workspace.principal);
      }
      const manager = createDwsAuthorizationManager({ binary, storageRoot: workspace.root, proxy, allowMacRuntime, clientId: dwsClientId, clientSecret: dwsClientSecret, hostProfile, hostConfigDir, verifyBinary, inspect: inspectDws });
      const authorization = await manager.start(workspace.principal);
      if (authorization.state !== 'awaiting-user' || !safeVerificationUrl(authorization.authorizationUrl)) {
        await rm(workspace.root, { recursive: true, force: true });
        throw new Error('DWS_AUTHORIZATION_INVALID_RESULT');
      }
      const flow = { ...workspace, manager, id: authorization.id };
      flows.set(authorization.id, flow);
      return publicAuthorization(authorization);
    } catch (error) {
      await rm(workspace.root, { recursive: true, force: true });
      throw error;
    }
  }

  function publicAuthorization(value) {
    const verification = value.authorizationUrl ? safeVerificationUrl(value.authorizationUrl) : null;
    return {
      id: value.id,
      state: value.state,
      ...(verification || {}),
      ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
      ...(value.installation ? { installation: value.installation } : {}),
      ...(value.reason ? { reason: value.reason } : {}),
    };
  }

  async function persistFlow(flow) {
    if (!hostProfile) await writeEncryptedProfile({ storageRoot, ownerKey: flow.ownerKey, masterKey, sourceRoot: flow.root, tempRoot: managedTmpRoot });
    await removeFlow(flow);
  }

  async function removeFlow(flow) {
    flows.delete(flow.id);
    await rm(flow.root, { recursive: true, force: true });
  }

  async function pollAuthorization(ticket, id) {
    const flow = flows.get(id);
    if (!flow || flow.ownerKey !== principalKey(ownerPrincipal(ticket))) throw new Error('CONNECTOR_AUTHORIZATION_NOT_FOUND');
    const authorization = await flow.manager.poll(flow.principal, id);
    if (authorization.state === 'authorized') await persistFlow(flow);
    else if (['failed', 'cancelled', 'expired'].includes(authorization.state)) await removeFlow(flow);
    return {
      id: authorization.id,
      state: authorization.state,
      ...(authorization.authorizationUrl ? safeVerificationUrl(authorization.authorizationUrl) : {}),
      ...(authorization.installation ? { installation: authorization.installation } : {}),
      ...(authorization.expiresAt ? { expiresAt: authorization.expiresAt } : {}),
      ...(authorization.reason ? { reason: authorization.reason } : {}),
    };
  }

  async function cancelAuthorization(ticket, id) {
    const flow = flows.get(id);
    if (!flow || flow.ownerKey !== principalKey(ownerPrincipal(ticket))) throw new Error('CONNECTOR_AUTHORIZATION_NOT_FOUND');
    const result = await flow.manager.cancel(flow.principal, id);
    await removeFlow(flow);
    return { id, state: result.state };
  }

  async function searchGroups(ticket, body) {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const cursor = typeof body.cursor === 'string' && body.cursor.length <= 200 ? body.cursor : '0';
    if (!query || query.length > 100) throw new Error('DWS_GROUP_QUERY_INVALID');
    const ownerKey = principalKey(ownerPrincipal(ticket));
    return withOwnerLock(dwsLockKey(ownerKey), async () => {
      const workspace = await createProfileWorkspace(ticket, 'search');
      let restored = false;
      try {
        restored = await restorePrincipalProfile(ownerKey, workspace);
        if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
        const statusValue = await inspectDws({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, allowMacRuntime, verifyBinary });
        if (statusValue.state !== 'identity-verified') throw new Error('DWS_PROFILE_NOT_AUTHENTICATED');
        const owner = await prepareProfileRoot(workspace.root, workspace.principal);
        const profilePayload = await runDws(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env: dwsEnvironment(owner) });
        const profile = selectCurrentProfile(profilePayload);
        if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
        const result = await runDws(binary, ['chat', 'search', '--query', query, '--limit', '20', '--cursor', cursor, '--format', 'json', '--profile', profile.selector], {
          cwd: owner, env: dwsEnvironment(owner), timeoutMs: 30_000,
        });
        return sanitizeGroups(result);
      } finally {
        if (restored && !hostProfile) await persistPrincipalProfile(ownerKey, workspace).catch(() => undefined);
        await rm(workspace.root, { recursive: true, force: true });
      }
    });
  }

  async function listGroups(ticket, body) {
    const cursor = typeof body.cursor === 'string' && body.cursor.length <= 200 ? body.cursor : '0';
    const pageLimit = Number(body.pageLimit ?? 50);
    if (!cursor || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) throw new Error('DWS_GROUP_LIST_LIMIT_INVALID');
    const ownerKey = principalKey(ownerPrincipal(ticket));
    return withOwnerLock(dwsLockKey(ownerKey), async () => {
      const workspace = await createProfileWorkspace(ticket, 'list-groups');
      let restored = false;
      try {
        restored = await restorePrincipalProfile(ownerKey, workspace);
        if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
        const statusValue = await inspectDws({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, allowMacRuntime, verifyBinary });
        if (statusValue.state !== 'identity-verified') throw new Error('DWS_PROFILE_NOT_AUTHENTICATED');
        const owner = await prepareProfileRoot(workspace.root, workspace.principal);
        const profilePayload = await runDws(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env: dwsEnvironment(owner) });
        const profile = selectCurrentProfile(profilePayload);
        if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
        const args = ['chat', '+my-groups', '--page-all', '--page-limit', String(pageLimit), '--format', 'json', '--profile', profile.selector];
        if (cursor !== '0') args.splice(5, 0, '--cursor', cursor);
        const result = await runDws(binary, args, {
          cwd: owner, env: dwsEnvironment(owner), timeoutMs: 60_000, maxBytes: 2 * 1024 * 1024,
        });
        return sanitizeGroupList(result);
      } finally {
        if (restored && !hostProfile) await persistPrincipalProfile(ownerKey, workspace).catch(() => undefined);
        await rm(workspace.root, { recursive: true, force: true });
      }
    });
  }

  async function disconnect(ticket) {
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const flow = [...flows.values()].find(item => item.ownerKey === ownerKey);
    if (flow) { await flow.manager.cancel(flow.principal, flow.id).catch(() => undefined); await removeFlow(flow); }
    for (const [key, listener] of activeMonitors) {
      if (listener.ownerKey === ownerKey) listener.stop();
    }
    if (hostProfile) return { disconnected: true, serverGrantRevoked: false, hostProfileRetained: true };
    await rm(path.join(storageRoot, `${ownerKey}.dws`), { force: true });
    return { disconnected: true, serverGrantRevoked: false };
  }

  async function streamGroupMessages(ticket, body, req, res) {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!conversationId || conversationId.length > 512) throw new Error('DWS_GROUP_QUERY_INVALID');
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const monitorKey = `${ownerKey}:${conversationId}`;
    if (activeMonitors.has(monitorKey)) throw new Error('DWS_MONITOR_ALREADY_ACTIVE');

    let workspace;
    let child;
    let ready = false;
    let streamOpen = false;
    let cancelled = false;
    let closed = false;
    let output = '';
    let errors = '';
    let stderrLineBuffer = '';
    let startupFailureCode = 'DWS_EVENT_LISTENER_FAILED';
    let startupFailureStage = 'prepare-workspace';
    let startupFailureCause = 'unclassified';
    let startupDiagnosticWritten = false;
    const startupStartedAt = Date.now();
    let stderrBytes = 0;
    let startupOutput = '';
    let startupOutputBytes = 0;
    let childExitCode;
    let childExitSignal;
    let spawnErrorCode;
    let outputBytes = 0;
    let readyTimer;
    let heartbeat;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const pendingEvents = [];
    let resolveClosed;
    const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const listener = {
      ownerKey,
      stop() {
        cancelled = true;
        if (closed) return;
        child?.kill('SIGTERM');
        if (!res.destroyed && res.headersSent) res.end();
      },
    };

    const sendFrame = value => {
      if (!res.destroyed && res.headersSent) res.write(`${JSON.stringify(value)}\n`);
    };
    const writeStartupDiagnostic = () => {
      if (startupDiagnosticWritten) return;
      startupDiagnosticWritten = true;
      process.stderr.write(`[dingtalk-monitor] ${JSON.stringify(eventStartupDiagnostic({
        stage: startupFailureStage,
        code: startupFailureCode,
        cause: startupFailureCause === 'unclassified' && stderrBytes === 0
          ? classifyEventStartupCause(errors, startupFailureStage)
          : startupFailureCause,
        exitCode: childExitCode,
        signal: childExitSignal,
        stderr: errors,
        stderrBytes,
        stdout: startupOutput,
        stdoutBytes: startupOutputBytes,
        osErrorCode: spawnErrorCode,
        elapsedMs: Date.now() - startupStartedAt,
      }))}\n`);
      errors = '';
      stderrLineBuffer = '';
    };
    const processOutputLine = line => {
      if (!line.trim()) return;
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const eventConversationId = String(value.conversation_id || value.conversationId || conversationId).trim();
      const messageId = String(value.message_id || value.messageId || '').trim();
      const text = typeof value.content === 'string' ? value.content : '';
      if (eventConversationId !== conversationId || !messageId || !text.trim()) return;
      const event = {
        type: 'message',
        message: {
          conversationId,
          messageId: messageId.slice(0, 256),
          senderId: String(value.sender_open_dingtalk_id || '').slice(0, 256),
          senderName: String(value.sender || '').slice(0, 200),
          text: text.slice(0, 6000),
        },
      };
      if (streamOpen) sendFrame(event);
      else if (pendingEvents.length < 100) pendingEvents.push(event);
    };

    const start = async () => withOwnerLock(dwsLockKey(ownerKey), async () => {
      if (activeMonitors.has(monitorKey)) throw new Error('DWS_MONITOR_ALREADY_ACTIVE');
      workspace = await createProfileWorkspace(ticket, 'monitor');
      const restored = await restorePrincipalProfile(ownerKey, workspace);
      if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
      startupFailureStage = 'inspect-profile';
      const profileState = await inspectDws({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, allowMacRuntime, verifyBinary });
      if (profileState.state !== 'identity-verified') throw new Error('DWS_PROFILE_NOT_AUTHENTICATED');
      const owner = await prepareProfileRoot(workspace.root, workspace.principal);
      startupFailureStage = 'list-profiles';
      const profilePayload = await runDws(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env: dwsEnvironment(owner) });
      const profile = selectCurrentProfile(profilePayload);
      if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
      startupFailureStage = 'spawn-listener';
      child = spawnProcess(binary, [
        'event', '+listen-im', '--kind', 'group', '--chat-id', conversationId,
        '--events', 'message', '-f', 'ndjson', '--profile', profile.selector, '--debug',
      ], { cwd: owner, env: dwsEnvironment(owner), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      startupFailureStage = 'await-ready';
      if (cancelled) child.kill('SIGTERM');
      listener.child = child;
      listener.workspace = workspace;
      if (!hostProfile) {
        const versionInfo = await stat(path.join(storageRoot, `${ownerKey}.dws`));
        listener.profileVersion = `${versionInfo.size}:${versionInfo.mtimeMs}`;
      }
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 8 * 1024 * 1024) { child.kill('SIGTERM'); return; }
        const decoded = stdoutDecoder.write(chunk);
        if (!ready) {
          startupOutputBytes += chunk.length;
          startupOutput = appendBoundedStartupStderr(startupOutput, decoded);
        }
        output += decoded;
        let boundary;
        while ((boundary = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, boundary);
          output = output.slice(boundary + 1);
          processOutputLine(line);
        }
        if (output.length > 256 * 1024) { output = ''; child.kill('SIGTERM'); }
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        const decoded = stderrDecoder.write(chunk);
        if (!ready) errors = appendBoundedStartupStderr(errors, decoded);
        stderrLineBuffer += decoded;
        let boundary;
        while ((boundary = stderrLineBuffer.indexOf('\n')) >= 0) {
          const line = stderrLineBuffer.slice(0, boundary);
          stderrLineBuffer = stderrLineBuffer.slice(boundary + 1);
          if (!ready && line.includes('[event] ready')) resolveReady();
          if (!ready) {
            startupFailureCode = classifyEventStartupFailure(line, startupFailureCode);
            const cause = classifyEventStartupCause(line, startupFailureStage);
            if (cause !== 'no-stderr') startupFailureCause = cause;
        }
        }
        if (stderrLineBuffer.length > 64 * 1024) stderrLineBuffer = stderrLineBuffer.slice(-1024);
      });
      child.once('error', error => {
        startupFailureStage = 'spawn-error';
        startupFailureCode = 'DWS_EVENT_LISTENER_FAILED';
        spawnErrorCode = error?.code;
        writeStartupDiagnostic();
        rejectReady(new Error('DWS_EVENT_LISTENER_FAILED'));
      });
      child.once('close', (code, signal) => {
        childExitCode = code;
        childExitSignal = signal;
        if (!ready) {
          const tail = stderrDecoder.end();
          errors = appendBoundedStartupStderr(errors, tail);
          const outputTail = stdoutDecoder.end();
          startupOutput = appendBoundedStartupStderr(startupOutput, outputTail);
          stderrLineBuffer += tail;
          startupFailureCode = classifyEventStartupFailure(errors, startupFailureCode);
          const cause = classifyEventStartupCause(errors, startupFailureStage);
          if (cause !== 'no-stderr') startupFailureCause = cause;
          startupFailureStage = 'child-exit';
          if (!cancelled) writeStartupDiagnostic();
          rejectReady(new Error(startupFailureCode));
        }
        closed = true;
        resolveClosed();
      });
      activeMonitors.set(monitorKey, listener);
      readyTimer = setTimeout(() => {
        startupFailureStage = 'ready-timeout';
        startupFailureCode = classifyEventStartupFailure(errors, startupFailureCode);
        const cause = classifyEventStartupCause(errors, startupFailureStage);
        if (cause !== 'no-stderr') startupFailureCause = cause;
        writeStartupDiagnostic();
        rejectReady(new Error(startupFailureCode));
      }, 30_000);
      await readyPromise;
      ready = true;
      errors = '';
      stderrLineBuffer = '';
    });

    const stop = () => listener.stop();
    req.once('aborted', stop);
    res.once('close', stop);
    try {
      await start();
      clearTimeout(readyTimer);
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      sendFrame({ type: 'ready' });
      streamOpen = true;
      for (const event of pendingEvents.splice(0)) sendFrame(event);
      heartbeat = setInterval(() => sendFrame({ type: 'ping' }), 20_000);
      await closedPromise;
      if (!res.destroyed) res.end();
    } catch (error) {
      clearTimeout(readyTimer);
      if (!ready && !cancelled) {
        const code = typeof error?.message === 'string' && allowedErrors.has(error.message) ? error.message : startupFailureCode;
        if (code !== startupFailureCode) startupFailureCode = code;
        writeStartupDiagnostic();
      }
      const failure = publicError(error);
      if (!res.headersSent) {
        const payload = Buffer.from(JSON.stringify({ ok: false, error: failure.body.error }));
        res.writeHead(failure.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store' });
        res.end(payload);
      } else if (!res.destroyed) {
        sendFrame({ type: 'error', error: failure.body.error });
        res.end();
      }
    } finally {
      clearTimeout(readyTimer);
      clearInterval(heartbeat);
      req.off('aborted', stop);
      res.off('close', stop);
      if (child && !closed) {
        child?.kill('SIGTERM');
        await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 5_000))]);
        if (!closed) child?.kill('SIGKILL');
      }
      if (activeMonitors.get(monitorKey) === listener) activeMonitors.delete(monitorKey);
      if (workspace) {
        if (!hostProfile) {
          try {
            const encryptedPath = path.join(storageRoot, `${ownerKey}.dws`);
            const current = await stat(encryptedPath);
            const currentVersion = `${current.size}:${current.mtimeMs}`;
            if (listener.profileVersion && currentVersion === listener.profileVersion) {
              await withOwnerLock(dwsLockKey(ownerKey), () => writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot }));
            }
          } catch { /* Keep the existing encrypted profile if it changed or cannot be refreshed. */ }
        }
        await rm(workspace.root, { recursive: true, force: true });
      }
    }
  }

  async function readBody(req, maximumBytes = maxRequestBytes) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error('DINGTALK_REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
    catch { throw new Error('DINGTALK_REQUEST_INVALID'); }
  }

  async function handle(req, res) {
    const send = (statusCode, body) => {
      const data = Buffer.from(JSON.stringify(body));
      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
      res.end(data);
    };
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true, service: 'dingtalk-connector-gateway', dwsVersion: '1.0.64' });
    if (req.headers.authorization !== `Bearer ${serviceToken}`) return send(401, { ok: false, error: 'SERVICE_AUTH_REQUIRED' });
    let ticket;
    try {
      ticket = verifyPrincipalTicket(req.headers['x-dots-principal-ticket'], ticketSecret);
      const previousExpiry = usedTicketNonces.get(ticket.nonce);
      if (previousExpiry && previousExpiry >= Math.floor(Date.now() / 1000)) return send(401, { ok: false, error: 'PRINCIPAL_TICKET_REPLAYED' });
      usedTicketNonces.set(ticket.nonce, ticket.expiresAt);
      for (const [nonce, expiresAt] of usedTicketNonces) if (expiresAt < Math.floor(Date.now() / 1000)) usedTicketNonces.delete(nonce);
    } catch { return send(401, { ok: false, error: 'PRINCIPAL_TICKET_INVALID' }); }

    try { assertHostProfilePrincipal(ticket); }
    catch (error) { return send(403, { ok: false, error: error.message }); }

    try {
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { ok: true, data: await status(ticket) });
      if (req.method === 'POST' && url.pathname === '/v1/authorization') return send(201, { ok: true, data: await startAuthorization(ticket) });
      const authorizationMatch = url.pathname.match(/^\/v1\/authorization\/([a-f0-9-]{36})$/i);
      if (authorizationMatch && req.method === 'GET') return send(200, { ok: true, data: await pollAuthorization(ticket, authorizationMatch[1]) });
      if (authorizationMatch && req.method === 'DELETE') return send(200, { ok: true, data: await cancelAuthorization(ticket, authorizationMatch[1]) });
      if (req.method === 'POST' && url.pathname === '/v1/groups/search') return send(200, { ok: true, data: await searchGroups(ticket, await readBody(req)) });
      if (req.method === 'POST' && url.pathname === '/v1/groups/list') return send(200, { ok: true, data: await listGroups(ticket, await readBody(req)) });
      const documentRoute = url.pathname.match(/^\/v1\/docs\/(create|fetch|search|update)$/);
      if (req.method === 'POST' && documentRoute) {
        const body = await readBody(req, maxDocumentRequestBytes);
        const operation = { create: 'createDocument', fetch: 'fetchDocument', search: 'searchDocuments', update: 'updateDocument' }[documentRoute[1]];
        return send(200, { ok: true, data: await documents[operation](ownerPrincipal(ticket), body) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/calendar/events') {
        const body = await readBody(req, 16 * 1024);
        return send(200, { ok: true, data: await calendar.listEvents(ownerPrincipal(ticket), body) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/monitors/events') return await streamGroupMessages(ticket, await readBody(req), req, res);
      if (req.method === 'DELETE' && url.pathname === '/v1/account') return send(200, { ok: true, data: await disconnect(ticket) });
      return send(404, { ok: false, error: 'NOT_FOUND' });
    } catch (error) {
      const failure = publicError(error);
      return send(failure.status, { ...failure.body, ok: false });
    }
  }

  const server = createServer((req, res) => { void handle(req, res); });
  return {
    server,
    async listen(host = env.DINGTALK_CONNECTOR_HOST || (localMacRuntime ? '127.0.0.1' : '0.0.0.0')) {
      if (localMacRuntime && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('DWS_LOCAL_RUNTIME_LOOPBACK_ONLY');
      await initialize();
      await verifyBinary(binary);
      await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
      return server.address();
    },
    async close() {
      for (const flow of flows.values()) await flow.manager.cancel(flow.principal, flow.id).catch(() => undefined);
      flows.clear();
      for (const listener of activeMonitors.values()) listener.stop();
      await Promise.all([...activeMonitors.values()].map(listener => listener.child ? new Promise(resolve => listener.child.once('close', resolve)) : Promise.resolve()));
      activeMonitors.clear();
      if (server.listening) await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const gateway = createDingtalkConnectorGateway();
    const address = await gateway.listen();
    process.stdout.write(`DingTalk connector gateway listening on ${address.address}:${address.port}\n`);
    const shutdown = () => { void gateway.close().finally(() => process.exit(0)); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch {
    process.stderr.write('DingTalk connector gateway startup failed\n');
    process.exitCode = 1;
  }
}
