import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Entry } from '../../../src/server/keyring.ts';
import type { UiScenarioContext } from '../ui.e2e.ts';

export async function slackAuthorization(ctx: UiScenarioContext) {
  const contextPanel = ctx.alphaPage!.getByTestId('dot-context-panel');
  await contextPanel.getByRole('button', { name: 'Slack' }).click();
  const modal = ctx.alphaPage!.getByRole('dialog', { name: 'Set up Slack' });
  await modal.waitFor({ state: 'visible' });
  await modal.getByText('Your dot in', { exact: true }).waitFor({ state: 'visible' });
  const workspacePlaceholder = modal.locator('.slack-current-workspace.is-placeholder');
  await workspacePlaceholder.waitFor({ state: 'visible' });
  assert.match(await workspacePlaceholder.innerText(), /Workspace/);
  const connectButton = modal.getByRole('button', { name: 'Select a workspace' });
  assert.equal(await modal.getByTestId('slack-connect').innerText(), 'Select a workspace');
  assert.equal(await connectButton.isDisabled(), false);
  await ctx.screenshot(ctx.alphaPage!, 'slack-setup-empty-workspace');

  await modal.getByRole('button', { name: 'Close Slack setup' }).click();
  await modal.waitFor({ state: 'hidden' });
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'dark');
  await contextPanel.getByRole('button', { name: 'Slack' }).click();
  const darkModal = ctx.alphaPage!.getByRole('dialog', { name: 'Set up Slack' });
  await darkModal.waitFor({ state: 'visible' });
  assert.equal(await darkModal.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(7, 23, 14)');
  assert.equal(await darkModal.locator('.slack-setup-workspace-card').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(11, 33, 21)');
  const darkModalBounds = await darkModal.boundingBox();
  const slackViewport = ctx.alphaPage!.viewportSize();
  assert(darkModalBounds && slackViewport, 'Slack dialog and viewport bounds must be available');
  assert(Math.abs(darkModalBounds.x - Math.max(20, slackViewport.width * 0.0135)) <= 1, 'Slack dialog should use the observed left inset');
  assert(Math.abs(darkModalBounds.y - Math.max(20, slackViewport.height * 0.22)) <= 1, 'Slack dialog should use the observed top placement');
  await ctx.screenshot(ctx.alphaPage!, 'slack-setup-empty-workspace-dark');
  await darkModal.getByRole('button', { name: 'Close Slack setup' }).click();
  await darkModal.waitFor({ state: 'hidden' });
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  assert.equal(await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'light');
  await contextPanel.getByRole('button', { name: 'Slack' }).click();
  await modal.waitFor({ state: 'visible' });

  await Promise.all([
    ctx.alphaPage!.waitForURL(url => url.origin === ctx.mockSlackProviderOrigin && url.pathname === '/oauth/v2/authorize', { timeout: 10_000 }),
    connectButton.click(),
  ]);
  await ctx.alphaPage!.getByRole('heading', { name: 'Authorize Coke Dots for ASPI' }).waitFor({ state: 'visible' });
  await ctx.alphaPage!.getByText('Permission requested: chat:write', { exact: true }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, 'slack-mock-consent');
  await Promise.all([
    ctx.alphaPage!.waitForURL(url => url.origin === new URL(ctx.baseUrl).origin && url.pathname === '/', { timeout: 15_000 }),
    ctx.alphaPage!.getByRole('button', { name: 'Allow access' }).click(),
  ]);

  const connectedModal = ctx.alphaPage!.getByRole('dialog', { name: 'Set up Slack' });
  await connectedModal.waitFor({ state: 'visible', timeout: 15_000 });
  const workspace = connectedModal.getByRole('button', { name: 'Slack workspace' });
  await workspace.waitFor({ state: 'visible' });
  assert.match(await workspace.innerText(), /Workspace/);
  assert.equal(await connectedModal.getByTestId('slack-connect').innerText(), 'Select a workspace');
  await ctx.screenshot(ctx.alphaPage!, 'slack-workspace-available');
  await workspace.click();
  const workspaceMenu = connectedModal.getByRole('listbox', { name: 'Choose a Slack workspace' });
  await workspaceMenu.waitFor({ state: 'visible' });
  assert.deepEqual((await workspaceMenu.getByRole('option').allTextContents()).map(text => text.replace(/^✓/, '')), ['Choose a workspace', 'ASPI', 'Select another']);
  await workspaceMenu.getByRole('option', { name: 'ASPI' }).hover();
  await ctx.screenshot(ctx.alphaPage!, 'slack-workspace-menu-open');
  await connectedModal.getByRole('button', { name: 'Close Slack setup' }).click();
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  await contextPanel.getByRole('button', { name: 'Slack' }).click();
  const darkConnectedModal = ctx.alphaPage!.getByRole('dialog', { name: 'Set up Slack' });
  await darkConnectedModal.waitFor({ state: 'visible' });
  const darkWorkspace = darkConnectedModal.getByRole('button', { name: 'Slack workspace' });
  assert.match(await darkWorkspace.innerText(), /Workspace/);
  assert.equal(await darkConnectedModal.getByTestId('slack-connect').innerText(), 'Select a workspace');
  await ctx.screenshot(ctx.alphaPage!, 'slack-workspace-available-dark');
  await darkWorkspace.click();
  const darkWorkspaceMenu = darkConnectedModal.getByRole('listbox', { name: 'Choose a Slack workspace' });
  await darkWorkspaceMenu.waitFor({ state: 'visible' });
  await darkWorkspaceMenu.getByRole('option', { name: 'ASPI' }).hover();
  await ctx.screenshot(ctx.alphaPage!, 'slack-workspace-menu-open-dark');
  await darkWorkspaceMenu.getByRole('option', { name: 'ASPI' }).click();
  assert.match(await darkWorkspace.innerText(), /ASPI/);
  assert.equal(await darkConnectedModal.getByTestId('slack-connect').innerText(), 'Add to Slack');
  await ctx.screenshot(ctx.alphaPage!, 'slack-workspace-installed-dark');

  await darkConnectedModal.getByTestId('slack-connect').click();
  await darkConnectedModal.getByRole('status').filter({ hasText: /ASPI is selected for/ }).waitFor({ state: 'visible' });
  const tenantId = await ctx.alphaPage!.getByTestId('app-shell').getAttribute('data-tenant-id');
  assert(tenantId, 'The Alpha tenant id must be present before checking tenant-scoped Slack credentials');
  ctx.e2eSlackTokenAccount = `tenant-${createHash('sha256').update(`${tenantId}\0TASPIE2E`).digest('hex')}-slack-bot-token`;
  const storedToken = new Entry('com.cokepoppy.coke-dots.e2e', ctx.e2eSlackTokenAccount).getPassword();
  assert.equal(storedToken, 'xoxb-coke-dots-e2e-only-token', 'OAuth token should be persisted only in the isolated E2E keychain');
  const slackState = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/slack')).json()) as { installations: { teamId: string; teamName: string; contactEnabled: boolean }[] };
  assert.deepEqual(slackState.installations.map(item => ({ teamId: item.teamId, teamName: item.teamName, contactEnabled: item.contactEnabled })), [
    { teamId: 'TASPIE2E', teamName: 'ASPI', contactEnabled: true },
  ]);
  assert.equal(JSON.stringify(slackState).includes(storedToken), false, 'Slack OAuth token must not be returned by the API');
  await ctx.screenshot(ctx.alphaPage!, 'slack-workspace-selected');
  await darkConnectedModal.getByRole('button', { name: 'Close Slack setup' }).click();
  await ctx.alphaPage!.getByTestId('theme-toggle').click();
  const sqlite = new DatabaseSync(join(ctx.testDataDir, 'dots.db'), { readOnly: true });
  const storedInstallation = sqlite.prepare('SELECT team_id,team_name,scopes_json FROM slack_installations').all();
  sqlite.close();
  assert.equal(JSON.stringify(storedInstallation).includes(storedToken), false, 'Slack OAuth token must not be stored in SQLite');
  assert.equal(ctx.mockSlackCodeExchanges, 1, 'Chrome should complete exactly one Slack OAuth code exchange');
}

export async function dingtalkGroups(ctx: UiScenarioContext) {
  const contextPanel = ctx.alphaPage!.getByTestId('dot-context-panel');
  await ctx.alphaPage!.getByTestId('task-composer').fill('保留的钉钉设置草稿');
  await contextPanel.getByRole('button', { name: '钉钉' }).click();
  const modal = ctx.alphaPage!.getByRole('dialog', { name: '连接钉钉' });
  await modal.waitFor({ state: 'visible' });
  await modal.getByTestId('dingtalk-authorize').click();
  await modal.getByTestId('dingtalk-user-code').waitFor({ state: 'visible' });
  assert.equal(await modal.getByTestId('dingtalk-user-code').innerText(), 'E2E-CODE');
  assert.equal(await modal.getByRole('link', { name: '打开钉钉授权页面' }).getAttribute('href'), 'https://login.dingtalk.com/oauth2/device?user_code=E2E-CODE');
  await ctx.screenshot(ctx.alphaPage!, 'dingtalk-device-authorization');
  await modal.getByRole('button', { name: '关闭钉钉设置' }).click();
  await contextPanel.getByRole('button', { name: '钉钉' }).click();
  const resumedModal = ctx.alphaPage!.getByRole('dialog', { name: '连接钉钉' });
  await resumedModal.getByTestId('dingtalk-user-code').waitFor({ state: 'visible' });
  assert.equal(await resumedModal.getByTestId('dingtalk-user-code').innerText(), 'E2E-CODE', 'Reopening the connector must resume the pending device authorization');
  await ctx.screenshot(ctx.alphaPage!, 'dingtalk-resumed-device-authorization');
  await resumedModal.getByTestId('dingtalk-e2e-authorize').click();
  await resumedModal.getByTestId('dingtalk-connected-state').waitFor({ state: 'visible' });
  assert.match(await resumedModal.getByTestId('dingtalk-connected-state').innerText(), /测试钉钉账号/);
  const appStreamStatus = resumedModal.getByTestId('dingtalk-app-stream-status');
  await appStreamStatus.waitFor({ state: 'visible' });
  assert.match(await appStreamStatus.innerText(), /Dots 应用机器人 Stream/);
  assert.match(await resumedModal.getByTestId('dingtalk-app-stream-status-label').innerText(), /测试模拟 · 已连接/);
  assert.match(await appStreamStatus.innerText(), /与个人账号的 DWS 群监听分开/);
  await resumedModal.getByTestId('dingtalk-dws-test-mode').waitFor({ state: 'visible' });
  assert.match(await resumedModal.getByTestId('dingtalk-dws-test-mode').innerText(), /模拟的 DWS 个人事件监听/);
  await ctx.screenshot(ctx.alphaPage!, 'dingtalk-stream-status-boundaries');
  const documentFlow = await ctx.alphaPage!.evaluate(async () => {
    const createdResponse = await fetch('/api/dingtalk/docs/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Chrome E2E 故障报告', content: '# Trace chrome-e2e\n已完成模拟排查', confirmed: true,
    }) });
    const created = { status: createdResponse.status, data: await createdResponse.json() };
    const nodeId = created.data.nodeId as string;
    const fetchedResponse = await fetch('/api/dingtalk/docs/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: nodeId }) });
    const fetched = { status: fetchedResponse.status, data: await fetchedResponse.json() };
    const searchedResponse = await fetch('/api/dingtalk/docs/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'chrome-e2e', limit: 10 }) });
    const searched = { status: searchedResponse.status, data: await searchedResponse.json() };
    const updateWithoutConfirmationResponse = await fetch('/api/dingtalk/docs/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', node: nodeId, command: 'append', content: '禁止写入', confirmed: false,
    }) });
    const updateWithoutConfirmation = { status: updateWithoutConfirmationResponse.status, data: await updateWithoutConfirmationResponse.json() };
    const updatedResponse = await fetch('/api/dingtalk/docs/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', node: nodeId, command: 'append', content: '已确认写入', confirmed: true,
    }) });
    const updated = { status: updatedResponse.status, data: await updatedResponse.json() };
    const fetchedAfterUpdateResponse = await fetch('/api/dingtalk/docs/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: nodeId }) });
    const fetchedAfterUpdate = { status: fetchedAfterUpdateResponse.status, data: await fetchedAfterUpdateResponse.json() };
    return { created, fetched, searched, updateWithoutConfirmation, updated, fetchedAfterUpdate };
  });
  assert.equal(documentFlow.created.status, 200, 'Signed-in Chrome could not create a simulated DingTalk document');
  assert.equal(documentFlow.created.data.verified, true, 'Document creation must return a verified DWS operation receipt');
  assert.equal(documentFlow.fetched.status, 200);
  assert.match(JSON.stringify(documentFlow.fetched.data.content), /已完成模拟排查/);
  assert.equal(documentFlow.searched.data.count, 1);
  assert.equal(documentFlow.updateWithoutConfirmation.status, 400, 'Document update must stop without explicit confirmation');
  assert.equal(documentFlow.updated.status, 200);
  assert.match(JSON.stringify(documentFlow.fetchedAfterUpdate.data.content), /已确认写入/);
  const groupListResponse = ctx.alphaPage!.waitForResponse(response => response.url().includes('/api/dingtalk/groups/list') && response.request().method() === 'POST');
  await resumedModal.getByTestId('dingtalk-group-list').click();
  const groupList = await groupListResponse;
  assert.equal(groupList.status(), 200, `Joined-group list API failed: ${groupList.status()} ${await groupList.text()}`);
  const groupListBody = await groupList.json() as { groups: { conversationId: string; name: string }[]; complete: boolean; hasMore: boolean; failureCount: number };
  assert.equal(groupListBody.complete, true, 'The UI must receive an explicit complete result before claiming all groups were loaded');
  assert.equal(groupListBody.hasMore, false);
  assert.equal(groupListBody.failureCount, 0);
  assert.deepEqual(groupListBody.groups, [{ conversationId: 'e2e-incident-alerts', name: '系统监控告警群' }]);
  await resumedModal.getByTestId('dingtalk-group-list-complete').waitFor({ state: 'visible' });
  assert.match(await resumedModal.getByTestId('dingtalk-group-list-complete').innerText(), /全部群聊，共 1 个/);
  await resumedModal.getByRole('group', { name: '我加入的钉钉群聊' }).getByText('系统监控告警群').waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, 'dingtalk-my-groups');
  const groupQuery = resumedModal.getByTestId('dingtalk-group-query');
  await groupQuery.fill('e2e-unmatched-group');
  await resumedModal.getByTestId('dingtalk-group-search').click();
  const emptyGroups = resumedModal.getByTestId('dingtalk-group-empty-state');
  await emptyGroups.waitFor({ state: 'visible' });
  assert.match(await emptyGroups.innerText(), /没有找到.*e2e-unmatched-group/);
  await groupQuery.fill('系统告警');
  assert.equal(await emptyGroups.count(), 0, 'Changing the query must clear the previous empty-state result');
  await resumedModal.getByTestId('dingtalk-group-search').click();
  const result = resumedModal.getByRole('group', { name: '钉钉群搜索结果' }).getByText('系统监控告警群');
  await result.waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, 'dingtalk-group-search');
  const groupCheckbox = resumedModal.getByRole('checkbox');
  await groupCheckbox.check();
  assert.equal(await resumedModal.getByTestId('dingtalk-selection-state').innerText(), '待保存群聊');
  const saveGroupsButton = resumedModal.getByTestId('dingtalk-groups-save');
  assert.equal(await saveGroupsButton.isEnabled(), true);
  const monitorRefreshRoute = '**/api/dingtalk/monitors';
  await ctx.alphaPage!.route(monitorRefreshRoute, route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'simulated monitor refresh outage' }) });
    return route.continue();
  });
  await saveGroupsButton.click();
  await resumedModal.getByRole('alert').filter({ hasText: '群选择已保存，但监听状态刷新失败' }).waitFor({ state: 'visible' });
  const persistedAfterRefreshFailure = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/dingtalk/groups/selected')).json()) as { conversationId: string; name: string }[];
  assert.deepEqual(persistedAfterRefreshFailure, [{ conversationId: 'e2e-incident-alerts', name: '系统监控告警群' }], 'A failed follow-up read must not conceal or undo a committed group selection');
  assert.equal(await resumedModal.getByTestId('dingtalk-selection-state').innerText(), '已保存群聊');
  assert.equal(await saveGroupsButton.isEnabled(), false, 'A committed selection must not remain actionable as an unsaved change');
  await ctx.alphaPage!.unroute(monitorRefreshRoute);
  await resumedModal.getByRole('button', { name: '重试读取钉钉状态' }).click();
  await resumedModal.getByRole('alert').waitFor({ state: 'hidden' });
  assert.equal(await resumedModal.getByTestId('dingtalk-selection-state').innerText(), '已保存群聊', 'Refreshing state must preserve the saved selection baseline');
  await groupCheckbox.uncheck();
  assert.equal(await saveGroupsButton.isEnabled(), true, 'Changing the selected group must re-enable Save');
  await resumedModal.getByTestId('dingtalk-groups-save').click();
  await resumedModal.getByRole('status').filter({ hasText: '是否开始监听，需要为每个群单独开启' }).waitFor({ state: 'visible' });
  assert.deepEqual(await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/dingtalk/groups/selected')).json()), [], 'Removing the selected group must persist cleanly');
  await groupCheckbox.check();
  assert.equal(await saveGroupsButton.isEnabled(), true);
  await saveGroupsButton.click();
  await resumedModal.getByRole('status').filter({ hasText: '是否开始监听，需要为每个群单独开启' }).waitFor({ state: 'visible' });
  const savedGroups = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/dingtalk/groups/selected')).json()) as { conversationId: string; name: string }[];
  assert.deepEqual(savedGroups, [{ conversationId: 'e2e-incident-alerts', name: '系统监控告警群' }]);
  assert.equal(await resumedModal.getByTestId('dingtalk-selection-state').innerText(), '已保存群聊');
  assert.equal(await saveGroupsButton.isEnabled(), false, 'The Save button must disable after a successful save');
  assert.equal(JSON.stringify(savedGroups).includes('tenantId'), false, 'The UI DTO must not expose internal tenant/user database fields');
  const incidentMonitor = resumedModal.getByTestId('dingtalk-monitor-e2e-incident-alerts');
  await incidentMonitor.waitFor({ state: 'visible' });
  assert.equal(await incidentMonitor.isEnabled(), false, 'A group monitor must stay off until it has an explicit event filter');
  const keywordEditor = resumedModal.getByTestId('dingtalk-keywords-e2e-incident-alerts');
  await keywordEditor.fill('告警, Trace ID, 500');
  const keywordSaveResponse = ctx.alphaPage!.waitForResponse(response => response.url().includes('/api/dingtalk/monitors') && response.request().method() === 'PUT');
  await resumedModal.getByTestId('dingtalk-save-keywords-e2e-incident-alerts').click();
  const keywordResponse = await keywordSaveResponse;
  assert.equal(keywordResponse.status(), 200, `Monitor criteria API failed: ${keywordResponse.status()} ${await keywordResponse.text()}`);
  assert.equal(await incidentMonitor.isEnabled(), true, 'Saving event filters should allow an explicit monitor opt-in');
  const configuredMonitors = await ctx.alphaPage!.evaluate(async () => await (await fetch('/api/dingtalk/monitors')).json()) as { groups: { conversationId: string; keywords: string[] }[] };
  assert.deepEqual(configuredMonitors.groups[0]?.keywords, ['告警', 'Trace ID', '500']);
  const monitorSaveResponse = ctx.alphaPage!.waitForResponse(response => response.url().includes('/api/dingtalk/monitors') && response.request().method() === 'PUT');
  await incidentMonitor.click();
  const monitorResponse = await monitorSaveResponse;
  const monitorResponseBody = await monitorResponse.text();
  assert.equal(monitorResponse.status(), 200, `Monitor opt-in API failed: ${monitorResponse.status()} ${monitorResponseBody}`);
  assert.equal(await incidentMonitor.isChecked(), true, 'The monitor should visibly turn on after the user opts in');
  await resumedModal.getByText('监听中 · 收到消息后自动启动 Pi 排查').waitFor({ state: 'visible', timeout: 5000 });
  await ctx.screenshot(ctx.alphaPage!, 'dingtalk-selected-group');
  const monitorStatus = resumedModal.getByTestId('dingtalk-monitor-status-e2e-incident-alerts');
  const monitorStatusRoute = '**/api/dingtalk/monitors';
  await ctx.alphaPage!.route(monitorStatusRoute, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    stream: { configured: true, connected: true, ready: true, testOnly: true },
    groups: [{ conversationId: 'e2e-incident-alerts', groupName: '系统监控告警群', enabled: true, keywords: ['告警', 'Trace ID', '500'], canEnable: true,
      listenerState: 'reconnecting', listenerIssue: 'authorization-expired' }],
  }) }));
  try {
    await monitorStatus.getByText('钉钉授权已过期 · 请重新连接账号', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    await ctx.screenshot(ctx.alphaPage!, 'dingtalk-monitor-expired-authorization');
  } finally { await ctx.alphaPage!.unroute(monitorStatusRoute); }
  await resumedModal.getByRole('button', { name: '关闭钉钉设置' }).click();
  assert.equal(await ctx.alphaPage!.getByTestId('task-composer').inputValue(), '保留的钉钉设置草稿', 'Opening the connector must preserve the chat draft');
  assert.equal(await ctx.alphaPage!.evaluate(async () => JSON.stringify(await (await fetch('/api/dingtalk')).json()).includes('token')), false, 'The account status API must not return credentials');
}

