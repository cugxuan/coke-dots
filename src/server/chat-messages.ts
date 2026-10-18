import { createHash } from 'node:crypto';
import { isEngine, type ChatMessageResult, type Engine, type Task } from '../shared/types.ts';
import { Store } from './store.ts';
import { classifyTaskMessage, selectRoutingCandidates, type RoutingCandidate, type RoutingContext, type TaskRoute } from './task-routing.ts';

export interface ChatSubmission {
  messageId: string; instruction: string; engine: Engine; mode: 'auto' | 'new' | 'continue';
  taskId?: string; attachmentIds: string[];
}
export class ChatSubmissionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
type Classifier = (tenantId: string, message: string, context: RoutingContext, signal?: AbortSignal) => Promise<TaskRoute>;
type Submitted = Extract<ChatMessageResult, { status: 'submitted' }>;
const uuid = /^[a-f0-9-]{36}$/i;

export function parseChatSubmission(value: unknown): ChatSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChatSubmissionError('聊天消息格式无效', 400);
  const body = value as Record<string, unknown>;
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction || instruction.length > 10000 || typeof body.messageId !== 'string' || !uuid.test(body.messageId)
    || !isEngine(body.engine) || !['auto', 'new', 'continue'].includes(String(body.mode))) throw new ChatSubmissionError('聊天消息格式无效', 400);
  if (body.mode === 'continue' ? typeof body.taskId !== 'string' || !uuid.test(body.taskId) : body.taskId != null) throw new ChatSubmissionError('任务归属参数无效', 400);
  const attachmentIds = body.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 5 || attachmentIds.some(id => typeof id !== 'string' || !uuid.test(id))
    || new Set(attachmentIds).size !== attachmentIds.length) throw new ChatSubmissionError('附件列表无效', 400);
  return { messageId: body.messageId, instruction, engine: body.engine, mode: body.mode as ChatSubmission['mode'],
    ...(body.mode === 'continue' ? { taskId: body.taskId as string } : {}), attachmentIds };
}

/** Only user submissions advance focus; scheduler and background results never do. */
export class ChatMessages {
  constructor(private store: Store, private classify: Classifier = classifyTaskMessage) {}

  context(tenantId: string, userId: string, instruction = ''): RoutingContext & { revision: number } {
    const focus = this.store.db.prepare('SELECT task_id,revision FROM chat_focus WHERE tenant_id=? AND user_id=?')
      .get(tenantId, userId) as { task_id: string; revision: number } | undefined;
    const rows = this.store.db.prepare(`SELECT t.id,t.title,t.status,substr(t.instruction,1,500) AS originalRequest,
      substr(COALESCE(t.result,''),1,700) AS summary,
      COALESCE((SELECT substr(e.body,1,500) FROM entries e WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id AND e.kind='user' ORDER BY e.id DESC LIMIT 1),'') AS lastUserMessage,
      COALESCE((SELECT substr(e.body,1,500) FROM entries e WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id AND e.kind='dot' ORDER BY e.id DESC LIMIT 1),'') AS lastReply,
      COALESCE((SELECT MAX(e.id) FROM entries e WHERE e.tenant_id=t.tenant_id AND e.task_id=t.id AND e.kind='user'),0) AS lastUserEntryId
      FROM tasks t WHERE t.tenant_id=? AND t.created_by_user_id=? AND t.parent_task_id IS NULL AND t.automation_profile IS NULL
        AND t.schedule_json IS NULL AND t.schedule_minutes IS NULL AND t.status<>'stopped' AND t.engine IN ('model','pi','dsh')
      ORDER BY (t.id=?) DESC,lastUserEntryId DESC LIMIT 40`).all(tenantId, userId, focus?.task_id || '') as unknown as RoutingCandidate[];
    const focusTaskId = rows.find(row => row.id === focus?.task_id)?.id || rows[0]?.id || null;
    return { focusTaskId, revision: focus?.revision || 0, candidates: selectRoutingCandidates(rows, instruction, focusTaskId) };
  }

