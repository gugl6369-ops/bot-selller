import { Keyboard, type Context } from 'grammy';
import type { AdminRepository } from '../../db/repositories/admin-repository.ts';
import type { StartService } from '../../services/start-service.ts';
import { adminMenuKeyboard, showAdminMenu } from './admin/views.ts';

const welcomeMessage = 'Здравствуйте! Здесь можно посмотреть форматы рекламы и выбрать подходящий тариф.';
export const DATA_DELETION_RESTART_PARAMETER = 'restart_after_data_deletion';

export function createMainMenu(isAdmin: boolean, hasSubmittedOrder = false, hasSettingsAccess = false): Keyboard {
  if (isAdmin) {
    return adminMenuKeyboard();
  }

  const keyboard = new Keyboard().text('Посмотреть тарифы');
  if (hasSubmittedOrder || hasSettingsAccess) keyboard.row();
  if (hasSubmittedOrder) keyboard.text('Мои заказы');
  if (hasSettingsAccess) keyboard.text('Настройки');

  return keyboard.resized().persistent();
}

export function createStartHandler(startService: StartService, adminRepository: AdminRepository) {
  return async function handleStart(ctx: Context): Promise<void> {
    const sender = ctx.from;
    if (!sender) {
      return;
    }

    const startParameter = typeof ctx.match === 'string' ? ctx.match.trim() : undefined;
    const isDataDeletionRestart = startParameter === DATA_DELETION_RESTART_PARAMETER;
    const { user, isAdmin, hasBusiness } = await startService.prepare({
      telegramId: String(sender.id),
      username: sender.username,
      firstName: sender.first_name,
      lastName: sender.last_name,
      referralCode: isDataDeletionRestart ? undefined : startParameter,
      startParameter: isDataDeletionRestart ? undefined : startParameter,
    });

    if (isAdmin) {
      await showAdminMenu(ctx, adminRepository);
      return;
    }

    const greeting = isDataDeletionRestart && user.isFirstVisit
        ? 'Профиль создан заново. Выберите «Посмотреть тарифы», чтобы начать оформление.'
      : hasBusiness
        ? 'С возвращением! Рады видеть вас снова. Данные о вашем бизнесе уже сохранены — можете продолжить оформление.'
        : user.isFirstVisit
          ? welcomeMessage
          : 'С возвращением! Выберите нужный раздел в меню.';

    const hasSubmittedOrder = await startService.hasSubmittedOrder(String(sender.id));
    const hasSettingsAccess = await startService.hasNotificationSettingsAccess(String(sender.id));
    await ctx.reply(greeting, { reply_markup: createMainMenu(false, hasSubmittedOrder, hasSettingsAccess) });
  };
}
