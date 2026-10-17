import assert from 'node:assert/strict';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function scheduleControls(ctx: UiScenarioContext) {
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.createTask(ctx.alphaPage!, ctx.scheduledTask, true);
  await ctx.clickNav(ctx.alphaPage!, 'Scheduled');
  await ctx.alphaPage!.getByTestId('scheduled-hub').waitFor({ state: 'visible' });
  const item = ctx.alphaPage!.locator('.scheduled-item').filter({ hasText: ctx.scheduledTask });
  await item.waitFor({ state: 'visible', timeout: 10_000 });
  const detail = ctx.alphaPage!.getByTestId('scheduled-detail');
  await detail.getByText('Every 60 minutes', { exact: true }).waitFor({ state: 'visible' });
  assert.ok((await detail.innerText()).includes(ctx.scheduledTask));
  await detail.getByText('Failed', { exact: true }).waitFor({ state: 'visible' });
  assert.match(await detail.innerText(), /内核尚未配置或安装/);
  assert.match(await detail.locator('.scheduled-detail-meta').innerText(), /Next run: Not scheduled/);
  const search = ctx.alphaPage!.getByLabel('Search scheduled tasks');
  await search.fill('no matching schedule');
  await ctx.alphaPage!.getByText('No matching tasks').first().waitFor({ state: 'visible' });
  await search.fill(ctx.scheduledTask);
  await item.click();
  assert.equal(await ctx.alphaPage!.locator('.sidebar').evaluate(element => getComputedStyle(element).display), 'none', 'Scheduled should use the compact single-rail work layout');
  assert.equal(await ctx.alphaPage!.locator('.icon-rail').evaluate(element => Math.round(element.getBoundingClientRect().width)), 44);
  assert.equal(await ctx.alphaPage!.getByTestId('surface-switcher').isVisible(), false, 'The Chat/Work switch should be hidden inside Scheduled');
  assert.equal(await ctx.alphaPage!.getByTestId('theme-toggle').isVisible(), true, 'Theme control should remain available inside Scheduled');
  assert.equal(await ctx.alphaPage!.locator('.workspace-switcher select').isVisible(), true, 'Workspace switching should remain available inside Scheduled');
  assert.equal(await ctx.alphaPage!.locator('.scheduled-detail-pane').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)', 'Scheduled should follow the light account theme');
  await ctx.screenshot(ctx.alphaPage!, '07-scheduled');
  await ctx.clickNav(ctx.alphaPage!, '新聊天');
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  await ctx.clickNav(ctx.alphaPage!, 'Scheduled');
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'dark');
  assert.equal(await ctx.alphaPage!.locator('.scheduled-detail-pane').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(13, 13, 15)', 'Scheduled should follow the dark account theme');
  await ctx.screenshot(ctx.alphaPage!, '07-scheduled-dark');
  await ctx.clickNav(ctx.alphaPage!, '新聊天');
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  await ctx.clickNav(ctx.alphaPage!, 'Scheduled');
  await search.fill(ctx.scheduledTask);
  await ctx.alphaPage!.locator('.scheduled-item').filter({ hasText: ctx.scheduledTask }).click();
  await ctx.alphaPage!.locator('.scheduled-add-watch').click();
  assert.equal(await ctx.alphaPage!.locator('.scheduled-add-watch').getAttribute('aria-expanded'), 'true');
  await ctx.alphaPage!.getByLabel('HTTPS URL').waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByRole('button', { name: 'Close monitor form' }).click();
  await detail.getByRole('button', { name: 'Open conversation' }).click();
  await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: ctx.scheduledTask }).waitFor({ state: 'visible' });
  await ctx.clickNav(ctx.alphaPage!, 'Scheduled');
  await ctx.alphaPage!.getByTestId('scheduled-detail').getByRole('button', { name: 'Cancel schedule' }).click();
  await ctx.alphaPage!.getByText('No scheduled tasks yet').first().waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByTestId('scheduled-new-task').click();
  assert.equal(await ctx.alphaPage!.getByLabel('定期检查').isChecked(), true, 'New task from Scheduled did not enable the recurring-work option');
  await ctx.alphaPage!.getByLabel('重复频率').selectOption('weekly');
  await ctx.alphaPage!.getByLabel('星期一').check();
  await ctx.alphaPage!.getByLabel('定时时间').fill('23:59');
  await ctx.alphaPage!.getByLabel('时区').selectOption('Asia/Shanghai');
  const scheduleEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await ctx.alphaPage!.getByLabel('结束日期').fill(scheduleEndDate);
  await ctx.screenshot(ctx.alphaPage!, '07b-weekly-schedule-editor');
  const weeklyTask = 'E2E weekly schedule — summarize the Monday planning changes';
  await ctx.alphaPage!.getByTestId('task-composer').fill(weeklyTask);
  await ctx.alphaPage!.locator('button.send').click();
  await ctx.alphaPage!.locator('.timeline .message.user p').filter({ hasText: weeklyTask }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.waitForFunction(() => document.querySelector<HTMLInputElement>('.schedule-toggle input[type="checkbox"]')?.checked === false);
  await ctx.clickNav(ctx.alphaPage!, 'Scheduled');
  await ctx.alphaPage!.locator('.scheduled-item').filter({ hasText: weeklyTask }).waitFor({ state: 'visible' });
  const weeklyDetail = ctx.alphaPage!.getByTestId('scheduled-detail');
  await weeklyDetail.getByText('Weekly on Mon at 23:59 (Asia/Shanghai)', { exact: false }).waitFor({ state: 'visible' });
  assert.match(await weeklyDetail.innerText(), new RegExp(`until ${scheduleEndDate}`));
  await ctx.screenshot(ctx.alphaPage!, '07c-weekly-scheduled');
  await weeklyDetail.getByRole('button', { name: 'Cancel schedule' }).click();
}

