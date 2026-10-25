import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgentPrompt, parseDecision, type AgentRequest } from '../src/server/adapters.ts';

const baseRequest: AgentRequest = {
  prompt: 'Create a Minesweeper game in the cloud computer.',
  priorResult: null,
  sessionId: null,
  workspace: '/private/workspace/task',
  onEvent: () => {},
};

test('cloud-computer Pi prompt allows coding and interactive Browser Use inside the tenant Debian computer', () => {
  const prompt = formatAgentPrompt({ ...baseRequest, engine: 'pi', cloudComputerTask: true });
  assert.match(prompt, /read、grep、find、ls、write、edit、bash/);
  assert.match(prompt, /操作可见 Chromium 的 Browser Use/);
  assert.match(prompt, /无需再次请求许可/);
  assert.match(prompt, /克隆仓库，安装项目依赖，运行测试和使用浏览器/);
  assert.match(prompt, /不得尝试访问 Mac 主机、VPS、Kubernetes 控制面或其他租户/);
  assert.match(prompt, /只有任务明确要求相应动作时，才能发送、发布、授权、付款、删除或更改账号数据/);
});

test('non-Pi cloud kernels are not told they have Pi shell, write, or Browser Use tools', () => {
  const prompt = formatAgentPrompt({ ...baseRequest, engine: 'dsh', cloudComputerTask: true });
  assert.match(prompt, /没有 Pi 的 shell、文件写入或交互式 Browser Use 工具/);
  assert.doesNotMatch(prompt, /Pi 可使用 read/);
});

test('non-cloud tasks are not told they can write files', () => {
  const prompt = formatAgentPrompt(baseRequest);
  assert.match(prompt, /没有可写的云电脑任务目录/);
  assert.doesNotMatch(prompt, /无需再次请求许可/);
});

test('private Dot memory updates are explicit, user scoped, and limited to durable non-sensitive notes', () => {
  const memoryId = '11111111-1111-4111-8111-111111111111';
  const prompt = formatAgentPrompt({
    ...baseRequest,
    dotMemories: [{ id: memoryId, note: 'Prefer concise Mandarin answers.' }],
    allowDotMemoryUpdates: true,
  });
  assert.match(prompt, /仅属于此 Dot 和发起用户的私人笔记/);
  assert.match(prompt, new RegExp(`ID: ${memoryId}`));
  assert.match(prompt, /持久的偏好、决定、长期责任/);
  assert.match(prompt, /不得保存一次性任务细节、事故载荷、复制的来源正文、秘密、API 密钥、OAuth 代码、密码、访问令牌或敏感个人资料/i);

  const saved = parseDecision(JSON.stringify({ status: 'done', message: '已记住。', memoryAction: { action: 'save', note: 'Prefer concise Mandarin answers.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [] });
  assert.deepEqual(saved.memoryAction, { action: 'save', note: 'Prefer concise Mandarin answers.' });
  const updated = parseDecision(JSON.stringify({ status: 'done', message: '已更新。', memoryAction: { action: 'update', memoryId, note: 'Prefer concise Chinese answers.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [memoryId] });
  assert.deepEqual(updated.memoryAction, { action: 'update', memoryId, note: 'Prefer concise Chinese answers.' });
  assert.throws(() => parseDecision(JSON.stringify({ status: 'done', message: 'Saved.', memoryAction: { action: 'save', note: 'Cross-user write.' } })), /没有更新 Dot 私人记忆的权限/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'done', message: 'Saved.', memoryAction: { action: 'update', memoryId: '22222222-2222-4222-8222-222222222222', note: 'Cross-user write.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [memoryId] }), /不存在的 Dot 私人记忆/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'waiting', message: 'Need input.', memoryAction: { action: 'save', note: 'Never persist incomplete work.' } }), undefined, { allowDotMemoryUpdates: true, dotMemoryIds: [] }), /只能在任务完成时更新/);
});
