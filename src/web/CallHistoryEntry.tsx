import type { VoiceCallSession } from '../shared/types.ts';

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const preciseFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
});

export function CallHistoryEntry({ call }: { call: VoiceCallSession }) {
  if (!call.endedAt) return null;
  const start = new Date(call.startedAt);
  const end = new Date(call.endedAt);
  const seconds = call.durationSeconds ?? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const duration = [hours || null, Math.floor(seconds / 60) % 60, seconds % 60]
    .filter(value => value !== null).map((value, index) => index === 0 && hours ? String(value) : String(value).padStart(2, '0')).join(':');
  return <article data-testid="chat-timeline-item" data-timestamp={call.endedAt} className="message voice-call-ended" data-call-id={call.id}>
    <div className="voice-call-ended-chip"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.1 3.8 10 7.2 8.2 9.1a13 13 0 0 0 6.7 6.7l1.9-1.8 3.4 2.9-.8 3.2a1.8 1.8 0 0 1-2 1.4C9 20.2 3.8 15 2.5 6.6a1.8 1.8 0 0 1 1.4-2z" fill="currentColor" /></svg>通话结束</div>
    <small data-testid="voice-call-duration">时长 {duration}</small>
    <div className="voice-call-time-range" aria-label="通话起止时间">
      <time dateTime={call.startedAt} title={preciseFormat.format(start)}>{dateTimeFormat.format(start)}</time>
      <span aria-hidden="true">–</span>
      <time dateTime={call.endedAt} title={preciseFormat.format(end)}>{start.toDateString() === end.toDateString() ? timeFormat.format(end) : dateTimeFormat.format(end)}</time>
    </div>
  </article>;
}
