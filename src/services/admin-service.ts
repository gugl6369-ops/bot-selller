import {
  AdminRepository,
} from '../db/repositories/admin-repository.ts';
import type { AdminAnswerResult, AdminFlow } from '../types/admin.ts';
import { parsePublicationDate } from './order-service.ts';
import { displayIsoDate } from './publication-dates.ts';
import { createPromotionalBroadcastDraftToken } from './promotional-broadcast-token.ts';

const tariffQuestions = [
  'Введите название тарифа.',
  'Укажите канал, чат или площадки размещения.',
  'Что входит в размещение?',
  'Сколько будет публикаций? Введите целое число или «не указано».',
  'Укажите срок размещения, например «7 дней» или «1 месяц», либо «не указан».',
  'Через сколько дней после публикации спросить результат? Введите число дней (например, 14).',
  'Дополнительные условия (или «нет»).',
  'Введите цену числом в EUR, например 120 или 120.50.',
  'До какой даты действует скидка 10%? Введите ГГГГ-ММ-ДД или «без срока».',
] as const;

export const tariffFieldLabels = [
  'Название', 'Площадки', 'Что входит', 'Количество публикаций', 'Срок размещения',
  'Срок запроса результата', 'Дополнительные условия', 'Цена', 'Дата скидки',
] as const;

const referralBonusQuestions = [
  'Размер бонуса введите числом (например, 15.00). Введите 0, чтобы отключить начисление.',
  'Валюта бонуса — три латинские буквы, например EUR.',
  'Срок использования бонуса в днях (1–3650) или «без срока».',
  'Разрешить совмещать бонус с 10% скидкой на первое размещение? Ответьте «да» или «нет».',
  'Укажите тарифы, на которых действует бонус: точные названия через «;» или «все». Доступные тарифы перечислены ниже.',
] as const;

function tariffPrompt(flow: AdminFlow, step = flow.step): string {
  const current = flow.payload[`answer${step}`];
  return `${tariffQuestions[step]}${flow.flowType === 'tariff_edit' ? `\nТекущее значение: ${current || 'не указано'}. Отправьте новое или «без изменений».` : ''}`;
}

export class AdminService {
  private readonly repository: AdminRepository;

  constructor(repository: AdminRepository) {
    this.repository = repository;
  }

  async startTariffCreate(adminTelegramId: string): Promise<string> {
    await this.repository.saveFlow(adminTelegramId, {
      flowType: 'tariff_create', step: 0, payload: {},
    });
    return tariffQuestions[0];
  }

  async startTariffEdit(adminTelegramId: string, tariffId: string): Promise<string | undefined> {
    const tariff = (await this.repository.listTariffs()).find((item) => item.id === tariffId);
    if (!tariff) return undefined;
    const flow: AdminFlow = {
      flowType: 'tariff_edit', step: 0, payload: {
        tariffId,
        answer0: tariff.name,
        answer1: tariff.platforms,
        answer2: tariff.inclusions,
        answer3: tariff.publicationCount === null ? '' : String(tariff.publicationCount),
        answer4: tariff.placementDuration,
        answer5: String(tariff.feedbackDelayDays),
        answer6: tariff.description,
        answer7: tariff.price,
        answer8: tariff.discountValidUntil ?? 'без срока',
      },
    };
    await this.repository.saveFlow(adminTelegramId, flow);
    return `Редактирование «${tariff.name}». ${tariffPrompt(flow)}`;
  }

  async startTariffEditField(adminTelegramId: string, tariffId: string, field: number): Promise<string | undefined> {
    if (!Number.isInteger(field) || field < 0 || field >= tariffQuestions.length) return undefined;
    const tariff = (await this.repository.listTariffs()).find((item) => item.id === tariffId);
    if (!tariff) return undefined;
    const answers = [
      tariff.name, tariff.platforms, tariff.inclusions,
      tariff.publicationCount === null ? '' : String(tariff.publicationCount),
      tariff.placementDuration, String(tariff.feedbackDelayDays), tariff.description,
      tariff.price, tariff.discountValidUntil ?? 'без срока',
    ];
    const flow: AdminFlow = {
      flowType: 'tariff_edit', step: field,
      payload: { tariffId, singleField: 'true', ...Object.fromEntries(answers.map((value, index) => [`answer${index}`, value])) },
    };
    await this.repository.saveFlow(adminTelegramId, flow);
    return `Изменение тарифа «${tariff.name}» · ${tariffFieldLabels[field]}. ${tariffPrompt(flow)}`;
  }

