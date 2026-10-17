import React, { useMemo } from 'react';

export function RecurrenceEditor({ frequency, setFrequency, minutes, setMinutes, time, setTime, timeZone, setTimeZone, weekdays, setWeekdays, endDate, setEndDate }: {
  frequency: 'interval' | 'daily' | 'weekly';
  setFrequency: React.Dispatch<React.SetStateAction<'interval' | 'daily' | 'weekly'>>;
  minutes: number; setMinutes: React.Dispatch<React.SetStateAction<number>>;
  time: string; setTime: React.Dispatch<React.SetStateAction<string>>;
  timeZone: string; setTimeZone: React.Dispatch<React.SetStateAction<string>>;
  weekdays: number[]; setWeekdays: React.Dispatch<React.SetStateAction<number[]>>;
  endDate: string; setEndDate: React.Dispatch<React.SetStateAction<string>>;
}) {
  const zones = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return [...new Set(['UTC', timeZone, ...supported])].sort();
  }, [timeZone]);
  const dayLabels = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return <div className="schedule-details" data-testid="schedule-details">
    <label>频率<select aria-label="重复频率" value={frequency} onChange={event => setFrequency(event.target.value as 'interval' | 'daily' | 'weekly')}><option value="interval">按间隔</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
    {frequency === 'interval' ? <label>每 <input aria-label="间隔分钟数" className="minutes" type="number" min="1" max="10080" value={minutes} onChange={event => setMinutes(Number(event.target.value))} /> 分钟</label> : <>
      <label>时间<input aria-label="定时时间" type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
      <label>时区<select aria-label="时区" value={timeZone} onChange={event => setTimeZone(event.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
      {frequency === 'weekly' && <fieldset className="schedule-weekdays"><legend>重复日</legend>{dayLabels.map((label, day) => <label key={day}><input aria-label={label} type="checkbox" checked={weekdays.includes(day)} onChange={event => setWeekdays(current => event.target.checked ? [...current, day] : current.filter(value => value !== day))} />{label.slice(2)}</label>)}</fieldset>}
      <label>结束日期（可选）<input aria-label="结束日期" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
    </>}
  </div>;
}
