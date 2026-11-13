import { InlineKeyboard } from 'grammy';
import type { OrderMaterialState } from '../../types/order-material.ts';
import { mediaKey } from '../../services/order-material-media.ts';
import { publicationDatesLabel } from '../../services/publication-dates.ts';

export function getMaterialPrompt(state: OrderMaterialState): { text: string; keyboard?: InlineKeyboard } {
  if (state.revisionMode) {
    if (state.step === 6) {
      const lines = [
        `Исправления по заказу №${state.orderNumber}`,
        'Проверьте свой пост и исправьте то, что попросил администратор.',
        '',
        state.adText?.trim() || 'Текст рекламы не указан',
        '',
        `Ссылка или контакт: ${state.destination || 'не указаны'}`,
        publicationDatesLabel(state.requestedDates),
        `Пожелания: ${state.wishes || 'нет'}`,
        `Фото и видео: ${mediaCountLabel(state.media.length)}`,
      ];
      if (state.adminComment) {
        lines.push('', `✉️ Сообщение администратора:\n${state.adminComment}`);
      }
      const keyboard = new InlineKeyboard()
        .text('Изменить текст', 'materials:edit:text').row()
        .text('Изменить медиа', 'materials:edit:media').row()
        .text('Изменить ссылку или контакт', 'materials:edit:destination').row()
        .text('Изменить пожелания', 'materials:edit:wishes').row()
        .text('Отправить исправленные материалы', 'materials:submit_revision');
      return { text: lines.join('\n'), keyboard };
    }
    if (state.step === 0) {
      const keyboard = new InlineKeyboard().text('Оставить прежний', 'materials:revision_menu');
      return {
        text: `Заказ №${state.orderNumber}. Текущий рекламный текст:\n\n${state.adText || 'не указан'}\n\nОтправьте новый текст или вернитесь, чтобы оставить прежний.`,
        keyboard,
      };
    }
    if (state.step === 1) {
      const keyboard = new InlineKeyboard().text('Готово', 'materials:revision_menu');
      appendMediaRemovalButtons(keyboard, state);
      return {
        text: [
          `Заказ №${state.orderNumber}. Сейчас приложено ${mediaCountLabel(state.media.length)}.`,
          ...(state.media.length > 0
            ? ['', state.media.map((media, index) => `${index + 1}. ${media.kind === 'photo' ? 'Фото' : 'Видео'}`).join('\n')]
            : []),
          '',
          'Отправьте новые фото или видео, а удалить ненужные можно кнопками ниже.',
        ].join('\n'),
        keyboard,
      };
    }
    if (state.step === 2) {
      const keyboard = new InlineKeyboard().text('Оставить прежнее', 'materials:revision_menu');
      return {
        text: `Заказ №${state.orderNumber}. Текущая ссылка или контакт: ${state.destination || 'не указаны'}\n\nОтправьте новое значение или вернитесь, чтобы оставить прежнее.`,
        keyboard,
      };
    }
    if (state.step === 4) {
      const keyboard = new InlineKeyboard().text('Оставить прежние', 'materials:revision_menu');
      return {
        text: `Заказ №${state.orderNumber}. Текущие пожелания: ${state.wishes || 'нет'}\n\nОтправьте новые пожелания или вернитесь, чтобы оставить прежние.`,
        keyboard,
      };
    }
  }

  if (state.reviewMode) {
    if (state.step === 0) {
      return {
        text: `Изменение текста рекламы для заказа №${state.orderNumber}. Отправьте новый текст рекламного сообщения.`,
      };
    }
    if (state.step === 1) {
      const keyboard = new InlineKeyboard()
        .text(state.media.length === 0 ? 'Продолжить без медиа' : 'Готово, продолжить', 'materials:media_done').row();
      appendMediaRemovalButtons(keyboard, state);
      return {
        text: `Изменение фото и видео для заказа №${state.orderNumber}. Отправьте новые файлы или удалите ненужные. Сейчас добавлено ${state.media.length} из 10.`,
        keyboard,
      };
    }
    if (state.step === 2) {
      return {
        text: `Изменение ссылки или контакта для заказа №${state.orderNumber}. Отправьте новое значение.`,
      };
    }
    if (state.step === 3) {
      return {
        text: `Изменение пожеланий для заказа №${state.orderNumber}. Отправьте новые пожелания или нажмите «Без пожеланий», чтобы удалить их.`,
        keyboard: new InlineKeyboard().text('Без пожеланий', 'materials:skip_wishes'),
      };
    }
  }

  if (state.step === 0) {
    return {
      text: `Оплата заказа №${state.orderNumber} подтверждена.\n\nШаг 1 из 4. Отправьте текст рекламы. Можно прислать фото или видео с текстом в подписи одним сообщением либо отправить текст отдельно, а медиа — следующим шагом. Сейчас приложено ${state.media.length} из 10 файлов.`,
    };
  }
  if (state.step === 1) {
    const keyboard = new InlineKeyboard()
      .text(
        state.media.length === 0 ? 'Продолжить без медиа' : 'Готово, продолжить',
        'materials:media_done',
      ).row();
    appendMediaRemovalButtons(keyboard, state);
    return {
      text: `Шаг 2 из 4. Прикрепите фото или видео к заказу №${state.orderNumber}. Уже добавлено ${state.media.length} из 10 файлов. Когда закончите, нажмите кнопку ниже. Удалить добавленные файлы можно кнопками ниже.`,
      keyboard,
    };
  }
  if (state.step === 2) {
    return {
      text: 'Шаг 3 из 4. Отправьте ссылку, адрес или контакт, который нужно указать клиентам.',
    };
  }
  if (state.step === 3) {
    if (!state.revisionMode) {
      const keyboard = new InlineKeyboard().text('Без пожеланий', 'materials:skip_wishes');
      return {
        text: 'Шаг 4 из 4. Добавьте дополнительные пожелания к размещению. Если их нет, нажмите «Без пожеланий».',
        keyboard,
      };
    }
    return {
      text: `${publicationDatesLabel(state.requestedDates)}\n\nДаты из заказа сохранены отдельно от материалов.`,
      keyboard: new InlineKeyboard().text('Назад без изменений', 'materials:revision_menu'),
    };
  }
  if (state.step === 4 && !state.revisionMode) {
    const mediaLines = state.media.length
      ? state.media.map((media, index) => `${index + 1}. ${media.kind === 'photo' ? 'Фото' : 'Видео'}`).join('\n')
      : 'Не добавлены';
    const text = [
      `✅ ПРОВЕРКА МАТЕРИАЛОВ · ЗАКАЗ №${state.orderNumber}`,
      '━━━━━━━━━━━━━━━━━━',
      '',
      `📝 Текст рекламы\n${state.adText?.trim() || 'Не указан'}`,
      '',
      `🖼 Фото и видео · ${state.media.length}/10\n${mediaLines}`,
      '',
      `🔗 Ссылка или контакт\n${state.destination?.trim() || 'Не указаны'}`,
      '',
      `📅 Даты публикаций\n${publicationDatesLabel(state.requestedDates)}`,
      '',
      `💬 Пожелания\n${state.wishes?.trim() || 'Не указаны'}`,
      '',
      '━━━━━━━━━━━━━━━━━━',
      'Проверьте данные и подтвердите отправку. Любой пункт можно изменить кнопками ниже.',
    ].join('\n');
    const keyboard = new InlineKeyboard()
      .text('Изменить текст', 'materials:review_edit:text').row()
      .text('Изменить фото и видео', 'materials:review_edit:media').row()
      .text('Изменить ссылку или контакт', 'materials:review_edit:destination').row()
      .text('Изменить пожелания', 'materials:review_edit:wishes').row()
      .text('Подтвердить и отправить', 'materials:confirm');
    return { text, keyboard };
  }
  const keyboard = new InlineKeyboard().text('Без пожеланий', 'materials:skip_wishes');
  return {
    text: 'Добавьте дополнительные пожелания. Если их нет, нажмите «Без пожеланий».',
    keyboard,
  };
}

function appendMediaRemovalButtons(keyboard: InlineKeyboard, state: OrderMaterialState): void {
  for (const [index, media] of state.media.entries()) {
    keyboard.row().text(
      `Удалить ${media.kind === 'photo' ? 'фото' : 'видео'} ${index + 1}`,
      `materials:remove_media:${index}:${mediaKey(media.fileId)}`,
    );
  }
}

function mediaCountLabel(count: number): string {
  if (count === 0) return 'нет файлов';
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11
    ? 'файл'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? 'файла'
      : 'файлов';
  return `${count} ${word} из 10`;
}