  async startMessage(
    adminTelegramId: string,
    userTelegramId: string,
    inquiryId?: string,
    materialOrderId?: string,
    inquiryTopic?: string,
    customerContext?: string,
    recipientLabel?: string,
    paymentRequestId?: string,
    paymentOrderId?: string,
    paymentMode?: 'plain' | 'instructions',
  ): Promise<string> {
    await this.repository.saveFlow(adminTelegramId, {
      flowType: 'message_user',
      step: 0,
      payload: {
        userTelegramId,
        ...(inquiryId ? { inquiryId } : {}),
        ...(materialOrderId ? { materialOrderId } : {}),
        ...(paymentRequestId ? { paymentRequestId } : {}),
        ...(paymentOrderId ? { paymentOrderId } : {}),
        ...(paymentMode ? { paymentMode } : {}),
        customerContext: customerContext
          ?? (inquiryId
            ? `Ответ администратора на ваш вопрос «${inquiryTopic ?? 'обращение'}».`
            : 'Личное сообщение от администратора.'),
      },
    });
    const recipient = recipientLabel ? ` для ${recipientLabel}` : ' для пользователя';
    return inquiryId
      ? inquiryTopic
        ? `Введите ответ по обращению «${inquiryTopic}»${recipient}.\nКонтекст, который получит пользователь: ${customerContext ?? `ответ на его вопрос «${inquiryTopic}»`}`
        : `Введите ответ на обращение${recipient}.`
      : materialOrderId
        ? `Опишите, что рекламодателю нужно исправить в материалах заказа${recipient}.\nКонтекст: ${customerContext ?? 'ответ по заказу'}`
        : `Введите сообщение${recipient}.${customerContext ? `\nКонтекст: ${customerContext}` : ''}`;
  }

  async startBusinessFilter(adminTelegramId: string): Promise<string> {
    await this.repository.saveFlow(adminTelegramId, {
      flowType: 'filter_business', step: 0, payload: {},
    });
    return 'Введите имя пользователя, @ник или название бизнеса. Поиск выполнится сразу по всем трём параметрам.';
  }

  async startScheduleOrder(adminTelegramId: string, orderId: string): Promise<string> {
    await this.repository.saveFlow(adminTelegramId, {
      flowType: 'schedule_order', step: 0, payload: { orderId },
    });
    return 'Выберите дату публикации в календаре или отправьте её текстом в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.';
  }

  async startPublishOrder(adminTelegramId: string, orderId: string, publicationIndex: number): Promise<string> {
    const order = await this.repository.getOrderDateInfo(orderId);
    if (!order || order.status !== 'confirmed' || !Number.isInteger(publicationIndex)
      || publicationIndex < 0 || publicationIndex >= order.publicationDates.length
      || order.publicationStatuses[publicationIndex] === 'published') {
      return 'Эта публикация уже отмечена или заказ не найден. Обновите список публикаций.';
    }
    const date = order.publicationDates[publicationIndex];
    const dateStatus = order.publicationDateStatuses[publicationIndex] ?? (date ? 'confirmed' : 'awaiting_admin');
    if (!date || dateStatus !== 'confirmed') {
      return !date
        ? 'Сначала назначьте дату публикации. После этого пользователь получит предложение согласовать её.'
        : 'Сначала дождитесь согласования даты пользователем. При необходимости предложите новую дату.';
    }
    await this.repository.saveFlow(adminTelegramId, {
      flowType: 'publish_order', step: 0, payload: { orderId, publicationIndex: String(publicationIndex) },
    });
    return `Отметка публикации ${publicationIndex + 1} из ${order.publicationDates.length} по заказу №${order.orderNumber}${date ? ` · дата ${displayIsoDate(date)}` : ''}. Отправьте ссылку или нажмите «Без ссылки».`;
  }

