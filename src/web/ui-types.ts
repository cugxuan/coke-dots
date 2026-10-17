import type { TaskEngine, TaskStatus } from '../shared/types.ts';

export interface AuthContext { user: { id: string; email: string; name: string }; tenant: { id: string; name: string; role: string; kind: string }; tenants: { id: string; name: string; role: string; kind: string }[] }

export interface TenantMember { id: string; email: string; name: string; role: string }

export interface WorkspaceInvitation { tenantId: string; tenantName?: string; email: string; role: string; invitedAt: string; expiresAt: string }

export interface TenantMemory { id: string; tenantId: string; note: string; createdBy: string; createdByName: string; createdAt: string; updatedAt: string }

export const statusText: Record<TaskStatus, string> = {
  queued: '排队中', working: '工作中', delegating: '并行处理中', waiting: '等待你', scheduled: '已安排', done: '已完成', failed: '失败', paused: '已暂停', stopped: '已停止',
};

export const engineText: Record<TaskEngine, string> = { model: '模型 API', claude: 'Claude Code（已停用）', pi: 'Pi', dsh: 'DeepSeek Harness' };