export async function automationIdeas(ctx: UiScenarioContext) {
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  const proposal = 'E2E automation ideas — ten ideas only';
  await ctx.createTask(ctx.alphaPage!, proposal);
  await ctx.alphaPage!.locator('.timeline .pill.done').waitFor({ state: 'visible', timeout: 15_000 });
  const ideas = ctx.alphaPage!.locator('.timeline .message.dot p').filter({ hasText: 'Morning operator brief' });
  await ideas.waitFor({ state: 'visible' });
  const answer = await ideas.innerText();
  assert.match(answer, /Admin and renewal radar/);
  assert.match(answer, /These are ideas, not activated routines/);
  const proposalPrompt = ctx.mockModelPrompts.find(prompt => prompt.includes(proposal)) || '';
  assert.match(proposalPrompt, /keep them as inactive proposals and choose done/);
  await ctx.clickNav(ctx.alphaPage!, 'Scheduled');
  await ctx.alphaPage!.getByText('No scheduled tasks yet').first().waitFor({ state: 'visible' });
  assert.equal(await ctx.alphaPage!.locator('.scheduled-item').count(), 0, 'Discussing ideas must not create a Scheduled entry');
  await ctx.screenshot(ctx.alphaPage!, '07-automation-proposals-unscheduled');
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
}

export async function recurringWork(ctx: UiScenarioContext) {
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha workspace');
  const instruction = 'E2E recurring run — verify due work reruns automatically';
  const promptCount = () => ctx.mockModelPrompts.filter(prompt => prompt.includes(instruction)).length;
  const initialCount = promptCount();
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.alphaPage!.getByLabel('定期检查').check();
  await ctx.alphaPage!.getByLabel('重复频率').selectOption('interval');
  await ctx.alphaPage!.locator('input.minutes').fill('1');
  await ctx.alphaPage!.getByTestId('task-composer').fill(instruction);
  await ctx.alphaPage!.locator('button.send').click();
  await ctx.alphaPage!.locator('.timeline .message.dot p').filter({ hasText: 'The recurring check completed.' }).waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.alphaPage!.locator('.timeline .pill.scheduled').waitFor({ state: 'visible', timeout: 15_000 });
  await ctx.waitFor(() => promptCount() === initialCount + 1, 15_000);
  await ctx.screenshot(ctx.alphaPage!, '07d-recurring-run-completed');

  await ctx.waitFor(() => promptCount() === initialCount + 2, 80_000);
  await ctx.alphaPage!.waitForFunction(async instructionText => {
    const response = await fetch('/api/state');
    const state = await response.json() as { tasks: { instruction: string; status: string; nextRunAt: string | null }[] };
    const task = state.tasks.find(item => item.instruction === instructionText);
    return task?.status === 'scheduled' && Boolean(task.nextRunAt) && Date.parse(task.nextRunAt!) > Date.now();
  }, instruction, { timeout: 20_000 });

  await ctx.clickNav(ctx.alphaPage!, 'Activity');
  const activityCard = ctx.alphaPage!.locator('.task-card').filter({ hasText: instruction });
  await activityCard.waitFor({ state: 'visible' });
  assert.equal(await activityCard.getByRole('button', { name: '暂停' }).count(), 0, 'A recurring run exposed the one-off Pause action in Activity');
  await ctx.screenshot(ctx.alphaPage!, '07f-recurring-task-activity-controls');
  const pauseResult = await ctx.alphaPage!.evaluate(async (goal: string) => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; instruction: string; status: string; nextRunAt: string | null }[] };
    const task = state.tasks.find(item => item.instruction === goal);
    if (!task) throw new Error('Recurring task missing from state');
    const response = await fetch(`/api/tasks/${task.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }) });
    const after = await fetch('/api/state').then(result => result.json()) as { tasks: { id: string; status: string; nextRunAt: string | null }[] };
    return { statusCode: response.status, before: task, after: after.tasks.find(item => item.id === task.id) };
  }, instruction);
  assert.equal(pauseResult.statusCode, 409, 'The server allowed a recurring task to be paused outside Scheduled');
  assert.equal(pauseResult.after?.status, 'scheduled', 'Rejected pause changed the recurring task status');
  assert.equal(pauseResult.after?.nextRunAt, pauseResult.before.nextRunAt, 'Rejected pause removed the next recurring run');

  await ctx.clickNav(ctx.alphaPage!, 'Scheduled');
  const item = ctx.alphaPage!.locator('.scheduled-item').filter({ hasText: instruction });
  await item.waitFor({ state: 'visible' });
  await item.click();
  const detail = ctx.alphaPage!.getByTestId('scheduled-detail');
  await detail.getByText('Every 1 minute', { exact: true }).waitFor({ state: 'visible' });
  await detail.getByText('The recurring check completed.', { exact: false }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, '07e-recurring-run-rescheduled');
  await detail.getByRole('button', { name: 'Cancel schedule' }).click();
  await item.waitFor({ state: 'detached' });
  assert.equal(promptCount(), initialCount + 2, 'The interval did not trigger exactly one automatic follow-up run');
  await ctx.selectTenant(ctx.alphaPage!, 'Alpha Shared');
}
