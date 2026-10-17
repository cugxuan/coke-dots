import { useEffect, useRef, useState } from 'react';
import type { Entry, Snapshot, Task } from '../shared/types.ts';
import { appFetch, request } from './api.ts';
import { statusText, engineText } from './ui-types.ts';
import { TaskControls } from './TaskControls.tsx';
import { MessageBody } from './MessageBody.tsx';

export function ActivityView({ tenantId, profileName, state, stateLoaded, onSelectTask, onOpenPage }: { tenantId: string; profileName: string; state: Snapshot; stateLoaded: boolean; onSelectTask: (taskId: string) => void; onOpenPage: (pageId: string, taskId?: string | null) => void }) {
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const pageGeneration = useRef(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const generation = ++pageGeneration.current;
    let current = true;
    setLoading(true); setLoadingOlder(false); setError(''); setEntries([]); setNextCursor(null);
    void appFetch('/api/activity?limit=50').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data as { entries: Entry[]; nextCursor: number | null };
    }).then(page => { if (current && generation === pageGeneration.current) { setEntries(page.entries); setNextCursor(page.nextCursor); } })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (current && generation === pageGeneration.current) setLoading(false); });
    return () => { current = false; };
  }, [tenantId, refreshKey]);

  useEffect(() => {
    if (loading || !state.entries.length) return;
    const oldestSnapshotEntryId = Math.min(...state.entries.map(entry => entry.id));
    setEntries(current => {
      const byId = new Map(current.map(entry => [entry.id, entry]));
      for (const entry of state.entries) byId.set(entry.id, entry);
      return [...byId.values()].sort((a, b) => b.id - a.id);
    });
    setNextCursor(current => state.entries.length < 150 ? null : current === null ? null : Math.min(current, oldestSnapshotEntryId));
  }, [state.entries, loading]);

  async function loadOlder() {
    if (nextCursor === null || loadingOlder) return;
    const requestedTenantId = tenantIdRef.current;
    const generation = pageGeneration.current;
    setLoadingOlder(true); setError('');
    try {
      const response = await appFetch(`/api/activity?limit=50&before=${nextCursor}`);
      const data = await response.json() as { entries?: Entry[]; nextCursor?: number | null; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (requestedTenantId !== tenantIdRef.current || generation !== pageGeneration.current) return;
      setEntries(current => {
        const byId = new Map(current.map(entry => [entry.id, entry]));
        for (const entry of data.entries || []) byId.set(entry.id, entry);
        return [...byId.values()].sort((a, b) => b.id - a.id);
      });
      setNextCursor(data.nextCursor ?? null);
    } catch (reason) { if (requestedTenantId === tenantIdRef.current && generation === pageGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (requestedTenantId === tenantIdRef.current && generation === pageGeneration.current) setLoadingOlder(false); }
  }

  const tasks = new Map(state.tasks.map(task => [task.id, task]));
  const childrenByParent = new Map<string, Task[]>();
  for (const task of state.tasks) if (task.parentTaskId) childrenByParent.set(task.parentTaskId, [...(childrenByParent.get(task.parentTaskId) || []), task]);
  const activityTasks = state.tasks.filter(task => !task.parentTaskId).flatMap(task => [task, ...(childrenByParent.get(task.id) || [])]);
  return <section className="content activity-content">
    <div className="section-heading"><h1>Activity</h1><p>查看 dot 正在处理的工作、结果和需要你决定的事项。</p></div>
    <div className="cards">{!stateLoaded ? <div className="empty workspace-loading" role="status">正在加载工作区…</div> : !state.tasks.length ? <div className="empty">还没有任务。回到对话，交给 dot 第一项工作。</div> : activityTasks.map(task => {
      const parent = task.parentTaskId ? tasks.get(task.parentTaskId) : undefined;
      const children = childrenByParent.get(task.id) || [];
      const terminalChildren = children.filter(child => ['done', 'failed', 'stopped'].includes(child.status)).length;
      const description = task.parentTaskId ? task.error || task.result || task.instruction
        : task.status === 'delegating' ? `${terminalChildren}/${children.length} 项子任务已结束。${task.result ? ` ${task.result}` : ''}`
          : task.error || task.result || task.instruction;
      return <div className={`task-card ${task.parentTaskId ? 'delegated-child' : ''}`} data-testid={`task-card-${task.id}`} key={task.id}>
      <div className="task-card-head"><span className={`pill ${task.status}`}>{statusText[task.status]}</span><time>{new Date(task.updatedAt).toLocaleString('zh-CN')}</time></div>
      {parent && <small className="delegated-from">委派自：{parent.title} · 内核：{engineText[task.engine]}</small>}
      <h2>{task.title}</h2><p>{description}</p>
      <div className="card-actions"><button onClick={() => onSelectTask(task.id)}>查看详情 →</button><TaskControls task={task} act={async (item, action, extra) => { try { await request(`/tasks/${item.id}`, 'PATCH', { action, ...extra }); } catch (reason) { setError(String(reason)); } }} compact /></div>
    </div>})}</div>
    <section className="activity-feed" data-testid="activity-feed" aria-label="Recent activity">
      <header><div><h2>Recent activity</h2><p>任务进度、用户方向和执行记录</p></div><button onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>刷新</button></header>
      {error && <p className="activity-error" role="alert">{error}</p>}
      {loading ? <p className="activity-empty" role="status">正在加载活动记录…</p> : !entries.length ? <p className="activity-empty">还没有活动记录。</p> : <ol className="activity-list">{entries.map(entry => {
        const task = entry.taskId ? tasks.get(entry.taskId) : undefined;
        return <li className={`activity-entry ${entry.kind}`} data-testid="activity-entry" key={entry.id}>
          <div className="activity-entry-head"><strong>{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? profileName : '系统'}</strong><time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></div>
          <MessageBody body={entry.body} onOpenPage={pageId => onOpenPage(pageId, entry.taskId)} />
          {task && <button className="activity-open-task" onClick={() => onSelectTask(task.id)}>打开任务：{task.title} →</button>}
        </li>;
      })}</ol>}
      {nextCursor !== null && <button className="activity-load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? '正在加载…' : '加载更早记录'}</button>}
    </section>
  </section>;
}