  async startReferralBonusSettings(adminTelegramId: string): Promise<string> {
    const [settings, tariffs] = await Promise.all([
      this.repository.getReferralBonusSettings(),
      this.repository.listTariffs(),
    ]);
    const eligibleNames = settings.eligibleTariffIds === null
      ? 'все'
      : tariffs.filter((tariff) => settings.eligibleTariffIds?.includes(tariff.id)).map((tariff) => tariff.name).join('; ');
    const flow: AdminFlow = {
      flowType: 'referral_bonus_settings', step: 0, payload: {
        answer0: settings.amount,
        answer1: settings.currency,
        answer2: settings.validityDays === null ? 'без срока' : String(settings.validityDays),
        answer3: settings.combineWithFirstDiscount ? 'да' : 'нет',
        answer4: settings.eligibleTariffIds?.join(',') ?? '*',
        answer4Label: eligibleNames || 'тарифы не выбраны',
      },
    };
    await this.repository.saveFlow(adminTelegramId, flow);
    const active = settings.isActive ? 'включены' : 'отключены';
    return `Настройка реферального бонуса (сейчас начисления ${active}).\nТекущие условия: ${settings.amount} ${settings.currency}, срок: ${settings.validityDays === null ? 'без срока' : `${settings.validityDays} дн.`}, совмещение со скидкой: ${settings.combineWithFirstDiscount ? 'да' : 'нет'}, тарифы: ${eligibleNames || 'все'}.\n\n${referralBonusQuestions[0]}`;
  }

  async startPromotionalBroadcast(adminTelegramId: string, mode: 'now' | 'schedule'): Promise<string> {
    await this.repository.saveFlow(adminTelegramId, {
      flowType: 'promotional_broadcast', step: 0,
      payload: { media: '[]', mode, draftToken: createPromotionalBroadcastDraftToken() },
    });
    return mode === 'schedule'
      ? 'Отправьте текст и медиа (до 10 файлов), затем выберите дату и время (Asia/Tomsk).'
      : 'Отправьте текст и медиа (до 10 файлов).';
  }

  async answer(adminTelegramId: string, value: string): Promise<AdminAnswerResult | undefined> {
    const flow = await this.repository.getFlow(adminTelegramId);
    if (!flow) return undefined;

    const answer = value.trim();
    if (!answer) return { kind: 'invalid', text: 'Введите непустое значение или нажмите «Назад».' };

    if (flow.flowType === 'publish_order') {
      const publicationLink = answer.toLowerCase() === 'без ссылки' ? null : answer;
      if (publicationLink) {
        try {
          const parsed = new URL(publicationLink);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL scheme');
        } catch {
          return { kind: 'invalid', text: 'Отправьте ссылку, начинающуюся с https:// или http://, либо нажмите кнопку «Без ссылки».' };
        }
      }
      const publication = await this.repository.markOrderPublished(
        flow.payload.orderId ?? '',
        Number(flow.payload.publicationIndex ?? '0'),
        publicationLink,
      );
      await this.repository.clearFlow(adminTelegramId);
      if (!publication) return { kind: 'done', text: 'Заказ не найден или публикацию не удалось отметить.' };
      return {
        kind: 'done',
        text: publication.allPublished
          ? `Все ${publication.publicationCount} публикации заказа №${publication.orderNumber} отмечены как опубликованные.`
          : `Публикация ${publication.publicationNumber} из ${publication.publicationCount} заказа №${publication.orderNumber} отмечена. Осталось: ${publication.remainingPublications}.`,
        publicationNotification: publication,
      };
    }

    if (flow.flowType === 'promotional_broadcast') {
      if (flow.step === 2) return { kind: 'invalid', text: 'Рассылка уже отправляется. Дождитесь результата.' };
      if (answer.length > 4096) {
        return { kind: 'invalid', text: 'Текст не должен превышать 4096 символов.' };
      }
      const payload = { ...flow.payload, text: answer, media: flow.payload.media ?? '[]' };
      await this.repository.savePromotionalDraftFlow(adminTelegramId, { ...flow, step: 1, payload });
      return {
        kind: 'prompt',
        text: 'Текст сохранён. Добавьте медиа или продолжите.',
      };
    }

    if (flow.flowType === 'referral_bonus_settings') {
      return this.answerReferralBonusSettings(adminTelegramId, flow, answer);
    }

    if (flow.flowType === 'tariff_create' || flow.flowType === 'tariff_edit') {
      return this.answerTariff(adminTelegramId, flow, answer);
    }

    if (flow.flowType === 'message_user') {
      await this.repository.clearFlow(adminTelegramId);
      return {
        kind: 'send_message',
        telegramId: flow.payload.userTelegramId ?? '',
        message: answer,
        customerContext: flow.payload.customerContext ?? 'Личное сообщение от администратора.',
        ...(flow.payload.inquiryId ? { inquiryId: flow.payload.inquiryId } : {}),
        ...(flow.payload.materialOrderId ? { materialOrderId: flow.payload.materialOrderId } : {}),
        ...(flow.payload.paymentRequestId ? { paymentRequestId: flow.payload.paymentRequestId } : {}),
        ...(flow.payload.paymentOrderId ? { paymentOrderId: flow.payload.paymentOrderId } : {}),
        ...(flow.payload.paymentMode === 'instructions' ? { paymentMode: 'instructions' as const } : {}),
      };
    }

    if (flow.flowType === 'filter_business') {
      await this.repository.clearFlow(adminTelegramId);
      return { kind: 'businesses', rows: await this.repository.listBusinessLeads(null, answer) };
    }

    if (flow.flowType === 'schedule_order') {
      const date = parsePublicationDate(answer);
      if (!date) return { kind: 'invalid', text: 'Введите будущую дату в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД, либо выберите её в календаре.' };
      const scheduled = await this.repository.scheduleOrder(flow.payload.orderId ?? '', `${date}T12:00:00.000Z`);
      await this.repository.clearFlow(adminTelegramId);
      return {
        kind: 'done',
        text: 'Дата публикации сохранена.',
        ...(scheduled ? { customerNotification: scheduled } : {}),
      };
    }

    if (flow.flowType === 'edit_publication_date') {
      return { kind: 'invalid', text: 'Выберите дату в календаре, который бот отправил для этой публикации.' };
    }

    return undefined;
  }

