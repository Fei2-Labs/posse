export function resolveActiveLiveSessionId(
  activeChatId: string | null,
  activeAcpId: string | null,
  activePtyId: string | null,
): string | null {
  if (activeChatId) return null;
  return activeAcpId || activePtyId;
}
