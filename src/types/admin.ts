import type { OrderMaterialMedia } from './order-material.ts';

export type AdminFlowType =
  | 'tariff_create'
  | 'tariff_edit'
  | 'publish_order'
  | 'referral_bonus_settings'
  | 'message_user'
  | 'filter_business'
  | 'schedule_order'
  | 'edit_publication_date'
  | 'promotional_broadcast';

export interface AdminFlow {
  flowType: AdminFlowType;
  step: number;
  payload: Record<string, string>;
}

export interface AdminTariff {
  id: string;
  name: string;
  platforms: string;
  inclusions: string;
  publicationCount: number | null;
  placementDuration: string;
  feedbackDelayDays: number;
  description: string;
  price: string;
  currency: string;
  discountValidUntil: string | null;
  isActive: boolean;
}

export interface ReferralBonusSettings {
  amount: string;
  currency: string;
  validityDays: number | null;
  combineWithFirstDiscount: boolean;
  eligibleTariffIds: string[] | null;
  isActive: boolean;
}

export interface AdminBusinessLead {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string;
  businessName: string;
  industry: string | null;
  region: string | null;
  websiteUrl: string | null;
  contactValue: string | null;
  requestedPlacement: string | null;
  createdAt: string;
}

export interface AdminInquiry {
  id: string;
  telegramId: string;
  firstName: string;
  username: string | null;
  businessName: string | null;
  topic: string;
  message: string;
  source: string;
  createdAt: string;
}

export interface AdminOrder {
  id: string;
  orderNumber: string;
  telegramId: string;
  firstName: string;
  username: string | null;
  businessName: string;
  tariffName: string;
  status: string;
  price: string;
  currency: string;
  publicationAt: string | null;
  publicationDates: string[];
  publicationStatuses: string[];
  reusedMaterialsFromOrderNumber: string | null;
}

export interface AdminMaterialSubmission {
  orderId: string;
  orderNumber: string;
  status: 'submitted' | 'approved';
  telegramId: string;
  firstName: string;
  username: string | null;
  businessName: string;
  tariffName: string;
  adText: string;
  media: OrderMaterialMedia[];
  destination: string;
  publicationDates: string[];
  publicationStatuses: string[];
  wishes: string;
  submittedAt: string;
  reusedFromOrderNumber?: string | null;
}

export interface AdminInboxCounts {
  unansweredQuestions: number;
  dataDeletionRequests: number;
  pendingOrders: number;
  pendingPayments: number;
  pendingMaterials: number;
  feedbacks: number;
}

export interface AdminFeedback {
  orderId: string;
  orderNumber: string;
  telegramId: string;
  firstName: string;
  username: string | null;
  businessName: string;
  tariffName: string;
  response: 'good' | 'discuss' | 'repeat';
  reviewText: string | null;
  status: 'open' | 'closed';
  createdAt: string;
}

export interface AdminFeedbackMessage {
  senderType: 'user' | 'admin';
  message: string;
  createdAt: string;
}

export interface AdminPayment {
  id: string;
  orderNumber: string;
  telegramId: string;
  firstName: string;
  username: string | null;
  businessName: string | null;
  amount: string;
  currency: string;
  paymentMethod: string;
  publicationDates: string[];
  proofFileId: string | null;
  reportedAt: string;
}

export interface ReviewedPayment {
  orderId: string;
  telegramId: string;
  orderNumber: string;
  firstName: string;
  username: string | null;
  businessName: string | null;
  referralBonus?: {
    referrerTelegramId: string;
    amount: string;
    currency: string;
    expiresAt: string | null;
  };
}

export interface AdminStatistics {
  users: string;
  businesses: string;
  inquiries: string;
  referral_clicks: string;
  active_tariffs: string;
  confirmed_payments: string;
  rejected_payments: string;
  cancelled_orders: string;
  scheduled_publications: string;
  discounted_orders: string;
  published_orders: string;
  repeat_customers: string;
  positive_feedback: string;
  discussion_feedback: string;
}

export interface PopularTariff {
  name: string;
  orders: string;
}

export interface ReferralRow {
  firstName: string;
  telegramId: string;
  username: string | null;
  businessName: string | null;
  clicks: string;
  invited: string;
  applications: string;
  paid: string;
}

export type AdminAnswerResult =
  | { kind: 'prompt'; text: string }
  | {
      kind: 'done';
      text: string;
      customerNotification?: { telegramId: string; orderNumber: string; publicationAt: string };
      publicationNotification?: {
        telegramId: string;
        orderNumber: string;
        businessName: string;
        publicationLink: string | null;
        publicationDate: string;
        publicationNumber: number;
        publicationCount: number;
        remainingPublications: number;
        allPublished: boolean;
        feedbackDueAt: string | null;
        feedbackDelayDays: number;
      };
    }
  | { kind: 'send_message'; telegramId: string; message: string; customerContext: string; inquiryId?: string; materialOrderId?: string; paymentRequestId?: string; paymentOrderId?: string; paymentMode?: 'instructions' }
  | { kind: 'businesses'; rows: AdminBusinessLead[] }
  | { kind: 'invalid'; text: string };
