import { UserRepository } from '../db/repositories/user-repository.ts';
import type { AdvertiserRepository } from '../db/repositories/advertiser-repository.ts';
import type { StartResult, TelegramProfile, UserPreferenceKey, UserPreferences } from '../types/user.ts';
import type { OrderRepository } from '../db/repositories/order-repository.ts';

export class StartService {
  private readonly users: UserRepository;
  private readonly advertisers: AdvertiserRepository;
  private readonly orders: OrderRepository;

  constructor(users: UserRepository, advertisers: AdvertiserRepository, orders: OrderRepository) {
    this.users = users;
    this.advertisers = advertisers;
    this.orders = orders;
  }

  async prepare(profile: TelegramProfile): Promise<StartResult> {
    const user = await this.users.getOrCreate(profile);
    const isAdmin = await this.users.isActiveAdmin(profile.telegramId);
    const hasBusiness = await this.advertisers.hasBusiness(profile.telegramId);

    return { user, isAdmin, hasBusiness };
  }

  isAdmin(telegramId: string): Promise<boolean> {
    return this.users.isActiveAdmin(telegramId);
  }

  hasBusiness(telegramId: string): Promise<boolean> {
    return this.advertisers.hasBusiness(telegramId);
  }

  hasSubmittedOrder(telegramId: string): Promise<boolean> {
    return this.orders.hasSubmittedOrder(telegramId);
  }

  getPreferences(telegramId: string): Promise<UserPreferences> {
    return this.users.getPreferences(telegramId);
  }

  togglePreference(telegramId: string, preference: UserPreferenceKey): Promise<UserPreferences> {
    return this.users.togglePreference(telegramId, preference);
  }

  disableAdvertisingMessages(telegramId: string): Promise<UserPreferences> {
    return this.users.disableAdvertisingMessages(telegramId);
  }

  canSendPromotionalMessage(telegramId: string, preference: UserPreferenceKey): Promise<boolean> {
    return this.users.canSendPromotionalMessage(telegramId, preference);
  }

  setMarketingConsent(telegramId: string, enabled: boolean): Promise<UserPreferences> {
    return this.users.setMarketingConsent(telegramId, enabled);
  }

  setFeedbackConsent(telegramId: string, enabled: boolean): Promise<UserPreferences> {
    return this.users.setFeedbackConsent(telegramId, enabled);
  }

  hasNotificationSettingsAccess(telegramId: string): Promise<boolean> {
    return this.users.hasNotificationSettingsAccess(telegramId);
  }

  setPendingConsentOrder(telegramId: string, orderId: string): Promise<void> {
    return this.users.setPendingConsentOrder(telegramId, orderId);
  }

  markPendingConsentAnswered(telegramId: string, category: 'marketing' | 'feedback') {
    return this.users.markPendingConsentAnswered(telegramId, category);
  }

  getPendingConsentOrder(telegramId: string): Promise<string | undefined> {
    return this.users.getPendingConsentOrder(telegramId);
  }

  clearPendingConsentOrder(telegramId: string): Promise<void> {
    return this.users.clearPendingConsentOrder(telegramId);
  }
}
