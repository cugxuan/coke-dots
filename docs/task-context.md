# Chat task attribution and lightweight task memory

The main composer can continue the task it displays, or classify a message in the root Dot conversation before creating work. For example, “帮我列出来具体有哪些信息渠道查询了，哪些没有查询” can continue the preceding BYD report without requiring the company name again.

## Submission

`POST /api/chat/messages` accepts `messageId` (UUID), `instruction`, `engine`, `attachmentIds`, and `mode`:

- `continue` requires `taskId`. It is an explicit selection and skips both candidate retrieval and the routing model, regardless of the task's age.
- `new` creates an independent task and also skips candidate retrieval and the routing model. The New chat view and “作为新任务发送” use this mode.
- `auto` classifies the message against the initiating user's task cards. It returns a new task, a continuation, or `status: clarify` with a question and candidate choices. Clarification leaves the draft and attachments unsubmitted.

`POST /api/tasks` retains its explicit task-creation contract for scheduling and integrations. This change does not route voice turns or automatic DingTalk events through the classifier.

The classifier uses the existing shared model configuration, one tool-free request, a 15-second deadline and an 800-token response limit. Provider-specific thinking is disabled only for the already supported DeepSeek/Ark family. No instance model setting is changed. Invalid JSON, unknown task IDs, network failure and ambiguity never silently create a contextless task. The UI offers explicit selection instead.

## Recall and focus

SQLite `chat_focus` stores one conversational focus and revision for each tenant/user pair. Only accepted chat submissions advance it; task completion and scheduled/background events do not. When the saved focus is outside the recent candidate window or absent, the classifier's focus hint falls back to the latest eligible user submission, not the latest task update.

Recall selects the latest eight top-level tasks owned by the initiating user, ordered by their last user message, excluding scheduled, automated, stopped and retired-engine tasks. Only those eight tasks have their evidence loaded and sent to the model. An old focus or matching title cannot displace a more recent conversation; explicitly continuing an old task makes it recent again. Each card contains bounded excerpts of the original request, stored result, last user message and last assistant reply. The model chooses among these IDs. Matching titles are hints: a later empty task asking for missing context is not a substitute for the report that actually produced the evidence.

This is bounded recall, not a search over all historical work. Older tasks outside that window remain available by opening their task page and explicitly continuing. The model's association is probabilistic; users can choose an explicit task or start independent work.

## Continuation and evidence

The root Dot view has a “清除历史” button. It saves an account/workspace-specific history boundary and resets automatic task focus without deleting tasks, messages, calls, attachments or files. The cleared Dot view and its recent/output lists stay empty across reloads; late replies from earlier tasks stay in Activity. Calls started before the boundary stay hidden even if they end later. Opening an old task in Activity preserves its full task context and permits explicit continuation. New user messages after the boundary can make that task visible and eligible for automatic association again. Other workspace members keep their own view.

The boundary and focus revision update atomically, invalidating automatic classification already in flight. History metadata is delivered in account-scoped SSE snapshots/patches; the underlying workspace snapshot is still built once per publish. This is a presentation/context reset, not deletion of stored history or private learned preferences.

The original task ID, title, instruction, workspace, native session and earlier conversation entries remain intact. `tasks.followup_message` records the current incremental request. The Worker executes that request with the previous result, up to six recent messages and up to twenty artifact metadata entries from the existing tenant Worker API. Files remain in the same task directory; Pi reads the required files using its existing tools. No desktop image or protocol change is required.

Historical messages and file metadata are untrusted evidence, not instructions to replay. The prompt explicitly requires using existing reports, preserving files and distinguishing original-source verification, indirect/search evidence, blocked attempts, unqueried sources and unknown coverage. This does not reconstruct a structured source ledger that an older research task never recorded, nor guarantee arbitrary model compliance.

Follow-up prompts respect the installed 20,000-character limit. Less relevant pages/notes and older messages are dropped before the latest request; oversized current requests fail visibly. Durable private notes remain separate. New attachment bodies are included for the current turn; earlier uploaded attachment bodies are not repeatedly copied into every follow-up.

## State and access boundaries

- The server independently checks tenant membership, task ownership, state and approvals after classification. The model cannot authorize cross-user or cross-tenant continuation.
- Running/queued/delegating, stopped, scheduled, automated and child tasks are not restarted through this entry point. Pending page approvals and active/paused delegated children must be resolved through their existing controls.
- Focus revision checks reject an automatic routing decision made stale by another accepted message. User-selected continuation remains explicit.
- Submission, attachments, focus and the idempotency receipt commit in one SQLite transaction. Reusing a message ID with the same payload returns the existing task; changing its payload is rejected.
- A client disconnect before submission aborts routing. The client retains a message ID for retry when the response is lost. Retrying an already committed message does not rerun it.

Regression coverage lives in `tests/task-routing.test.ts` and `tests/e2e/scenarios/task-routing.ts`. It exercises the original follow-up, explicit continuation, new topics, ambiguity, attachments, persistence, concurrency, cancellation, boundaries and preserving the original report. Existing cloud-computer E2E coverage checks the unchanged Agent/Worker transport.
