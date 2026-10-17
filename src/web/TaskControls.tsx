import { useEffect, useState } from 'react';
import type { PageActionApproval, Task } from '../shared/types.ts';
import { appFetch, request } from './api.ts';
import { statusText } from './ui-types.ts';

export function TaskControls({ task, act, compact = false }: { task: Task; act: (task: Task, action: string, extra?: object) => Promise<void>; compact?: boolean }) {
  const [redirect, setRedirect] = useState('');
  const [approval, setApproval] = useState<PageActionApproval | null>(null);
  const [approvalLoaded, setApprovalLoaded] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  useEffect(() => {
    let active = true;
    setApproval(null); setApprovalLoaded(false); setApprovalError('');
    if (compact || task.status !== 'waiting') { setApprovalLoaded(true); return () => { active = false; }; }
    void appFetch(`/api/tasks/${task.id}/approval`).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setApproval(data as PageActionApproval | null);
    }).catch(reason => { if (active) setApprovalError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setApprovalLoaded(true); });
    return () => { active = false; };
  }, [task.id, task.status, compact]);
  async function decideApproval(decision: 'approve' | 'decline') {
    setApprovalBusy(true); setApprovalError('');
    try {
      const result = await request(`/tasks/${task.id}/approval`, 'POST', { decision }) as { approval: PageActionApproval };
      setApproval(result.approval);
    } catch (reason) { setApprovalError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApprovalBusy(false); }
  }
  const hasRecurringSchedule = Boolean(task.scheduleSpec || task.scheduleMinutes !== null);
  const canStop = !hasRecurringSchedule && ['queued', 'working', 'delegating', 'waiting', 'scheduled', 'paused'].includes(task.status);
  return <div className={`task-controls ${compact ? 'compact' : ''}`}>
    {!compact && <span className={`pill ${task.status}`}>{statusText[task.status]}</span>}
    {!hasRecurringSchedule && ['working', 'queued', 'delegating', 'scheduled'].includes(task.status) && <button onClick={() => void act(task, 'pause')}>暂停</button>}
    {['paused', 'failed'].includes(task.status) && <button onClick={() => void act(task, task.status === 'failed' ? 'retry' : 'resume')}>{task.status === 'failed' ? '重试' : '继续'}</button>}
    {canStop && <button className="stop-task" title="停止后这项工作不能继续" onClick={() => void act(task, 'stop')}>停止工作</button>}
    {!compact && <>
      {task.status !== 'stopped' && <button onClick={() => void act(task, 'priority', { priority: task.priority + 1 })}>提高优先级</button>}
      {task.status === 'waiting' && !approvalLoaded && <small role="status" className="approval-loading">正在读取待审批操作…</small>}
      {approval?.status === 'pending' && <div className="page-approval" data-testid="page-action-approval">
        <div className="page-approval-heading"><strong>Scratchpad 页面写入等待批准</strong><small>批准后才会保存到当前工作区。</small></div>
        <div className="page-approval-proposal"><strong>{approval.action.action === 'create' ? '创建' : '更新'}：{approval.action.title}</strong><p>{approval.message}</p><pre>{approval.action.content}</pre></div>
        {approvalError && <small role="alert" className="approval-error">{approvalError}</small>}
        <div className="page-approval-actions"><button className="approve" disabled={approvalBusy} onClick={() => void decideApproval('approve')}>{approvalBusy ? '处理中…' : '批准并执行'}</button><button disabled={approvalBusy} onClick={() => void decideApproval('decline')}>拒绝并保持不变</button></div>
      </div>}
      {approvalLoaded && !approval && task.status !== 'stopped' && <div className="redirect">
        <input aria-label={task.status === 'waiting' ? '回复 dot 的问题' : '调整这项工作的要求'} value={redirect} onChange={e => setRedirect(e.target.value)} placeholder={task.status === 'waiting' ? '回复 dot 的问题…' : '调整这项工作的要求'} />
        <button disabled={!redirect.trim()} onClick={() => {
          const action = task.status === 'waiting' ? 'reply' : 'redirect';
          const extra = task.status === 'waiting' ? { message: redirect } : { instruction: redirect };
          void act(task, action, extra);
          setRedirect('');
        }}>{task.status === 'waiting' ? '回复并继续' : '更新'}</button>
      </div>}
    </>}
  </div>;
}
