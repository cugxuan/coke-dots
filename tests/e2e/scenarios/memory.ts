import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function workspaceMemory(ctx: UiScenarioContext) {
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha workspace');
  await ctx.openProfile(ctx.alphaPage!);
  const memoryManager = ctx.alphaPage!.getByTestId('memory-manager');
  await memoryManager.waitFor({ state: 'visible' });
  await memoryManager.getByTestId('empty-memory-list').waitFor({ state: 'visible' });
  await memoryManager.getByLabel('添加记忆').fill('Alpha prefers concise updates.');
  await memoryManager.getByRole('button', { name: '添加记忆' }).click();
  const memoryRow = memoryManager.getByTestId('memory-row').filter({ hasText: 'Alpha prefers concise updates.' });
  await memoryRow.waitFor({ state: 'visible' });
  await memoryRow.getByRole('button', { name: '编辑' }).click();
  await memoryRow.getByLabel('编辑这条记忆').fill('Alpha prefers concise Mandarin updates.');
  await memoryManager.getByTestId('memory-row').first().getByRole('button', { name: '保存记忆' }).click();
  const updatedMemoryRow = memoryManager.getByTestId('memory-row').filter({ hasText: 'Alpha prefers concise Mandarin updates.' });
  await updatedMemoryRow.waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, '18-alpha-workspace-memory');

  const promptStart = ctx.mockModelPrompts.length;
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  const memoryTask = 'E2E memory prompt — apply the saved workspace preference';
  await ctx.createTask(ctx.alphaPage!, memoryTask);
  await ctx.alphaPage!.locator('.timeline .pill.done').waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.waitFor(() => ctx.mockModelPrompts.length === promptStart + 1, 10_000);
  assert.match(ctx.mockModelPrompts[promptStart], /User-approved workspace notes[\s\S]*Alpha prefers concise Mandarin updates\./, 'Saved note did not reach the actual model request');
  await ctx.screenshot(ctx.alphaPage!, '18b-agent-used-workspace-memory');

  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByTestId('memory-manager').getByTestId('empty-memory-list').waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.getByTestId('memory-row').count(), 0, 'Alpha personal memory appeared in Alpha Shared');

  await ctx.selectTenant(ctx.betaPage!, 'Beta workspace');
  await ctx.openProfile(ctx.betaPage!);
  await ctx.betaPage!.getByTestId('memory-manager').getByTestId('empty-memory-list').waitFor({ state: 'visible' });
  assert.equal(await ctx.betaPage!.getByTestId('memory-row').count(), 0, 'Alpha personal memory appeared in Beta personal workspace');
  await ctx.screenshot(ctx.betaPage!, '18c-beta-memory-isolation');

  await ctx.selectTenant(ctx.alphaPage!, 'Alpha workspace');
  await ctx.openProfile(ctx.alphaPage!);
  const savedMemory = ctx.alphaPage!.getByTestId('memory-row').filter({ hasText: 'Alpha prefers concise Mandarin updates.' });
  await savedMemory.waitFor({ state: 'visible' });
  await savedMemory.getByRole('button', { name: '删除' }).click();
  await ctx.alphaPage!.getByTestId('memory-manager').getByTestId('empty-memory-list').waitFor({ state: 'visible' });
}

export async function privateDotMemory(ctx: UiScenarioContext) {
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.openProfile(ctx.alphaPage!);
  const privateMemoryManager = ctx.alphaPage!.getByTestId('dot-memory-manager');
  await privateMemoryManager.getByTestId('empty-dot-memory-list').waitFor({ state: 'visible' });
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');

  let promptStart = ctx.mockModelPrompts.length;
  const captureTask = 'E2E dot memory capture — remember this durable preference';
  await ctx.createTask(ctx.alphaPage!, captureTask);
  const captureTaskItem = await ctx.taskNavigationItem(ctx.alphaPage!, captureTask);
  await captureTaskItem.waitFor({ state: 'visible' });
  await captureTaskItem.click();
  await ctx.alphaPage!.locator('.timeline .pill.done').waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.waitFor(() => ctx.mockModelPrompts.length === promptStart + 1, 10_000);
  assert.match(ctx.mockModelPrompts[promptStart], /Private notes for this Dot and the initiating user: \(none\)/);
  assert.match(ctx.mockModelPrompts[promptStart], /durable preference, decision, or ongoing responsibility/);
  await ctx.openProfile(ctx.alphaPage!);
  const savedPrivateMemory = privateMemoryManager.getByTestId('dot-memory-row').filter({ hasText: 'Alpha prefers concise Mandarin updates.' });
  await savedPrivateMemory.waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, '18f-dot-private-memory-saved');

  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  promptStart = ctx.mockModelPrompts.length;
  const updateTask = 'E2E dot memory update — use and refine the private preference';
  await ctx.createTask(ctx.alphaPage!, updateTask);
  const updateTaskItem = await ctx.taskNavigationItem(ctx.alphaPage!, updateTask);
  await updateTaskItem.waitFor({ state: 'visible' });
  await updateTaskItem.click();
  await ctx.alphaPage!.locator('.timeline .pill.done').waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.waitFor(() => ctx.mockModelPrompts.length === promptStart + 1, 10_000);
  assert.match(ctx.mockModelPrompts[promptStart], /Private notes for this Dot and the initiating user only/);
  assert.match(ctx.mockModelPrompts[promptStart], /Alpha prefers concise Mandarin updates\./);
  await ctx.openProfile(ctx.alphaPage!);
  const updatedPrivateMemory = privateMemoryManager.getByTestId('dot-memory-row').filter({ hasText: 'Alpha prefers concise Chinese updates.' });
  await updatedPrivateMemory.waitFor({ state: 'visible' });

  await ctx.selectTenant(ctx.betaPage!, 'Alpha Shared');
  await ctx.openProfile(ctx.betaPage!);
  await ctx.betaPage!.getByTestId('dot-memory-manager').getByTestId('empty-dot-memory-list').waitFor({ state: 'visible' });
  const betaDotMemories = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/dot-memories')).json()) as unknown[];
  assert.deepEqual(betaDotMemories, [], 'A second member of the same shared workspace must not receive Alpha’s private Dot notes');
  await ctx.screenshot(ctx.betaPage!, '18g-shared-workspace-private-memory-isolation');

  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.openProfile(ctx.alphaPage!);
  const savedRow = privateMemoryManager.getByTestId('dot-memory-row').filter({ hasText: 'Alpha prefers concise Chinese updates.' });
  await savedRow.getByRole('button', { name: '编辑' }).click();
  const editingRow = privateMemoryManager.getByTestId('dot-memory-row').first();
  await editingRow.getByLabel('编辑这条私人记忆').fill('Alpha prefers brief Mandarin replies.');
  await editingRow.getByRole('button', { name: '保存更改' }).click();
  const editedRow = privateMemoryManager.getByTestId('dot-memory-row').filter({ hasText: 'Alpha prefers brief Mandarin replies.' });
  await editedRow.waitFor({ state: 'visible' });
  await editedRow.getByRole('button', { name: '删除' }).click();
  await privateMemoryManager.getByTestId('empty-dot-memory-list').waitFor({ state: 'visible' });
}
