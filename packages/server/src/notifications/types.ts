import type {
  MultiremiInboxItem,
  MultiremiNotificationChannel,
  MultiremiNotificationDelivery,
} from "@multiremi/contracts/types.js";

export interface OutboundNotification {
  chatId: string;
  card: Record<string, unknown>;
  channel: MultiremiNotificationChannel;
  delivery: MultiremiNotificationDelivery;
  item: MultiremiInboxItem;
}

export interface OutboundNotificationSender {
  send(notification: OutboundNotification): Promise<void>;
}

export class PermanentNotificationDeliveryError extends Error {}
