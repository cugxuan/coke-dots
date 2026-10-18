import { chatTaskRouting } from './scenarios/task-routing.ts';
import { signedOutControls, signInAlpha, supportedEngines, themePreference, firstRunConversation, customizeAppearance, persistAppearance } from './scenarios/onboarding.ts';
import { authenticatedEventStream, personalIsolation, createSharedWorkspace, inviteMember, revokeInvitations, switchTenant, restoreAfterRestart } from './scenarios/workspaces.ts';
import { dictateAndSend } from './scenarios/dictation.ts';
import { persistentTask, activityControls, attachments, resumeWaitingTask, pauseAndResume, stopAndCancelApproval, parallelTasks, delegatedTasks } from './scenarios/tasks.ts';
import { slackAuthorization, dingtalkGroups, dingtalkAlerts } from './scenarios/integrations.ts';
import { computerShortcut, sharedComputerIdentity, personalComputerIsolation, inputRequiresTakeover, takeoverAndReturn } from './scenarios/computers.ts';
import { scheduleControls, automationIdeas, recurringWork } from './scenarios/scheduling.ts';
import { sharedModelPermissions, transientSecretOutage } from './scenarios/model-settings.ts';
import { desktopVoiceCall } from './scenarios/browser-voice.ts';
import { mobileVoiceCall } from './scenarios/mobile-voice.ts';
import { workspaceMemory, privateDotMemory } from './scenarios/memory.ts';
import { workspaceRules, pageApprovals } from './scenarios/approvals.ts';
import { qwenWebRtc } from './scenarios/qwen-voice.ts';
import { volcanoRealtime, seedDuplexEntitlement, mobileSeedDuplex, seedDuplexClarification } from './scenarios/volcengine-voice.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Entry } from '../../src/server/keyring.ts';
import { WebSocket as NodeWebSocket, WebSocketServer } from 'ws';
import { decodeVolcengineFrame } from '../../src/server/volcengine-voice.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactStamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = resolve(process.env.DOTS_E2E_ARTIFACTS || join(projectRoot, 'artifacts', 'e2e', artifactStamp));
const screenshotsDir = join(artifactRoot, 'screenshots');
const videoDir = join(artifactRoot, 'video');
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-e2e-'));
const emptyEnvFile = join(tempRoot, 'empty.env');
const testDataDir = join(tempRoot, 'data');
const sharedModelSecretUnavailableFile = join(tempRoot, 'simulated-shared-model-secret-unavailable');
const testModelSecretDirectory = join(tempRoot, 'model-secrets');
const testKeyringDirectory = join(testDataDir, 'keyring');
process.env.DOTS_TEST_KEYRING_DIR = testKeyringDirectory;
const fixtureSource = join(projectRoot, 'tests', 'e2e', 'fixtures', 'computer.html');
const fixtureDestination = join(projectRoot, 'dist', 'e2e-computer-fixture.html');
const chromePath = findChromePath();
const steps: { name: string; result: 'passed' }[] = [];
const screenshotNames: string[] = [];
const serverLogs: string[] = [];
const pageErrors: string[] = [];
let server: ChildProcess | null = null;
let mockModelServer: Server | null = null;
let mockSlackServer: Server | null = null;
let mockQwenSignalingServer: Server | null = null;
let mockVolcEngineServer: WebSocketServer | null = null;
let mockVolcEngineDuplexServer: WebSocketServer | null = null;
let mockVolcEngineRejectedServer: Server | null = null;
let mockSlackProviderOrigin = '';
let mockQwenSignalingUrl = '';
let mockQwenSignalingRequests: { authorization: string; contentType: string; sdp: string }[] = [];
let mockVolcEngineUrl = '';
let mockVolcEngineConnections: { headers: Record<string, string>; events: number[]; serverEvents: number[]; timeline: string[]; pcmBytes: number; spokenTexts: string[] }[] = [];
let mockVolcEngineDuplexUrl = '';
let mockVolcEngineDuplexConnections: { headers: Record<string, string>; events: string[]; timeline: string[]; pcmBytes: number; pcmPeak: number; nonSilentPcmSamples: number; spokenTexts: string[]; audioDeltas: number; sendTranscript: (transcript: string, turnId: string) => void }[] = [];
let mockVolcEngineDuplexNextInitialTranscript = '请用中文整理本周人工智能产品更新的三个要点，并说明来源。';
let mockSlackCodeExchanges = 0;
let e2eSlackTokenAccount = '';
let mockModelPrompts: string[] = [];
let mockModelRequests: { prompt: string; authorization: string }[] = [];
let heldPauseModelRelease: (() => void) | null = null;
let heldPauseModelAborted = false;
let pauseModelHeld = false;
let heldVoiceModelRelease: (() => void) | null = null;
let voiceModelHeld = false;
let heldMobileVoiceModelRelease: (() => void) | null = null;
let mobileVoiceModelHeld = false;
let heldStopModelRelease: (() => void) | null = null;
let heldStopModelAborted = false;
let parallelModelReleases: (() => void)[] = [];
let delegatedModelReleases = new Map<string, () => void>();
let delegatedModelPrompts: string[] = [];
let delegatedModelAborted = new Set<string>();
let testModelBaseUrl = '';
let testModelApiKey = '';
let testModelName = '';
let browser: Browser | null = null;
let alphaContext: BrowserContext | null = null;
let betaContext: BrowserContext | null = null;
let gammaContext: BrowserContext | null = null;
let mobileContext: BrowserContext | null = null;
let alphaPage: Page | null = null;
let betaPage: Page | null = null;
let gammaPage: Page | null = null;
let mobilePage: Page | null = null;
let baseUrl = '';
let failure = '';
let e2ePort = 0;

await mkdir(screenshotsDir, { recursive: true });
await mkdir(videoDir, { recursive: true });
await writeFile(emptyEnvFile, '');
await copyFile(fixtureSource, fixtureDestination);

function findChromePath() {
  const candidates = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  const result = candidates.find(candidate => candidate && existsSync(candidate));
  if (!result) throw new Error('Chrome was not found. Set DOTS_CHROME_BIN to a local Chrome executable.');
  return result;
}

