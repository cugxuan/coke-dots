import assert from 'node:assert/strict';
import type { ChatMessageResult, Snapshot, Task } from '../../../src/shared/types.ts';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function clearChatHistory(ctx: UiScenarioContext) {
  const page = ctx.alphaPage!, beta = ctx.betaPage!;
  await ctx.selectTenant(page, 'Alpha Shared');
  await ctx.clickNav(page, '你的 dot');
  await page.getByTestId('engine-select').selectOption('model');
  await page.getByTestId('attachment-input').setInputFiles({ name: 'history-demo.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this original file after clearing Dot.') });
  await page.getByTestId('pending-attachment').filter({ hasText: 'history-demo.txt' }).waitFor();
  const instruction = 'E2E history clear — preserve this task and its file';
  await ctx.createTask(page, instruction);
  const snapshot = () => page.evaluate(async () => await (await fetch('/api/state')).json() as Snapshot);
  const original = (await snapshot()).tasks.find(task => task.instruction === instruction)!;
  assert(original);
  await page.waitForFunction(async id => (await (await fetch('/api/state')).json()).tasks.find((task: Task) => task.id === id)?.status === 'done', original.id);
  const call = await page.evaluate(async () => {
    const call = await (await fetch('/api/voice-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    await fetch(`/api/voice-calls/${call.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds: 12 }) });
    return call;
  });
  await page.goto(`${ctx.baseUrl}/chat`);
  await page.locator(`[data-call-id="${call.id}"]`).waitFor();
  await ctx.selectTenant(beta, 'Alpha Shared');
  const betaHistory = await beta.evaluate(async () => (await (await fetch('/api/state')).json()).chatHistory);
  const before = await snapshot();
  const second = await page.context().newPage();
  try {
    await second.goto(`${ctx.baseUrl}/chat`);
    await second.getByTestId('clear-chat-history').waitFor();
    const response = page.waitForResponse(response => response.url().endsWith('/api/chat/history/clear'));
    await page.getByTestId('clear-chat-history').click();
    assert.equal((await response).status(), 200);
    await page.getByTestId('chat-history-empty').waitFor();
    await second.getByTestId('chat-history-empty').waitFor();
    assert.equal(await page.getByTestId('chat-timeline-item').count(), 0);
    await page.getByTestId('dot-context-panel').waitFor();
    assert.equal(await page.getByTestId('dot-computer-row').isVisible(), true);
    assert.equal(await page.getByTestId('context-activity').locator('button').count(), 0);
    const after = await snapshot();
    assert.equal(after.tasks.length, before.tasks.length);
    assert.deepEqual(after.tasks.find(task => task.id === original.id), before.tasks.find(task => task.id === original.id));
    assert(after.entries.some(entry => entry.attachments?.some(file => file.name === 'history-demo.txt')));
    assert.deepEqual(await beta.evaluate(async () => (await (await fetch('/api/state')).json()).chatHistory), betaHistory);
    const calls = await page.evaluate(async () => await (await fetch('/api/voice-calls')).json() as { id: string }[]);
    assert(calls.some(item => item.id === call.id));
    await page.reload();
    await page.getByTestId('chat-history-empty').waitFor();
    assert.equal(await page.getByTestId('chat-timeline-item').count(), 0);
    await ctx.screenshot(page, 'chat-history-cleared');
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    const button = await page.getByTestId('clear-chat-history').boundingBox();
    assert(button && button.x >= 0 && button.x + button.width <= 390);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ctx.screenshot(page, 'chat-history-cleared-mobile');
    await page.setViewportSize(viewport);

    await restoreWhileHistoryLoads(ctx, original.id);

    await page.getByTestId('task-composer').fill('E2E clean chat — start an independent conversation');
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/chat/messages'));
    await page.getByTestId('task-composer').press('Enter');
    const fresh = await (await submitted).json() as ChatMessageResult;
    assert.equal(fresh.status, 'submitted');
    if (fresh.status !== 'submitted') throw new Error('Missing fresh task');
    assert.equal(fresh.routing, 'new'); assert.notEqual(fresh.task.id, original.id);
    await page.waitForFunction(async id => (await (await fetch('/api/state')).json()).tasks.find((task: Task) => task.id === id)?.status === 'done', fresh.task.id);
    assert.equal(await page.locator('.timeline .message.user').count(), 1);
    assert.equal(await page.locator('.voice-call-ended').count(), 0);
    await ctx.clickNav(page, 'Activity');
    await page.getByTestId(`task-card-${original.id}`).getByRole('button', { name: '查看详情 →' }).click();
    await page.getByTestId('message-attachments').getByText('history-demo.txt', { exact: true }).waitFor();
    await page.getByTestId('task-composer').fill('手动继续清除前的任务');
    const continuation = page.waitForResponse(response => response.url().endsWith('/api/chat/messages'));
    await page.getByTestId('task-composer').press('Enter');
    const continued = await (await continuation).json() as ChatMessageResult;
    assert.equal(continued.status, 'submitted');
    if (continued.status === 'submitted') { assert.equal(continued.task.id, original.id); assert.equal(continued.routing, 'continued'); }
    await page.waitForFunction(async id => (await (await fetch('/api/state')).json()).tasks.find((task: Task) => task.id === id)?.status === 'done', original.id);
  } finally { await second.close(); }
}

async function restoreWhileHistoryLoads(ctx: UiScenarioContext, originalTaskId: string) {
  const page = await ctx.alphaPage!.context().newPage();
  let releaseCalls!: () => void;
  const callsGate = new Promise<void>(resolve => { releaseCalls = resolve; });
  try {
    // Delay full-history delivery while keeping the real initial chat event.
    await page.addInitScript({ content: `{
      const pending = [];
      let released = false;
      window.releaseHistory = () => {
        released = true; for (const send of pending.splice(0)) send();
      };
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(url, options) {
          super(url, options);
          let handler = null;
          Object.defineProperty(this, 'onmessage', { get: () => handler, set: next => { handler = next; } });
          this.addEventListener('message', event => {
            const send = () => handler?.(event);
            if (released) send(); else pending.push(send);
          });
        }
      };
    }` });
    await page.route('**/api/voice-calls', async route => { await callsGate; await route.continue().catch(() => {}); });
    await page.goto(`${ctx.baseUrl}/chat`);
    await page.getByTestId('chat-history-empty').waitFor();
    assert.equal(await page.getByTestId('app-shell').getAttribute('data-state-loaded'), 'false');
    assert.equal(await page.getByText('正在恢复工作区…', { exact: true }).count(), 0);
    await page.getByTestId('dot-computer-row').waitFor();
    await page.getByTestId('task-composer').fill('保留电脑旁的未发送草稿');
    assert.equal(await page.locator('.send').isEnabled(), true, 'Sending must not wait for retained Activity history');
    await page.getByTestId('dot-computer-row').click();
    const pane = await page.getByTestId('computer-split').elementHandle(); assert(pane);
    const computerUrl = page.url();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    await page.route('**/api/voice/provider', async route => { await providerGate; await route.continue().catch(() => {}); });
    try {
      await page.getByTestId('conversation-call-launch').click();
      await page.getByTestId('voice-call').waitFor();
      assert.equal(page.url(), computerUrl, 'Calling must preserve the computer route');
      assert(await pane.evaluate(node => node.isConnected), 'Calling must not unmount the desktop');
      assert.equal(await page.getByTestId('task-composer').inputValue(), '保留电脑旁的未发送草稿');
      await page.getByTestId('voice-call').getByRole('button', { name: '结束通话' }).click();
      assert(await pane.evaluate(node => node.isConnected));
    } finally { releaseProvider(); }
    await page.getByRole('button', { name: '关闭电脑分栏' }).click();
    await page.getByTestId('dot-computer-row').waitFor();
    await ctx.clickNav(page, 'Activity');
    assert.equal(await page.getByTestId(`task-card-${originalTaskId}`).count(), 0);
    await page.evaluate(() => (window as unknown as { releaseHistory: () => void }).releaseHistory());
    await page.getByTestId(`task-card-${originalTaskId}`).waitFor();
    await ctx.clickNav(page, '你的 dot');
    await page.getByTestId('chat-history-empty').waitFor();
    assert.equal(await page.getByTestId('app-shell').getAttribute('data-state-loaded'), 'true');
  } finally { releaseCalls(); await page.close(); }
}
