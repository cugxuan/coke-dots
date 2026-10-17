import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function workspaceRules(ctx: UiScenarioContext) {
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.openProfile(ctx.alphaPage!);
  const ruleManager = ctx.alphaPage!.getByTestId('action-rule-manager');
  await ruleManager.waitFor({ state: 'visible' });
  await ruleManager.getByRole('button', { name: 'Add rule' }).click();
  await ruleManager.getByLabel('规则说明').fill('Create or update the shared launch notes.');
  await ruleManager.getByLabel('规则处理方式').selectOption('ask-before');
  await ruleManager.getByRole('button', { name: 'Save rule' }).click();
  await ruleManager.getByTestId('custom-action-rule').getByText('Ask before taking action', { exact: true }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, '18d-alpha-shared-scratchpad-rule');

  await ctx.selectTenant(ctx.betaPage!, 'Alpha Shared');
  await ctx.clickNav(ctx.betaPage!, '你的 dot');
  await ctx.openProfile(ctx.betaPage!);
  const memberRuleManager = ctx.betaPage!.getByTestId('action-rule-manager');
  await memberRuleManager.getByTestId('custom-action-rule').waitFor({ state: 'visible' });
  assert.equal(await memberRuleManager.getByRole('button', { name: 'Edit rule' }).count(), 0, 'A regular workspace member received rule-management controls');
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
}

