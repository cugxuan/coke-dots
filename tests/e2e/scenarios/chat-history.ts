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
    assert.equal(await page.getByTestId('dot-context-panel').count(), 0);
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