async function reservePort() {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function startMockModel() {
  mockModelPrompts = [];
  mockModelRequests = [];
  mockModelServer = createHttpServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const payload = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
        const prompt = payload.messages?.find(message => message.role === 'user')?.content || '';
        if (payload.messages?.some(message => message.role === 'system' && message.content.startsWith('You classify a new message'))) {
          const data = JSON.parse(prompt) as { message: string; candidates: { id: string; title: string }[] };
          const byd = data.candidates.find(candidate => candidate.title.includes('E2E BYD 信用报告'));
          const route = data.message === '帮我列出来具体有哪些信息渠道查询了，哪些没有查询' && byd
            ? { action: 'continue', taskId: byd.id, reason: '追问比亚迪报告的渠道覆盖' }
            : data.message === '这份报告的来源呢？'
              ? { action: 'clarify', question: '你指的是哪份报告？', taskIds: data.candidates.slice(0, 2).map(candidate => candidate.id) }
              : { action: 'new', reason: '这是独立的新请求' };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(route) } }] }));
          return;
        }
        mockModelPrompts.push(prompt);
        mockModelRequests.push({ prompt, authorization: String(request.headers.authorization || '') });
        if (prompt.includes('E2E BYD 信用报告') || prompt.includes('Task: 路由新话题：安排读书计划')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          const text = prompt.includes('Task: 帮我列出来具体有哪些信息渠道查询了，哪些没有查询')
            ? '渠道清单：A 已核验；B 尚未查询。沿用比亚迪报告，没有重跑调研。'
            : prompt.includes('Task: 只总结这份报告') ? '已在原比亚迪任务内补充摘要。' : '比亚迪报告已完成：来源 A 已核验，来源 B 尚未查询。';
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'done', message: text }) } }] }));
          return;
        }
        const hasReply = prompt.includes('User reply: Use Friday.');
        const isRecurringCheck = prompt.includes('E2E recurring run — verify due work reruns automatically');
        const isAutomationIdeas = prompt.includes('E2E automation ideas — ten ideas only');
        const isMemoryCheck = prompt.includes('E2E memory prompt — apply the saved workspace preference');
        const isDotMemoryCapture = prompt.includes('E2E dot memory capture — remember this durable preference');
        const isDotMemoryUpdate = prompt.includes('E2E dot memory update — use and refine the private preference');
        const isPageRequest = prompt.includes('E2E Scratchpad page — create the team launch notes');
        const isPageUpdate = prompt.includes('E2E Scratchpad page — update the team launch notes');
        const isPauseTask = prompt.includes('E2E pause task — abort work and resume it');
        const isVoiceTask = prompt.includes('E2E voice request — finish after the call ends');
        const isVoiceResponse = prompt.includes('E2E voice response — speak actual task result');
        const isMobileVoiceRequest = prompt.includes('帮我准备明天的会议资料');
        const isMobileVoiceReply = isMobileVoiceRequest && prompt.includes('User reply:');
        const isVolcVoiceResponse = prompt.includes('请用中文整理本周人工智能产品更新的三个要点');
        const isSeedDuplexClarification = prompt.includes('请用云电脑打开网页并告诉我标题。') && !prompt.includes('User reply:');
        const isSeedDuplexClarificationReply = prompt.includes('User reply: 请打开 https://example.com/。');
        const isStopTask = prompt.includes('E2E stop task — stop while the model is still working');
        const isParallelTask = prompt.includes('E2E parallel work —');
        const isDelegationPlan = prompt.includes('E2E delegation goal — build a launch packet') && !prompt.includes('Delegated task results:');
        const isDelegationAggregate = prompt.includes('E2E delegation goal — build a launch packet') && prompt.includes('Delegated task results:');
        const isSharedModelTask = prompt.includes('E2E shared model call from Beta account');
        const isSecretResilienceTask = prompt.includes('E2E transient K3D outage — use the cached shared model credential');
        const isDingTalkAlertTask = prompt.includes('这是一条由已授权的钉钉监控群事件自动触发');
        const delegatedChild = ['Market scan', 'Competitor scan', 'Launch risks'].find(title => prompt.includes(`E2E delegated child — ${title.toLowerCase()}`));
        if (isPauseTask && !pauseModelHeld) {
          pauseModelHeld = true;
          heldPauseModelAborted = false;
          response.once('close', () => { heldPauseModelAborted = true; });
          await new Promise<void>(resolvePromise => { heldPauseModelRelease = resolvePromise; });
          heldPauseModelRelease = null;
        }
        if (isStopTask) {
          heldStopModelAborted = false;
          response.once('close', () => { heldStopModelAborted = true; });
          await new Promise<void>(resolvePromise => { heldStopModelRelease = resolvePromise; });
          heldStopModelRelease = null;
        }
        if (isVoiceTask && !voiceModelHeld) {
          voiceModelHeld = true;
          await new Promise<void>(resolvePromise => { heldVoiceModelRelease = resolvePromise; });
          heldVoiceModelRelease = null;
        }
        if (isMobileVoiceReply && !mobileVoiceModelHeld) {
          mobileVoiceModelHeld = true;
          await new Promise<void>(resolvePromise => { heldMobileVoiceModelRelease = resolvePromise; });
          heldMobileVoiceModelRelease = null;
        }
        if (isParallelTask) await new Promise<void>(resolvePromise => parallelModelReleases.push(resolvePromise));
        if (delegatedChild) {
          delegatedModelPrompts.push(prompt);
          response.once('close', () => { if (!response.writableFinished) delegatedModelAborted.add(delegatedChild); });
          await new Promise<void>(resolvePromise => delegatedModelReleases.set(delegatedChild, resolvePromise));
          delegatedModelReleases.delete(delegatedChild);
        }
        const isAskBeforeScratchpad = prompt.includes('the app will wait for approval');
        const isComplete = hasReply || isRecurringCheck || isAutomationIdeas || isMemoryCheck || isDotMemoryCapture || isDotMemoryUpdate || isPageRequest || isPageUpdate || isPauseTask || isStopTask || isVoiceTask || isVoiceResponse || isVolcVoiceResponse || isSeedDuplexClarificationReply || isMobileVoiceReply || isParallelTask || Boolean(delegatedChild) || isDelegationAggregate || isSharedModelTask || isSecretResilienceTask || isDingTalkAlertTask;
        const pageId = isPageUpdate ? prompt.match(/ID: ([a-f0-9-]{36})\nTitle: Team launch notes\n/)?.[1] : undefined;
        const dotMemoryId = isDotMemoryUpdate ? prompt.match(/ID: ([a-f0-9-]{36})\nNote: Alpha prefers concise Mandarin updates\./)?.[1] : undefined;
        const memoryAction = isDotMemoryCapture ? { action: 'save', note: 'Alpha prefers concise Mandarin updates.' } : isDotMemoryUpdate ? { action: 'update', memoryId: dotMemoryId, note: 'Alpha prefers concise Chinese updates.' } : undefined;
        const dingTalkAlertResult = '已收到这条告警并完成当前可用范围内的只读检查。当前尚未接入日志平台、GitHub 仓库或测试环境，因此没有查询 Trace、修改代码或创建 PR；需要配置对应连接后才能继续自动排障。';
        const decision = isDelegationPlan ? { status: 'delegating', message: 'I split the launch packet into three independent research tasks.', delegations: [
          { title: 'Market scan', instruction: 'E2E delegated child — market scan', engine: 'model' },
          { title: 'Competitor scan', instruction: 'E2E delegated child — competitor scan' },
          { title: 'Launch risks', instruction: 'E2E delegated child — launch risks', engine: 'model' },
        ] } : { status: isSeedDuplexClarification ? 'waiting' : isComplete ? 'done' : 'waiting', message: isSharedModelTask ? '共享模型 API 已在第二个 Google 账号中成功调用。' : isSecretResilienceTask ? 'K3D Secret 暂时不可读，但任务使用进程缓存的共享模型凭据完成。' : isDelegationAggregate ? 'Completed launch packet from the delegated research.' : delegatedChild ? `${delegatedChild} completed with verified findings.` : isSeedDuplexClarificationReply ? '网页标题是「Example Domain」。' : isSeedDuplexClarification ? '请告诉我你要打开的网址。' : hasReply ? 'The launch plan now uses Friday.' : isRecurringCheck ? 'The recurring check completed.' : isAutomationIdeas ? '1. Morning operator brief\n2. Open-loop roundup\n3. Meeting prep on autopilot\n4. Meeting-to-action cleanup\n5. Cohort session readiness\n6. Content repurposing queue\n7. Practical AI news filter\n8. Creative quality checks\n9. Weekly business pulse\n10. Admin and renewal radar\n\nThese are ideas, not activated routines. We would choose sources, timing, and review requirements before setting them up.' : isMemoryCheck ? 'The saved workspace preference was applied.' : isDotMemoryCapture ? '我会记住你偏好简洁的中文回复。' : isDotMemoryUpdate ? '我已根据你的偏好更新私人记忆。' : isStopTask ? 'This stopped task returned a late result.' : isPauseTask ? 'The paused task completed after resume.' : isVoiceTask ? 'Voice request finished after the call ends.' : isVoiceResponse ? 'Voice response returned from the model.' : isVolcVoiceResponse ? '已完成：本周公开资料中有三项值得关注的人工智能产品更新，分别涉及模型能力、Agent 工作流和语音交互。' : isParallelTask ? 'Parallel task complete.' : isDingTalkAlertTask ? dingTalkAlertResult : isPageRequest ? isAskBeforeScratchpad ? 'The page draft is ready for review.' : 'I created the team launch notes.' : isPageUpdate ? isAskBeforeScratchpad ? 'The proposed page update is ready for review.' : 'I updated the team launch notes.' : 'What launch date should I use?', ...(isPageRequest ? { pageAction: { action: 'create', title: 'Team launch notes', content: '# Launch outline\n- Review the short intro\n- Confirm the release date' } } : isPageUpdate ? { pageAction: { action: 'update', pageId, title: 'Team launch notes', content: '## Revised outline\n- Approve the short intro\n- Confirm the release date' } } : {}), ...(memoryAction ? { memoryAction } : {}) };
        if (isMobileVoiceRequest) {
          decision.status = isMobileVoiceReply ? 'done' : 'waiting';
          decision.message = isMobileVoiceReply
            ? '好的，我会把产品进展、风险和待决策事项整理成会前资料。'
            : '你希望会前资料重点覆盖哪些主题？';
        }
        const content = JSON.stringify(decision);
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Invalid test model request' }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => mockModelServer!.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = mockModelServer.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function startMockSlackProvider() {
  mockSlackCodeExchanges = 0;
  mockSlackServer = createHttpServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/oauth/v2/authorize') {
      const callback = new URL(url.searchParams.get('redirect_uri') || 'http://invalid/');
      if (url.searchParams.get('client_id') !== 'coke-dots-slack-e2e-client' || url.searchParams.get('scope') !== 'chat:write' || callback.origin !== baseUrl || callback.pathname !== '/auth/slack/callback' || !url.searchParams.get('state')) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Invalid Slack OAuth request');
        return;
      }
      const approve = new URLSearchParams({ redirect_uri: callback.toString(), state: url.searchParams.get('state') || '' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><html><head><title>Slack authorization</title></head><body><main><h1>Authorize Coke Dots for ASPI</h1><p>Permission requested: chat:write</p><form method="get" action="/oauth/approve"><input type="hidden" name="redirect_uri" value="${approve.get('redirect_uri')}"><input type="hidden" name="state" value="${approve.get('state')}"><button type="submit">Allow access</button></form></main></body></html>`);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/oauth/approve') {
      const callback = new URL(url.searchParams.get('redirect_uri') || 'http://invalid/');
      const state = url.searchParams.get('state') || '';
      if (callback.origin !== baseUrl || callback.pathname !== '/auth/slack/callback' || !state) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Invalid Slack OAuth approval');
        return;
      }
      callback.searchParams.set('code', 'coke-dots-e2e-authorization-code');
      callback.searchParams.set('state', state);
      response.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/oauth.v2.access') {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = new URLSearchParams(raw);
        if (body.get('code') !== 'coke-dots-e2e-authorization-code' || body.get('client_id') !== 'coke-dots-slack-e2e-client' || body.get('client_secret') !== 'coke-dots-slack-e2e-secret' || body.get('redirect_uri') !== `${baseUrl}/auth/slack/callback`) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error: 'invalid_e2e_oauth_exchange' }));
          return;
        }
        mockSlackCodeExchanges += 1;
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, access_token: 'xoxb-coke-dots-e2e-only-token', scope: 'chat:write', team: { id: 'TASPIE2E', name: 'ASPI' } }));
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
  await new Promise<void>((resolvePromise, reject) => mockSlackServer!.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = mockSlackServer.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function startMockQwenSignaling() {
  if (mockQwenSignalingServer) await new Promise<void>(resolvePromise => mockQwenSignalingServer!.close(() => resolvePromise()));
  mockQwenSignalingRequests = [];
  mockQwenSignalingServer = createHttpServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      mockQwenSignalingRequests.push({ authorization: request.headers.authorization || '', contentType: request.headers['content-type'] || '', sdp: raw });
      if (request.method !== 'POST' || request.url !== '/realtime?model=qwen3.8-omni-flash-realtime' || request.headers.authorization !== 'Bearer e2e-qwen-secret' || request.headers['content-type'] !== 'application/sdp' || !raw.startsWith('v=0')) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('Invalid mock Qwen request');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/sdp' });
      response.end(['v=0', 'o=- 2 2 IN IP4 127.0.0.1', 's=-', 't=0 0', ''].join(String.fromCharCode(13, 10)));
    });
  });
  await new Promise<void>((resolvePromise, reject) => mockQwenSignalingServer!.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = mockQwenSignalingServer.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/realtime?model=qwen3.8-omni-flash-realtime`;
}

function encodeVolcServerFrame(eventId: number, payload: unknown, sessionId?: string, audio = false) {
  const body = audio ? Buffer.from(payload as Uint8Array) : Buffer.from(JSON.stringify(payload), 'utf8');
  const id = sessionId === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0, Buffer.byteLength(sessionId)]), Buffer.from(sessionId, 'utf8')]);
  const header = Buffer.from([0x11, ((audio ? 11 : 9) << 4) | 4, audio ? 0 : 0x10, 0]);
  const event = Buffer.alloc(4); event.writeUInt32BE(eventId);
  const payloadLength = Buffer.alloc(4); payloadLength.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, event, id, payloadLength, body]);
}

