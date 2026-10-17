import type { AgentProgress, TokenUsage } from '../../src/shared/types.ts';
export function progressText(value: unknown, secrets?: string[], limit?: number): string;
export function tokenUsage(value: unknown, format?: 'pi' | 'completions'): TokenUsage | undefined;
export function normalizeProgress(value: unknown, secrets?: string[]): AgentProgress | null;
export function createPiProgressReporter(onProgress?: (event: AgentProgress) => void, secrets?: string[]): (event: any) => void;
