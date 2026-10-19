# Qwen voice secretary

Qwen calls answer ordinary questions directly and delegate work only through explicit function calls. A transcription event saves the user's words; it no longer starts an Agent task. Browser SpeechRecognition and Volcano providers retain their existing task flow.

The Qwen session exposes two tools using the provider's nested `function` schema:

- `delegate_task(instruction, task_id?)` creates work or resumes a waiting task from this call. Instructions include the conversation context needed by the Agent. Acceptance returns immediately; queued work is not reported as completed.
- `get_task_status(task_id?)` reads a real task from this call, defaulting to the latest delegated task. Progress questions do not create new tasks.

The existing tenant Agent executes delegated work. The call follows the shared chat snapshot, speaks genuine waiting questions/results, and keeps full results in chat. The existing authenticated speech-summary endpoint still prepares long results. Ending a call or interrupting speech does not stop a submitted task.

`QwenVoiceSession` owns provider event ordering. It accepts complete tool calls only after a successful response ends, deduplicates call IDs, associates native/manual responses with their originating speech turn, and keeps superseded output muted. An interrupted tool response cannot submit new work. An already accepted task may finish silently; asking about progress reads its current state and resumes watching active work. Late acceptance of an older request cannot replace the latest task.

Direct user/assistant messages persist through `/api/voice-calls/:id/messages`. The server derives tenant and user from the session and deduplicates `(call_id,item_id,role)`. Delegated turns reference their source message, linking the original transcript to the task without a second user message, regardless of whether transcription or task acceptance arrives first. Task lookup and secretary continuations require an association with the current call and owner. Existing clients without a source message keep the old turn API behavior.

The 2,500 ms VAD pause tolerance remains intentional. A live Qwen Audio 3.0 probe accepted `smart_turn`, but split the existing paused dictation sample into two responses. This change reduces the unnecessary Agent round trip for direct dialogue while preserving dictation behavior. It does not claim subsecond end-to-end latency.

Release requires the new control-plane message/task endpoints before the frontend. No tenant image or Agent model change is needed. Mock browser/unit coverage is distinct from authenticated public Chrome with real Qwen audio and the tenant worker.

Protocol references: [Qwen-Audio](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides), [Qwen-Omni function calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling).
