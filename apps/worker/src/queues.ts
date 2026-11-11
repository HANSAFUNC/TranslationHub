export const QUEUE_NAMES = {
  QA: 'qa',
  IMPORT_EXPORT: 'import-export',
  NOTIFICATIONS: 'notifications',
  WEBHOOKS: 'webhooks',
  AI: 'ai',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
