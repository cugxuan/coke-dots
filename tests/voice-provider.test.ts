import assert from 'node:assert/strict';
import { test } from 'node:test';
import { negotiateQwenRealtime, qwenRealtimeConfig, qwenRealtimeEndpoint, VoiceProviderError, voiceProviderInfo } from '../src/server/voice-provider.ts';
import { QWEN_AUDIO_REALTIME_MODEL, QWEN_REALTIME_MODEL, qwenSessionConfig } from '../src/shared/qwen-realtime.ts';

const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const answer = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const env = (): NodeJS.ProcessEnv => ({ DOTS_VOICE_PROVIDER: 'qwen', DOTS_QWEN_API_KEY: 'server-secret', DOTS_QWEN_WORKSPACE_ID: 'workspace-123', DOTS_QWEN_REGION: 'beijing' });

test('Qwen configuration reports availability without exposing credentials', () => {
  assert.deepEqual(voiceProviderInfo({}), { provider: 'browser', configured: true });
  assert.deepEqual(voiceProviderInfo({ DOTS_VOICE_PROVIDER: 'typo' }), { provider: 'unsupported', configured: false });
  assert.deepEqual(voiceProviderInfo({ DOTS_VOICE_PROVIDER: 'qwen' }), { provider: 'qwen', configured: false, model: 'qwen3.8-omni-flash-realtime' });
  assert.deepEqual(voiceProviderInfo(env()), { provider: 'qwen', configured: true, model: 'qwen3.8-omni-flash-realtime' });
  assert.equal(qwenRealtimeEndpoint(qwenRealtimeConfig({ ...env(), DOTS_QWEN_REGION: 'singapore' })), 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');
});

test('Qwen WebRTC negotiation forwards SDP and bearer key only to the fixed provider endpoint', async () => {
  let requestUrl = '';
  let requestAuthorization = '';
  let requestContentType = '';
  let requestBody = '';
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestAuthorization = new Headers(init?.headers).get('authorization') || '';
    requestContentType = new Headers(init?.headers).get('content-type') || '';
    requestBody = String(init?.body || '');
    return new Response(answer, { status: 200 });
  };
  assert.equal(await negotiateQwenRealtime(offer, env(), fetcher), answer);
  assert.equal(requestUrl, 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');
  assert.equal(requestAuthorization, 'Bearer server-secret');
  assert.equal(requestContentType, 'application/sdp');
  assert.equal(requestBody, offer);
});

test('provider errors do not reveal upstream response bodies or credentials', async () => {
  const failingFetcher: typeof fetch = async () => new Response('server-secret is invalid', { status: 401 });
  await assert.rejects(negotiateQwenRealtime(offer, env(), failingFetcher), error => {
    assert(error instanceof VoiceProviderError);
    assert.equal(error.status, 502);
    assert.equal(error.message.includes('server-secret'), false);
    return true;
  });
  await assert.rejects(negotiateQwenRealtime('not-sdp', env(), failingFetcher), /offer SDP 无效/);
  await assert.rejects(negotiateQwenRealtime(offer, { ...env(), DOTS_QWEN_REGION: 'mars' }, failingFetcher), /地域无效/);
  await assert.rejects(negotiateQwenRealtime(offer, { ...env(), DOTS_QWEN_WORKSPACE_ID: 'invalid.host' }, failingFetcher), /工作空间 ID/);
});

test('Token Plan Audio 3.0 uses its own voice and built-in transcription over server-side WebRTC', async () => {
  const config = { ...env(), DOTS_QWEN_WORKSPACE_ID: 'token-plan', DOTS_QWEN_MODEL: QWEN_AUDIO_REALTIME_MODEL };
  assert.deepEqual(voiceProviderInfo(config), { provider: 'qwen', configured: true, model: QWEN_AUDIO_REALTIME_MODEL });
  let requested = '';
  await negotiateQwenRealtime(offer, config, async url => { requested = String(url); return new Response(answer); });
  assert.equal(requested, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen-audio-3.0-realtime-plus');
  const audio = qwenSessionConfig(QWEN_AUDIO_REALTIME_MODEL, 'Dot');
  assert('voice' in audio);
  assert.equal(audio.voice, 'longanqian');
  assert.equal('input_audio_transcription' in audio, false);
  assert.equal('audio' in audio, false);
  assert.equal(audio.turn_detection.type, 'server_vad');
  assert.equal(audio.turn_detection.silence_duration_ms, 2500);
  assert.deepEqual(audio.modalities, ['text', 'audio']);
  assert.equal(audio.tools.length, 2);
  const omni = qwenSessionConfig(QWEN_REALTIME_MODEL, 'Dot');
  assert('audio' in omni);
  assert.equal(omni.audio.output.voice, 'Tina');
  assert.equal(omni.input_audio_transcription.model, 'qwen3-asr-flash-realtime');
  assert.deepEqual(omni.modalities, ['text', 'audio']);
  assert.throws(() => qwenRealtimeConfig({ ...config, DOTS_QWEN_MODEL: 'unknown-model' }), /模型不受支持/);
  assert.equal(voiceProviderInfo({ ...config, DOTS_QWEN_MODEL: 'unknown-model' }).configured, false);
});