  async submit(tenantId: string, userId: string, input: ChatSubmission, signal?: AbortSignal): Promise<ChatMessageResult> {
    if (!this.store.isTenantMember(tenantId, userId)) throw new ChatSubmissionError('工作区不可用', 403);
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const duplicate = this.receipt(tenantId, userId, input.messageId, hash);
    if (duplicate) return duplicate;
    const context = this.context(tenantId, userId, input.instruction);
    let route: TaskRoute;
    if (input.mode === 'continue') route = { action: 'continue', taskId: input.taskId!, reason: '继续当前选中的任务' };
    else if (input.mode === 'new' || !context.candidates.length) route = { action: 'new', reason: '开始新任务' };
    else {
      try {
        route = await this.classify(tenantId, input.instruction, { focusTaskId: context.focusTaskId, candidates: context.candidates }, signal);
      } catch {
        signal?.throwIfAborted();
        return { status: 'clarify', question: '暂时无法判断这条消息属于哪个任务，请选择继续的任务，或作为新任务发送。', candidates: context.candidates.map(({ id, title, status }) => ({ id, title, status })) };
      }
    }
    signal?.throwIfAborted();
    if (route.action === 'clarify') return { status: 'clarify', question: route.question,
      candidates: context.candidates.filter(candidate => !route.taskIds.length || route.taskIds.includes(candidate.id)).map(({ id, title, status }) => ({ id, title, status })) };
    if (input.mode === 'auto' && route.action === 'continue' && !context.candidates.some(candidate => candidate.id === route.taskId)) throw new ChatSubmissionError('关联结果已失效，请选择任务后重试');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.store.isTenantMember(tenantId, userId)) throw new ChatSubmissionError('工作区不可用', 403);
      const existing = this.receipt(tenantId, userId, input.messageId, hash);
      if (existing) { this.store.db.exec('COMMIT'); return existing; }
      const revision = (this.store.db.prepare('SELECT revision FROM chat_focus WHERE tenant_id=? AND user_id=?').get(tenantId, userId) as { revision: number } | undefined)?.revision || 0;
      if (input.mode === 'auto' && revision !== context.revision) throw new ChatSubmissionError('你在另一条消息中切换了话题，请重新发送，或明确选择要继续的任务');
      const task = route.action === 'new'
        ? this.store.createTask(input.instruction, null, input.engine, tenantId, null, null, input.attachmentIds, userId)
        : this.continueTask(tenantId, userId, route.taskId, input);
      const routing = route.action === 'new' ? 'new' : 'continued';
      const now = new Date().toISOString();
      this.store.db.prepare(`INSERT INTO chat_focus(tenant_id,user_id,task_id,revision,updated_at) VALUES (?,?,?,1,?)
        ON CONFLICT(tenant_id,user_id) DO UPDATE SET task_id=excluded.task_id,revision=chat_focus.revision+1,updated_at=excluded.updated_at`).run(tenantId, userId, task.id, now);
      this.store.db.prepare('INSERT INTO chat_message_receipts(tenant_id,user_id,message_id,payload_hash,task_id,routing,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(tenantId, userId, input.messageId, hash, task.id, routing, route.reason, now);
      this.store.addEntry('system', `${routing === 'continued' ? '已关联并继续' : '已新建'}「${task.title}」。${route.reason}`, task.id, tenantId);
      this.store.db.exec('COMMIT');
      return { status: 'submitted', task, routing, reason: route.reason };
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }

  private receipt(tenantId: string, userId: string, messageId: string, hash: string): Submitted | null {
    const row = this.store.db.prepare('SELECT payload_hash,task_id,routing,reason FROM chat_message_receipts WHERE tenant_id=? AND user_id=? AND message_id=?')
      .get(tenantId, userId, messageId) as { payload_hash: string; task_id: string; routing: Submitted['routing']; reason: string } | undefined;
    if (!row) return null;
    if (row.payload_hash !== hash) throw new ChatSubmissionError('这条消息已提交，不能用同一消息编号发送不同内容');
    const task = this.store.getTask(row.task_id, tenantId);
    if (!task) throw new ChatSubmissionError('任务记录不可用');
    return { status: 'submitted', task, routing: row.routing, reason: row.reason };
  }

  private continueTask(tenantId: string, userId: string, id: string, input: ChatSubmission): Task {
    const task = this.store.getTask(id, tenantId);
    if (!task || this.store.taskOwnerUserId(id, tenantId) !== userId) throw new ChatSubmissionError('找不到你可以继续的任务', 404);
    if (task.parentTaskId || task.scheduleSpec || task.scheduleMinutes !== null || this.store.taskAutomationProfile(id, tenantId)) throw new ChatSubmissionError('子任务或自动任务请在对应任务页操作；也可以作为新任务发送');
    if (!isEngine(task.engine)) throw new ChatSubmissionError('该任务的内核已停用，请作为新任务发送');
    if (!['done', 'waiting', 'failed', 'paused'].includes(task.status)) throw new ChatSubmissionError(task.status === 'stopped' ? '任务已停止，请作为新任务发送' : '这个任务正在执行，请完成或暂停后再追加要求');
    if (this.store.pageActionApproval(tenantId, id)?.status === 'pending') throw new ChatSubmissionError('请先处理该任务已有的页面写入审批');
    if (this.store.delegatedTasks(id, tenantId).some(child => !['done', 'failed', 'waiting', 'stopped'].includes(child.status))) throw new ChatSubmissionError('这个任务还有执行中或暂停的子任务，请先处理子任务');
    if (input.attachmentIds.length) {
      const slots = input.attachmentIds.map(() => '?').join(',');
      const owned = this.store.db.prepare(`SELECT COUNT(*) AS count FROM task_attachments WHERE tenant_id=? AND uploaded_by=? AND task_id IS NULL AND id IN (${slots})`).get(tenantId, userId, ...input.attachmentIds) as { count: number };
      if (owned.count !== input.attachmentIds.length) throw new ChatSubmissionError('一个或多个附件已失效或不属于你', 400);
      this.store.db.prepare(`UPDATE task_attachments SET task_id=? WHERE tenant_id=? AND uploaded_by=? AND task_id IS NULL AND id IN (${slots})`).run(id, tenantId, userId, ...input.attachmentIds);
    }
    const now = new Date().toISOString();
    this.store.db.prepare("UPDATE tasks SET followup_message=?,status='queued',error=NULL,next_run_at=?,updated_at=? WHERE tenant_id=? AND id=?")
      .run(input.instruction, now, now, tenantId, id);
    this.store.addEntry('user', input.instruction, id, tenantId, input.attachmentIds);
    return this.store.getTask(id, tenantId)!;
  }
}
