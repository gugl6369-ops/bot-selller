export function displayIsoDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

export function publicationDatesText(dates: readonly string[]): string {
  if (dates.length === 0) return 'Дату публикации согласуем после оплаты.';
  return dates.map((date, index) => {
    const dateText = date ? displayIsoDate(date) : 'согласуем после оплаты';
    return `${dates.length > 1 ? `${index + 1}. ` : ''}${dateText}`;
  }).join('\n');
}

export function publicationDatesLabel(dates: readonly string[]): string {
  return dates.length > 1
    ? `Даты публикаций:\n${publicationDatesText(dates)}`
    : `Дата публикации: ${publicationDatesText(dates)}`;
}

export function publicationDatesStatusText(dates: readonly string[], statuses: readonly string[]): string {
  if (dates.length === 0) return publicationDatesLabel(dates);
  return dates.map((date, index) => {
    const dateText = date ? displayIsoDate(date) : 'согласуем после оплаты';
    const statusText = statuses[index] === 'published' ? 'опубликована' : 'ожидает публикации';
    return `${dates.length > 1 ? `${index + 1}. ` : ''}${dateText} · ${statusText}`;
  }).join('\n');
}
