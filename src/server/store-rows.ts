import type { Entry, ScheduleSpec, Task, TaskEngine, TaskStatus, Watch } from '../shared/types.ts';
import { scheduleForTask, validateScheduleSpec } from '../shared/scheduling.ts';

export function toTask(r: Record<string, unknown>): Task {
  const scheduleMinutes = r.schedule_minutes == null ? null : Number(r.schedule_minutes);
  let scheduleSpec: ScheduleSpec | null = null;
  if (typeof r.schedule_json === 'string') {
    try { scheduleSpec = validateScheduleSpec(JSON.parse(r.schedule_json)); } catch { scheduleSpec = null; }
  }
  scheduleSpec = scheduleForTask(scheduleSpec, scheduleMinutes);
  return {
    id: String(r.id), tenantId: String(r.tenant_id), parentTaskId: r.parent_task_id == null ? null : String(r.parent_task_id), title: String(r.title), instruction: String(r.instruction),
    engine: r.engine as TaskEngine, agentSessionId: r.agent_session_id == null ? null : String(r.agent_session_id),
    status: r.status as TaskStatus, priority: Number(r.priority),
    nextRunAt: r.next_run_at == null ? null : String(r.next_run_at),
    scheduleMinutes: scheduleMinutes !== null ? scheduleMinutes : scheduleSpec?.frequency === 'interval' ? scheduleSpec.intervalMinutes : null,
    scheduleSpec,
    result: r.result == null ? null : String(r.result), error: r.error == null ? null : String(r.error),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function toEntry(r: Record<string, unknown>): Entry {
  return { id: Number(r.id), tenantId: String(r.tenant_id), taskId: r.task_id == null ? null : String(r.task_id), kind: r.kind as Entry['kind'], body: String(r.body), createdAt: String(r.created_at) };
}

export function toWatch(r: Record<string, unknown>): Watch {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), url: String(r.url), intervalMinutes: Number(r.interval_minutes),
    status: r.status as Watch['status'], nextCheckAt: r.next_check_at == null ? null : String(r.next_check_at),
    lastCheckedAt: r.last_checked_at == null ? null : String(r.last_checked_at),
    lastStatus: r.last_status == null ? null : String(r.last_status), error: r.error == null ? null : String(r.error),
  };
}