export async function dingtalkAlerts(ctx: UiScenarioContext) {
  await ctx.clickNav(ctx.alphaPage!, '你的 dot');
  await ctx.alphaPage!.getByTestId('dot-context-panel').getByRole('button', { name: '钉钉' }).click();
  const modal = ctx.alphaPage!.getByRole('dialog', { name: '连接钉钉' });
  await modal.waitFor({ state: 'visible' });
  const monitor = modal.getByTestId('dingtalk-monitor-e2e-incident-alerts');
  await monitor.waitFor({ state: 'visible' });
  assert.equal(await monitor.isChecked(), true, 'The user opt-in must survive closing and reopening the connector');
  const requestStart = ctx.mockModelRequests.length;
  const unrelated = { messageId: 'e2e-stream-chat-001', conversationId: 'e2e-incident-alerts', text: '大家下午三点开会' };
  const ignored = await ctx.alphaPage!.evaluate(async (payload) => {
    const response = await fetch('/api/dingtalk/e2e/stream-message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as { kind: string; taskId: string | null } };
  }, unrelated);
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.kind, 'ignored', 'An ordinary chat message should not start an Agent task when it does not match the saved criteria');
  assert.equal(ignored.body.taskId, null);
  const event = { messageId: 'e2e-stream-alert-001', conversationId: 'e2e-incident-alerts', text: '支付 API 返回 500，Trace ID: e2e-trace-2026' };
  const accepted = await ctx.alphaPage!.evaluate(async (payload) => {
    const response = await fetch('/api/dingtalk/e2e/stream-message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as { kind: string; taskId: string | null; testOnly: boolean; engine: string } };
  }, event);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.kind, 'queued');
  assert.equal(accepted.body.testOnly, true);
  assert.equal(accepted.body.engine, 'model', 'The isolated browser harness uses its fake Model API; production Stream tasks default to Pi');
  assert(accepted.body.taskId, 'The accepted alert should create a task in Alpha personal workspace');
  await ctx.alphaPage!.waitForFunction(async (taskId: string) => {
    const state = await (await fetch('/api/state')).json() as { tasks: { id: string; status: string; engine: string; instruction: string; result: string | null }[] };
    const task = state.tasks.find(item => item.id === taskId);
    return task?.status === 'done' && task.engine === 'model' && task.instruction.includes('e2e-trace-2026') && task.result?.includes('尚未接入日志平台');
  }, accepted.body.taskId!, { timeout: 20_000 });
  await ctx.waitFor(() => ctx.mockModelRequests.slice(requestStart).some(request => request.prompt.includes('e2e-trace-2026')), 5_000);
  const modelRequest = ctx.mockModelRequests.slice(requestStart).find(request => request.prompt.includes('e2e-trace-2026'));
  assert.match(modelRequest?.prompt || '', /外部不可信数据/);
  assert.match(modelRequest?.prompt || '', /不要修改代码、写入业务系统/);
  const completedTask = await ctx.alphaPage!.evaluate(async (taskId: string) => (await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; result: string | null }[] }).tasks.find(task => task.id === taskId), accepted.body.taskId!);
  assert.match(completedTask?.result || '', /尚未接入日志平台/);
  assert.match(completedTask?.result || '', /没有查询 Trace、修改代码或创建 PR/);
  const duplicate = await ctx.alphaPage!.evaluate(async (payload) => {
    const response = await fetch('/api/dingtalk/e2e/stream-message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as { kind: string; taskId: string | null } };
  }, event);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.kind, 'duplicate');
  assert.equal(duplicate.body.taskId, null, 'A provider retry must not create a second task');
  const betaState = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/state')).json()) as { tasks: { instruction: string }[] };
  assert.equal(betaState.tasks.some(task => task.instruction.includes('e2e-trace-2026')), false, 'The external alert must not cross into a different Google tenant');
  const betaMonitors = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/dingtalk/monitors')).json()) as { groups: unknown[] };
  assert.deepEqual(betaMonitors.groups, [], 'The second Google tenant must not inherit Alpha group monitor state');
  const alphaIncidents = await ctx.alphaPage!.evaluate(async () => {
    const response = await fetch('/api/dingtalk/incidents');
    return { status: response.status, body: await response.json() as { taskId: string; groupName: string; title: string; status: string; createdAt: string }[] };
  });
  assert.equal(alphaIncidents.status, 200);
  assert.equal(alphaIncidents.body.length, 1);
  assert.deepEqual(Object.keys(alphaIncidents.body[0]!).sort(), ['createdAt', 'groupName', 'status', 'taskId', 'title']);
  assert.deepEqual(alphaIncidents.body[0], {
    taskId: accepted.body.taskId!, groupName: '系统监控告警群', title: alphaIncidents.body[0]!.title,
    status: 'done', createdAt: alphaIncidents.body[0]!.createdAt,
  }, 'The incident API should expose only the event-to-task summary and current task status');
  assert.match(alphaIncidents.body[0]!.title, /^钉钉告警：支付 API 返回 500/);
  assert(Number.isFinite(Date.parse(alphaIncidents.body[0]!.createdAt)), 'The incident timestamp should be a valid ISO date');
  const betaIncidents = await ctx.betaPage!.evaluate(async () => await (await fetch('/api/dingtalk/incidents')).json()) as unknown[];
  assert.deepEqual(betaIncidents, [], 'Incident history must remain tenant-isolated');
  const incidentRow = modal.getByTestId(`dingtalk-incident-${accepted.body.taskId}`);
  await incidentRow.waitFor({ state: 'visible', timeout: 5000 });
  await incidentRow.click();
  await modal.waitFor({ state: 'hidden' });
  await ctx.alphaPage!.locator('.timeline').getByText('e2e-trace-2026', { exact: false }).waitFor({ state: 'visible' });
  await ctx.screenshot(ctx.alphaPage!, 'dingtalk-alert-task-complete');
}
