export interface OrderDraftSummary {
  tariffId: string;
  name: string;
  description: string;
  originalPrice: string;
  discountAmount: string;
  finalPrice: string;
  currency: string;
  preferredDate: string | null;
  publicationCount: number;
  publicationDates: string[];
  status: 'awaiting_date' | 'ready';
}

export interface CreatedOrder {
  id: string;
  orderNumber: string;
  price: string;
  discountAmount: string;
  currency: string;
  adminTelegramIds: string[];
}

export interface PaymentProofRequest {
  orderId: string;
  orderNumber: string;
  paymentMethod: string;
}

export type PaymentProofStart =
  | { kind: 'started'; orderNumber: string }
  | { kind: 'already_reported'; orderNumber: string }
  | { kind: 'not_confirmed' };

export type OrderHistoryStatus = 'pending_confirmation' | 'confirmed' | 'rejected' | 'cancelled' | 'completed';
export type PaymentHistoryStatus = 'pending_approval' | 'approved' | 'rejected';

export interface UserOrderHistoryItem {
  id: string;
  tariffId: string;
  orderNumber: string;
  tariffName: string;
  tariffDescription: string;
  status: OrderHistoryStatus;
  price: string;
  currency: string;
  requestedPublicationDates: string[];
  publicationStatuses: string[];
  publicationLinks: (string | null)[];
  publicationAt: string | null;
  createdAt: string;
  paymentStatus: PaymentHistoryStatus | null;
  materialsStatus: 'collecting' | 'submitted' | null;
  feedbackResponse: 'good' | 'discuss' | 'repeat' | null;
  feedbackReview: string | null;
}

export type PaymentReport =
  | { kind: 'created'; orderNumber: string; amount: string; currency: string; paymentMethod: string; adminTelegramIds: string[] }
  | { kind: 'already_reported'; orderNumber: string }
  | { kind: 'not_confirmed' };