  async goBack(adminTelegramId: string): Promise<{ kind: 'prompt'; text: string } | { kind: 'menu' }> {
    const flow = await this.repository.getFlow(adminTelegramId);
    if (!flow) return { kind: 'menu' };

    if (flow.flowType === 'tariff_edit' && flow.payload.singleField === 'true') {
      await this.repository.clearFlow(adminTelegramId);
      return { kind: 'menu' };
    }

    if ((flow.flowType === 'tariff_create' || flow.flowType === 'tariff_edit') && flow.step > 0) {
      const previousStep = flow.step - 1;
      const payload = { ...flow.payload };
      if (flow.flowType === 'tariff_create') delete payload[`answer${previousStep}`];
      await this.repository.saveFlow(adminTelegramId, { ...flow, step: previousStep, payload });
      return { kind: 'prompt', text: tariffPrompt({ ...flow, step: previousStep }) };
    }

    await this.repository.clearFlow(adminTelegramId);
    return { kind: 'menu' };
  }

  cancel(adminTelegramId: string): Promise<void> {
    return this.repository.clearFlow(adminTelegramId);
  }

  recordMessage(adminTelegramId: string, userTelegramId: string, message: string): Promise<void> {
    return this.repository.recordMessage(adminTelegramId, userTelegramId, message);
  }

