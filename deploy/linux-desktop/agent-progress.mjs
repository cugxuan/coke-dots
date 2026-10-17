// Public execution telemetry only. Never forward private thinking blocks or SDK payloads.
export function progressText(value, secrets = [], limit = 2000) {
  let text = typeof value === 'string' ? value : '';
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.replaceAll(secret, '[redacted]');
  text = text.replace(/\bsk-[\w-]{8,}\b/g, '[redacted]')
    .replace(/(bearer\s+)\S+/ig, '$1[redacted]')
    .replace(/((?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|secret)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"'&,;]+)/ig, '$1[redacted]')
    .replace(/([?&](?:key|token|code|signature)=)[^&#\s]+/ig, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 12))}\n…（内容已截断）` : text;
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function tokenUsage(value, format = 'pi') {
  if (!value || typeof value !== 'object') return undefined;
  const input = count(format === 'pi' ? value.input : value.prompt_tokens);
  const output = count(format === 'pi' ? value.output : value.completion_tokens);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = count(format === 'pi' ? value.cacheRead : value.prompt_tokens_details?.cached_tokens) || 0;
  const cacheWrite = count(format === 'pi' ? value.cacheWrite : 0) || 0;
  if (format === 'pi' && input + output + cacheRead + cacheWrite === 0) return undefined;
  // Pi's input excludes cache tokens; Chat Completions prompt_tokens includes them.
  const total = count(format === 'pi' ? value.totalTokens : value.total_tokens)
    ?? input + output + (format === 'pi' ? cacheRead + cacheWrite : 0);
  return { input: format === 'pi' ? input + cacheRead + cacheWrite : input, output, cacheRead, cacheWrite, total };
}

export function normalizeProgress(value, secrets = []) {
  if (!value || typeof value !== 'object' || !['status', 'tool', 'usage', 'commentary'].includes(value.kind)) return null;
  const id = progressText(value.id, secrets, 160);
  const message = progressText(value.message, secrets, 240);
  if (!id || !message) return null;
  if (value.kind === 'usage') {
    const u = value.usage;
    if (!u || !['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => count(u[key]) !== undefined)) return null;
    return { id, kind: 'usage', message, usage: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map(key => [key, u[key]])) };
  }
  return { id, kind: value.kind, message, ...(typeof value.detail === 'string' ? { detail: progressText(value.detail, secrets) } : {}),
    ...(['running', 'done', 'failed', 'interrupted'].includes(value.state) ? { state: value.state } : {}) };
}

export function createPiProgressReporter(onProgress, secrets = []) {
  let usage;
  let messageIndex = 0;
  const tools = new Map();
  const seenMessages = new WeakSet();
  const emit = event => { const safe = normalizeProgress(event, secrets); if (safe) onProgress?.(safe); };
  const phase = message => emit({ id: 'phase', kind: 'status', message, state: 'running' });
  return event => {
    if (event.type === 'message_start' && event.message?.role === 'assistant') phase('正在分析任务…');
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_start') phase('正在思考下一步…');
    if (event.type === 'tool_execution_start') {
      const name = progressText(event.toolName, secrets, 80) || '工具';
      const args = event.args || {};
      const detail = ['command', 'path', 'pattern', 'url', 'action', 'selector'].filter(key => typeof args[key] === 'string')
        .map(key => `${key}: ${args[key]}`).join('\n');
      const tool = { id: `tool:${event.toolCallId}`, kind: 'tool', message: name, detail, state: 'running', updated: 0 };
      tools.set(event.toolCallId, tool);
      emit(tool); phase(`正在执行 ${name}…`);
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const tool = tools.get(event.toolCallId);
      if (!tool) return;
      const ended = event.type === 'tool_execution_end';
      if (!ended && Date.now() - tool.updated < 1000) return;
      tool.updated = Date.now();
      const result = ended ? event.result : event.partialResult;
      const output = result?.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n') || '';
      emit({ ...tool, detail: `${tool.detail}${output ? `\n\n${output}` : ''}`, state: ended ? event.isError ? 'failed' : 'done' : 'running' });
      if (ended) { tools.delete(event.toolCallId); phase('正在整理结果…'); }
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (seenMessages.has(event.message)) return;
      seenMessages.add(event.message);
      const next = tokenUsage(event.message.usage);
      if (next) {
        usage = Object.fromEntries(Object.keys(next).map(key => [key, (usage?.[key] || 0) + next[key]]));
        emit({ id: 'usage', kind: 'usage', message: '模型用量', usage });
      }
      const text = event.message.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n').trim();
      // Final decision JSON is delivered separately; only tool-turn commentary is public here.
      if (text && event.message.content?.some(item => item.type === 'toolCall') && !/^\s*(?:\{|```)/.test(text)) {
        emit({ id: `commentary:${++messageIndex}`, kind: 'commentary', message: '执行说明', detail: text });
      }
    }
  };
}