async function startMockVolcEngineProvider() {
  mockVolcEngineConnections = [];
  mockVolcEngineServer = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 1024 * 1024, perMessageDeflate: false });
  mockVolcEngineServer.on('connection', (socket, request) => {
    const connection = {
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value || '')])),
      events: [] as number[], serverEvents: [] as number[], timeline: [] as string[], pcmBytes: 0, spokenTexts: [] as string[],
    };
    mockVolcEngineConnections.push(connection);
    let activeSessionId = '';
    let sentSpeech = false;
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) return;
      const frame = decodeVolcengineFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      if (frame.eventId === null) return;
      connection.events.push(frame.eventId);
      connection.timeline.push(`client:${frame.eventId}`);
      let payload: Record<string, unknown> = {};
      if (frame.payloadIsJson) {
        try { payload = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>; } catch { /* malformed client JSON is visible in the assertion set */ }
      }
      if (frame.eventId === 1) {
        socket.send(encodeVolcServerFrame(50, {}, frame.sessionId || undefined));
      } else if (frame.eventId === 100) {
        activeSessionId = frame.sessionId || '';
        socket.send(encodeVolcServerFrame(150, { dialog_id: 'mock-volc-dialog' }, activeSessionId));
      } else if (frame.eventId === 200) {
        connection.pcmBytes += frame.payload.byteLength;
        if (!sentSpeech && activeSessionId) {
          sentSpeech = true;
          socket.send(encodeVolcServerFrame(450, { question_id: 'volc-question-e2e-0001' }, activeSessionId));
          socket.send(encodeVolcServerFrame(451, { results: [{ text: '请用中文整理本周人工智能产品更新的三个要点，并说明来源。', is_interim: false }] }, activeSessionId));
          socket.send(encodeVolcServerFrame(459, {}, activeSessionId));
        }
      } else if (frame.eventId === 500) {
        connection.spokenTexts.push(String(payload.content || ''));
        socket.send(encodeVolcServerFrame(350, { tts_type: 'chat_tts_text', text: payload.content || '' }, activeSessionId));
        socket.send(encodeVolcServerFrame(352, Buffer.alloc(960, 1), activeSessionId, true));
        socket.send(encodeVolcServerFrame(359, {}, activeSessionId));
      } else if (frame.eventId === 102) {
        connection.serverEvents.push(152);
        connection.timeline.push('server:152');
        socket.send(encodeVolcServerFrame(152, {}, activeSessionId));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    mockVolcEngineServer!.once('error', reject);
    mockVolcEngineServer!.once('listening', resolvePromise);
  });
  const address = mockVolcEngineServer.address();
  assert(address && typeof address !== 'string');
  return `ws://127.0.0.1:${address.port}/realtime`;
}

