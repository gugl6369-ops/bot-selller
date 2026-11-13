export const DATA_DELETION_INQUIRY_TOPIC = 'Запрос на удаление данных';

export function isDataDeletionInquiry(topic: string): boolean {
  return topic === DATA_DELETION_INQUIRY_TOPIC;
}
