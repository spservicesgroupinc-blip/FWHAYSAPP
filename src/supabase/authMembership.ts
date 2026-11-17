/**
 * Identifies the inputs that can change a staff membership decision.
 * Auth token refreshes keep the same user id and must not restart the check.
 */
export function membershipCheckKey(
  userId: string | null,
  passwordSetup: boolean,
  retryVersion: number,
): string | null {
  if (!userId || passwordSetup) return null;
  return `${userId}:${retryVersion}`;
}
