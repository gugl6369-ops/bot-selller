export interface TelegramProfile {
  telegramId: string;
  username: string | undefined;
  firstName: string;
  lastName: string | undefined;
  referralCode: string | undefined;
  startParameter: string | undefined;
}

export interface UserRecord {
  id: string;
  telegramId: string;
  isFirstVisit: boolean;
}

export type UserPreferenceKey = 'monthlyPromotions' | 'applicationReminders' | 'repeatPlacementMessages' | 'feedbackRequests';

export interface UserPreferences {
  monthlyPromotions: boolean;
  applicationReminders: boolean;
  repeatPlacementMessages: boolean;
  feedbackRequests: boolean;
}

export interface StartResult {
  user: UserRecord;
  isAdmin: boolean;
  hasBusiness: boolean;
}