  private async answerTariff(
    adminTelegramId: string,
    flow: AdminFlow,
    answer: string,
  ): Promise<AdminAnswerResult> {
    const singleField = flow.flowType === 'tariff_edit' && flow.payload.singleField === 'true';
    if (flow.flowType === 'tariff_edit' && answer.toLowerCase() === 'без изменений') {
      if (singleField) {
        await this.repository.clearFlow(adminTelegramId);
        return { kind: 'done', text: 'Изменения отменены.' };
      }
      return this.advanceTariff(adminTelegramId, flow, flow.payload[`answer${flow.step}`] ?? '');
    }

    const optionalValue = answer.toLowerCase() === 'не указано' || answer.toLowerCase() === 'не указан' || answer.toLowerCase() === 'нет'
      ? ''
      : answer;
    if (flow.step === 3 && optionalValue && !/^\d+$/.test(optionalValue)) {
      return { kind: 'invalid', text: 'Введите положительное целое число или «не указано».' };
    }
    if (flow.step === 3 && optionalValue && Number(optionalValue) < 1) {
      return { kind: 'invalid', text: 'Число публикаций должно быть больше нуля.' };
    }
    if (flow.step === 5 && (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > 3650)) {
      return { kind: 'invalid', text: 'Укажите число дней от 1 до 3650.' };
    }
    if (flow.step === 7 && !/^\d+(\.\d{1,2})?$/.test(answer)) {
      return { kind: 'invalid', text: 'Цена должна быть числом с максимум двумя знаками после точки.' };
    }

    if (flow.step === 8 && answer.toLowerCase() !== 'без срока' && !this.isValidDate(answer)) {
      return { kind: 'invalid', text: 'Дата должна быть в формате ГГГГ-ММ-ДД или «без срока».' };
    }

    if (singleField) {
      const payload = { ...flow.payload, [`answer${flow.step}`]: flow.step === 3 || flow.step === 4 || flow.step === 6 ? optionalValue : answer };
      await this.repository.updateTariff(
        flow.payload.tariffId ?? '', payload.answer0 ?? '', payload.answer1 ?? '', payload.answer2 ?? '',
        payload.answer3 ? Number(payload.answer3) : null, payload.answer4 ?? '', Number(payload.answer5 ?? '14'),
        payload.answer6 ?? '', payload.answer7 ?? '0',
        payload.answer8?.toLowerCase() === 'без срока' ? null : payload.answer8 ?? null,
      );
      await this.repository.clearFlow(adminTelegramId);
      return { kind: 'done', text: `Пункт «${tariffFieldLabels[flow.step]}» тарифа обновлён.` };
    }

    return this.advanceTariff(adminTelegramId, flow, flow.step === 8 && answer.toLowerCase() === 'без срока' ? 'без срока' : optionalValue);
  }

  private async answerReferralBonusSettings(
    adminTelegramId: string,
    flow: AdminFlow,
    answer: string,
  ): Promise<AdminAnswerResult> {
    if (answer.toLowerCase() === 'без изменений') {
      return this.advanceReferralBonusSettings(adminTelegramId, flow, flow.payload[`answer${flow.step}`] ?? '');
    }
    if (flow.step === 0 && !/^\d+(\.\d{1,2})?$/.test(answer)) {
      return { kind: 'invalid', text: 'Введите сумму числом не более чем с двумя знаками после точки.' };
    }
    if (flow.step === 1 && !/^[a-zA-Z]{3}$/.test(answer)) {
      return { kind: 'invalid', text: 'Введите трёхбуквенный код валюты, например EUR.' };
    }
    if (flow.step === 2 && answer.toLowerCase() !== 'без срока' && (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > 3650)) {
      return { kind: 'invalid', text: 'Введите число дней от 1 до 3650 или «без срока».' };
    }
    if (flow.step === 3 && !['да', 'нет'].includes(answer.toLowerCase())) {
      return { kind: 'invalid', text: 'Ответьте «да» или «нет».' };
    }
    if (flow.step === 4) {
      const value = answer.toLowerCase();
      if (value !== 'все' && value !== 'все тарифы') {
        const names = answer.split(';').map((name) => name.trim()).filter(Boolean);
        const tariffs = (await this.repository.listTariffs()).filter((tariff) => tariff.isActive);
        const matched = names.map((name) => tariffs.find((tariff) => tariff.name.toLowerCase() === name.toLowerCase()));
        if (names.length === 0 || matched.some((tariff) => !tariff)) {
          return { kind: 'invalid', text: `Не нашёл тариф с таким точным названием. Введите названия через «;» или «все». Доступно: ${tariffs.map((tariff) => tariff.name).join('; ') || 'активных тарифов нет'}.` };
        }
        return this.advanceReferralBonusSettings(adminTelegramId, flow, matched.map((tariff) => tariff!.id).join(','));
      }
      return this.advanceReferralBonusSettings(adminTelegramId, flow, '*');
    }
    return this.advanceReferralBonusSettings(adminTelegramId, flow, flow.step === 3 ? answer.toLowerCase() : answer);
  }

