import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function computerShortcut(ctx: UiScenarioContext) {
  await ctx.alphaPage!.getByTestId('dot-computer-row').click();
  await ctx.alphaPage!.getByRole('heading', { name: '打开独立电脑' }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, 'context-computer-shortcut');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.alphaPage!.getByTestId('dot-context-panel').waitFor({ state: 'visible' });
}

export async function sharedComputerIdentity(ctx: UiScenarioContext) {
  await ctx.clickNav(ctx.alphaPage!, '电脑');
  await ctx.alphaPage!.getByRole('region', { name: 'Shared Dot 的电脑' }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByRole('button', { name: '打开电脑' }).click();
  await ctx.alphaPage!.getByRole('button', { name: 'Take over' }).waitFor({ state: 'visible', timeout: 20_000 });
  await ctx.alphaPage!.getByRole('status').filter({ hasText: 'Shared Dot has control' }).waitFor({ state: 'visible' });
  const welcomeState = await ctx.alphaPage!.evaluate(async () => {
    const response = await fetch('/api/computer');
    return await response.json() as { title: string; owner: string };
  });
  assert.equal(welcomeState.title, 'Welcome back, Shared Dot', 'The isolated browser did not open the observed welcome screen');
  assert.equal(welcomeState.owner, 'agent');
  assert.equal(await ctx.alphaPage!.locator('.computer-dock span').count(), 3, 'The source computer view shows three dock icons');
  assert.equal(await ctx.alphaPage!.locator('.computer-controlbar.is-user-control').count(), 0, 'The agent-owned screen must keep the takeover affordance');
  const screenImage = await ctx.waitForComputerScreenshot(ctx.alphaPage!);
  const screenAspect = screenImage.naturalWidth / screenImage.naturalHeight;
  assert.ok(Math.abs(screenAspect - 1280 / 820) < 0.002,
    `The replicated remote screen aspect ratio changed: expected 1280x820, saw ${screenImage.naturalWidth}x${screenImage.naturalHeight} (${screenAspect.toFixed(5)}) from ${screenImage.src}`);
  await ctx.screenshot(ctx.alphaPage!, '14-computer-dot-control');
}

export async function personalComputerIsolation(ctx: UiScenarioContext) {
  await ctx.clickNav(ctx.betaPage!, '电脑');
  await ctx.betaPage!.getByRole('region', { name: 'Dot 的电脑' }).waitFor({ state: 'visible' });
  await ctx.betaPage!.getByRole('button', { name: '打开电脑' }).waitFor({ state: 'visible' });
  assert.equal(await ctx.betaPage!.locator('.computer-browser-window').count(), 0, 'Beta inherited another tenant’s already-open computer');
  await ctx.betaPage!.getByRole('button', { name: '打开电脑' }).click();
  await ctx.betaPage!.getByRole('status').filter({ hasText: 'Dot has control' }).waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await ctx.alphaPage!.getByRole('status').filter({ hasText: 'Shared Dot has control' }).count(), 1, 'Opening Beta’s computer changed Alpha’s control owner');
  await ctx.screenshot(ctx.betaPage!, '14-beta-private-computer');
}

export async function inputRequiresTakeover(ctx: UiScenarioContext) {
  const addressBar = ctx.alphaPage!.locator('.browser-toolbar input');
  assert.equal(await addressBar.isDisabled(), true, 'Browser navigation is enabled before takeover');
  await ctx.alphaPage!.getByRole('button', { name: 'Take over' }).click();
  await ctx.alphaPage!.getByRole('status').filter({ hasText: 'You have control' }).waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.locator('.computer-controlbar.is-user-control').count(), 1, 'Take over must switch to the observed user-control ribbon');
  await ctx.screenshot(ctx.alphaPage!, '14-computer-takeover');
}

export async function takeoverAndReturn(ctx: UiScenarioContext) {
  const addressBar = ctx.alphaPage!.locator('.browser-toolbar input');
  await addressBar.fill(`${ctx.baseUrl}/e2e-computer-fixture.html`);
  await addressBar.press('Enter');
  await ctx.alphaPage!.getByText('Dot E2E Computer Fixture', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  const image = ctx.alphaPage!.getByAltText('独立浏览器画面');
  await ctx.waitForComputerScreenshot(ctx.alphaPage!);
  await ctx.clickComputerScreen(ctx.alphaPage!, 112 + 165, 82 + 32);
  await ctx.alphaPage!.getByText('Dot E2E Clicked', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await ctx.clickComputerScreen(ctx.alphaPage!, 112 + 165, 180 + 32);
  await image.focus();
  await ctx.alphaPage!.keyboard.type('typed by takeover', { delay: 20 });
  await ctx.alphaPage!.getByText('Dot E2E Typed: typed by takeover', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await ctx.screenshot(ctx.alphaPage!, '15-computer-typed');
  await ctx.alphaPage!.getByRole('button', { name: 'Return control' }).click();
  await ctx.alphaPage!.getByRole('status').filter({ hasText: 'Shared Dot has control' }).waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.locator('.computer-controlbar.is-user-control').count(), 0, 'Return control did not restore the agent-control presentation');
  assert.equal(await ctx.alphaPage!.locator('.browser-toolbar input').isDisabled(), true, 'Navigation remained enabled after control was returned');
  await ctx.screenshot(ctx.alphaPage!, '16-computer-returned');
}
