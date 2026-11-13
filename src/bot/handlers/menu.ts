import { Bot } from 'grammy';
import type { AdvertiserRepository } from '../../db/repositories/advertiser-repository.ts';
import { AdvertiserService } from '../../services/advertiser-service.ts';
import { OrderService } from '../../services/order-service.ts';
import type { StartService } from '../../services/start-service.ts';
import type { OrderMaterialService } from '../../services/order-material-service.ts';
import type { AdminRepository } from '../../db/repositories/admin-repository.ts';
import { isAdvertiser, beginOnboarding, showTariffs } from './menu/presentation.ts';
import { registerOrderHandlers } from './menu/orders.ts';
import { registerMaterialHandlers } from './menu/materials.ts';
import { registerConversationHandlers } from './menu/conversations.ts';
import { registerProfileHandlers } from './menu/profile.ts';
export function registerMenuHandlers(
  bot: Bot,
  advertisers: AdvertiserRepository,
  service: AdvertiserService,
  startService: StartService,
  orderService: OrderService,
  materialService: OrderMaterialService,
  adminRepository: AdminRepository,
): void {
  registerOrderHandlers(bot, advertisers, service, startService, orderService, adminRepository);
  registerMaterialHandlers(bot, startService, orderService, materialService, adminRepository);
  registerConversationHandlers(bot, advertisers, service, startService, orderService, materialService, adminRepository);
  registerProfileHandlers(bot, advertisers, service, startService, orderService, adminRepository, materialService);

  bot.hears('Посмотреть тарифы', async (ctx) => {
    if (!(await isAdvertiser(ctx, startService))) return;
    const sender = ctx.from;
    if (!sender) return;

    await service.cancel(String(sender.id));
    await orderService.cancel(String(sender.id));
    await showTariffs(ctx, advertisers, startService);
  });

  bot.hears('Оформить рекламу', (ctx) => beginOnboarding(ctx, service, startService, advertisers, orderService));


}