async function startMockVolcEngineDuplexProvider() {
  mockVolcEngineDuplexConnections = [];
  mockVolcEngineDuplexServer = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 1024 * 1024, perMessageDeflate: false });
  mockVolcEngineDuplexServer.on('connection', (socket, request) => {
    const initialTranscript = mockVolcEngineDuplexNextInitialTranscript;
    mockVolcEngineDuplexNextInitialTranscript = '请用中文整理本周人工智能产品更新的三个要点，并说明来源。';
    const connection = {
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value || '')])),
      events: [] as string[], timeline: [] as string[], pcmBytes: 0, pcmPeak: 0, nonSilentPcmSamples: 0, spokenTexts: [] as string[], audioDeltas: 0,
      sendTranscript: (transcript: string, turnId: string) => {
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.started', item_id: turnId }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: turnId, delta: transcript.slice(0, Math.max(1, Math.floor(transcript.length / 2))) }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: turnId, delta: transcript }));
        // SeedDuplex can repeat the same cumulative snapshot and omit text on
        // completed. The gateway must retain one final transcript, not append it.
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: turnId, delta: transcript }));
        socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: turnId }));
      },
    };
    mockVolcEngineDuplexConnections.push(connection);
    let sentTranscript = false;
    socket.on('message', (raw, isBinary) => {
      if (isBinary) { connection.timeline.push('unexpected-binary-client-frame'); return; }
      let event: Record<string, unknown>;
      try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) as Record<string, unknown>; }
      catch { connection.timeline.push('invalid-json-client-frame'); return; }
      const type = typeof event.type === 'string' ? event.type : 'missing-type';
      connection.events.push(type);
      connection.timeline.push(`client:${type}`);
      if (type === 'session.create') {
        socket.send(JSON.stringify({ type: 'session.created', event_id: 'mock-session-created', session: { id: 'mock-seedduplex-session' } }));
      } else if (type === 'input_audio_buffer.append') {
        if (typeof event.audio === 'string') {
          const pcm = Buffer.from(event.audio, 'base64');
          connection.pcmBytes += pcm.byteLength;
          for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
            const sample = pcm.readInt16LE(offset);
            connection.pcmPeak = Math.max(connection.pcmPeak, Math.abs(sample));
            if (sample !== 0) connection.nonSilentPcmSamples += 1;
          }
        }
        if (!sentTranscript) {
          sentTranscript = true;
          connection.sendTranscript(initialTranscript, 'duplex-e2e-turn-0001');
        }
      } else if (type === 'input_audio_mute.commit' || type === 'input_audio_unmute.commit') {
        connection.timeline.push(`mute-control:${type}`);
      } else if (type === 'speech_text_buffer.commit') {
        if (typeof event.text === 'string') connection.spokenTexts.push(event.text);
        socket.send(JSON.stringify({ type: 'response.output_audio.started', response_id: 'mock-response' }));
        const pcm = Buffer.alloc(960);
        for (let index = 0; index < pcm.length / 4; index += 1) pcm.writeFloatLE(Math.sin(index * 2 * Math.PI * 440 / 24000) * 0.5, index * 4);
        socket.send(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'mock-response', delta: pcm.toString('base64') }));
        socket.send(JSON.stringify({ type: 'response.output_audio.done', response_id: 'mock-response' }));
        connection.audioDeltas += 1;
      } else if (type === 'session.close') {
        connection.timeline.push('server:session.closed');
        socket.send(JSON.stringify({ type: 'session.closed', event_id: 'mock-session-closed' }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    mockVolcEngineDuplexServer!.once('error', reject);
    mockVolcEngineDuplexServer!.once('listening', resolvePromise);
  });
  const address = mockVolcEngineDuplexServer.address();
  assert(address && typeof address !== 'string');
  return `ws://127.0.0.1:${address.port}/duplex`;
}

async function startMockVolcEngineEntitlementRejection() {
  mockVolcEngineRejectedServer = createHttpServer();
  mockVolcEngineRejectedServer.on('upgrade', (_request, socket) => {
    const body = JSON.stringify({ error: { code: 45000030, message: 'requested resource not granted [resource_id=volc.speech.dialog]' } });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\nConnection: close\r\n\r\n' + body);
  });
  await new Promise<void>((resolvePromise, reject) => mockVolcEngineRejectedServer!.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = mockVolcEngineRejectedServer.address();
  assert(address && typeof address !== 'string');
  return 'ws://127.0.0.1:' + address.port + '/duplex';
}

async function websocketUpgradeStatus(url: string, cookie: string) {
  return await new Promise<number>(resolvePromise => {
    const origin = new URL(url).origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const socket = new NodeWebSocket(url, { headers: { cookie, origin }, handshakeTimeout: 5000 });
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode || 0;
      response.resume();
      resolvePromise(status);
    });
    socket.once('open', () => { socket.close(); resolvePromise(101); });
    socket.once('error', () => resolvePromise(0));
  });
}

