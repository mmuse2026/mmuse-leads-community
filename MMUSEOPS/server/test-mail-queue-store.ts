import { DEFAULT_TEST_MAIL_CONFIG, type TestMailQueueStore } from '../src/services/testMailQueue'

export function readTestMailQueue(): TestMailQueueStore {
  return {version: 1, updatedAt: new Date(0).toISOString(), paused: true, config: {...DEFAULT_TEST_MAIL_CONFIG}, records: []}
}
