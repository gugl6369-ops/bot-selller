import {
  OrderMaterialRepository,
} from '../db/repositories/order-material-repository.ts';
import type { MaterialAnswerResult, OrderMaterialMedia, OrderMaterialState, ReusableOrderMaterials } from '../types/order-material.ts';

export class OrderMaterialService {
  private readonly materials: OrderMaterialRepository;

  constructor(materials: OrderMaterialRepository) {
    this.materials = materials;
  }

  startAfterPayment(orderId: string): Promise<OrderMaterialState | undefined> {
    return this.materials.startAfterPayment(orderId);
  }

  reusableForOrder(orderId: string): Promise<ReusableOrderMaterials | undefined> {
    return this.materials.getReusableForOrder(orderId);
  }

  reusePublishedMaterials(telegramId: string, orderId: string, sourceOrderNumber: string): Promise<boolean> {
    return this.materials.reusePublishedMaterials(telegramId, orderId, sourceOrderNumber);
  }

  current(telegramId: string): Promise<OrderMaterialState | undefined> {
    return this.materials.getActive(telegramId);
  }

  forOrder(orderId: string): Promise<OrderMaterialState | undefined> {
    return this.materials.getForOrder(orderId);
  }

  pause(telegramId: string): Promise<OrderMaterialState | undefined> {
    return this.materials.pauseActive(telegramId);
  }

  async resume(telegramId: string): Promise<OrderMaterialState | undefined> {
    return (await this.current(telegramId)) ?? this.materials.resumePaused(telegramId);
  }

  async answerText(telegramId: string, input: string): Promise<MaterialAnswerResult> {
    const state = await this.current(telegramId);
    if (!state || state.status !== 'collecting') return { kind: 'no_active_flow' };
    const value = input.trim();
    if (!value) return { kind: 'invalid', message: 'Отправьте непустой ответ.' };

    if (state.step === 0) {
      if (value.length > 1800) return { kind: 'invalid', message: 'Текст рекламы слишком длинный. Максимум 1800 символов.' };
      await this.materials.saveAdText(state.orderId, value);
      const updated = await this.current(telegramId);
      return updated ? { kind: 'updated', state: updated } : { kind: 'no_active_flow' };
    }
    if (state.step === 1) {
      if (/^(готово|пропустить|нет|без (фото|видео|медиа))$/i.test(value)) {
        await this.materials.advanceFromMedia(state.orderId);
        const updated = await this.current(telegramId);
        return updated ? { kind: 'updated', state: updated } : { kind: 'no_active_flow' };
      }
      return { kind: 'media_step' };
    }
    if (state.step === 2) {
      if (value.length > 700) return { kind: 'invalid', message: 'Ссылка или контакт слишком длинные. Максимум 700 символов.' };
      await this.materials.saveDestination(state.orderId, value);
      const updated = await this.current(telegramId);
      return updated ? { kind: 'updated', state: updated } : { kind: 'no_active_flow' };
    }
    if (state.step === 3 && state.revisionMode) {
      return { kind: 'invalid', message: 'Даты указаны в заказе. Передача материалов их не меняет.' };
    }
    if (state.step === 3 && !state.revisionMode) {
      if (value.length > 700) return { kind: 'invalid', message: 'Пожелания слишком длинные. Максимум 700 символов.' };
      const updated = await this.materials.saveWishesDraft(state.orderId, value);
      return updated ? { kind: 'updated', state: updated } : { kind: 'no_active_flow' };
    }
    if (state.step === 4 && state.reviewMode) {
      return { kind: 'invalid', message: 'Проверьте материалы в сообщении выше и выберите, что изменить, или подтвердите отправку.' };
    }
    if (state.step === 4) {
      if (!state.revisionMode) {
        return { kind: 'invalid', message: 'Проверьте материалы в сообщении выше и выберите, что изменить, или подтвердите отправку.' };
      }
      if (value.length > 700) return { kind: 'invalid', message: 'Пожелания слишком длинные. Максимум 700 символов.' };
      if (!(await this.materials.saveWishes(state.orderId, value))) return { kind: 'no_active_flow' };
      const updated = await this.current(telegramId);
      return updated ? { kind: 'updated', state: updated } : { kind: 'no_active_flow' };
    }
    return { kind: 'no_active_flow' };
  }