function captureServerOutput(child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    const line = String(chunk);
    serverLogs.push(line);
    if (serverLogs.length > 500) serverLogs.splice(0, serverLogs.length - 500);
  });
}

async function startServer(port: number, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTS_E2E_AUTH: '1',
      DOTS_ENV_FILE: emptyEnvFile,
      DOTS_DATA_DIR: testDataDir,
      DOTS_PORT: String(port),
      DOTS_CHROME_BIN: chromePath,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      DOTS_MODEL_BASE_URL: '',
      DOTS_MODEL_API_KEY: '',
      DOTS_MODEL: '',
      DOTS_PI_ENABLED: '0',
      DOTS_DSH_BIN: '',
      DOTS_KEYCHAIN_SERVICE: 'com.cokepoppy.coke-dots.e2e',
      DOTS_TEST_MODEL_SECRET_DIR: testModelSecretDirectory,
      DOTS_TEST_MODEL_SECRET_SCOPE: 'ui-e2e-shared-instance',
      DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE: sharedModelSecretUnavailableFile,
      DOTS_TEST_KEYRING_DIR: testKeyringDirectory,
      SLACK_CLIENT_ID: 'coke-dots-slack-e2e-client',
      SLACK_CLIENT_SECRET: 'coke-dots-slack-e2e-secret',
      SLACK_REDIRECT_URI: `${baseUrl}/auth/slack/callback`,
      DOTS_E2E_SLACK_PROVIDER_URL: mockSlackProviderOrigin,
      DOTS_E2E_DINGTALK: '1',
      DOTS_VOICE_PROVIDER: '',
      DOTS_QWEN_API_KEY: '',
      DOTS_QWEN_WORKSPACE_ID: '',
      DOTS_QWEN_REGION: '',
      DASHSCOPE_API_KEY: '',
      DOTS_VOLCENGINE_API_KEY: '',
      DOTS_VOLCENGINE_APP_ID: '',
      DOTS_VOLCENGINE_ACCESS_TOKEN: '',
      DOTS_VOLCENGINE_RESOURCE_ID: '',
      DOTS_E2E_VOLCENGINE_WS_URL: '',
      DOTS_E2E_VOLCENGINE_DUPLEX_WS_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  captureServerOutput(child);
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Coke Dots test service exited early (${child.exitCode}).\n${serverLogs.join('')}`);
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return child;
    } catch { /* Wait for the loopback listener. */ }
    await delay(150);
  }
  child.kill('SIGTERM');
  throw new Error(`Coke Dots test service did not become healthy.\n${serverLogs.join('')}`);
}

async function stopServer(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function delay(milliseconds: number) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 3_000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for browser task state');
    await delay(20);
  }
}

function releaseHeldStopModel() {
  const release = heldStopModelRelease as (() => void) | null;
  if (release) release();
  heldStopModelRelease = null;
}

function releaseHeldPauseModel() {
  const release = heldPauseModelRelease as (() => void) | null;
  if (release) release();
  heldPauseModelRelease = null;
}

function releaseHeldVoiceModel() {
  const release = heldVoiceModelRelease;
  if (release) release();
  heldVoiceModelRelease = null;
}

function releaseParallelModels() {
  for (const release of parallelModelReleases.splice(0)) release();
}

async function recordStep(name: string, action: () => Promise<void>) {
  await action();
  steps.push({ name, result: 'passed' });
  console.log(`PASS ${name}`);
}

async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const path = join(screenshotsDir, `${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  screenshotNames.push(`screenshots/${name}.png`);
}

function browserVoiceMockScript() {
  return [
    '(() => {',
    '  class FakeSpeechRecognition {',
    '    constructor() { this.onresult = null; this.onerror = null; this.onend = null; }',
    '    start() { window.__dotsRecognitionStarts += 1; window.__dotsVoiceEvents.push("listening"); window.__dotsFakeRecognition = this; }',
    '    abort() {}',
    '    emitResults(texts, resultIndex = 0) { const results = texts.map(text => Object.assign([{ transcript: text }], { isFinal: true })); const event = Object.assign(new Event("result"), { resultIndex, results }); this.onresult?.(event); }',
    '    emit(text) { this.emitResults([text]); this.onend?.(); }',
    '    emitRepeated(text) { this.emitResults([text]); this.emitResults([text]); this.onend?.(); }',
    '  }',
    '  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeSpeechRecognition });',
    '  Object.defineProperty(window, "__dotsSpeechOutput", { configurable: true, value: [] });',
    '  Object.defineProperty(window, "__dotsVoiceEvents", { configurable: true, value: [] });',
    '  Object.defineProperty(window, "__dotsRecognitionStarts", { configurable: true, value: 0, writable: true });',
    '  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { cancel() {}, speak(utterance) { window.__dotsSpeechOutput.push(utterance.text); window.__dotsVoiceEvents.push("spoken:" + utterance.text); window.setTimeout(() => utterance.onend?.(), 0); } } });',
    '  Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: class { constructor(text) { this.text = text; } } });',
    '})()',
  ].join('\n');
}

async function waitForComputerScreenshot(page: Page) {
  const screenshot = await page.waitForFunction(() => {
    const screenshot = document.querySelector<HTMLImageElement>('img[alt="独立浏览器画面"]');
    if (!screenshot?.complete || screenshot.naturalWidth <= 0 || screenshot.naturalHeight <= 0) return false;
    const bounds = screenshot.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    return { naturalWidth: screenshot.naturalWidth, naturalHeight: screenshot.naturalHeight, src: screenshot.currentSrc };
  }, null, { timeout: 20_000 });
  const frame = await screenshot.jsonValue() as { naturalWidth: number; naturalHeight: number; src: string };
  await screenshot.dispose();
  return frame;
}

async function clickComputerScreen(page: Page, x: number, y: number) {
  const image = page.getByAltText('独立浏览器画面');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await waitForComputerScreenshot(page);
    const measurements = await image.evaluate(element => {
      const box = element.getBoundingClientRect();
      const screenshot = element as HTMLImageElement;
      return { left: box.left, top: box.top, width: box.width, height: box.height, naturalWidth: screenshot.naturalWidth, naturalHeight: screenshot.naturalHeight };
    });
    if (measurements.width > 0 && measurements.height > 0 && measurements.naturalWidth > 0 && measurements.naturalHeight > 0) {
      const scale = Math.min(measurements.width / measurements.naturalWidth, measurements.height / measurements.naturalHeight);
      const offsetX = (measurements.width - measurements.naturalWidth * scale) / 2;
      const offsetY = (measurements.height - measurements.naturalHeight * scale) / 2;
      await page.mouse.click(measurements.left + offsetX + x * scale, measurements.top + offsetY + y * scale);
      return;
    }
    await page.waitForTimeout(100);
  }
  assert.fail('Computer screenshot stayed unmeasurable during its periodic refresh');
}

