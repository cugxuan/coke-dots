// Own the compaction boundary: Pi's default check only runs after an entire
// tool loop and treats our soft working budget as a hard provider limit.
// Yield after complete tool batches, then compact/continue the same transcript.
export function createPiTurnRunner(session, { signal, threshold, isContextOverflow }) {
  if (!session.agent || !session.subscribe) return { prompt: text => session.prompt(text), dispose() {} };
  const agent = session.agent;
  const afterToolCall = agent.afterToolCall;
  const yielded = new Set();
  const endWaiters = new Set();
  let assistant;
  const release = () => { for (const resolve of endWaiters) resolve(); endWaiters.clear(); };
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') { assistant = event.message; yielded.clear(); }
    if (event.type === 'agent_end') {
      assistant = [...event.messages].reverse().find(message => message.role === 'assistant') || assistant;
      release();
    }
    if (event.type === 'auto_retry_end' && !event.success) release();
  });
  agent.afterToolCall = async (context, toolSignal) => {
    const previous = await afterToolCall?.(context, toolSignal);
    // Respect tools/extensions that already requested a terminal result.
    if ((previous?.terminate ?? context.result.terminate) === true) return previous;
    yielded.add(context.toolCall.id);
    return { ...previous, terminate: true };
  };
  const checkAbort = () => { if (signal?.aborted) throw signal.reason || new Error('Task stopped'); };
  const nextEnd = () => new Promise(resolve => endWaiters.add(resolve));
  const settle = async operation => {
    const ended = nextEnd();
    await operation();
    // Session events/persistence are queued separately from agent.prompt().
    await ended;
    while (session.isRetrying) await nextEnd();
    await agent.waitForIdle();
    checkAbort();
  };
  const compact = async () => {
    checkAbort();
    try {
      await session.compact('Preserve the user request, constraints, verified findings, artifact paths, completed tool operations and remaining work. Clearly distinguish completed actions from pending actions; do not repeat completed side effects.');
    } catch (error) {
      checkAbort();
      throw new Error(`上下文整理失败；已保留任务文件和工具记录：${error.message}`);
    }
    checkAbort();
  };
  const compactIfNeeded = async () => {
    if ((session.getContextUsage()?.tokens || 0) > threshold) await compact();
  };
  return {
    async prompt(text, { recoverOverflow = true } = {}) {
      checkAbort();
      await compactIfNeeded();
      assistant = undefined;
      yielded.clear();
      await settle(() => session.prompt(text));
      let recoveredOverflow = false;
      for (;;) {
        checkAbort();
        // Detect explicit provider overflow only. Successful answers above the
        // working budget are final answers, not errors or reasons to replay.
        if (recoverOverflow && !recoveredOverflow && assistant?.stopReason === 'error' && isContextOverflow(assistant)) {
          recoveredOverflow = true;
          await compact();
          const messages = session.messages;
          if (messages.at(-1)?.role === 'assistant' && messages.at(-1).stopReason === 'error') agent.state.messages = messages.slice(0, -1);
        } else {
          const calls = assistant?.content?.filter(item => item.type === 'toolCall') || [];
          if (!calls.length || ['error', 'aborted', 'length'].includes(assistant.stopReason) || !calls.every(call => yielded.has(call.id))) return;
          await compactIfNeeded();
        }
        checkAbort();
        yielded.clear();
        assistant = undefined;
        await settle(() => agent.continue());
      }
    },
    dispose() { unsubscribe(); agent.afterToolCall = afterToolCall; release(); },
  };
}
