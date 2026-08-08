export interface AgentSessionGroup {
  lives: readonly unknown[];
  closed: readonly unknown[];
  history: readonly unknown[];
}

export function agentFamilyMatchesTab(family: string, activeAgentTab: string): boolean {
  return activeAgentTab === 'all' || family === activeAgentTab;
}

export function visibleAgentFamilies(families: Iterable<string>, activeAgentTab: string): string[] {
  return Array.from(families).filter((family) => agentFamilyMatchesTab(family, activeAgentTab));
}

export function projectVisibleForAgent(
  groups: ReadonlyMap<string, AgentSessionGroup>,
  activeAgentTab: string,
): boolean {
  let totalSessions = 0;
  let matchingSessions = 0;

  for (const [family, group] of groups) {
    const count = group.lives.length + group.closed.length + group.history.length;
    totalSessions += count;
    if (agentFamilyMatchesTab(family, activeAgentTab)) matchingSessions += count;
  }

  // Keep newly added, sessionless projects visible so users can start a conversation.
  return totalSessions === 0 || matchingSessions > 0;
}