async function clickNav(page: Page, label: string) {
  const target = page.getByRole('button', { name: label, exact: true }).first();
  if (label === '你的 dot' && !(await target.isVisible())) await page.getByRole('button', { name: '新聊天', exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).first().click();
}

async function openProfile(page: Page) {
  const profileShortcut = page.getByRole('button', { name: '你的 dot 设置', exact: true });
  if (await profileShortcut.isVisible()) {
    await profileShortcut.click();
    return;
  }
  const mobileMenu = page.getByTestId('mobile-chat-menu-toggle');
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
    await page.getByRole('button', { name: '账户与 Dot 设置', exact: true }).click();
    return;
  }
  assert.fail('The Dot profile must be reachable from desktop navigation or the mobile menu');
}

async function taskNavigationItem(page: Page, title: string) {
  const item = page.locator('.task-links button').filter({ hasText: title }).first();
  if (!(await item.isVisible())) {
    const newChat = page.getByRole('button', { name: '新聊天', exact: true });
    if (await newChat.isVisible()) await newChat.click();
  }
  return page.locator('.task-links button').filter({ hasText: title }).first();
}

async function signIn(page: Page, email: string) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#e2e-email').fill(email);
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByTestId('e2e-sign-in').click();
  await navigation;
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
  const profileEmail = page.locator('.profile-link small').filter({ hasText: email });
  if (await profileEmail.isVisible()) return;
  const mobileDotNav = page.getByTestId('mobile-dot-nav');
  if (await mobileDotNav.isVisible()) {
    await mobileDotNav.click();
    await page.getByTestId('mobile-chat-menu-toggle').click();
    const mobileNavigation = page.getByTestId('mobile-navigation');
    await mobileNavigation.locator('.mobile-navigation-account small').filter({ hasText: email }).waitFor({ state: 'visible' });
    await mobileNavigation.locator('.mobile-navigation-panel').getByRole('button', { name: '关闭导航菜单' }).click();
    return;
  }
  await profileEmail.waitFor({ state: 'visible' });
}

async function createTask(page: Page, instruction: string, scheduled = false) {
  if (scheduled) {
    await page.getByLabel('定期检查').check();
    await page.getByLabel('重复频率').selectOption('interval');
    await page.locator('input.minutes').fill('60');
  }
  await page.getByTestId('task-composer').fill(instruction);
  const submitted = page.waitForResponse(response => (response.url().endsWith('/api/tasks') || response.url().endsWith('/api/chat/messages')) && response.request().method() === 'POST');
  const explicitNew = page.getByRole('button', { name: '作为新任务发送', exact: true });
  if (!scheduled && await explicitNew.count()) await explicitNew.click();
  else await page.locator('button.send').click();
  const body = await (await submitted).json() as { id?: string; task?: { id: string } };
  const task = body.task || { id: body.id! };
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-testid=task-composer]')?.value === '');
  await page.locator('.timeline .message.user p').filter({ hasText: instruction }).waitFor({ state: 'visible', timeout: 10_000 });
  const inlineTask = page.getByTestId(`task-progress-${task.id}`);
  await inlineTask.waitFor({ state: 'visible' });
  const openDetails = inlineTask.getByRole('button', { name: '任务详情 →' });
  if (await openDetails.count()) await openDetails.click();
  await page.locator('.timeline .task-controls').waitFor({ state: 'visible' });
  if (scheduled) await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.schedule-toggle input[type="checkbox"]')?.checked === false);
}