export async function pageApprovals(ctx: UiScenarioContext) {
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  const instruction = 'E2E Scratchpad page — create the team launch notes';
  const promptStart = ctx.mockModelPrompts.length;
  await ctx.createTask(ctx.alphaPage!, instruction);
  const approval = ctx.alphaPage!.getByTestId('page-action-approval');
  await approval.waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.alphaPage!.locator('.timeline .pill.waiting').waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.waitFor(() => ctx.mockModelPrompts.length === promptStart + 1, 10_000);
  assert.match(ctx.mockModelPrompts[promptStart], /Mode: If this task calls for a Scratchpad page action/);
  assert.match(ctx.mockModelPrompts[promptStart], /Create or update the shared launch notes/);
  assert.match(await approval.innerText(), /Review the short intro/);
  const taskId = await ctx.alphaPage!.evaluate(async (goal: string) => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; instruction: string }[] };
    return state.tasks.find(task => task.instruction === goal)?.id || null;
  }, instruction);
  assert(taskId, 'The waiting page task was absent from the tenant state');
  assert.equal(await ctx.alphaPage!.evaluate(async () => (await fetch('/api/pages').then(response => response.json()) as unknown[]).length), 0, 'The pending approval wrote the proposed page too early');

  await ctx.selectTenant(ctx.betaPage!, 'Beta workspace');
  assert.equal(await ctx.betaPage!.evaluate(async (id: string) => fetch(`/api/tasks/${id}/approval`).then(response => response.status), taskId), 404, 'A different personal tenant retrieved a pending approval');
  await ctx.selectTenant(ctx.betaPage!, 'Alpha Shared');
  await ctx.clickNav(ctx.betaPage!, 'Activity');
  const sharedTask = ctx.betaPage!.locator('.task-card').filter({ hasText: instruction });
  await sharedTask.getByRole('button', { name: /查看详情/ }).click();
  const memberApproval = ctx.betaPage!.getByTestId('page-action-approval');
  await memberApproval.waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.betaPage!, '18e-member-scratchpad-approval');
  const pendingState = await ctx.betaPage!.evaluate(async (id: string) => fetch(`/api/tasks/${id}/approval`).then(response => response.json()), taskId) as { status: string };
  assert.equal(pendingState.status, 'pending');
  await memberApproval.getByRole('button', { name: '批准并执行' }).click();
  await ctx.alphaPage!.locator('.timeline .pill.done').waitFor({ state: 'visible', timeout: 15_000 });
  const approvedPages = await ctx.alphaPage!.evaluate(async () => fetch('/api/pages').then(response => response.json())) as { id: string; title: string; content: string }[];
  assert.equal(approvedPages.length, 1, 'Approval did not write exactly one page');
  assert.equal(approvedPages[0].title, 'Team launch notes');
  const alphaPageId = approvedPages[0].id;
  assert.match(ctx.mockModelPrompts[promptStart], /Scratchpad pages in this workspace/);
  await ctx.alphaPage!.locator('.timeline .message.dot .message-page-link').filter({ hasText: 'Team launch notes' }).click();
  const pane = ctx.alphaPage!.getByTestId('scratchpad-page');
  await pane.waitFor({ state: 'visible' });
  await pane.getByText('Connected', { exact: true }).waitFor({ state: 'visible' });
  await pane.getByRole('heading', { name: 'Team launch notes', exact: true }).waitFor({ state: 'visible' });
  await pane.getByText('Review the short intro', { exact: false }).waitFor({ state: 'visible' });
  const pageNavigation = ctx.alphaPage!.getByTestId('scratchpad-navigation');
  await pageNavigation.getByTestId('scratchpad-nav-page-row').filter({ hasText: 'Team launch notes' }).waitFor({ state: 'visible' });
  await pageNavigation.getByRole('button', { name: /Team launch notes/ }).evaluate(button => { if (button.getAttribute('aria-current') !== 'page') throw new Error('The open page is not selected in Scratchpad navigation'); });
  const splitWidths = await ctx.alphaPage!.evaluate(() => ({
    rail: document.querySelector('.icon-rail')!.getBoundingClientRect().width,
    navigationSidebar: document.querySelector('.sidebar')!.getBoundingClientRect().width,
    conversation: document.querySelector('.chat-panel')!.getBoundingClientRect().width,
    navigation: document.querySelector('[data-testid="scratchpad-navigation"]')!.getBoundingClientRect().width,
    document: document.querySelector('.scratchpad-page-pane.split')!.getBoundingClientRect().width,
  }));
  assert.equal(splitWidths.rail, 44, 'The global icon rail changed width when opening a connected page');
  assert.equal(splitWidths.navigationSidebar, 0, 'The main navigation should collapse in the connected page view');
  assert.ok(splitWidths.navigation >= 156, 'The Scratchpad page-navigation column collapsed');
  assert.ok(splitWidths.document > splitWidths.conversation * 0.9, `The page document pane is too narrow (${splitWidths.document}px vs ${splitWidths.conversation}px conversation)`);
  await ctx.screenshot(ctx.alphaPage!, '19a-agent-created-scratchpad-page');
  await pageNavigation.getByRole('button', { name: /Back to Your Personal Scratchpad/ }).click();
  await ctx.alphaPage!.getByTestId('scratchpad-library').waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByTestId('scratchpad-library').getByTestId('scratchpad-page-row').filter({ hasText: 'Team launch notes' }).click();
  await pane.getByRole('heading', { name: 'Team launch notes', exact: true }).waitFor({ state: 'visible' });

  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  const updateInstruction = 'E2E Scratchpad page — update the team launch notes';
  const updatePromptStart = ctx.mockModelPrompts.length;
  await ctx.createTask(ctx.alphaPage!, updateInstruction);
  const updateApproval = ctx.alphaPage!.getByTestId('page-action-approval');
  await updateApproval.waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.alphaPage!.locator('.timeline .pill.waiting').waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.waitFor(() => ctx.mockModelPrompts.length === updatePromptStart + 1, 10_000);
  assert.match(ctx.mockModelPrompts[updatePromptStart], /ID: [a-f0-9-]{36}\nTitle: Team launch notes/);
  await updateApproval.getByRole('button', { name: '拒绝并保持不变' }).click();
  await ctx.alphaPage!.locator('.timeline .pill.done').waitFor({ state: 'visible', timeout: 15_000 });
  const afterDecline = await ctx.alphaPage!.evaluate(async (id: string) => fetch(`/api/pages/${id}`).then(response => response.json()), alphaPageId) as { content: string };
  assert.match(afterDecline.content, /Review the short intro/);
  assert.doesNotMatch(afterDecline.content, /Revised outline/, 'The declined change modified the page');
  await ctx.screenshot(ctx.alphaPage!, '19b-declined-scratchpad-update');

  await ctx.clickNav(ctx.alphaPage!, 'Scratchpad');
  const pageList = ctx.alphaPage!.getByTestId('scratchpad-library');
  await pageList.getByTestId('scratchpad-page-row').filter({ hasText: 'Team launch notes' }).click();
  await pane.getByRole('heading', { name: 'Team launch notes', exact: true }).waitFor({ state: 'visible' });

  await pane.getByRole('button', { name: 'Edit' }).click();
  await pane.getByLabel('编辑页面标题').fill('Team launch notes revised');
  await pane.getByLabel('编辑页面内容').fill('## Release review\n- Approve the short intro\n- Confirm the release date');
  await pane.getByRole('button', { name: 'Save changes' }).click();
  await pane.getByRole('heading', { name: 'Team launch notes revised', exact: true }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, '19c-edited-scratchpad-page');

  await ctx.clickNav(ctx.alphaPage!, 'Scratchpad');
  const library = ctx.alphaPage!.getByTestId('scratchpad-library');
  await library.waitFor({ state: 'visible' });
  await library.getByTestId('scratchpad-page-row').filter({ hasText: 'Team launch notes revised' }).waitFor({ state: 'visible' });
  await library.getByLabel('页面标题').fill('Workspace research notes');
  await library.getByLabel('页面内容').fill('# Research\n- Compare two sources before sharing');
  await library.getByRole('button', { name: 'Create page' }).click();
  await ctx.alphaPage!.getByTestId('scratchpad-page').getByRole('heading', { name: 'Workspace research notes', exact: true }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByTestId('scratchpad-page').getByRole('button', { name: /Your Personal Scratchpad/ }).click();
  await library.getByTestId('scratchpad-page-row').filter({ hasText: 'Workspace research notes' }).waitFor({ state: 'visible' });
  assert.equal(await library.getByTestId('scratchpad-page-row').count(), 2, 'The user-created page was not persisted beside the agent-created page');
  const sharedPageId = await ctx.alphaPage!.evaluate(async () => {
    const pages = await fetch('/api/pages').then(response => response.json()) as { id: string; title: string }[];
    return pages.find(page => page.title === 'Workspace research notes')?.id || null;
  });
  assert(sharedPageId, 'The newly created tenant page was missing from the authenticated API');

  await ctx.selectTenant(ctx.betaPage!, 'Alpha Shared');
  await ctx.clickNav(ctx.betaPage!, 'Scratchpad');
  await ctx.betaPage!.getByTestId('scratchpad-page-row').filter({ hasText: 'Team launch notes revised' }).waitFor({ state: 'visible' });
  await ctx.betaPage!.getByTestId('scratchpad-page-row').filter({ hasText: 'Workspace research notes' }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.betaPage!, '19d-beta-shared-scratchpad');
  await ctx.selectTenant(ctx.betaPage!, 'Beta workspace');
  await ctx.clickNav(ctx.betaPage!, 'Scratchpad');
  await ctx.betaPage!.getByText('Your Scratchpad pages will appear here.', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await ctx.betaPage!.getByTestId('scratchpad-page-row').count(), 0, 'A shared-workspace page appeared in Beta personal Scratchpad');
  const privatePageResponse = await ctx.betaPage!.evaluate(async (id: string) => fetch(`/api/pages/${id}`).then(response => response.status), sharedPageId);
  assert.equal(privatePageResponse, 404, 'A Beta personal session retrieved an Alpha shared-workspace page by ID');
  await ctx.screenshot(ctx.betaPage!, '19e-beta-scratchpad-isolation');
}