  async receiveMedia(telegramId: string, media: OrderMaterialMedia): Promise<OrderMaterialState | undefined> {
    const state = await this.current(telegramId);
    if (!state || state.step > 4 || state.media.length >= 10) return undefined;
    if (media.caption.length > 1000) return undefined;
    if (state.step === 0 && media.caption.trim()) {
      if (media.caption.length > 1800) return undefined;
      if (!(await this.materials.saveAdTextWithMedia(state.orderId, media.caption.trim(), media))) return undefined;
    } else if (!(await this.materials.addMedia(state.orderId, media))) {
      return undefined;
    }
    return this.current(telegramId);
  }

  async receiveMediaBatch(
    telegramId: string,
    mediaItems: OrderMaterialMedia[],
  ): Promise<{ state: OrderMaterialState | undefined; added: number; skipped: number }> {
    let state = await this.current(telegramId);
    const startingCount = state?.media.length ?? 0;
    if (!state) return { state: undefined, added: 0, skipped: mediaItems.length };
    for (const media of mediaItems) {
      if (state.media.length >= 10) break;
      const updated = await this.receiveMedia(telegramId, media);
      if (updated) state = updated;
    }
    const added = (state?.media.length ?? startingCount) - startingCount;
    return { state, added, skipped: mediaItems.length - added };
  }

  async skipMedia(telegramId: string): Promise<OrderMaterialState | undefined> {
    const state = await this.current(telegramId);
    if (!state || state.step !== 1) return undefined;
    if (!(await this.materials.advanceFromMedia(state.orderId))) return undefined;
    return this.current(telegramId);
  }

  async skipWishes(telegramId: string): Promise<MaterialAnswerResult> {
    const state = await this.current(telegramId);
    if (!state || (state.step !== 3 && !(state.revisionMode && state.step === 4))) return { kind: 'no_active_flow' };
    if (state.revisionMode) {
      if (!(await this.materials.saveWishes(state.orderId, ''))) return { kind: 'no_active_flow' };
      const updated = await this.current(telegramId);
      return updated ? { kind: 'updated', state: updated } : { kind: 'no_active_flow' };
    }
    const updated = await this.materials.saveWishesDraft(state.orderId, '');
    return updated ? { kind: 'updated', state: updated } : { kind: 'no_active_flow' };
  }

  async selectReviewField(telegramId: string, field: 'text' | 'media' | 'destination' | 'wishes'): Promise<OrderMaterialState | undefined> {
    const state = await this.current(telegramId);
    if (!state || state.step !== 4 || state.revisionMode) return undefined;
    const steps = { text: 0, media: 1, destination: 2, wishes: 3 } as const;
    if (!(await this.materials.selectReviewField(state.orderId, steps[field]))) return undefined;
    return this.current(telegramId);
  }

  async submitMaterials(telegramId: string): Promise<MaterialAnswerResult> {
    const state = await this.current(telegramId);
    if (!state || state.step !== 4 || state.revisionMode) return { kind: 'no_active_flow' };
    const submitted = await this.materials.submitMaterials(state.orderId);
    return submitted?.status === 'submitted'
      ? { kind: 'submitted', state: submitted }
      : { kind: 'no_active_flow' };
  }

  async selectRevisionField(telegramId: string, field: 'text' | 'media' | 'destination' | 'date' | 'wishes'): Promise<OrderMaterialState | undefined> {
    const state = await this.current(telegramId);
    if (!state || !state.revisionMode || state.step !== 6) return undefined;
    const steps = { text: 0, media: 1, destination: 2, date: 3, wishes: 4 } as const;
    if (!(await this.materials.selectRevisionField(state.orderId, steps[field]))) return undefined;
    return this.current(telegramId);
  }

  async revisionMenu(telegramId: string): Promise<OrderMaterialState | undefined> {
    const state = await this.current(telegramId);
    if (!state || !state.revisionMode) return undefined;
    if (state.step !== 6 && !(await this.materials.returnToRevisionMenu(state.orderId))) return undefined;
    return this.current(telegramId);
  }

  async removeMedia(telegramId: string, index: number, expectedKey: string): Promise<OrderMaterialState | undefined> {
    const state = await this.current(telegramId);
    if (!state || !Number.isInteger(index) || index < 0) return undefined;
    if (!(await this.materials.removeMedia(state.orderId, index, expectedKey))) return undefined;
    return this.current(telegramId);
  }

  async submitRevision(telegramId: string): Promise<MaterialAnswerResult> {
    const state = await this.current(telegramId);
    if (!state || !state.revisionMode || state.step !== 6) return { kind: 'no_active_flow' };
    const submitted = await this.materials.submitRevision(state.orderId);
    return submitted?.status === 'submitted'
      ? { kind: 'submitted', state: submitted }
      : { kind: 'no_active_flow' };
  }
}
