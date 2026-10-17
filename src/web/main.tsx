import { TaskProgress } from './TaskProgress.tsx';
import React, { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { selectableEngines, type AttachmentSummary, type DotAppearance, type Engine, type Entry, type ScheduleSpec, type Snapshot, type Task, type VoiceCallSession } from '../shared/types.ts';
import { engineAvailabilityHint } from '../shared/engine-availability.ts';
import { appFetch, request } from './api.ts';
import './base.css';
import { ComputerView, type ComputerHandle } from './ComputerView.tsx';
import { TaskArtifacts } from './TaskArtifacts.tsx';
import { DotContextPanel } from './DotContextPanel.tsx';
import { SlackSetupModal } from './SlackSetupModal.tsx';
import { DingTalkSetupModal } from './DingTalkSetupModal.tsx';
import { appPath } from './api.ts';
import { ScheduledView } from './ScheduledView.tsx';
import { PagePane, PagesView, ScratchpadNavigationPane } from './Pages.tsx';
import './permission-rules.css';
import { DotOnboarding } from './DotOnboarding.tsx';
import { DotAvatar } from './DotAvatar.tsx';
import { DotAvatarEditor } from './DotAvatarEditor.tsx';
import { DotSetupEditor } from './DotSetupEditor.tsx';
import { DotComputerChoice } from './DotComputerChoice.tsx';
import { VoiceCall } from './VoiceCall.tsx';
import { DictationButton } from './DictationButton.tsx';
import './shell-replica.css';
import './onboarding-replica.css';
import './computer-choice.css';
import './call-timeline.css';
import './mobile-replica.css';
import './computer-split.css';
import { MessageBody } from './MessageBody.tsx';
import { LoginScreen } from './LoginScreen.tsx';
import { ActivityView } from './ActivityView.tsx';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import { RecurrenceEditor } from './RecurrenceEditor.tsx';
import { TaskControls } from './TaskControls.tsx';
import { Profile } from './Profile.tsx';
import { engineText, type AuthContext, type WorkspaceInvitation } from './ui-types.ts';

const initial: Snapshot = { profile: { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss', avatarSetupCompletedAt: null, onboardingCompletedAt: null, onboardingCompletedName: null }, preferences: { desktopNotifications: false }, computerAccess: { dotComputer: true, localComputer: true, configured: false }, tasks: [], watches: [], entries: [], configured: false, availableEngines: [], remoteEngines: [], modelSettings: { baseUrl: '', model: '', hasKey: false, adminTenantId: null, apiKeyStatus: 'missing' } };
type Theme = 'light' | 'dark';
type ChatTimelineItem =
  | { id: string; at: string; source: 'entry'; entry: Entry }
  | { id: string; at: string; source: 'call-ended'; call: VoiceCallSession };
const buildDefaultEngine = import.meta.env.VITE_DOTS_DEFAULT_ENGINE;
const defaultEngine: Engine = buildDefaultEngine === 'pi' || buildDefaultEngine === 'dsh' || buildDefaultEngine === 'model' ? buildDefaultEngine : 'model';

function App() {
  const [authContext, setAuthContext] = useState<AuthContext | null>(null);
  const [theme, setTheme] = useState<Theme>('light');
  const [authChecked, setAuthChecked] = useState(false);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [localAuthAvailable, setLocalAuthAvailable] = useState(false);
  const [e2eAuthAvailable, setE2eAuthAvailable] = useState(false);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [state, setState] = useState<Snapshot>(initial);
  const [voiceCalls, setVoiceCalls] = useState<VoiceCallSession[]>([]);
  const [voiceCallsScope, setVoiceCallsScope] = useState('');
  const timelineRef = useRef<HTMLDivElement>(null);
  const computerRef = useRef<ComputerHandle>(null);
  const timelineAtBottomRef = useRef(true);
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const [avatarSetupOpen, setAvatarSetupOpen] = useState(false);
  const [computerAccessOpen, setComputerAccessOpen] = useState(false);
  const [computerConnectedToast, setComputerConnectedToast] = useState(false);
  const [voiceCallOpen, setVoiceCallOpen] = useState(false);
  const [voiceCallAudioContext, setVoiceCallAudioContext] = useState<AudioContext | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [slackModalOpen, setSlackModalOpen] = useState(false);
  const [dingtalkModalOpen, setDingtalkModalOpen] = useState(false);
  const [view, setView] = useState<'home' | 'chat' | 'activity' | 'scheduled' | 'computer' | 'profile' | 'pages'>('home');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const lastChatLocation = useRef<{ view: 'home' | 'chat'; selected: string | null; selectedPageId: string | null }>({ view: 'home', selected: null, selectedPageId: null });
  const [pageIndexVersion, setPageIndexVersion] = useState(0);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentSummary[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [minutes, setMinutes] = useState(60);
  const [frequency, setFrequency] = useState<'interval' | 'daily' | 'weekly'>('interval');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleTimeZone, setScheduleTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [scheduleWeekdays, setScheduleWeekdays] = useState<number[]>([]);
  const [scheduleEndDate, setScheduleEndDate] = useState('');
  const [engine, setEngine] = useState<Engine>(defaultEngine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (view === 'home' || view === 'chat') lastChatLocation.current = { view, selected, selectedPageId };
    if (view === 'computer') lastChatLocation.current = { view: 'chat', selected, selectedPageId: null };
  }, [view, selected, selectedPageId]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileNavOpen]);

  useEffect(() => {
    void appFetch('/api/auth/me').then(async response => response.ok ? await response.json() as AuthContext : null)
      .then(setAuthContext).catch(() => setAuthContext(null)).finally(() => setAuthChecked(true));
    void appFetch('/api/auth/config').then(response => response.json()).then(data => { setGoogleConfigured(Boolean(data.googleConfigured)); setLocalAuthAvailable(Boolean(data.localAuthAvailable)); setE2eAuthAvailable(Boolean(data.e2eAuthAvailable)); }).catch(() => { setGoogleConfigured(false); setLocalAuthAvailable(false); setE2eAuthAvailable(false); });
  }, []);

  useEffect(() => {
    if (!authContext) { setInvitations([]); return; }
    const refresh = () => void appFetch('/api/auth/invitations').then(async response => response.ok ? await response.json() as WorkspaceInvitation[] : [])
      .then(setInvitations).catch(() => setInvitations([]));
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [authContext?.user.id]);

  useEffect(() => {
    if (!authContext) return;
    const url = new URL(window.location.href);
    const connected = url.searchParams.get('slack') === 'connected';
    const slackError = url.searchParams.get('slackError');
    if (!connected && !slackError) return;
    try {
      const saved = sessionStorage.getItem('coke-dots:slack-return-state');
      if (saved) {
        sessionStorage.removeItem('coke-dots:slack-return-state');
        const route = JSON.parse(saved) as { view?: string; selected?: unknown };
        if (route.view === 'chat' && (route.selected === null || (typeof route.selected === 'string' && route.selected.length <= 100))) {
          setView('chat');
          setSelected(route.selected as string | null);
        }
      }
    } catch { /* Continue with the home view when session storage is unavailable. */ }
    url.searchParams.delete('slack');
    url.searchParams.delete('slackError');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    if (connected) setSlackModalOpen(true);
    else if (slackError === 'cancelled') setError('Slack 工作区连接已取消。');
    else if (slackError === 'expired') setError('Slack 连接已过期，请重新连接。');
    else setError('Slack 工作区连接失败，请重试。');
  }, [authContext?.user.id]);

  useEffect(() => {
    setPendingAttachments([]);
    if (!authContext) return;
    const controller = new AbortController();
    void appFetch('/api/attachments', { signal: controller.signal })
      .then(async response => response.ok ? await response.json() as AttachmentSummary[] : [])
      .then(items => setPendingAttachments(items))
      .catch(error => { if (error instanceof Error && error.name !== 'AbortError') setPendingAttachments([]); });
    return () => controller.abort();
  }, [authContext?.tenant.id, authContext?.user.id]);

  useEffect(() => {
    setVoiceCalls([]);
    setVoiceCallsScope('');
    if (!authContext) return;
    const scope = `${authContext.tenant.id}:${authContext.user.id}`;
    const controller = new AbortController();
    void appFetch('/api/voice-calls', { signal: controller.signal })
      .then(async response => response.ok ? await response.json() as VoiceCallSession[] : [])
      .then(items => { setVoiceCalls(items); setVoiceCallsScope(scope); })
      .catch(error => { if (!(error instanceof Error && error.name === 'AbortError')) { setVoiceCalls([]); setVoiceCallsScope(scope); } });
    return () => controller.abort();
  }, [authContext?.tenant.id, authContext?.user.id]);

  useEffect(() => {
    if (!authContext) { setTheme('light'); return; }
    try {
      setTheme(localStorage.getItem(`coke-dots:theme:${authContext.user.id}`) === 'dark' ? 'dark' : 'light');
    } catch {
      setTheme('light');
    }
  }, [authContext?.user.id]);

  useEffect(() => {
    if (!computerConnectedToast) return;
    const timer = window.setTimeout(() => setComputerConnectedToast(false), 5000);
    return () => window.clearTimeout(timer);
  }, [computerConnectedToast]);

  useEffect(() => {
    if (!authContext) return;
    setStateLoaded(false);
    const stream = new EventSource(appPath('/api/events'));
    stream.onmessage = event => {
      setState(JSON.parse(event.data)); setStateLoaded(true);
      setError(current => current === '与本机服务的连接已断开，正在重连。' ? '' : current);
    };
    stream.onerror = () => {
      setError('与本机服务的连接已断开，正在重连。');
      void appFetch('/api/auth/me').then(response => { if (response.status === 401) setAuthContext(null); }).catch(() => { /* Keep the session while the service restarts; EventSource retries. */ });
    };
    return () => stream.close();
  }, [authContext?.tenant.id]);

  const selectedTask = state.tasks.find(t => t.id === selected) || null;
  const entries = useMemo(() => selected ? state.entries.filter(e => e.taskId === selected) : state.entries, [state.entries, selected]);
  const taskById = useMemo(() => new Map(state.tasks.map(task => [task.id, task])), [state.tasks]);
  const progressEntry = useMemo(() => {
    const anchors = new Map<string, number>();
    for (const entry of entries) if (entry.taskId && (entry.kind === 'user' || !anchors.has(entry.taskId))) anchors.set(entry.taskId, entry.id);
    return anchors;
  }, [entries]);
  const currentVoiceCallScope = authContext ? `${authContext.tenant.id}:${authContext.user.id}` : '';
  const currentVoiceCalls = voiceCallsScope === currentVoiceCallScope ? voiceCalls : [];
  const voiceCallsLoaded = voiceCallsScope === currentVoiceCallScope;
  const timelineItems = useMemo<ChatTimelineItem[]>(() => {
    const items: ChatTimelineItem[] = entries.map(entry => ({ id: `entry-${entry.id}`, at: entry.createdAt, source: 'entry', entry }));
    if (!selected) {
      for (const call of currentVoiceCalls) if (call.endedAt) items.push({ id: `call-${call.id}`, at: call.endedAt, source: 'call-ended', call });
    }
    return items.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id));
  }, [entries, selected, currentVoiceCalls]);
  const hasConversationHistory = entries.length > 0 || timelineItems.some(item => item.source === 'call-ended');

  useLayoutEffect(() => { timelineAtBottomRef.current = true; }, [view, selected]);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline && timelineAtBottomRef.current) timeline.scrollTop = timeline.scrollHeight;
  }, [timelineItems, state.tasks, view, selected, stateLoaded]);

  async function refreshVoiceCalls() {
    const response = await appFetch('/api/voice-calls');
    if (!response.ok) throw new Error('读取通话记录失败：HTTP ' + response.status);
    setVoiceCalls(await response.json() as VoiceCallSession[]);
    if (authContext) setVoiceCallsScope(`${authContext.tenant.id}:${authContext.user.id}`);
  }

  function openComputer() {
    if (!['home', 'chat', 'computer'].includes(view)) setSelected(lastChatLocation.current.selected);
    setSelectedPageId(null);
    setView('computer');
  }

  async function closeComputer() {
    if (await computerRef.current?.releaseControl() === false) return;
    setView('chat');
  }

  function openPage(pageId: string, taskId: string | null = null) {
    setSelectedPageId(pageId);
    if (taskId) setSelected(taskId);
    setView('chat');
  }

  function toggleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    if (authContext) {
      try { localStorage.setItem(`coke-dots:theme:${authContext.user.id}`, next); } catch { /* Keep the current session usable when storage is unavailable. */ }
    }
  }

  async function saveAvatarAppearance(appearance: DotAppearance, name?: string, completeOnboarding = false, completeSetup = false) {
    try {
      const profile = await request('/profile', 'PATCH', { ...appearance, ...(name === undefined ? {} : { name }), ...(completeOnboarding ? { onboardingComplete: true } : {}), ...(completeSetup ? { setupComplete: true } : {}) }) as Snapshot['profile'];
      setState(current => ({ ...current, profile }));
      setAvatarEditorOpen(false);
      setAvatarSetupOpen(false);
    } catch (error) { setError(String(error)); }
  }

  function openDotCustomizer() {
    if (state.profile.avatarSetupCompletedAt) setAvatarEditorOpen(true);
    else setAvatarSetupOpen(true);
  }

  async function saveComputerAccess(localComputer: boolean) {
    const shouldShowConnectedToast = localComputer && (!state.computerAccess.localComputer || !state.computerAccess.configured);
    const computerAccess = await request('/computer-access', 'PATCH', { localComputer }) as Snapshot['computerAccess'];
    setState(current => ({ ...current, computerAccess }));
    if (shouldShowConnectedToast) setComputerConnectedToast(true);
    setComputerAccessOpen(false);
  }

  async function submit() {
    if (!draft.trim() || busy) return;
    const keepRootDotConversation = selected === null;
    if (state.remoteEngines.includes(engine) && !state.availableEngines.includes(engine)) {
      setError(state.modelSettings.apiKeyStatus === 'unavailable'
        ? state.modelSettings.secretBackend === 'file'
          ? '无法读取实例共享 API 密钥。请检查服务器密钥文件的归属及访问权限后重试。'
          : '无法读取实例共享 API 密钥。请检查 K3D 集群连接及 coke-dots-system/shared-model-api Secret 权限后重试。'
        : '所选云电脑 Agent 未配置实例共享模型 API，请先完成配置后再提交。');
      return;
    }
    setBusy(true); setError('');
    try {
      if (await computerRef.current?.releaseControl() === false) return;
      const scheduleSpec: ScheduleSpec | null = !schedule ? null : frequency === 'interval'
        ? { frequency, intervalMinutes: minutes }
        : frequency === 'daily'
          ? { frequency, time: scheduleTime, timeZone: scheduleTimeZone, endDate: scheduleEndDate || null }
          : { frequency, weekdays: scheduleWeekdays, time: scheduleTime, timeZone: scheduleTimeZone, endDate: scheduleEndDate || null };
      const task = await request('/tasks', 'POST', { instruction: draft, scheduleSpec, scheduleMinutes: schedule && frequency === 'interval' ? minutes : null, engine, attachmentIds: pendingAttachments.map(attachment => attachment.id) }) as Task;
      setDraft(''); setPendingAttachments([]); setSelected(keepRootDotConversation ? null : task.id); setSelectedPageId(null); setView(current => current === 'computer' ? 'computer' : 'chat'); setSchedule(false); setFrequency('interval'); setMinutes(60); setScheduleWeekdays([]); setScheduleEndDate('');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function uploadAttachments(files: FileList | null) {
    if (!files?.length || uploadingAttachments) return;
    setUploadingAttachments(true); setError('');
    try {
      for (const file of Array.from(files)) {
        const response = await appFetch('/api/attachments', {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream', 'x-attachment-name': encodeURIComponent(file.name) },
          body: file,
        });
        const data = await response.json() as AttachmentSummary & { error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        setPendingAttachments(current => current.some(item => item.id === data.id) ? current : [...current, data]);
      }
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : String(uploadError)); }
    finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  }

  async function removePendingAttachment(attachment: AttachmentSummary) {
    try {
      const response = await appFetch(`/api/attachments/${attachment.id}`, { method: 'DELETE' });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setPendingAttachments(current => current.filter(item => item.id !== attachment.id));
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : String(removeError)); }
  }

  async function act(task: Task, action: string, extra: object = {}) {
    try { setError(''); await request(`/tasks/${task.id}`, 'PATCH', { action, ...extra }); }
    catch (e) { setError(String(e)); }
  }

  async function submitVoiceTranscript(instruction: string, waitingTaskId: string | undefined, callId: string, turnId: string) {
    return await request(`/voice-calls/${callId}/turns`, 'POST', { transcript: instruction, turnId, waitingTaskId, engine }) as Task;
  }

  function startDotCall() {
    let audioContext: AudioContext | null = null;
    try {
      if (typeof window.AudioContext === 'function') {
        audioContext = new window.AudioContext({ latencyHint: 'interactive' });
        void audioContext.resume().catch(() => {});
      }
    } catch {
      // The call screen will show a tap-to-enable recovery if this browser blocks audio startup.
    }
    setVoiceCallAudioContext(audioContext);
    setSelected(null);
    setSelectedPageId(null);
    setView('chat');
    setVoiceCallOpen(true);
  }

  async function addScheduledWatch(url: string, intervalMinutes: number) {
    try { setError(''); await request('/watches', 'POST', { url, intervalMinutes }); }
    catch (e) { setError(String(e)); throw e; }
  }

  async function actWatch(id: string, action: 'pause' | 'resume') {
    try { setError(''); await request(`/watches/${id}`, 'PATCH', { action }); }
    catch (e) { setError(String(e)); }
  }

  async function switchTenant(tenantId: string) {
    if (authContext?.tenant.id === tenantId) return;
    if (await computerRef.current?.releaseControl() === false) return;
    if (view === 'computer') setView('chat');
    setVoiceCallOpen(false); setPendingAttachments([]);
    try {
      const response = await appFetch('/api/auth/tenant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setAuthContext(data as AuthContext); setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null); setError('');
    } catch (e) { setError(String(e)); }
  }

  async function createTenant(name: string) {
    if (await computerRef.current?.releaseControl() === false) return;
    if (view === 'computer') setView('chat');
    setVoiceCallOpen(false);
    const response = await appFetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const refreshed = await appFetch('/api/auth/me');
    if (refreshed.ok) setAuthContext(await refreshed.json() as AuthContext);
    setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null);
  }

  async function logout() {
    if (await computerRef.current?.releaseControl() === false) return;
    if (view === 'computer') setView('chat');
    setVoiceCallOpen(false);
    try { await appFetch('/api/auth/logout', { method: 'POST' }); }
    finally { setAuthContext(null); setState(initial); setPendingAttachments([]); setSelectedPageId(null); }
  }

  async function acceptInvitation(invitation: WorkspaceInvitation) {
    if (await computerRef.current?.releaseControl() === false) return;
    if (view === 'computer') setView('chat');
    try {
      setError('');
      const response = await appFetch(`/api/auth/invitations/${invitation.tenantId}/accept`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setAuthContext(data as AuthContext);
      setInvitations(current => current.filter(item => item.tenantId !== invitation.tenantId));
      setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null); setView('chat');
    } catch (e) { setError(String(e)); }
  }

  if (!authChecked) return <div className="auth-loading">Coke Dots</div>;
  if (!authContext) return <LoginScreen googleConfigured={googleConfigured} localAuthAvailable={localAuthAvailable} e2eAuthAvailable={e2eAuthAvailable} />;

  const chatView = view === 'chat' || view === 'computer';
  const workSurface = ['activity', 'scheduled', 'pages'].includes(view);
  const onboardingMode = view === 'chat' && !selectedTask && !hasConversationHistory && voiceCallsLoaded;
  const computerChoiceMode = onboardingMode && !state.computerAccess.configured;
  const contextMode = view === 'computer' || (view === 'chat' && Boolean(selectedTask || hasConversationHistory));
  return <div className={`shell ${theme === 'dark' ? 'dots-dark' : ''} ${view === 'home' ? 'home-mode' : ''} ${chatView ? 'dot-chat-mode' : ''} ${view === 'computer' ? 'computer-open-mode' : ''} ${contextMode ? 'dot-context-mode' : ''} ${contextMode && voiceCallOpen ? 'voice-call-active-mode' : ''} ${onboardingMode ? 'dot-onboarding-mode' : ''} ${computerChoiceMode ? 'dot-computer-choice-mode' : ''} ${view === 'scheduled' ? 'scheduled-mode' : ''} ${view === 'chat' && selectedPageId ? 'page-open-mode' : ''}`} data-testid="app-shell" data-theme={theme} data-tenant-id={authContext.tenant.id} data-state-loaded={stateLoaded}>
    <aside className="icon-rail" aria-label="主导航">
      <button className={`rail-button ${view === 'home' ? 'selected' : ''}`} aria-label="新聊天" title="新聊天" onClick={() => { setSelectedPageId(null); setSelected(null); setView('home'); }}>⌂</button>
      <button className={`rail-button mobile-dot-nav ${view === 'chat' ? 'selected' : ''}`} data-testid="mobile-dot-nav" aria-label="你的 dot" title="你的 dot" onClick={() => { setSelectedPageId(null); setView('chat'); setSelected(null); }}>◉</button>
      <button className={`rail-button ${view === 'pages' ? 'selected' : ''}`} aria-label="Scratchpad" title="Scratchpad" onClick={() => { setSelectedPageId(null); setView('pages'); }}>▱</button>
      <button className={`rail-button ${view === 'activity' ? 'selected' : ''}`} aria-label="Activity" title="Activity" onClick={() => { setSelectedPageId(null); setView('activity'); }}>◷</button>
      <button className={`rail-button ${view === 'scheduled' ? 'selected' : ''}`} aria-label="Scheduled" title="Scheduled" onClick={() => { setSelectedPageId(null); setView('scheduled'); }}>◴</button>
      <button className={`rail-button ${view === 'computer' ? 'selected' : ''}`} aria-label="电脑" title="电脑" onClick={openComputer}>▣</button>
      <span className="rail-spacer" />
      <button className="rail-user" aria-label="你的 dot 设置" title="你的 dot 设置" onClick={() => { setSelectedPageId(null); setView('profile'); }}><DotAvatar appearance={state.profile} small /></button>
    </aside>
    <aside className="sidebar">
      <div className="sidebar-heading"><strong>ChatGPT</strong><span>⌄</span><button aria-label="搜索" title="搜索">⌕</button></div>
      <button className={`nav new-chat-link ${view === 'home' ? 'selected' : ''}`} aria-label="New chat" title="New chat" onClick={() => { setSelectedPageId(null); setSelected(null); setView('home'); }}>＋ <span>New chat</span></button>
      <button className={`nav ${view === 'chat' ? 'selected' : ''}`} aria-label="你的 dot" title="你的 dot" onClick={() => { setSelectedPageId(null); setView('chat'); setSelected(null); }}>◉ <span>你的 dot</span></button>
      <div className="side-caption">Pinned</div>
      <button className={`sidebar-item ${view === 'pages' ? 'selected' : ''}`} aria-label="Pinned Scratchpad" onClick={() => { setSelectedPageId(null); setView('pages'); }}>▱ <span>Scratchpad</span></button>
      <div className="side-caption recent-caption">Recent</div>
      <div className="task-links">{stateLoaded ? state.tasks.slice(0, 12).map(task => <button key={task.id} className={selected === task.id ? 'on' : ''} onClick={() => { setSelectedPageId(null); setView('chat'); setSelected(task.id); }}><span className={`status-dot ${task.status}`} />{task.title}</button>) : <span className="side-loading">恢复中…</span>}</div>
      <button className="profile-link" onClick={() => { setSelectedPageId(null); setView('profile'); }}><DotAvatar appearance={state.profile} small /><span><strong>{state.profile.name}</strong><small>{authContext.user.email}</small></span><span>⌄</span></button>
    </aside>
    <main className="main">
      <header className="topbar">
        {chatView && <button type="button" className="mobile-chat-menu-toggle" data-testid="mobile-chat-menu-toggle" aria-label="打开导航菜单" aria-expanded={mobileNavOpen} aria-controls="mobile-navigation-panel" onClick={() => setMobileNavOpen(true)}><span aria-hidden="true">☰</span></button>}
        <span className="topbar-title">{view === 'chat' ? selectedTask?.title || state.profile.name : view === 'activity' ? 'Activity' : view === 'computer' ? '电脑' : view === 'profile' ? '你的 dot' : view === 'pages' ? 'Your Personal Scratchpad' : ''}</span>
        {chatView && <div className="mobile-chat-heading" data-testid="mobile-chat-heading"><DotAvatar appearance={state.profile} small /><span>{selectedTask?.title || state.profile.name}</span></div>}
        <div className="surface-switcher" data-testid="surface-switcher" role="group" aria-label="Chat 与 Work"><button aria-pressed={!workSurface} onClick={() => { const previous = lastChatLocation.current; setSelected(previous.selected); setSelectedPageId(previous.selectedPageId); setView(previous.view); }}>Chat</button><button aria-pressed={workSurface} onClick={() => { setSelectedPageId(null); setView('activity'); }}>Work</button></div>
        <div className="top-actions"><button className="theme-toggle" data-testid="theme-toggle" aria-label={`切换到${theme === 'light' ? '深色' : '浅色'}主题`} aria-pressed={theme === 'dark'} title={`切换到${theme === 'light' ? '深色' : '浅色'}主题`} onClick={toggleTheme}><span aria-hidden="true">{theme === 'light' ? '◐' : '☀'}</span><span>{theme === 'light' ? '深色' : '浅色'}</span></button><WorkspaceSwitcher auth={authContext} onSwitch={switchTenant} onCreate={createTenant} onError={message => setError(message)} /><button className="logout-button" onClick={() => void logout()}>退出</button><span className="top-status"><span className="online" />本机运行中</span></div>
        {chatView && !voiceCallOpen && <div className="dot-conversation-actions"><button type="button" data-testid="conversation-call-launch" className="conversation-call-launch" aria-label="Call" title="Call" onMouseDown={event => event.preventDefault()} onClick={startDotCall}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.1 3.8 10 7.2 8.2 9.1a13 13 0 0 0 6.7 6.7l1.9-1.8 3.4 2.9-.8 3.2a1.8 1.8 0 0 1-2 1.4C9 20.2 3.8 15 2.5 6.6a1.8 1.8 0 0 1 1.4-2z" /></svg></button></div>}
      </header>
      {invitations.length > 0 && <section className="invitation-banner" aria-label="工作区邀请">{invitations.map(invitation => <div className="invitation-banner-row" key={invitation.tenantId}><div><strong>工作区邀请：{invitation.tenantName}</strong><span>{invitation.email} · {invitation.role === 'admin' ? '管理员' : '成员'} · 有效期至 {new Date(invitation.expiresAt).toLocaleDateString('zh-CN')}</span></div><button onClick={() => void acceptInvitation(invitation)}>接受并打开工作区</button></div>)}</section>}
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {computerConnectedToast && <div className="computer-connected-toast" data-testid="computer-connected-toast" role="status"><span className="computer-connected-icon" aria-hidden="true">✓</span><span>The computer is connected to your dot</span><button type="button" aria-label="Dismiss notification" onClick={() => setComputerConnectedToast(false)}>×</button></div>}
      {(view === 'home' || chatView) && <div className="chat-layout"><section className="chat-panel">
        {!stateLoaded ? <div className="workspace-loading" role="status">正在恢复工作区…</div> : view === 'home' ? <div className="welcome chat-home" data-testid="chat-home"><h1>What's on your mind today?</h1></div> : !voiceCallsLoaded ? <div className="workspace-loading" role="status">正在恢复工作区…</div> : !selectedTask && !hasConversationHistory ? <DotOnboarding profile={state.profile} computerAccess={state.computerAccess} onComputerAccess={saveComputerAccess} onEditSetup={openDotCustomizer} /> : <div className="timeline" ref={timelineRef} onScroll={() => { const timeline = timelineRef.current; if (timeline) timelineAtBottomRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= 48; }}>
          {!selectedTask && <div className="timeline-title">最近的对话和进度</div>}
          {timelineItems.map(item => item.source === 'entry'
            ? <Fragment key={item.id}><article data-testid="chat-timeline-item" data-timestamp={item.at} className={`message ${item.entry.kind}`}><div className="message-avatar">{item.entry.kind === 'user' ? '你' : item.entry.kind === 'dot' ? <DotAvatar appearance={state.profile} small /> : '·'}</div><div><div className="message-name">{item.entry.kind === 'user' ? '你' : item.entry.kind === 'dot' ? state.profile.name : '系统'} <time>{new Date(item.entry.createdAt).toLocaleString('zh-CN')}</time></div><MessageBody body={item.entry.body} onOpenPage={id => openPage(id, item.entry.taskId)} />{Boolean(item.entry.attachments?.length) && <ul className="message-attachments" data-testid="message-attachments" aria-label="附加文件">{item.entry.attachments!.map(attachment => <li key={attachment.id}><span aria-hidden="true">▤</span><span>{attachment.name}</span></li>)}</ul>}</div></article>{item.entry.taskId && progressEntry.get(item.entry.taskId) === item.entry.id && taskById.has(item.entry.taskId) && <TaskProgress task={taskById.get(item.entry.taskId)!} onOpen={selected ? undefined : () => { setSelected(item.entry.taskId); }} onBack={selected ? () => setSelected(null) : undefined} />}</Fragment>
            : <article key={item.id} data-testid="chat-timeline-item" data-timestamp={item.at} className="message voice-call-ended" data-call-id={item.call.id}><div className="voice-call-ended-chip"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.1 3.8 10 7.2 8.2 9.1a13 13 0 0 0 6.7 6.7l1.9-1.8 3.4 2.9-.8 3.2a1.8 1.8 0 0 1-2 1.4C9 20.2 3.8 15 2.5 6.6a1.8 1.8 0 0 1 1.4-2z" fill="currentColor" /></svg>Me: Call ended</div><small>Optional</small></article>)}
          {selectedTask?.status === 'done' && (selectedTask.engine === 'pi' || selectedTask.engine === 'dsh') && <TaskArtifacts key={selectedTask.id} taskId={selectedTask.id} onOpenComputer={openComputer} />}
          {selectedTask && <TaskControls task={selectedTask} act={act} />}
        </div>}
        <div className="composer-wrap">
          {pendingAttachments.length > 0 && <ul className="pending-attachments" data-testid="pending-attachments" aria-label="待发送附件">{pendingAttachments.map(attachment => <li key={attachment.id} data-testid="pending-attachment"><span aria-hidden="true">▤</span><span className="attachment-name" title={attachment.name}>{attachment.name}</span><button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => void removePendingAttachment(attachment)}>×</button></li>)}</ul>}
          <div className="composer"><input ref={attachmentInputRef} className="attachment-input" data-testid="attachment-input" type="file" multiple accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.sql,.sh,.toml,.ini,.log,.c,.h,.cpp,.hpp" onChange={event => void uploadAttachments(event.currentTarget.files)} /><button className="attachment-button" data-testid="attachment-button" type="button" onMouseDown={event => event.preventDefault()} aria-label="添加附件" title="添加附件" disabled={uploadingAttachments || pendingAttachments.length >= 5} onClick={() => attachmentInputRef.current?.click()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button><textarea data-testid="task-composer" ref={composerRef} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder={view === 'home' ? 'Ask ChatGPT' : 'Type a message'} /><DictationButton draft={draft} setDraft={setDraft} onError={setError} textareaRef={composerRef} /><div className="composer-bottom"><label>内核 <select data-testid="engine-select" value={engine} onChange={e => setEngine(e.target.value as Engine)}>{selectableEngines.map(id => <option key={id} value={id} disabled={state.remoteEngines.includes(id) && !state.availableEngines.includes(id)}>{engineText[id]}{state.availableEngines.includes(id) ? '' : ' · 未配置'}</option>)}</select></label><label className="schedule-toggle"><input type="checkbox" checked={schedule} onChange={e => setSchedule(e.target.checked)} /> 定期检查</label><button className="voice-call-launch" data-testid="voice-call-launch" type="button" onMouseDown={event => event.preventDefault()} aria-label={`拨打 ${state.profile.name}`} title={`拨打 ${state.profile.name}`} onClick={startDotCall}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button><button className="send" onMouseDown={event => event.preventDefault()} disabled={!stateLoaded || busy || !draft.trim() || (state.remoteEngines.includes(engine) && !state.availableEngines.includes(engine))} onClick={() => void submit()}>↑</button></div>{schedule && <RecurrenceEditor frequency={frequency} setFrequency={setFrequency} minutes={minutes} setMinutes={setMinutes} time={scheduleTime} setTime={setScheduleTime} timeZone={scheduleTimeZone} setTimeZone={setScheduleTimeZone} weekdays={scheduleWeekdays} setWeekdays={setScheduleWeekdays} endDate={scheduleEndDate} setEndDate={setScheduleEndDate} />}</div><small className="hint" data-testid="composer-hint">{engineAvailabilityHint(state, engine)}</small></div>
      </section>{view === 'computer' ? <aside className="computer-split" data-testid="computer-split"><header className="computer-pane-header"><div><strong>{state.profile.name} 的电脑</strong><span>点击画面接管 · 点击画面外交还给 {state.profile.name}</span></div><button type="button" aria-label="关闭电脑分栏" title="关闭电脑分栏" onClick={() => void closeComputer()}>×</button></header><ComputerView ref={computerRef} key={authContext.tenant.id} dotName={state.profile.name} localComputerEnabled={state.computerAccess.localComputer} onManageAccess={() => setComputerAccessOpen(true)} onError={setError} /></aside> : view === 'chat' && selectedPageId ? <div className="scratchpad-page-split" data-testid="scratchpad-page-split"><ScratchpadNavigationPane tenantId={authContext.tenant.id} selectedPageId={selectedPageId} refreshKey={pageIndexVersion} onOpen={setSelectedPageId} onBack={() => { setSelectedPageId(null); setView('pages'); }} /><PagePane pageId={selectedPageId} tenantId={authContext.tenant.id} onBack={() => { setSelectedPageId(null); setView('pages'); }} onPageUpdated={() => setPageIndexVersion(version => version + 1)} /></div> : view === 'chat' && (selectedTask || entries.length > 0) && <DotContextPanel profile={state.profile} state={state} tenantId={authContext.tenant.id} onOpenComputer={openComputer} onStartCall={startDotCall} onOpenSlack={() => setSlackModalOpen(true)} onOpenDingTalk={() => setDingtalkModalOpen(true)} onSelectTask={taskId => { setSelected(taskId); setView('chat'); }} />}</div>}
      {view === 'pages' && (selectedPageId ? <PagePane pageId={selectedPageId} tenantId={authContext.tenant.id} full onBack={() => setSelectedPageId(null)} onPageUpdated={() => setPageIndexVersion(version => version + 1)} /> : <PagesView tenantId={authContext.tenant.id} onOpen={id => setSelectedPageId(id)} />)}
      {view === 'activity' && <ActivityView tenantId={authContext.tenant.id} profileName={state.profile.name} state={state} stateLoaded={stateLoaded} onSelectTask={taskId => { setSelected(taskId); setView('chat'); }} onOpenPage={openPage} />}
      {view === 'scheduled' && <ScheduledView tasks={state.tasks} watches={state.watches}
        onCancelTask={task => void act(task, 'cancelSchedule')}
        onWatchAction={(watch, action) => void actWatch(watch.id, action)}
        onOpenTask={task => { setSelected(task.id); setView('chat'); }}
        onNewTask={() => { setSchedule(true); setView('chat'); requestAnimationFrame(() => composerRef.current?.focus()); }}
        onAddWatch={addScheduledWatch} />}
      {view === 'profile' && <Profile state={state} auth={authContext} onError={setError} onEditAppearance={() => setAvatarEditorOpen(true)} onManageComputerAccess={() => setComputerAccessOpen(true)} onStartCall={startDotCall} />}
    </main>
    {mobileNavOpen && <div className="mobile-navigation" data-testid="mobile-navigation">
      <button type="button" className="mobile-navigation-backdrop" aria-label="关闭导航菜单" onClick={() => setMobileNavOpen(false)} />
      <aside className="mobile-navigation-panel" id="mobile-navigation-panel" role="dialog" aria-modal="true" aria-label="Coke Dots 导航">
        <header><strong>Coke Dots</strong><button type="button" aria-label="关闭导航菜单" onClick={() => setMobileNavOpen(false)}>×</button></header>
        <nav aria-label="页面导航">
          <button type="button" onClick={() => { setSelectedPageId(null); setSelected(null); setView('home'); setMobileNavOpen(false); }}>＋ <span>新聊天</span></button>
          <button type="button" className={view === 'chat' && !selected ? 'selected' : ''} onClick={() => { setSelectedPageId(null); setSelected(null); setView('chat'); setMobileNavOpen(false); }}>◉ <span>你的 dot</span></button>
          <button type="button" onClick={() => { setSelectedPageId(null); setView('pages'); setMobileNavOpen(false); }}>▱ <span>Scratchpad</span></button>
          <button type="button" onClick={() => { setSelectedPageId(null); setView('activity'); setMobileNavOpen(false); }}>◷ <span>Activity</span></button>
          <button type="button" onClick={() => { setSelectedPageId(null); setView('scheduled'); setMobileNavOpen(false); }}>◴ <span>Scheduled</span></button>
          <button type="button" onClick={() => { openComputer(); setMobileNavOpen(false); }}>▣ <span>电脑</span></button>
        </nav>
        <div className="mobile-navigation-recent"><strong>最近任务</strong>{state.tasks.slice(0, 12).map(task => <button type="button" key={task.id} className={selected === task.id ? 'selected' : ''} onClick={() => { setSelectedPageId(null); setSelected(task.id); setView('chat'); setMobileNavOpen(false); }}><i className={`status-dot ${task.status}`} />{task.title}</button>)}{state.tasks.length === 0 && <span>还没有任务</span>}</div>
        <footer>
          <div className="mobile-navigation-account"><strong>{authContext.user.name || authContext.user.email}</strong><small>{authContext.user.email}</small></div>
          <WorkspaceSwitcher auth={authContext} onSwitch={switchTenant} onCreate={createTenant} onError={message => setError(message)} />
          <button type="button" onClick={() => { setSelectedPageId(null); setView('profile'); setMobileNavOpen(false); }}>账户与 Dot 设置</button>
          <button type="button" onClick={() => void logout()}>退出账号</button>
        </footer>
      </aside>
    </div>}
    {avatarSetupOpen && <DotSetupEditor profile={state.profile} onClose={() => setAvatarSetupOpen(false)} onSave={(appearance, name) => saveAvatarAppearance(appearance, name, false, true)} />}
    {computerAccessOpen && <DotComputerChoice localComputer={state.computerAccess.localComputer} mode="settings" onSave={saveComputerAccess} onCancel={() => setComputerAccessOpen(false)} />}
    {avatarEditorOpen && <DotAvatarEditor profile={state.profile} onClose={() => setAvatarEditorOpen(false)} onSave={(appearance, name) => saveAvatarAppearance(appearance, name, !state.profile.onboardingCompletedAt)} />}
    {voiceCallOpen && <VoiceCall dotName={state.profile.name} appearance={state.profile} initialAudioContext={voiceCallAudioContext} onTranscript={submitVoiceTranscript} onClose={() => { setVoiceCallOpen(false); setVoiceCallAudioContext(null); void refreshVoiceCalls().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }} />}
    {slackModalOpen && authContext && <SlackSetupModal key={authContext.tenant.id} dotName={state.profile.name} canManage={['owner', 'admin'].includes(authContext.tenant.role)} onClose={() => setSlackModalOpen(false)} onConnectSlack={() => {
      try { sessionStorage.setItem('coke-dots:slack-return-state', JSON.stringify({ view, selected })); } catch { /* Restore the home view if session storage is unavailable. */ }
      window.location.assign(appPath('/api/slack/oauth/start'));
    }} />}
    {dingtalkModalOpen && authContext && <DingTalkSetupModal onClose={() => setDingtalkModalOpen(false)} onOpenIncident={taskId => { setDingtalkModalOpen(false); setSelected(taskId); setSelectedPageId(null); setView('chat'); }} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
