import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';
import type { ChatMessageResult, Task } from '../../../src/shared/types.ts';

export async function chatTaskRouting(ctx: UiScenarioContext) {
  const page = ctx.alphaPage!;
  page.setDefaultTimeout(15_000);
  await ctx.selectTenant(page, 'Alpha workspace');
  await ctx.clickNav(page, '你的 dot');
  const initial = 'E2E BYD 信用报告：核查来源 A 与 B';
  await ctx.createTask(page, initial);
  const getTasks = () => page.evaluate(async () => (await (await fetch('/api/state')).json()).tasks as Task[]);
  await page.locator('.timeline .pill.done').waitFor();
  const original = (await getTasks()).find(task => task.instruction === initial)!;
  assert(original);
  const beforeCount = (await getTasks()).length;

  const send = async (text: string): Promise<ChatMessageResult> => {
    await page.getByTestId('task-composer').fill(text);
    const response = page.waitForResponse(response => response.url().endsWith('/api/chat/messages') && response.request().method() === 'POST');
    await page.getByTestId('task-composer').press('Enter');
    const received = await response;
    assert(received.ok(), await received.text());
    return await received.json() as ChatMessageResult;
  };
  const selected = await send('只总结这份报告');
  assert.equal(selected.status, 'submitted');
  if (selected.status !== 'submitted') throw new Error('Missing task');
  assert.equal(selected.task.id, original.id);
  await page.getByText('已在原比亚迪任务内补充摘要。', { exact: true }).waitFor();

  await ctx.clickNav(page, '你的 dot');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ctx.clickNav(page, '你的 dot');
  const implicit = await send('帮我列出来具体有哪些信息渠道查询了，哪些没有查询');
  assert.equal(implicit.status, 'submitted');
  if (implicit.status !== 'submitted') throw new Error('Missing task');
  assert.equal(implicit.task.id, original.id);
  assert.equal(implicit.routing, 'continued');
  await page.getByText('渠道清单：A 已核验；B 尚未查询。沿用比亚迪报告，没有重跑调研。', { exact: true }).waitFor();
  assert.equal((await getTasks()).length, beforeCount);
  const lastPrompt = ctx.mockModelPrompts.at(-1)!;
  assert.match(lastPrompt, /Continuation of the SAME task/);
  assert.match(lastPrompt, /来源 A 已核验/);
  assert.match(lastPrompt, /Task: 帮我列出来具体有哪些信息渠道查询了，哪些没有查询/);

  const fresh = await send('路由新话题：安排读书计划');
  assert.equal(fresh.status, 'submitted');
  if (fresh.status !== 'submitted') throw new Error('Missing task');
  assert.notEqual(fresh.task.id, original.id);
  await page.waitForFunction(async id => (await (await fetch('/api/state')).json()).tasks.find((task: Task) => task.id === id)?.status === 'done', fresh.task.id);
  const ambiguous = await send('这份报告的来源呢？');
  assert.equal(ambiguous.status, 'clarify');
  await page.getByText('你指的是哪份报告？', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('task-composer').inputValue(), '这份报告的来源呢？');
  assert.equal((await getTasks()).length, beforeCount + 1);
  const resumed = page.waitForResponse(response => response.url().endsWith('/api/chat/messages') && response.request().method() === 'POST');
  await page.getByRole('button', { name: `继续：${initial}`, exact: true }).click();
  const chosen = await (await resumed).json() as Extract<ChatMessageResult, { status: 'submitted' }>;
  assert.equal(chosen.task.id, original.id);
  await page.getByTestId('task-composer').waitFor({ state: 'visible' });
  await ctx.screenshot(page, 'task-context-routing');
  await page.waitForFunction(async id => (await (await fetch('/api/state')).json()).tasks.find((task: Task) => task.id === id)?.status === 'done', original.id);
}
