export const BROADCAST_TIME_ZONE = 'Asia/Tomsk';

function dateParts(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return { year, month, day };
}

export function parseBroadcastDate(value: string): string | undefined {
  const date = dateParts(value.trim());
  if (!date) return undefined;
  const today = formatBroadcastDate(new Date());
  const selected = `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  return selected >= today ? selected : undefined;
}

export function formatBroadcastDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BROADCAST_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isValidBroadcastTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function localParts(date: Date): number[] {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BROADCAST_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return [get('year'), get('month'), get('day'), get('hour'), get('minute'), get('second')];
}

/** Converts a wall-clock date/time in Asia/Tomsk without consulting process TZ. */
export function broadcastLocalDateTimeToUtc(date: string, time: string): Date | undefined {
  const parts = dateParts(date);
  if (!parts || !isValidBroadcastTime(time)) return undefined;
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
  let candidate = target;
  // Iterate the UTC offset to resolve the selected wall-clock time in the named zone.
  for (let i = 0; i < 4; i += 1) {
    const [year, month, day, localHour, localMinute, second] = localParts(new Date(candidate));
    const represented = Date.UTC(year!, month! - 1, day!, localHour!, localMinute!, second!);
    const adjustment = target - represented;
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  const result = new Date(candidate);
  const actual = localParts(result);
  if (actual[0] !== parts.year || actual[1] !== parts.month || actual[2] !== parts.day
    || actual[3] !== hour || actual[4] !== minute || actual[5] !== 0) return undefined;
  return result;
}

export function formatBroadcastDateTime(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: BROADCAST_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
