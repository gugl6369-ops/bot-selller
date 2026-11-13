export type AdvertiserFlowType = 'advertiser_onboarding' | 'question' | 'contact_update';

export interface AdvertiserFlowState {
  flowType: AdvertiserFlowType;
  step: number;
  payload: Record<string, string>;
}

export interface ActiveTariff {
  id: string;
  name: string;
  platforms: string;
  inclusions: string;
  publicationCount: number | null;
  placementDuration: string;
  description: string;
  price: string;
  currency: string;
  discountedPrice: string | null;
}

export interface ReferralStats {
  referralCode: string;
  clicks: number;
  referrals: number;
  applications: number;
  paidReferrals: number;
  earnedBonuses: string;
  usedBonuses: string;
  bonusOffer: string;
}

export interface SavedInquiry {
  id: string;
  source: string;
  orderNumber: string | undefined;
  adminTelegramIds: string[];
}

export interface AdvertiserAnswers {
  businessName: string;
  industry: string;
  region: string;
  websiteUrl: string;
  contactValue: string;
  requestedPlacement: string;
}

export type AdvertiserAnswerResult =
  | { kind: 'prompt'; text: string }
  | { kind: 'onboarding_complete'; alreadySaved: boolean; pendingTariffId?: string }
  | { kind: 'question_submitted'; inquiry: SavedInquiry; topic: string }
  | { kind: 'contact_updated'; saved: boolean }
  | { kind: 'cancelled' }
  | { kind: 'empty' };