async function selectTenant(page: Page, text: string) {
  const option = page.locator('.workspace-switcher option').filter({ hasText: text }).first();
  await option.waitFor({ state: 'attached', timeout: 10_000 });
  const value = await option.getAttribute('value');
  assert(value, `Workspace option containing "${text}" has no value`);
  const activeTenantId = await page.getByTestId('app-shell').getAttribute('data-tenant-id');
  if (activeTenantId === value) {
    await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
    return;
  }
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/tenant') && response.request().method() === 'POST');
  await page.locator('.workspace-switcher select').selectOption(value);
  const response = await responsePromise;
  assert(response.ok(), `Workspace switch returned HTTP ${response.status()}`);
  const data = await response.json() as { tenant: { id: string } };
  await page.waitForFunction(tenantId => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-tenant-id') === tenantId, data.tenant.id);
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
}

async function assertNoVisibleText(page: Page, text: string) {
  assert.equal(await page.getByText(text, { exact: true }).count(), 0, `Unexpected tenant data visible: ${text}`);
}

async function restartService() {
  await stopServer(server);
  server = await startServer(e2ePort);
}

// Shared accessors preserve the mutable fixture across the original sequential scenarios.
const scenarioContext = {
  alphaPrivateTask: 'E2E alpha private goal — inventory the project risks',
  scheduledTask: 'E2E scheduled responsibility — report on the next review',
  get alphaPage(): Page | null { return alphaPage; },
  get baseUrl(): string { return baseUrl; },
  screenshot,
  signIn,
  clickNav,
  openProfile,
  createTask,
  get mockSlackProviderOrigin(): string { return mockSlackProviderOrigin; },
  get e2eSlackTokenAccount(): string { return e2eSlackTokenAccount; },
  set e2eSlackTokenAccount(value: string) { e2eSlackTokenAccount = value; },
  get testDataDir(): string { return testDataDir; },
  get mockSlackCodeExchanges(): number { return mockSlackCodeExchanges; },
  get betaPage(): Page | null { return betaPage; },
  assertNoVisibleText,
  get testModelBaseUrl(): string { return testModelBaseUrl; },
  get testModelName(): string { return testModelName; },
  get testModelApiKey(): string { return testModelApiKey; },
  get mockModelRequests(): { prompt: string; authorization: string }[] { return mockModelRequests; },
  waitFor,
  get sharedModelSecretUnavailableFile(): string { return sharedModelSecretUnavailableFile; },
  taskNavigationItem,
  selectTenant,
  get gammaPage(): Page | null { return gammaPage; },
  restartService,
  get mockModelPrompts(): string[] { return mockModelPrompts; },
  browserVoiceMockScript,
  get screenshotsDir(): string { return screenshotsDir; },
  get screenshotNames(): string[] { return screenshotNames; },
  delay,
  get heldVoiceModelRelease(): (() => void) | null { return heldVoiceModelRelease; },
  releaseHeldVoiceModel,
  get mobileContext(): BrowserContext | null { return mobileContext; },
  set mobileContext(value: BrowserContext | null) { mobileContext = value; },
  get browser(): Browser | null { return browser; },
  get mobilePage(): Page | null { return mobilePage; },
  set mobilePage(value: Page | null) { mobilePage = value; },
  get pageErrors(): string[] { return pageErrors; },
  get heldMobileVoiceModelRelease(): (() => void) | null { return heldMobileVoiceModelRelease; },
  get heldPauseModelAborted(): boolean { return heldPauseModelAborted; },
  releaseHeldPauseModel,
  get heldStopModelAborted(): boolean { return heldStopModelAborted; },
  releaseHeldStopModel,
  releaseParallelModels,
  get delegatedModelPrompts(): string[] { return delegatedModelPrompts; },
  get delegatedModelAborted(): Set<string> { return delegatedModelAborted; },
  get delegatedModelReleases(): Map<string, () => void> { return delegatedModelReleases; },
  waitForComputerScreenshot,
  clickComputerScreen,
  get mockQwenSignalingUrl(): string { return mockQwenSignalingUrl; },
  set mockQwenSignalingUrl(value: string) { mockQwenSignalingUrl = value; },
  startMockQwenSignaling,
  stopServer,
  get server(): ChildProcess | null { return server; },
  set server(value: ChildProcess | null) { server = value; },
  startServer,
  get e2ePort(): number { return e2ePort; },
  get mockQwenSignalingRequests(): { authorization: string; contentType: string; sdp: string }[] { return mockQwenSignalingRequests; },
  get mockVolcEngineUrl(): string { return mockVolcEngineUrl; },
  set mockVolcEngineUrl(value: string) { mockVolcEngineUrl = value; },
  startMockVolcEngineProvider,
  get alphaContext(): BrowserContext | null { return alphaContext; },
  get mockVolcEngineConnections(): { headers: Record<string, string>; events: number[]; serverEvents: number[]; timeline: string[]; pcmBytes: number; spokenTexts: string[] }[] { return mockVolcEngineConnections; },
  get betaContext(): BrowserContext | null { return betaContext; },
  websocketUpgradeStatus,
  startMockVolcEngineEntitlementRejection,
  get mockVolcEngineRejectedServer(): Server | null { return mockVolcEngineRejectedServer; },
  set mockVolcEngineRejectedServer(value: Server | null) { mockVolcEngineRejectedServer = value; },
  get mockVolcEngineDuplexUrl(): string { return mockVolcEngineDuplexUrl; },
  set mockVolcEngineDuplexUrl(value: string) { mockVolcEngineDuplexUrl = value; },
  startMockVolcEngineDuplexProvider,
  get mockVolcEngineDuplexConnections(): { headers: Record<string, string>; events: string[]; timeline: string[]; pcmBytes: number; pcmPeak: number; nonSilentPcmSamples: number; spokenTexts: string[]; audioDeltas: number; sendTranscript: (transcript: string, turnId: string) => void }[] { return mockVolcEngineDuplexConnections; },
  get mockVolcEngineDuplexNextInitialTranscript(): string { return mockVolcEngineDuplexNextInitialTranscript; },
  set mockVolcEngineDuplexNextInitialTranscript(value: string) { mockVolcEngineDuplexNextInitialTranscript = value; },
};
export type UiScenarioContext = typeof scenarioContext;

try {
  e2ePort = await reservePort();
  baseUrl = `http://127.0.0.1:${e2ePort}`;
  testModelBaseUrl = await startMockModel();
  testModelApiKey = 'e2e-shared-model-key';
  testModelName = 'e2e-shared-model';
  mockSlackProviderOrigin = await startMockSlackProvider();
  server = await startServer(e2ePort);
  browser = await chromium.launch({ executablePath: chromePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  alphaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } });
  betaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } });
  gammaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } });
  await alphaContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await betaContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await gammaContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  alphaPage = await alphaContext.newPage();
  betaPage = await betaContext.newPage();
  gammaPage = await gammaContext.newPage();
  alphaPage.on('pageerror', error => pageErrors.push(`alpha: ${error.message}`));
  betaPage.on('pageerror', error => pageErrors.push(`beta: ${error.message}`));
  gammaPage.on('pageerror', error => pageErrors.push(`gamma: ${error.message}`));

  await recordStep('Unauthenticated page and E2E-only sign-in control render', () => signedOutControls(scenarioContext));

  await recordStep('Google-style tenant Alpha signs in through the rendered page', () => signInAlpha(scenarioContext));

  await recordStep('Authenticated chat events disable proxy buffering and deliver a snapshot without closing the stream', () => authenticatedEventStream(scenarioContext));

  await recordStep('Only the supported model, Pi, and DeepSeek Harness choices are selectable', () => supportedEngines(scenarioContext));

  await recordStep('Switch between light and dark themes and restore the account preference after reload', () => themePreference(scenarioContext));

  await recordStep('Choose Dot computer access and continue into the evidence-matched first-run conversation', () => firstRunConversation(scenarioContext));

  await recordStep('Customize the Dot appearance in both themes and restore it from tenant storage', () => customizeAppearance(scenarioContext));

  await recordStep('Dictate into the composer, edit the transcript, then explicitly send it', () => dictateAndSend(scenarioContext));

  await recordStep('Create a persistent task and inspect its visible execution state', () => persistentTask(scenarioContext));

  await recordStep('Connect Slack in Chrome, authorize the mock workspace, and select it for the Alpha tenant', () => slackAuthorization(scenarioContext));

  await recordStep('Connect the DingTalk account, search a group, and save a scoped selection', () => dingtalkGroups(scenarioContext));

  await recordStep('Dot computer shortcut opens the tenant-isolated browser workspace', () => computerShortcut(scenarioContext));

  await recordStep('A second Google-style account is isolated before workspace invitation', () => personalIsolation(scenarioContext));

  await recordStep('Activity shows the task and supports priority and direction changes', () => activityControls(scenarioContext));

  await recordStep('Scheduled view exposes a recurring task and its cancellation control', () => scheduleControls(scenarioContext));

  await recordStep('Alpha configures one shared Model API and Beta can read but cannot edit it', () => sharedModelPermissions(scenarioContext));

  await recordStep('Chat routes a BYD follow-up, preserves its history and resolves ambiguity', () => chatTaskRouting(scenarioContext));

  await recordStep('A monitored DingTalk alert starts one isolated background task and ignores delivery retries', () => dingtalkAlerts(scenarioContext));

  await recordStep('Chrome completes an Alpha task during a transient K3D Secret read outage', () => transientSecretOutage(scenarioContext));

  await recordStep('Dot appearance changes persist within Alpha personal workspace', () => persistAppearance(scenarioContext));

  await recordStep('Create a separate shared workspace and task', () => createSharedWorkspace(scenarioContext));

  await recordStep('Invite the second signed-in account and verify member permissions', () => inviteMember(scenarioContext));

  await recordStep('Owner can revoke an unexpired pending invitation and an accepted member session', () => revokeInvitations(scenarioContext));

  await recordStep('Tenant switch hides shared data from Beta personal workspace', () => switchTenant(scenarioContext));

  await recordStep('Restart the local service and recover both authenticated tenant sessions and task data', () => restoreAfterRestart(scenarioContext));

  await recordStep('Upload a text source, restore it after reload, and pass its contents to the agent', () => attachments(scenarioContext));

  await recordStep('Automation ideas stay in chat proposals until the user schedules work', () => automationIdeas(scenarioContext));

  await recordStep('Voice calls dispatch tenant work, preserve in-call controls, and end without stopping assigned work', () => desktopVoiceCall(scenarioContext));

  await recordStep('Mobile Chrome E2E sign-in opens the Dot and completes an outgoing call', () => mobileVoiceCall(scenarioContext));

  await recordStep('A user reply resumes a waiting task while retaining the original goal', () => resumeWaitingTask(scenarioContext));

  await recordStep('Workspace memory is user managed, reaches the agent prompt, and stays tenant isolated', () => workspaceMemory(scenarioContext));

  await recordStep('Dot learns private durable notes, updates them on a later task, and isolates shared-workspace members', () => privateDotMemory(scenarioContext));

  await recordStep('Workspace admins set a tenant rule and members can review its scope', () => workspaceRules(scenarioContext));

  await recordStep('Scratchpad page actions wait for tenant approval and respect a decline', () => pageApprovals(scenarioContext));

  await recordStep('Pausing a running task aborts its active model call and resume starts it again in Chrome', () => pauseAndResume(scenarioContext));

  await recordStep('Activity stops a running task and cancels its pending page approval', () => stopAndCancelApproval(scenarioContext));

  await recordStep('Recurring work runs again automatically and remains cancellable in Chrome', () => recurringWork(scenarioContext));

  await recordStep('Three independent tasks run in parallel in one workspace and finish in Activity', () => parallelTasks(scenarioContext));

  await recordStep('One goal delegates three parallel tasks, supports a single-child stop, and resumes with their results', () => delegatedTasks(scenarioContext));

  await recordStep('Alpha shared-workspace computer opens under the shared Dot identity', () => sharedComputerIdentity(scenarioContext));

  await recordStep('Beta personal computer remains isolated from Alpha shared computer', () => personalComputerIsolation(scenarioContext));

  await recordStep('Clicking the computer screen acquires control before sending input', () => inputRequiresTakeover(scenarioContext));

  await recordStep('Computer takeover performs real browser navigation, click, text input, and return', () => takeoverAndReturn(scenarioContext));

  await recordStep('Qwen WebRTC call sends Chinese speech to the tenant Agent and speaks its real task result', () => qwenWebRtc(scenarioContext));

  await recordStep('Qwen Audio 3.0 call uses built-in transcription and speaks the tenant Agent result', () => qwenWebRtc(scenarioContext, 'qwen-audio-3.0-realtime-plus'));

  await recordStep('Volcano realtime WebSocket keeps credentials server-side and sends Chinese speech into the tenant Agent', () => volcanoRealtime(scenarioContext));

  await recordStep('SeedDuplex explains the observed 45000030 resource entitlement failure in Chinese', () => seedDuplexEntitlement(scenarioContext));

  await recordStep('Mobile Chrome SeedDuplex call captures microphone audio, speaks the Agent result, and dispatches Chinese speech', () => mobileSeedDuplex(scenarioContext));

  await recordStep('SeedDuplex keeps a spoken clarification in the same task and speaks the resumed result', () => seedDuplexClarification(scenarioContext));

  assert.deepEqual(pageErrors, [], `Browser runtime errors: ${pageErrors.join('; ')}`);
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
  if (alphaPage) await alphaPage.screenshot({ path: join(artifactRoot, 'failure-alpha.png'), fullPage: true }).catch(() => undefined);
  if (betaPage) await betaPage.screenshot({ path: join(artifactRoot, 'failure-beta.png'), fullPage: true }).catch(() => undefined);
  if (gammaPage) await gammaPage.screenshot({ path: join(artifactRoot, 'failure-gamma.png'), fullPage: true }).catch(() => undefined);
  const failedMobilePage = mobilePage as unknown as Page | null;
  if (failedMobilePage) await failedMobilePage.screenshot({ path: join(artifactRoot, 'failure-mobile.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  releaseHeldPauseModel();
  releaseHeldStopModel();
  releaseHeldVoiceModel();
  releaseParallelModels();
  for (const release of delegatedModelReleases.values()) release();
  if (alphaContext) await alphaContext.tracing.stop({ path: join(artifactRoot, 'alpha-trace.zip') }).catch(() => undefined);
  if (betaContext) await betaContext.tracing.stop({ path: join(artifactRoot, 'beta-trace.zip') }).catch(() => undefined);
  if (gammaContext) await gammaContext.tracing.stop({ path: join(artifactRoot, 'gamma-trace.zip') }).catch(() => undefined);
  await alphaContext?.close().catch(() => undefined);
  await betaContext?.close().catch(() => undefined);
  await gammaContext?.close().catch(() => undefined);
  await (mobileContext as BrowserContext | null)?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopServer(server);
  if (mockModelServer) await new Promise<void>(resolvePromise => mockModelServer!.close(() => resolvePromise()));
  if (mockSlackServer) await new Promise<void>(resolvePromise => mockSlackServer!.close(() => resolvePromise()));
  if (mockQwenSignalingServer) await new Promise<void>(resolvePromise => mockQwenSignalingServer!.close(() => resolvePromise()));
  if (mockVolcEngineServer) await new Promise<void>(resolvePromise => mockVolcEngineServer!.close(() => resolvePromise()));
  if (mockVolcEngineDuplexServer) await new Promise<void>(resolvePromise => mockVolcEngineDuplexServer!.close(() => resolvePromise()));
  if (mockVolcEngineRejectedServer) await new Promise<void>(resolvePromise => mockVolcEngineRejectedServer!.close(() => resolvePromise()));
  if (e2eSlackTokenAccount) {
    try { new Entry('com.cokepoppy.coke-dots.e2e', e2eSlackTokenAccount).deletePassword(); } catch { /* The OAuth test may have failed before writing its token. */ }
  }
  testModelBaseUrl = '';
  testModelApiKey = '';
  testModelName = '';
  await writeFile(join(artifactRoot, 'server.log'), serverLogs.join(''));
  const videoFiles = (await readdir(videoDir)).filter(name => name.endsWith('.webm')).map(name => `video/${name}`);
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify({
    runAt: new Date().toISOString(),
    viewport: { width: 1440, height: 1000 },
    testService: `http://127.0.0.1:${e2ePort}`,
    browser: chromePath,
    steps,
    screenshots: screenshotNames,
    videos: videoFiles,
    pageErrors,
    failure,
  }, null, 2) + '\n');
  await appendFile(join(artifactRoot, 'server.log'), '\n');
  await rm(fixtureDestination, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
  console.log(`E2E evidence: ${artifactRoot}`);
}

if (failure) throw new Error(failure);
console.log(`PASS ${steps.length} browser E2E steps`);
