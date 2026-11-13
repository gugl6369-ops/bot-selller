export function customerLabel(
  firstName: string | null | undefined,
  username: string | null | undefined,
  businessName?: string | null,
): string {
  const identity = `${firstName?.trim() || 'Имя не указано'}${username ? ` (@${username.replace(/^@/, '')})` : ''}`;
  return businessName ? `${identity} · бизнес «${businessName}»` : identity;
}

export function minuteTimestamp(value: string | Date): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).replace(',', '');
}

export function dayCountLabel(days: number): string {
  const remainder100 = days % 100;
  const remainder10 = days % 10;
  const unit = remainder100 >= 11 && remainder100 <= 14
    ? 'дней'
    : remainder10 === 1
      ? 'день'
      : remainder10 >= 2 && remainder10 <= 4
        ? 'дня'
        : 'дней';
  return `${days} ${unit}`;
}
