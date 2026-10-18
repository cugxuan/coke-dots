export const QWEN_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';
export const QWEN_AUDIO_REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus';
export type QwenRealtimeModel = typeof QWEN_REALTIME_MODEL | typeof QWEN_AUDIO_REALTIME_MODEL;

export function qwenSessionConfig(model: string, dotName: string) {
  return {
    modalities: ['text', 'audio'],
    instructions: `你是 ${dotName}，是 Coke Dots 的语音界面。请始终使用中文。用户说话时，你只做简短确认，并明确真实工作会交给独立的 Dots Agent 处理；不要自行回答任务内容、假称已完成或编造进度。稍后收到以“Dots Agent 状态更新”开头的文字时，只简短朗读其中状态。`,
    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
    // Audio 3.0 provides its own transcription and uses a different voice schema.
    ...(model === QWEN_AUDIO_REALTIME_MODEL
      ? { voice: 'longanqian' }
      : { audio: { output: { voice: 'Tina' } }, input_audio_transcription: { model: 'qwen3-asr-flash-realtime' } }),
  };
}
