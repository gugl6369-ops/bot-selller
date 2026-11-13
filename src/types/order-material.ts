export interface OrderMaterialMedia {
  kind: 'photo' | 'video';
  fileId: string;
  caption: string;
}

export interface OrderMaterialState {
  orderId: string;
  orderNumber: string;
  telegramId: string;
  status: 'collecting' | 'submitted' | 'approved' | 'rejected';
  step: number;
  revisionMode: boolean;
  reviewMode: boolean;
  adText: string | null;
  media: OrderMaterialMedia[];
  destination: string | null;
  requestedDates: string[];
  wishes: string | null;
  adminComment: string | null;
  adminTelegramIds: string[];
}

export interface ReusableOrderMaterials {
  sourceOrderId: string;
  sourceOrderNumber: string;
  sourceBusinessName: string;
  adText: string;
  media: OrderMaterialMedia[];
  destination: string | null;
  wishes: string | null;
}

export type MaterialAnswerResult =
  | { kind: 'updated'; state: OrderMaterialState }
  | { kind: 'submitted'; state: OrderMaterialState }
  | { kind: 'invalid'; message: string }
  | { kind: 'media_step' }
  | { kind: 'no_active_flow' };

export interface MaterialDeliveryReport {
  deliveredAdmins: number;
  failedAdmins: number;
}
