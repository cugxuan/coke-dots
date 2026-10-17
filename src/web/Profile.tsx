import { useEffect, useState } from 'react';
import type { Snapshot } from '../shared/types.ts';
import type { AuthContext, TenantMember, WorkspaceInvitation, TenantMemory } from './ui-types.ts';
import { appFetch, request } from './api.ts';
import { DotAvatar } from './DotAvatar.tsx';
import { DotMemoryManager } from './DotMemoryManager.tsx';
import { PermissionRules } from './PermissionRules.tsx';

export function Profile({ state, auth, onError, onEditAppearance, onManageComputerAccess, onStartCall }: { state: Snapshot; auth: AuthContext; onError: (s: string) => void; onEditAppearance: () => void; onManageComputerAccess: () => void; onStartCall: () => void }) {
  const [name, setName] = useState(state.profile.name);
  const [baseUrl, setBaseUrl] = useState(state.modelSettings.baseUrl || 'https://api.openai.com/v1');
  const [model, setModel] = useState(state.modelSettings.model);
  const [apiKey, setApiKey] = useState('');
  const [desktopNotifications, setDesktopNotifications] = useState(state.preferences.desktopNotifications);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [memberNotice, setMemberNotice] = useState('');
  const [membersError, setMembersError] = useState('');
  const [memories, setMemories] = useState<TenantMemory[]>([]);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [editingMemory, setEditingMemory] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);
  const canManageSharedModel = ['owner', 'admin'].includes(auth.tenant.role)
    && (!state.modelSettings.adminTenantId || state.modelSettings.adminTenantId === auth.tenant.id);
  const refreshMembers = async () => {
    const response = await appFetch(`/api/tenants/${auth.tenant.id}/members`);
    if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    setMembers(await response.json() as TenantMember[]);
    if (['owner', 'admin'].includes(auth.tenant.role)) {
      const inviteResponse = await appFetch(`/api/tenants/${auth.tenant.id}/invitations`);
      if (!inviteResponse.ok) throw new Error((await inviteResponse.json()).error || `HTTP ${inviteResponse.status}`);
      setInvitations(await inviteResponse.json() as WorkspaceInvitation[]);
    } else setInvitations([]);
  };
  useEffect(() => { setName(state.profile.name); }, [state.profile.name]);
  useEffect(() => { setDesktopNotifications(state.preferences.desktopNotifications); }, [state.preferences.desktopNotifications]);
  useEffect(() => { if (state.modelSettings.baseUrl) setBaseUrl(state.modelSettings.baseUrl); if (state.modelSettings.model) setModel(state.modelSettings.model); }, [state.modelSettings.baseUrl, state.modelSettings.model]);
  useEffect(() => { void refreshMembers().catch(error => setMembersError(String(error))); }, [auth.tenant.id]);
  useEffect(() => {
    let active = true;
    setMemoryDraft(''); setEditingMemory(null); setEditingDraft(''); setMemoryError(''); setMemories([]);
    void appFetch('/api/memories').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setMemories(data as TenantMemory[]);
    }).catch(error => { if (active) setMemoryError(String(error)); });
    return () => { active = false; };
  }, [auth.tenant.id]);
  async function addMemory() {
    setMemoryBusy(true); setMemoryError('');
    try {
      const memory = await request('/memories', 'POST', { note: memoryDraft }) as TenantMemory;
      setMemories(current => [memory, ...current]); setMemoryDraft('');
    } catch (error) { setMemoryError(String(error)); }
    finally { setMemoryBusy(false); }
  }
  async function saveMemory(memory: TenantMemory) {
    setMemoryBusy(true); setMemoryError('');
    try {
      const updated = await request(`/memories/${memory.id}`, 'PATCH', { note: editingDraft }) as TenantMemory;
      setMemories(current => current.map(item => item.id === updated.id ? updated : item)); setEditingMemory(null); setEditingDraft('');
    } catch (error) { setMemoryError(String(error)); }
    finally { setMemoryBusy(false); }
  }
  async function removeMemory(memory: TenantMemory) {
    setMemoryBusy(true); setMemoryError('');
    try {
      const response = await appFetch(`/api/memories/${memory.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setMemories(current => current.filter(item => item.id !== memory.id));
    } catch (error) { setMemoryError(String(error)); }
    finally { setMemoryBusy(false); }
  }
  return <section className="content profile-content">
    <div className="section-heading"><h1>你的 dot</h1><p>给它起个名字，选择一个外观。</p></div>
    <div className="profile-card">
      <DotAvatar appearance={state.profile} />
      <button type="button" className="primary" data-testid="profile-voice-call-launch" aria-label={`拨打 ${state.profile.name}`} onClick={onStartCall}>拨打 {state.profile.name}</button>
      <button type="button" className="avatar-profile-customize" onClick={onEditAppearance}>Customize your dot</button>
      <label>名字<input maxLength={40} value={name} onChange={e => setName(e.target.value)} /></label>
      <button className="primary" onClick={async () => { try { await request('/profile', 'PATCH', { name }); } catch (e) { onError(String(e)); } }}>保存更改</button>
    </div>
    <div className="section-heading model-heading"><h2>电脑访问</h2><p>管理 Dot 是否可以使用本机上的隔离 Chrome 工作区。</p></div>
    <div className="profile-card model-card computer-access-card">
      <p>{state.computerAccess.localComputer ? '已允许 Dot 使用本机隔离 Chrome 工作区。' : '已关闭本机 Chrome 工作区访问。'}</p>
      <small>当前版本不连接 Mac 文件或其他应用。</small>
      <button className="primary" disabled={!['owner', 'admin'].includes(auth.tenant.role)} onClick={onManageComputerAccess}>更改电脑访问</button>
      {!['owner', 'admin'].includes(auth.tenant.role) && <small>只有工作区所有者或管理员可以更改此设置。</small>}
    </div>
    <div className="section-heading model-heading"><h2>通知</h2><p>后台工作需要你处理或完成时，在这台 Mac 上提醒你。</p></div>
    <div className="profile-card model-card notification-card">
      <label className="notification-toggle"><input aria-label="桌面通知" type="checkbox" checked={desktopNotifications} disabled={notificationBusy} onChange={async event => { const enabled = event.currentTarget.checked; setNotificationBusy(true); setDesktopNotifications(enabled); try { await request('/preferences', 'PATCH', { desktopNotifications: enabled }); } catch (error) { setDesktopNotifications(!enabled); onError(String(error)); } finally { setNotificationBusy(false); } }} /><span><strong>桌面通知</strong><small>{desktopNotifications ? '此工作区已开启任务和网页监控提醒。' : '此工作区的提醒目前关闭。'}</small></span></label>
      <small className="notification-note">通知只显示 Dot 名称和事项状态，不包含任务结果正文。</small>
    </div>
    <DotMemoryManager key={`${auth.tenant.id}:${auth.user.id}`} tenantId={auth.tenant.id} userId={auth.user.id} />
    <div className="section-heading model-heading"><h2>工作区记忆</h2><p>你明确保存的偏好、决定和背景会提供给此工作区中的 Dot 任务。成员可查看；创建者和管理员可编辑或删除。不会自动从聊天中提取。</p></div>
    <div className="profile-card model-card memory-card" data-testid="memory-manager">
      <div className="memory-list" aria-label="已保存的工作区记忆">
        {memories.map(memory => {
          const canManage = memory.createdBy === auth.user.id || ['owner', 'admin'].includes(auth.tenant.role);
          return <article className="memory-row" data-testid="memory-row" key={memory.id}>
            {editingMemory === memory.id ? <>
              <label>编辑这条记忆<textarea aria-label="编辑这条记忆" maxLength={1000} value={editingDraft} onChange={event => setEditingDraft(event.target.value)} /></label>
              <div className="memory-actions"><button className="primary" disabled={memoryBusy || !editingDraft.trim()} onClick={() => void saveMemory(memory)}>保存记忆</button><button disabled={memoryBusy} onClick={() => { setEditingMemory(null); setEditingDraft(''); }}>取消</button></div>
            </> : <>
              <p>{memory.note}</p><small>由 {memory.createdByName} 保存</small>
              {canManage && <div className="memory-actions"><button aria-label={`编辑记忆：${memory.note}`} disabled={memoryBusy} onClick={() => { setEditingMemory(memory.id); setEditingDraft(memory.note); }}>编辑</button><button aria-label={`删除记忆：${memory.note}`} disabled={memoryBusy} onClick={() => void removeMemory(memory)}>删除</button></div>}
            </>}
          </article>;
        })}
        {memories.length === 0 && <small data-testid="empty-memory-list">还没有保存的记忆。</small>}
      </div>
      <label>添加一条 Dot 应记住的信息<textarea aria-label="添加记忆" maxLength={1000} value={memoryDraft} onChange={event => setMemoryDraft(event.target.value)} placeholder="例如：回答时优先使用中文，日期按北京时间表达。" /></label>
      <button className="primary" disabled={memoryBusy || !memoryDraft.trim() || memories.length >= 20} onClick={() => void addMemory()}>添加记忆</button>
      <small>每个工作区最多 20 条，每条最多 1000 个字符。</small>
      {memoryError && <small role="alert" className="member-error">{memoryError}</small>}
    </div>
    <PermissionRules tenantId={auth.tenant.id} role={auth.tenant.role} />
    <div className="section-heading model-heading"><h2>工作区成员</h2><p>所有成员都必须使用对应 Google 账号登录并接受邀请后才能访问。邀请 7 天后过期；Coke Dots 不会代发邮件，请通过其他方式通知对方。当前角色：{auth.tenant.role}。</p></div>
    <div className="profile-card model-card">
      <div className="member-list">{members.map(member => <div className="member-row" key={member.id}>
        <span><strong>{member.name}</strong><small>{member.email}</small></span>
        <span className="member-role">{member.role === 'owner' ? '所有者' : member.role === 'admin' ? '管理员' : '成员'}</span>
        {['owner', 'admin'].includes(auth.tenant.role) && member.role !== 'owner' && <button onClick={async () => { try { const response = await appFetch(`/api/tenants/${auth.tenant.id}/members/${member.id}`, { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); await refreshMembers(); } catch (error) { setMembersError(String(error)); } }}>移除</button>}
      </div>)}</div>
      {invitations.length > 0 && <div className="member-invitations" role="region" aria-label="待接受邀请"><strong>待接受邀请</strong>{invitations.map(invitation => <div className="member-row pending-invitation" key={invitation.email}>
        <span><strong>{invitation.email}</strong><small>有效期至 {new Date(invitation.expiresAt).toLocaleDateString('zh-CN')}</small></span>
        <span className="member-role">{invitation.role === 'admin' ? '管理员' : '成员'}</span>
        <button aria-label={`撤销 ${invitation.email} 的邀请`} onClick={async () => { try { const response = await appFetch(`/api/tenants/${auth.tenant.id}/invitations/${encodeURIComponent(invitation.email)}`, { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); await refreshMembers(); } catch (error) { setMembersError(String(error)); } }}>撤销</button>
      </div>)}</div>}
      <label>Google 账号邮箱<input type="email" value={memberEmail} onChange={e => { setMemberEmail(e.target.value); setMemberNotice(''); }} placeholder="teammate@example.com" /></label>
      <button className="primary" disabled={!['owner', 'admin'].includes(auth.tenant.role) || !memberEmail.trim()} onClick={async () => { try { const result = await request(`/tenants/${auth.tenant.id}/members`, 'POST', { email: memberEmail, role: 'member' }) as { invited: boolean }; setMemberEmail(''); setMembersError(''); setMemberNotice(result.invited ? '邀请已创建。对方在 Coke Dots 登录同一 Google 账号后，会看到待接受邀请。' : '成员已加入工作区。'); await refreshMembers(); } catch (e) { onError(String(e)); } }}>添加工作区成员</button>
      {memberNotice && <small role="status">{memberNotice}</small>}
      {membersError && <small className="member-error">{membersError}</small>}
      {!['owner', 'admin'].includes(auth.tenant.role) && <small>只有工作区所有者或管理员可以添加成员。</small>}
    </div>
    <div className="section-heading model-heading"><h2>共享模型 API</h2><p>所有账号和工作区共用同一模型地址、名称与 API Key。任务、记忆和工作区数据仍相互隔离。</p></div>
    <div className="profile-card model-card" data-testid="shared-model-settings">
      {canManageSharedModel ? <>
        <label>API 地址<input aria-label="共享模型 API 地址" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label>
        <label>模型名称<input aria-label="共享模型名称" value={model} onChange={e => setModel(e.target.value)} /></label>
        <label>API 密钥<input aria-label="共享模型 API 密钥" type="password" autoComplete="off" placeholder={state.modelSettings.hasKey ? '已保存；留空则保持不变' : '输入密钥'} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label>
        <small>{state.modelSettings.adminTenantId ? '此配置由模型管理员工作区维护。' : '保存后，当前工作区将成为共享模型配置管理员。'}API Key 由服务器保存，不会提供给浏览器或写入工作区文件。</small>
        <button className="primary" onClick={async () => { try { await request('/model-settings', 'PATCH', { baseUrl, model, apiKey }); setApiKey(''); } catch (e) { onError(String(e)); } }}>保存共享模型设置</button>
      </> : <div data-testid="shared-model-settings-readonly">
        <p>API 地址：{state.modelSettings.baseUrl || '未配置'}</p>
        <p>模型名称：{state.modelSettings.model || '未配置'}</p>
        <p>API 密钥：{state.modelSettings.hasKey ? '已配置' : '未配置'}</p>
        <small>所有工作区都可以使用这份共享配置；只有模型管理员工作区的所有者或管理员可以修改。</small>
      </div>}
    </div>
  </section>;
}
