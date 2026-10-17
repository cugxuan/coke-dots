import type { AgentProgress } from '../shared/types.ts';
import { normalizeProgress } from '../../deploy/linux-desktop/agent-progress.mjs';

/** Accept older JSON-only runtimes, but never accept a truncated streaming result. */
export async function readAgentResponse(response: Response, onProgress?: (event: AgentProgress) => void): Promise<Record<string, any>> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    return await response.json().catch(() => ({}));
  }
  if (!response.body) throw new Error('Agent 没有返回执行流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let result: Record<string, any> | undefined;
  function accept(line: string) {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    if (frame.type === 'error') throw new Error(typeof frame.error === 'string' ? frame.error : 'Agent 执行失败');
    if (frame.type === 'result') {
      if (result || !frame.result || typeof frame.result !== 'object') throw new Error('Agent 执行流的结果无效');
      result = frame.result;
    }
    if (frame.type === 'progress' && !result) {
      const event = normalizeProgress(frame.event);
      if (event) onProgress?.(event);
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 512_000) throw new Error('Agent 执行事件过大');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) { accept(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (done) break;
    }
    if (pending.trim()) accept(pending);
    if (!result) throw new Error('Agent 执行连接中断，未收到最终结果');
    return result;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
