import { InlineKeyboard } from 'grammy';

export function currentIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function monthKey(year: number, month: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
}

export function calendarKeyboard(
  year: number,
  month: number,
  prefix = 'order',
  minimumDate = currentIsoDate(),
  callbackToken?: string,
  allowedWeekday?: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const tokenSuffix = callbackToken ? `:${callbackToken}` : '';
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = (firstDay.getUTCDay() + 6) % 7;
  const today = minimumDate;
  const monthName = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(firstDay);
  const currentMonth = today.slice(0, 7);
  const callbackData = (value: string) => {
    if (new TextEncoder().encode(value).length > 64) throw new Error('Calendar callback_data exceeds Telegram 64-byte limit.');
    return value;
  };
  const previousMonthDate = new Date(Date.UTC(year, month - 2, 1));
  const nextMonthDate = new Date(Date.UTC(year, month, 1));

  if (monthKey(year, month) > currentMonth) {
    keyboard.text('‹', callbackData(`${prefix}:calendar:${monthKey(previousMonthDate.getUTCFullYear(), previousMonthDate.getUTCMonth() + 1)}${tokenSuffix}`));
  }
  keyboard.text(monthName, callbackData(`${prefix}:noop${tokenSuffix}`));
  keyboard.text('›', callbackData(`${prefix}:calendar:${monthKey(nextMonthDate.getUTCFullYear(), nextMonthDate.getUTCMonth() + 1)}${tokenSuffix}`)).row();

  for (const weekday of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']) keyboard.text(weekday, callbackData(`${prefix}:noop${tokenSuffix}`));
  keyboard.row();

  let column = 0;
  for (; column < offset; column++) keyboard.text(' ', callbackData(`${prefix}:noop${tokenSuffix}`));
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${monthKey(year, month)}-${day.toString().padStart(2, '0')}`;
    const isoWeekday = (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7 + 1;
    const isAvailable = date >= today && (!allowedWeekday || isoWeekday === allowedWeekday);
    keyboard.text(isAvailable ? day.toString() : '×', callbackData(isAvailable ? `${prefix}:pickdate:${date}${tokenSuffix}` : `${prefix}:noop${tokenSuffix}`));
    column++;
    if (column === 7 && day < daysInMonth) {
      keyboard.row();
      column = 0;
    }
  }
  keyboard.row().text('Назад', callbackData(`${prefix}:calendar_back${tokenSuffix}`));
  return keyboard;
}

export function parseCalendarMonth(value: string, minimumDate = currentIsoDate()): { year: number; month: number } | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || value < minimumDate.slice(0, 7)) return undefined;
  return { year, month };
}
