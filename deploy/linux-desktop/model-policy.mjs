import { Type } from 'typebox';

export function modelProfile(config) {
  const host = new URL(config.baseUrl).hostname;
  // Only select provider-specific thinking fields for verified provider/model families.
  const deepseek = (host === 'api.deepseek.com' || host.endsWith('.volces.com')) && /^deepseek-(?:v[34]|flash|chat)/i.test(config.model);
  const vision = host.endsWith('.volces.com') && /^deepseek-v4/i.test(config.model);
  return {
    id: config.model, name: config.model, reasoning: deepseek,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Deliberate working budget, not the provider's maximum context capacity.
    contextWindow: 40_000, maxTokens: 8_192,
    ...(deepseek ? { thinkingLevelMap: { minimal: 'high', low: 'high', medium: 'high', high: 'high', xhigh: 'max' } } : {}),
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens', ...(deepseek ? { thinkingFormat: 'deepseek' } : {}) },
  };
}

export const cloudSessionSettings = {
  compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 8_000 },
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000, provider: { timeoutMs: 120_000, maxRetries: 1, maxRetryDelayMs: 10_000 } },
  enableInstallTelemetry: false,
};

export function reasoningTool(profile, getSession) {
  if (!profile.reasoning) return null;
  return {
    name: 'set_reasoning', label: '调整分析深度',
    description: 'Set thinking for subsequent model calls: off for browser actions, extraction and routine edits; high for complex analysis. Does not change the instance model or other tasks.',
    promptSnippet: 'Start with thinking off. Use set_reasoning(high) only when complex analysis needs it; return to off before routine browser actions.',
    parameters: Type.Object({ level: Type.Union([Type.Literal('off'), Type.Literal('high')]) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_id, { level }) {
      getSession().setThinkingLevel(level);
      return { content: [{ type: 'text', text: `Thinking ${level} for subsequent calls in this task.` }], details: { level } };
    },
  };
}

// Transform only the model's view. Pi's original session journal and browser evidence remain intact.
export function boundedToolContext(messages, sessionFile = 'the task Pi session journal') {
  const recent = new Set(messages.filter(m => m.role === 'toolResult').slice(-4));
  const olderCount = messages.filter(m => m.role === 'toolResult' && !recent.has(m)).length;
  const olderLimit = Math.min(2000, Math.floor(24_000 / Math.max(1, olderCount)));
  return messages.map(message => {
    if (message.role !== 'toolResult') return message;
    let remaining = recent.has(message) ? 16_000 : olderLimit;
    return { ...message, content: (message.content || []).map(item => {
      if (item.type === 'image') return recent.has(message) ? item : { type: 'text', text: '[Earlier screenshot omitted from model context; inspect the current page if needed.]' };
      if (item.type !== 'text') return item;
      const allowance = Math.max(0, remaining); remaining -= item.text.length;
      if (item.text.length <= allowance) return item;
      const excerpt = recent.has(message) && allowance > 2000 ? `${item.text.slice(0, 2000)}\n…\n${item.text.slice(-(allowance - 2000))}` : item.text.slice(0, allowance);
      return { ...item, text: `${excerpt}\n[Output shortened. Full evidence: ${sessionFile}. Do not infer missing content.]` };
    }) };
  });
}
