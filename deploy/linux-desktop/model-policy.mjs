import { Type } from 'typebox';

function thinkingFormat(config) {
  const host = new URL(config.baseUrl).hostname;
  if ((host === 'api.deepseek.com' || host.endsWith('.volces.com')) && /^deepseek-(?:v[34]|flash|chat)/i.test(config.model)) return 'deepseek';
  const aliyun = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(host)
    || /^[a-z0-9_-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host);
  if (aliyun && /^deepseek-v4/i.test(config.model)) return 'qwen';
  return null;
}

export function nonThinkingParameters(config) {
  const format = thinkingFormat(config);
  return format === 'qwen' ? { enable_thinking: false } : format === 'deepseek' ? { thinking: { type: 'disabled' } } : {};
}

export function modelProfile(config) {
  const host = new URL(config.baseUrl).hostname;
  // Only select provider-specific thinking fields for verified provider/model families.
  const format = thinkingFormat(config);
  const deepseek = Boolean(format);
  const vision = host.endsWith('.volces.com') && /^deepseek-v4/i.test(config.model);
  return {
    id: config.model, name: config.model, reasoning: deepseek,
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Soft working budget. pi-turn-runner owns compaction at tool boundaries;
    // never feed this budget into Pi's automatic hard-overflow recovery.
    contextWindow: 40_000, maxTokens: 8_192,
    ...(deepseek ? { thinkingLevelMap: { minimal: 'high', low: 'high', medium: 'high', high: 'high', xhigh: 'max' } } : {}),
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens', ...(format ? { thinkingFormat: format } : {}) },
  };
}

export const cloudSessionSettings = {
  compaction: { enabled: false, reserveTokens: 8_000, keepRecentTokens: 8_000 },
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000, provider: { timeoutMs: 120_000, maxRetries: 1, maxRetryDelayMs: 10_000 } },
  enableInstallTelemetry: false,
};

export function reasoningTool(profile, getSession) {
  if (!profile.reasoning) return null;
  return {
    name: 'set_reasoning', label: '调整分析深度',
    description: '调整本任务后续模型调用的分析深度：浏览器操作、提取和常规编辑用 off，复杂分析用 high；不更改实例模型或其他任务。',
    promptSnippet: '初始使用 off。只有复杂分析确有需要时才用 set_reasoning(high)，常规浏览器操作前切回 off。',
    parameters: Type.Object({ level: Type.Union([Type.Literal('off'), Type.Literal('high')]) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_id, { level }) {
      getSession().setThinkingLevel(level);
      return { content: [{ type: 'text', text: `本任务后续调用的分析深度已设为 ${level}。` }], details: { level } };
    },
  };
}

// Transform only the model's view. Pi's original session journal and browser evidence remain intact.
export function boundedToolContext(messages, sessionFile = '本任务的 Pi 会话日志') {
  const recent = new Set(messages.filter(m => m.role === 'toolResult').slice(-4));
  const olderCount = messages.filter(m => m.role === 'toolResult' && !recent.has(m)).length;
  const olderLimit = Math.min(2000, Math.floor(24_000 / Math.max(1, olderCount)));
  return messages.map(message => {
    if (message.role !== 'toolResult') return message;
    let remaining = recent.has(message) ? 16_000 : olderLimit;
    return { ...message, content: (message.content || []).map(item => {
      if (item.type === 'image') return recent.has(message) ? item : { type: 'text', text: '[已从模型上下文移除旧截图，需要时重新检查当前页面。]' };
      if (item.type !== 'text') return item;
      const allowance = Math.max(0, remaining); remaining -= item.text.length;
      if (item.text.length <= allowance) return item;
      const excerpt = recent.has(message) && allowance > 2000 ? `${item.text.slice(0, 2000)}\n…\n${item.text.slice(-(allowance - 2000))}` : item.text.slice(0, allowance);
      return { ...item, text: `${excerpt}\n[输出已截短。完整证据：${sessionFile}。不要推测省略的内容。]` };
    }) };
  });
}
