export function nonThinkingParameters(config: { baseUrl: string; model: string }): {
  enable_thinking?: boolean;
  thinking?: { type: string };
};
