import { useEffect, useState } from 'react';
import type { Task, TokenUsage } from '../shared/types.ts';
import { statusText } from './ui-types.ts';
import './task-progress.css';

const number = (value: number) => value.toLocaleString('zh-CN');
const usageTitle = (usage: TokenUsage) => `输入 ${number(usage.input)}（含缓存读取 ${number(usage.cacheRead)}、写入 ${number(usage.cacheWrite)}） · 输出 ${number(usage.output)}`;

export function TaskProgress({ task, onOpen, onBack }: { task: Task; onOpen?: () => void; onBack?: () => void }) {
  const [, setClock] = useState(0);
  const execution = task.execution;
  const timing = execution?.timing;
  const seconds = (value = 0) => `${(value / 1000).toFixed(1)} 秒`;
  const active = task.status === 'working' && !execution?.finishedAt;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClock(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = execution ? Math.max(0, Math.floor(((execution.finishedAt ? Date.parse(execution.finishedAt) : active ? Date.now() : Date.parse(task.updatedAt)) - Date.parse(execution.startedAt)) / 1000)) : 0;
  const phase = [...(execution?.events || [])].reverse().find(event => event.kind === 'status');
  const events = (execution?.events || []).filter(event => event.kind !== 'status');
  const current = task.status === 'queued' ? '已排队，等待执行' : active ? phase?.message || '正在执行…' : statusText[task.status];
  return <section className="task-progress" data-testid={`task-progress-${task.id}`} aria-label={`任务进度：${task.title}`}>
    <header><span className={`task-progress-badge ${task.status}`}>{statusText[task.status]}</span><strong>{onOpen ? task.title : '执行过程'}</strong>{(onOpen || onBack) && <button type="button" onMouseDown={event => event.preventDefault()} onClick={onOpen || onBack}>{onOpen ? '任务详情 →' : '返回主聊天'}</button>}</header>
    <div className="task-progress-state" role="status"><span className={active ? 'task-progress-pulse' : ''} aria-hidden="true">●</span><span>{current}</span>{execution && <time>{elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</time>}</div>
    {events.length > 0 && <details className="task-progress-events"><summary onMouseDown={event => event.preventDefault()}>执行记录 · {events.length} 项{events.length === 50 ? '（最近 50 项）' : ''}</summary><ol>{events.map(event => <li key={event.id} data-state={event.state}>
      <div><span>{event.kind === 'tool' ? ({ running: '执行中', done: '已完成', failed: '失败', interrupted: '已中断' }[event.state || 'done']) : '说明'}</span><strong>{event.message}</strong>{event.durationMs !== undefined && <time>{seconds(event.durationMs)}</time>}</div>
      {event.detail && <details><summary onMouseDown={event => event.preventDefault()}>查看内容</summary><pre>{event.detail}</pre></details>}
    </li>)}</ol></details>}
    {task.error && <p className="task-progress-error">{task.error}</p>}
    {timing && <details className="task-progress-timing" data-testid="task-timing"><summary onMouseDown={event => event.preventDefault()}>耗时明细{timing.modelCalls !== undefined ? ` · ${timing.modelCalls} 轮模型调用` : ''}</summary><p>
      连接 {seconds(timing.dispatchMs)} · 排队 {seconds((timing.schedulerMs || 0) + (timing.queueMs || 0))} · 启动 {seconds(timing.startupMs)}<br />
      模型响应 {seconds(timing.modelMs)} · 工具执行 {seconds(timing.toolMs)}
      {timing.browserMs !== undefined && <> · 其中浏览器 {seconds(timing.browserMs)}</>}
      {!!timing.pageWaitMs && <>（导航与显式等待 {seconds(timing.pageWaitMs)}）</>}
      {!!timing.compactions && <><br />上下文整理 {timing.compactions} 次 · {seconds(timing.compactionMs)}</>}
    </p></details>}
    <footer data-testid="task-token-usage">{execution?.usage ? <>
      <span title={usageTitle(execution.usage)}>本轮 {number(execution.usage.total)} tokens</span>
      <span>输入 {number(execution.usage.input)} · 输出 {number(execution.usage.output)}</span>
      {(execution.usage.cacheRead > 0 || execution.usage.cacheWrite > 0) && <span>缓存读取 {number(execution.usage.cacheRead)} · 写入 {number(execution.usage.cacheWrite)}（计入输入）</span>}
      {execution.runs > 1 && execution.totalUsage && <span title={usageTitle(execution.totalUsage)}>已记录累计 {number(execution.totalUsage.total)} tokens</span>}
      {active && <span>随模型响应更新</span>}
    </> : <><span>{active || task.status === 'queued' ? '等待模型返回用量' : '本轮用量未提供'}</span>{execution?.totalUsage && <span>已记录累计 {number(execution.totalUsage.total)} tokens</span>}</>}</footer>
  </section>;
}
