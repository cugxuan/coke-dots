import './message-timestamp.css';

const compactFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const preciseFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'longOffset',
});

export function MessageTimestamp({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const precise = preciseFormat.format(date);
  return <time className="message-timestamp" dateTime={date.toISOString()} title={precise} aria-label={precise}>{compactFormat.format(date)}</time>;
}
