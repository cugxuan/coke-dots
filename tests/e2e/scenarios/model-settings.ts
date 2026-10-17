import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function sharedModelPermissions(ctx: UiScenarioContext) {
  await ctx.openProfile(ctx.alphaPage!);
  await ctx.alphaPage!.getByLabel('共享模型 API 地址').fill(ctx.testModelBaseUrl);
  await ctx.alphaPage!.getByLabel('共享模型名称').fill(ctx.testModelName);
  await ctx.alphaPage!.getByLabel('共享模型 API 密钥').fill(ctx.testModelApiKey);
  await ctx.alphaPage!.getByRole('button', { name: '保存共享模型设置' }).click();
  const alphaState = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/state')).json());
  const alphaTenantId = await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-tenant-id');
  assert.equal(alphaState.modelSettings.baseUrl, ctx.testModelBaseUrl);
  assert.equal(alphaState.modelSettings.model, ctx.testModelName);
  assert.equal(alphaState.modelSettings.hasKey, true);
  assert.equal(alphaState.modelSettings.adminTenantId, alphaTenantId);
  assert(alphaState.availableEngines.includes('model'), 'Saving the shared API must enable Model API tasks in the admin workspace');
  assert.equal(JSON.stringify(alphaState).includes(ctx.testModelApiKey), false, 'The API key must never be returned by the state endpoint');
  await ctx.screenshot(ctx.alphaPage!, 'shared-model-settings-admin');

  const betaTenantId = await ctx.betaPage!.getByTestId('app-shell').getAttribute('data-tenant-id');
  const betaState = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/state')).json());
  assert.equal(betaState.modelSettings.hasKey, true, 'A second Google account must see that the instance Model API is configured');
  assert.equal(betaState.modelSettings.baseUrl, ctx.testModelBaseUrl);
  assert.equal(betaState.modelSettings.model, ctx.testModelName);
  assert.notEqual(betaState.modelSettings.adminTenantId, betaTenantId, 'The second account must not become the model administrator');
  assert(betaState.availableEngines.includes('model'), 'A fresh tenant must inherit the instance Model API availability');
  await ctx.openProfile(ctx.betaPage!);
  await ctx.betaPage!.getByTestId('shared-model-settings-readonly').waitFor({ state: 'visible' });
  const deniedModelWrite = await ctx.betaPage!.evaluate(async () => {
    const response = await fetch('/api/model-settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://attacker.example/v1', model: 'other-model', apiKey: '' }) });
    return { status: response.status, body: await response.json() as { error?: string } };
  });
  assert.equal(deniedModelWrite.status, 403, 'A different account must not be allowed to change the shared instance model');
  await ctx.clickNav(ctx.betaPage!, '你的 dot');

  const betaComputerChoice = ctx.betaPage!.getByTestId('computer-choice');
  if (await betaComputerChoice.isVisible()) {
    await betaComputerChoice.getByRole('button', { name: 'Continue' }).click();
    await ctx.betaPage!.getByTestId('dot-onboarding').waitFor({ state: 'visible' });
    await ctx.clickNav(ctx.betaPage!, 'Activity');
    await ctx.clickNav(ctx.betaPage!, '新聊天');
  }

  const sharedModelInstruction = 'E2E shared model call from Beta account — 用中文确认模型调用成功';
  const requestStart = ctx.mockModelRequests.length;
  await ctx.createTask(ctx.betaPage!, sharedModelInstruction);
  await ctx.betaPage!.waitForFunction(async (instruction: string) => {
    const snapshot = await (await fetch('/api/state')).json() as { tasks: { instruction: string; status: string; result: string | null; engine: string }[] };
    const task = snapshot.tasks.find(candidate => candidate.instruction === instruction);
    return task?.engine === 'model' && task.status === 'done' && task.result?.includes('共享模型 API 已在第二个 Google 账号中成功调用。');
  }, sharedModelInstruction, { timeout: 20_000 });
  await ctx.waitFor(() => ctx.mockModelRequests.slice(requestStart).some(request => request.prompt.includes(sharedModelInstruction)), 5_000);
  const betaModelRequest = ctx.mockModelRequests.slice(requestStart).find(request => request.prompt.includes(sharedModelInstruction));
  assert.equal(betaModelRequest?.authorization, `Bearer ${ctx.testModelApiKey}`, 'Beta must execute a real authenticated model HTTP request with the instance-shared credential');
  await ctx.screenshot(ctx.betaPage!, 'shared-model-task-from-beta');
}

export async function transientSecretOutage(ctx: UiScenarioContext) {
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.alphaPage!.locator('.composer-bottom select').selectOption('model');
  const instruction = 'E2E transient K3D outage — use the cached shared model credential';
  const requestStart = ctx.mockModelRequests.length;
  await writeFile(ctx.sharedModelSecretUnavailableFile, 'simulate a temporary K3D API outage');
  try {
    const lockedState = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/state')).json()) as { modelSettings: { hasKey: boolean }; availableEngines: string[] };
    assert.equal(lockedState.modelSettings.hasKey, true, 'The page should keep showing the shared model as configured after a transient K3D read failure');
    assert(lockedState.availableEngines.includes('model'), 'A temporary K3D outage must not remove the Model API kernel from this tenant');
    await ctx.createTask(ctx.alphaPage!, instruction);
    await ctx.clickNav(ctx.alphaPage!, 'Activity');
    await ctx.alphaPage!.waitForFunction(async (taskInstruction: string) => {
      const state = await (await fetch('/api/state')).json() as { tasks: { instruction: string; status: string; result: string | null }[] };
      const task = state.tasks.find(candidate => candidate.instruction === taskInstruction);
      return task?.status === 'done' && task.result?.includes('K3D Secret 暂时不可读，但任务使用进程缓存的共享模型凭据完成。');
    }, instruction, { timeout: 20_000 });
    await ctx.waitFor(() => ctx.mockModelRequests.slice(requestStart).some(request => request.prompt.includes(instruction)), 5_000);
    const request = ctx.mockModelRequests.slice(requestStart).find(candidate => candidate.prompt.includes(instruction));
    assert.equal(request?.authorization, `Bearer ${ctx.testModelApiKey}`, 'The task must make an authenticated model call with the retained instance credential');
    await ctx.screenshot(ctx.alphaPage!, 'shared-model-task-during-k3d-outage');
  } finally {
    await rm(ctx.sharedModelSecretUnavailableFile, { force: true });
  }
}
