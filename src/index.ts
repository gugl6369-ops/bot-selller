import { createBot } from './bot/create-bot.ts';
import { config } from './config/env.ts';
import { initializeDatabase } from './db/initialize.ts';
import { pool } from './db/pool.ts';
import { UserRepository } from './db/repositories/user-repository.ts';
import { AdvertiserRepository } from './db/repositories/advertiser-repository.ts';
import { AdminRepository } from './db/repositories/admin-repository.ts';
import { StartService } from './services/start-service.ts';
import { AdvertiserService } from './services/advertiser-service.ts';
import { AdminService } from './services/admin-service.ts';
import { OrderRepository } from './db/repositories/order-repository.ts';
import { OrderService } from './services/order-service.ts';
import { OrderMaterialRepository } from './db/repositories/order-material-repository.ts';
import { OrderMaterialService } from './services/order-material-service.ts';
import { dayCountLabel } from './services/admin-display.ts';
import { InlineKeyboard } from 'grammy';
import { sendPromotionalBroadcastContent } from './services/promotional-broadcast-delivery.ts';

const users = new UserRepository(pool);
const advertisers = new AdvertiserRepository(pool);
const adminRepository = new AdminRepository(pool);
const orderRepository = new OrderRepository(pool);
const orderMaterialRepository = new OrderMaterialRepository(pool);
const startService = new StartService(users, advertisers, orderRepository);
const advertiserService = new AdvertiserService(advertisers);
const adminService = new AdminService(adminRepository);
const orderService = new OrderService(orderRepository);
const orderMaterialService = new OrderMaterialService(orderMaterialRepository);
const bot = createBot(startService, advertisers, advertiserService, adminRepository, adminService, orderService, orderMaterialService);

let feedbackTimer: ReturnType<typeof setInterval> | undefined;
let paymentReminderTimer: ReturnType<typeof setInterval> | undefined;
let promotionalBroadcastTimer: ReturnType<typeof setInterval> | undefined;
let promotionalBroadcastWorkerRunning = false;
const stop = () => {
  if (feedbackTimer) clearInterval(feedbackTimer);
  if (paymentReminderTimer) clearInterval(paymentReminderTimer);
  if (promotionalBroadcastTimer) clearInterval(promotionalBroadcastTimer);
  bot.stop();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function sendDueFeedback(): Promise<void> {
  const due = await orderService.dueFeedback();
  for (const item of due) {
    try {
      await bot.api.sendMessage(
        item.telegramId,
        `Здравствуйте! Прошло ${dayCountLabel(item.feedbackDelayDays)} после размещения рекламы «${item.businessName}». Как вам результат?`,
        {
          reply_markup: new InlineKeyboard()
            .text('Все понравилось', `feedback:good:${item.id}`).row()
            .text('Хочу обсудить итог', `feedback:discuss:${item.id}`).row()
            .text('Хочу повторить рекламу', `feedback:repeat:${item.id}`),
        },
      );
      await orderService.markFeedbackSent(item.id);
    } catch (error) {
      await orderService.releaseFeedbackClaim(item.id);
      console.error(`Failed to send feedback request for order ${item.orderNumber}:`, error);
    }
  }
}

async function sendDuePaymentCheckoutReminders(): Promise<void> {
  const due = await orderService.duePaymentCheckoutReminders();
  for (const item of due) {
    try {
      await bot.api.sendMessage(
        item.telegramId,
        `Вы остановились на оплате заказа №${item.orderNumber}. Планируете продолжить заказ? Если возникла проблема, сообщите нам.`,
        {
          reply_markup: new InlineKeyboard()
            .text('Перейти к оплате', `pay:methods:${item.orderId}`).row()
            .text('Задать вопрос', 'open_question_topics').row()
            .text('Сообщить о проблеме', `order:problem:${item.orderId}`),
        },
      );
      await orderService.markPaymentCheckoutReminderSent(item.orderId);
    } catch (error) {
      await orderService.releasePaymentCheckoutReminder(item.orderId);
      console.error(`Failed to send payment reminder for order ${item.orderNumber}:`, error);
    }
  }
}

async function sendDuePromotionalBroadcasts(): Promise<void> {
  if (promotionalBroadcastWorkerRunning) return;
  promotionalBroadcastWorkerRunning = true;
  try {
    while (true) {
      const broadcast = await adminRepository.claimDuePromotionalBroadcast();
      if (!broadcast) return;
      // On an uncertain failure keep status='sending'; automatic retries could
      // duplicate deliveries because the Telegram API has no idempotency key.
      const recipients = await adminRepository.listPromotionalRecipients();
      let sent = 0;
      let partial = 0;
      let failed = 0;
      let skipped = 0;
      for (const recipientId of recipients) {
        const media = (Array.isArray(broadcast.media) ? broadcast.media : []) as { type?: string; fileId?: string }[];
        const safeMedia = media.filter((item) => (item.type === 'photo' || item.type === 'video')
          && typeof item.fileId === 'string').slice(0, 10) as { type: 'photo' | 'video'; fileId: string }[];
        const result = await sendPromotionalBroadcastContent(
          bot.api,
          recipientId,
          broadcast.text,
          safeMedia,
          () => adminRepository.hasPromotionalConsent(recipientId),
        );
        if (result.kind === 'delivered') sent += 1;
        else if (result.kind === 'partial') {
          partial += 1;
          if (result.error) console.error(`Could not finish scheduled promotional broadcast ${broadcast.id} for Telegram user ${recipientId}:`, result.error);
        } else if (result.kind === 'failed') {
          failed += 1;
          console.error(`Could not deliver scheduled promotional broadcast ${broadcast.id} to Telegram user ${recipientId}:`, result.error);
        } else {
          skipped += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await adminRepository.completePromotionalBroadcast(broadcast.id);
      try {
        await bot.api.sendMessage(broadcast.adminTelegramId,
          `Запланированная рассылка: доставлено ${sent}, частично ${partial}, не доставлено ${failed}, пропущено ${skipped}.`);
      } catch (error) {
        console.error(`Could not report completion of scheduled promotional broadcast ${broadcast.id}:`, error);
      }
    }
  } finally {
    promotionalBroadcastWorkerRunning = false;
  }
}

try {
  await initializeDatabase(pool);
  await users.syncConfiguredAdmins(config.adminTelegramIds);
  await pool.query('SELECT 1');
  feedbackTimer = setInterval(() => {
    void sendDueFeedback().catch((error) => console.error('Failed to check scheduled feedback:', error));
  }, 60_000);
  paymentReminderTimer = setInterval(() => {
    void sendDuePaymentCheckoutReminders().catch((error) => console.error('Failed to check payment checkout reminders:', error));
  }, 60_000);
  promotionalBroadcastTimer = setInterval(() => {
    void sendDuePromotionalBroadcasts().catch((error) => console.error('Failed to deliver scheduled promotional broadcasts:', error));
  }, 10_000);
  await sendDueFeedback();
  await sendDuePaymentCheckoutReminders();
  await sendDuePromotionalBroadcasts();
  await bot.start({
    onStart: (botInfo) => {
      console.log(`Bot @${botInfo.username} is running.`);
    },
  });
} catch (error) {
  console.error('Failed to start the bot:', error);
  process.exitCode = 1;
} finally {
  if (feedbackTimer) clearInterval(feedbackTimer);
  if (paymentReminderTimer) clearInterval(paymentReminderTimer);
  if (promotionalBroadcastTimer) clearInterval(promotionalBroadcastTimer);
  await pool.end();
}
