import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { Snapshot, WorkspacePage } from '../../../src/shared/types.ts';
import { Store } from '../../../src/server/store.ts';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function pageNavigation(ctx: UiScenarioContext) {
  const page = ctx.alphaPage!;
  const ready = async (target = page) => target.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  const location = (target = page) => new URL(target.url()).pathname + new URL(target.url()).search;
  const reload = async (path: string) => {
    assert.equal(location(), path);
    const response = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200, `Direct GET ${path} must serve the app`);
    await ready();
    assert.equal(location(), path, 'Reload must preserve the page address');
  };
  await ctx.selectTenant(page, 'Alpha Shared');
  const state = await page.evaluate(async () => (await fetch('/api/state')).json()) as Snapshot;
  const task = state.tasks[0]; assert(task);
  const pages = await page.evaluate(async () => (await fetch('/api/pages')).json()) as WorkspacePage[];
  const scratchpad = pages[0]; assert(scratchpad);

  await ctx.clickNav(page, 'Activity');
  await reload('/activity');
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  await ctx.openProfile(page);
  await reload('/settings');
  await page.getByLabel('名字', { exact: true }).waitFor();
  await page.goBack(); await ready();
  assert.equal(location(), '/activity');
  await page.goForward(); await ready();
  assert.equal(location(), '/settings');

  await ctx.clickNav(page, 'Scratchpad');
  await reload('/pages');
  await page.getByTestId('scratchpad-page-row').filter({ hasText: scratchpad.title }).click();
  await reload(`/pages/${scratchpad.id}`);
  await page.getByTestId('scratchpad-page').getByRole('heading', { name: scratchpad.title, exact: true }).waitFor();

  await page.goto(`${ctx.baseUrl}/chat/${task.id}?page=${scratchpad.id}`);
  await ready();
  await page.getByTestId('scratchpad-page-split').waitFor();
  await reload(`/chat/${task.id}?page=${scratchpad.id}`);
  await page.getByTestId('scratchpad-page-split').waitFor();
  assert.equal(await page.locator('.topbar-title').innerText(), task.title);

  await ctx.clickNav(page, 'Activity');
  await (await ctx.taskNavigationItem(page, task.title)).click();
  await reload(`/chat/${task.id}`);
  assert.equal(await page.locator('.topbar-title').innerText(), task.title);
  await ctx.clickNav(page, '电脑');
  await reload(`/computer?task=${task.id}`);
  await page.getByTestId('computer-split').waitFor();
  await page.getByRole('button', { name: '关闭电脑分栏', exact: true }).click();
  assert.equal(location(), `/chat/${task.id}`);

  const tenantId = await page.getByTestId('app-shell').getAttribute('data-tenant-id'); assert(tenantId);
  const fixture = new Store(ctx.testDataDir);
  let watch;
  try {
    watch = fixture.createWatch('https://navigation.example.test/', 60, tenantId);
    fixture.updateWatch(watch.id, { status: 'paused', nextCheckAt: null }, tenantId);
  } finally { fixture.close(); }
  await ctx.clickNav(page, 'Scheduled');
  await reload('/scheduled');
  await page.locator('.scheduled-item').filter({ hasText: watch.url }).click();
  await reload(`/scheduled/watches/${watch.id}`);
  await page.getByTestId('scheduled-detail').waitFor();
  assert.equal(await page.getByTestId('scheduled-detail').getAttribute('data-item-id'), watch.id);

  const otherTab = await page.context().newPage();
  try {
    const response = await otherTab.goto(`${ctx.baseUrl}/chat/${task.id}`);
    assert.equal(response?.status(), 200);
    await ready(otherTab);
    assert.equal(await otherTab.locator('.topbar-title').innerText(), task.title);
  } finally { await otherTab.close(); }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ctx.baseUrl}/chat/${task.id}`); await ready();
  await page.getByTestId('mobile-chat-menu-toggle').click();
  await page.getByTestId('mobile-navigation').getByRole('button', { name: /Activity/ }).click();
  await reload('/activity');
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  await page.goBack(); await ready();
  assert.equal(location(), `/chat/${task.id}`);
  await ctx.screenshot(page, 'mobile-task-deep-link');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await ctx.selectTenant(page, 'Alpha workspace');
  assert.equal(location(), '/chat', 'Changing workspace must drop the previous task selection');
  await page.goto(`${ctx.baseUrl}/chat/${task.id}`); await ready();
  await page.getByRole('alert').filter({ hasText: '此任务不存在，或不属于当前工作区' }).waitFor();
  assert.equal(await page.getByTestId('task-composer').inputValue(), '');
  await page.getByRole('button', { name: '返回 Dot 对话', exact: true }).click();
  await reload('/chat');
  await ctx.selectTenant(page, 'Alpha Shared');

  const loginContext = await ctx.browser!.newContext();
  const loginPage: Page = await loginContext.newPage();
  try {
    await loginPage.goto(`${ctx.baseUrl}/activity`);
    await loginPage.getByLabel('E2E 测试账号').fill('routes@example.test');
    await loginPage.getByTestId('e2e-sign-in').click();
    await ready(loginPage);
    assert.equal(location(loginPage), '/activity', 'Signing in from a deep link must keep the target page');
    await loginPage.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
  } finally { await loginContext.close(); }
}
