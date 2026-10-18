export const QWEN_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';
export const QWEN_AUDIO_REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus';
export type QwenRealtimeModel = typeof QWEN_REALTIME_MODEL | typeof QWEN_AUDIO_REALTIME_MODEL;

export function qwenSessionConfig(model: string, dotName: string) {
  return {
    modalities: ['text', 'audio'],
    instructions: `你是 ${dotName}，是 Coke Dots 的语音界面。请始终使用中文。用户布置工作时，只用一句自然、简短的话确认收到，例如“收到，我来处理。”不要播报任务转交、派发、工作队列或内部执行流程，不要提及 Pi、Agent 或内核。不要自行回答任务内容、假称已完成或编造进度。稍后收到以“播报内容：”开头的文字时，只自然地朗读其中内容，不要读出这个标记或附加解释。`,
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
    // Audio 3.0 provides its own transcription and uses a different voice schema.
    ...(model === QWEN_AUDIO_REALTIME_MODEL
      ? { voice: 'longanqian' }
      : { audio: { output: { voice: 'Tina' } }, input_audio_transcription: { model: 'qwen3-asr-flash-realtime' } }),
  };
}
