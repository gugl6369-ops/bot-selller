import { AdvertiserRepository } from '../db/repositories/advertiser-repository.ts';
import type { AdvertiserAnswerResult, AdvertiserFlowState as FlowState } from '../types/advertiser.ts';

export const advertiserQuestions = [
  'Как называется ваш бизнес или проект?',
  'В какой сфере вы работаете?',
  'В каком городе или регионе работаете?',
  'Пришлите ссылку на сайт, страницу или социальную сеть.',
  'Как с вами связаться?',
  'Когда планируете размещение?',
] as const;

export const questionTopics = [
  { id: 'tariffs', label: 'Тарифы и форматы' },
  { id: 'discount', label: 'Скидка на первое размещение' },
  { id: 'payment', label: 'Оплата' },
  { id: 'materials', label: 'Подготовка рекламного материала' },
  { id: 'moderation', label: 'Модерация и дата публикации' },
  { id: 'results', label: 'Результат рекламы' },
  { id: 'repeat', label: 'Повторное размещение' },
  { id: 'referrals', label: 'Реферальная программа' },
  { id: 'other', label: 'Другое' },
] as const;

export class AdvertiserService {
  private readonly advertisers: AdvertiserRepository;

  constructor(advertisers: AdvertiserRepository) {
    this.advertisers = advertisers;
  }

  async startOnboarding(telegramId: string, pendingTariffId?: string): Promise<string> {
    await this.advertisers.saveFlow(telegramId, {
      flowType: 'advertiser_onboarding',
      step: 0,
      payload: pendingTariffId ? { pendingTariffId } : {},
    });

    return advertiserQuestions[0];
  }

  async goBack(telegramId: string): Promise<{ kind: 'prompt'; text: string } | { kind: 'menu' }> {
    const flow = await this.advertisers.getFlow(telegramId);
    if (!flow || flow.flowType === 'question' || flow.step === 0) {
      await this.advertisers.clearFlow(telegramId);
      return { kind: 'menu' };
    }

    const previousStep = flow.step - 1;
    const payload = { ...flow.payload };
    delete payload[`answer${previousStep}`];
    await this.advertisers.saveFlow(telegramId, {
      flowType: 'advertiser_onboarding',
      step: previousStep,
      payload,
    });

    return { kind: 'prompt', text: advertiserQuestions[previousStep] };
  }

  async startQuestion(telegramId: string, topicId: string): Promise<string | undefined> {
    const topic = questionTopics.find((item) => item.id === topicId);
    if (!topic) return undefined;

    await this.advertisers.saveFlow(telegramId, {
      flowType: 'question',
      step: 0,
      payload: { topic: topic.label },
    });

    return `Напишите ваш вопрос по теме «${topic.label}».`;
  }

  async startContactUpdate(telegramId: string): Promise<string> {
    await this.advertisers.saveFlow(telegramId, {
      flowType: 'contact_update',
      step: 0,
      payload: {},
    });
    return 'Отправьте новый телефон, email, ссылку или другой удобный способ связи.';
  }

  async answer(telegramId: string, answer: string): Promise<AdvertiserAnswerResult | undefined> {
    const flow = await this.advertisers.getFlow(telegramId);
    if (!flow) return undefined;

    if (answer.trim().toLowerCase() === 'отмена' || answer.trim() === '/cancel') {
      await this.advertisers.clearFlow(telegramId);
      return { kind: 'cancelled' };
    }

    const value = answer.trim();
    if (!value) return { kind: 'empty' };

    if (flow.flowType === 'question') {
      const topic = flow.payload.topic ?? 'Другое';
      const inquiry = await this.advertisers.createInquiry(telegramId, topic, value);
      await this.advertisers.clearFlow(telegramId);
      return { kind: 'question_submitted', inquiry, topic };
    }

    if (flow.flowType === 'contact_update') {
      const saved = await this.advertisers.updateContactValue(telegramId, value);
      await this.advertisers.clearFlow(telegramId);
      return { kind: 'contact_updated', saved };
    }

    return this.saveOnboardingAnswer(telegramId, flow, value);
  }

  async cancel(telegramId: string): Promise<void> {
    await this.advertisers.clearFlow(telegramId);
  }

  private async saveOnboardingAnswer(
    telegramId: string,
    flow: FlowState,
    value: string,
  ): Promise<AdvertiserAnswerResult> {
    const payload = { ...flow.payload, [`answer${flow.step}`]: value };
    const nextStep = flow.step + 1;

    if (nextStep < advertiserQuestions.length) {
      await this.advertisers.saveFlow(telegramId, {
        flowType: 'advertiser_onboarding',
        step: nextStep,
        payload,
      });

      return { kind: 'prompt', text: advertiserQuestions[nextStep] };
    }

    const saved = await this.advertisers.saveBusiness(telegramId, {
      businessName: payload.answer0 ?? '',
      industry: payload.answer1 ?? '',
      region: payload.answer2 ?? '',
      websiteUrl: payload.answer3 ?? '',
      contactValue: payload.answer4 ?? '',
      requestedPlacement: payload.answer5 ?? '',
    });
    await this.advertisers.clearFlow(telegramId);

    return {
      kind: 'onboarding_complete',
      alreadySaved: !saved,
      pendingTariffId: flow.payload.pendingTariffId,
    };
  }
}