  private async advanceReferralBonusSettings(adminTelegramId: string, flow: AdminFlow, answer: string): Promise<AdminAnswerResult> {
    const payload = { ...flow.payload, [`answer${flow.step}`]: answer };
    const nextStep = flow.step + 1;
    if (nextStep < referralBonusQuestions.length) {
      await this.repository.saveFlow(adminTelegramId, { ...flow, step: nextStep, payload });
      const tariffs = nextStep === 4
        ? (await this.repository.listTariffs()).filter((tariff) => tariff.isActive).map((tariff) => tariff.name)
        : [];
      return {
        kind: 'prompt',
        text: `${referralBonusQuestions[nextStep]}${tariffs.length ? `\n\nДоступные тарифы: ${tariffs.join('; ')}` : ''}\nТекущее значение: ${payload[`answer${nextStep}Label`] ?? payload[`answer${nextStep}`] ?? 'не задано'}. Отправьте новое или «без изменений».`,
      };
    }

    const eligibleTariffIds = payload.answer4 === '*'
      ? null
      : (payload.answer4 ?? '').split(',').filter(Boolean);
    await this.repository.updateReferralBonusSettings({
      amount: payload.answer0 ?? '0',
      currency: (payload.answer1 ?? 'EUR').toUpperCase(),
      validityDays: payload.answer2?.toLowerCase() === 'без срока' ? null : Number(payload.answer2),
      combineWithFirstDiscount: payload.answer3 === 'да',
      eligibleTariffIds,
      isActive: Number(payload.answer0 ?? '0') > 0,
    });
    await this.repository.clearFlow(adminTelegramId);
    const tariffLabel = eligibleTariffIds === null ? 'все активные тарифы' : `${eligibleTariffIds.length} выбранных тарифов`;
    return {
      kind: 'done',
      text: Number(payload.answer0 ?? '0') > 0
        ? `Реферальный бонус включён: ${payload.answer0} ${(payload.answer1 ?? 'EUR').toUpperCase()}, срок ${payload.answer2}, совмещение со скидкой: ${payload.answer3}, тарифы: ${tariffLabel}. Он будет начисляться после первой подтверждённой оплаты приглашённого рекламодателя.`
        : 'Реферальное начисление отключено. Уже начисленные бонусы сохранены.',
    };
  }

  private async advanceTariff(adminTelegramId: string, flow: AdminFlow, answer: string): Promise<AdminAnswerResult> {
    const payload = { ...flow.payload, [`answer${flow.step}`]: answer };
    const nextStep = flow.step + 1;
    if (nextStep < tariffQuestions.length) {
      await this.repository.saveFlow(adminTelegramId, { ...flow, step: nextStep, payload });
      return { kind: 'prompt', text: tariffPrompt({ ...flow, step: nextStep, payload }) };
    }

    const discountValue = payload.answer8 ?? 'без срока';
    const discountValidUntil = discountValue.toLowerCase() === 'без срока' ? null : discountValue;
    const publicationCount = payload.answer3 ? Number(payload.answer3) : null;
    const feedbackDelayDays = Number(payload.answer5 ?? '14');
    if (flow.flowType === 'tariff_create') {
      await this.repository.createTariff(
        payload.answer0 ?? '',
        payload.answer1 ?? '',
        payload.answer2 ?? '',
        publicationCount,
        payload.answer4 ?? '',
        feedbackDelayDays,
        payload.answer6 ?? '',
        payload.answer7 ?? '0',
        discountValidUntil,
      );
    } else {
      await this.repository.updateTariff(
        flow.payload.tariffId ?? '',
        payload.answer0 ?? '',
        payload.answer1 ?? '',
        payload.answer2 ?? '',
        publicationCount,
        payload.answer4 ?? '',
        feedbackDelayDays,
        payload.answer6 ?? '',
        payload.answer7 ?? '0',
        discountValidUntil,
      );
    }
    await this.repository.clearFlow(adminTelegramId);
    return { kind: 'done', text: 'Тариф сохранён.' };
  }

  private isValidDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
}
