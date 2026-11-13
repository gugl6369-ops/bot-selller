import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { AdminRepository } from '../../../db/repositories/admin-repository.ts';
import { OrderService } from '../../../services/order-service.ts';
import type { StartService } from '../../../services/start-service.ts';
import type { OrderMaterialService } from '../../../services/order-material-service.ts';
import { notifyPaymentReported } from '../../../services/admin-notifications.ts';
import { menuKeyboard, isAdvertiser, sendMaterialPrompt, sendMaterialPromptWithReuseOffer, refreshMaterialPrompt, handleMaterialAnswer, forwardMaterialsToAdmins } from './presentation.ts';

interface AlbumBuffer {
  ctx: Context;
  media: { kind: 'photo' | 'video'; fileId: string; caption: string }[];
  timer: ReturnType<typeof setTimeout>;
}

export function registerMaterialHandlers(bot: Bot, startService: StartService, orderService: OrderService, materialService: OrderMaterialService, adminRepository: AdminRepository): void {
  const albumBuffers = new Map<string, AlbumBuffer>();
  const acceptMedia = async (
    ctx: Context,
    telegramId: string,
    media: { kind: 'photo' | 'video'; fileId: string; caption: string }[],
  ): Promise<void> => {
    const activeFlow = await materialService.current(telegramId);
    if (!activeFlow) return;
    const result = await materialService.receiveMediaBatch(telegramId, media);
    const state = result.state;
    if (!state || result.added === 0) {
      if (activeFlow.revisionMode && activeFlow.step === 6) {
        await ctx.reply('Чтобы добавить фото или видео к исправлениям, сначала нажмите «Изменить фото и видео».');
        return;
      }
      await ctx.reply(activeFlow.media.length >= 10
        ? 'Достигнут лимит в 10 файлов.'
        : 'Не удалось принять медиа. Проверьте, что подпись не длиннее 1000 символов.');
      return;
    }
    if (result.skipped > 0) {
      await ctx.reply(state.media.length >= 10
        ? `Принято ${result.added} из ${media.length} файлов: достигнут лимит в 10.`
        : `Принято ${result.added} из ${media.length} файлов. Остальные не удалось принять; отправьте их ещё раз без длинной подписи.`);
    } else if (activeFlow.step === 0 && !media.some((item) => item.caption.trim())) {
      await ctx.reply(`Принято ${result.added} фото/видео (${state.media.length}/10). Теперь отправьте текст рекламы или добавьте его подписью к медиа.`);
    }
    await sendMaterialPrompt(ctx, state);
  };

  bot.callbackQuery(/^materials:/, async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const telegramId = String(sender.id);
    const [, action, value, token] = ctx.callbackQuery.data.split(':');
    if (action === 'noop') return;
    if (action === 'new' && value) {
      const state = await materialService.current(telegramId);
      if (!state || state.orderId !== value || state.status !== 'collecting') {
        await ctx.reply('Передача материалов по этому заказу уже завершена. Откройте текущий заказ, чтобы продолжить.');
        return;
      }
      await ctx.editMessageText(`Хорошо, отправьте новые материалы для заказа №${state.orderNumber}.`, {
        reply_markup: new InlineKeyboard(),
      });
      await sendMaterialPrompt(ctx, state);
      return;
    }
    if (action === 'reuse' && value && token) {
      const state = await materialService.current(telegramId);
      if (!state || state.orderId !== value || state.status !== 'collecting') {
        await ctx.reply('Предложение использовать прошлые материалы уже устарело. Откройте текущий заказ, чтобы продолжить.');
        return;
      }
      const reused = await materialService.reusePublishedMaterials(telegramId, value, token);
      if (!reused) {
        await ctx.editMessageText('Не удалось повторно использовать материалы. Отправьте новые материалы для этого заказа.', {
          reply_markup: new InlineKeyboard(),
        });
        await sendMaterialPrompt(ctx, state);
        return;
      }
      await ctx.editMessageText(`Материалы из заказа №${token} повторно использованы для нового заказа №${state.orderNumber}.`, {
        reply_markup: new InlineKeyboard(),
      });
      await ctx.reply('Они уже были опубликованы и согласованы администратором, поэтому повторная проверка не требуется.');
      const reusedState = await materialService.forOrder(value);
      if (reusedState) {
        const delivery = await forwardMaterialsToAdmins(ctx, reusedState, adminRepository, token);
        if (delivery.deliveredAdmins > 0) {
          await ctx.reply('Администраторы уведомлены: материалы повторно использованы и уже согласованы.');
        } else if (reusedState.adminTelegramIds.length > 0) {
          await ctx.reply('Не удалось доставить уведомление администраторам. Пакет материалов доступен в панели «Материалы».');
        }
      }
      return;
    }
    if (action === 'edit' && value) {
      if (value === 'date') {
        await ctx.reply('Даты публикаций указаны в заказе и не меняются при передаче материалов.');
        return;
      }
      const state = await materialService.selectRevisionField(
        telegramId,
        value as 'text' | 'media' | 'destination' | 'wishes',
      );
      if (state) await refreshMaterialPrompt(ctx, state);
      return;
    }
    if (action === 'review_edit' && value) {
      const state = await materialService.selectReviewField(
        telegramId,
        value as 'text' | 'media' | 'destination' | 'wishes',
      );
      if (state) await refreshMaterialPrompt(ctx, state);
      return;
    }
    if (action === 'confirm') {
      await handleMaterialAnswer(ctx, await materialService.submitMaterials(telegramId), startService, adminRepository);
      return;
    }
    if (action === 'revision_menu') {
      const state = await materialService.revisionMenu(telegramId);
      if (state) await refreshMaterialPrompt(ctx, state);
      return;
    }
    if (action === 'remove_media' && value && token) {
      const state = await materialService.removeMedia(telegramId, Number(value), token);
      if (state) {
        const sourceMessage = ctx.callbackQuery.message;
        if (sourceMessage && ('photo' in sourceMessage || 'video' in sourceMessage)) {
          try {
            await ctx.editMessageCaption({
              caption: `Файл удалён из материалов заказа №${state.orderNumber}.`,
              reply_markup: new InlineKeyboard(),
            });
          } catch {
            // The preview could already be gone; the refreshed prompt below is what matters.
          }
        }
        await refreshMaterialPrompt(ctx, state);
      } else {
        await ctx.reply('Не удалось удалить этот файл. Обновите список материалов и попробуйте ещё раз.');
      }
      return;
    }
    if (action === 'submit_revision') {
      await handleMaterialAnswer(ctx, await materialService.submitRevision(telegramId), startService, adminRepository);
      return;
    }
    if (action === 'resume') {
      const state = await materialService.resume(telegramId);
      if (state) await sendMaterialPrompt(ctx, state);
      return;
    }
    if (action === 'skip_media' || action === 'media_done') {
      const state = await materialService.skipMedia(telegramId);
      if (state) await refreshMaterialPrompt(ctx, state);
      return;
    }
    if (['keep_date', 'choose_date', 'calendar', 'calendar_back', 'pickdate'].includes(action)) {
      await ctx.reply('Даты публикаций уже сохранены в заказе. Передача материалов их не меняет.');
      return;
    }
    if (action === 'skip_wishes') {
      await handleMaterialAnswer(ctx, await materialService.skipWishes(telegramId), startService, adminRepository);
    }
  });

  bot.on(['message:photo', 'message:video'], async (ctx) => {
    const sender = ctx.from;
    if (!sender || !(await isAdvertiser(ctx, startService))) return;
    const message = ctx.message;
    const paymentProofRequest = await orderService.pendingPaymentProof(String(sender.id));
    if (paymentProofRequest) {
      if (!('photo' in message) || !message.photo) {
        await ctx.reply(`Для подтверждения перевода по заказу №${paymentProofRequest.orderNumber} отправьте скриншот именно как фото.`);
        return;
      }
      const photo = message.photo.at(-1);
      if (!photo) {
        await ctx.reply('Не удалось прочитать изображение. Отправьте скриншот перевода ещё раз как фото.');
        return;
      }
      const payment = await orderService.submitPaymentProof(String(sender.id), photo.file_id);
      if (payment.kind === 'created') {
        await notifyPaymentReported(ctx.api, adminRepository, payment);
        await ctx.reply(`Скриншот перевода по заказу №${payment.orderNumber} получен и отправлен администратору на проверку.`, {
          reply_markup: await menuKeyboard(ctx, startService),
        });
      } else if (payment.kind === 'already_reported') {
        await ctx.reply(`Оплата заказа №${payment.orderNumber} уже отправлена администратору.`);
      } else {
        await ctx.reply('Не удалось связать скриншот с ожидающим заказом. Повторно выберите способ оплаты в разделе «Текущие заказы».');
      }
      return;
    }
    let media: { kind: 'photo' | 'video'; fileId: string; caption: string } | undefined;
    if ('photo' in message && message.photo) {
      const photo = message.photo.at(-1);
      if (photo) media = { kind: 'photo', fileId: photo.file_id, caption: message.caption ?? '' };
    } else if ('video' in message && message.video) {
      media = { kind: 'video', fileId: message.video.file_id, caption: message.caption ?? '' };
    }
    if (!media) return;
    const groupId = 'media_group_id' in message ? message.media_group_id : undefined;
    if (groupId) {
      const key = `${sender.id}:${groupId}`;
      const current = albumBuffers.get(key);
      if (current) {
        current.media.push(media);
        current.ctx = ctx;
        clearTimeout(current.timer);
        current.timer = setTimeout(() => {
          albumBuffers.delete(key);
          void acceptMedia(ctx, String(sender.id), current.media);
        }, 500);
      } else {
        const buffer: AlbumBuffer = {
          ctx,
          media: [media],
          timer: setTimeout(() => {
            albumBuffers.delete(key);
            void acceptMedia(buffer.ctx, String(sender.id), buffer.media);
          }, 500),
        };
        albumBuffers.set(key, buffer);
      }
      return;
    }
    await acceptMedia(ctx, String(sender.id), [media]);
  });


}
