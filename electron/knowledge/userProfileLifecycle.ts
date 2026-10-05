import type { UserProfileCategory, UserProfileItem, UserProfileReviewItem } from './userProfileTypes';

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

/** Review windows are limited to the non-sensitive categories approved by the v5 design. */
const reviewDaysByCategory: Partial<Record<UserProfileCategory, number>> = {
  professional: 180,
  goals: 120,
  interests: 180,
};

export function getNextUserProfileReviewAt(category: UserProfileCategory, from = new Date()): string | undefined {
  const days = reviewDaysByCategory[category];
  if (!days) return undefined;
  return new Date(from.getTime() + days * millisecondsPerDay).toISOString();
}

export function collectUserProfileReviewDueItems(
  items: readonly UserProfileItem[],
  now = new Date(),
): UserProfileReviewItem[] {
  const nowMs = now.getTime();
  return items.flatMap((item) => {
    if (item.status !== 'active' || !item.expiresAt) return [];
    const dueMs = new Date(item.expiresAt).getTime();
    if (!Number.isFinite(dueMs) || dueMs > nowMs) return [];
    return [{
      item,
      dueAt: item.expiresAt,
      daysOverdue: Math.max(0, Math.floor((nowMs - dueMs) / millisecondsPerDay)),
    }];
  }).sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.item.itemId.localeCompare(right.item.itemId));
}
