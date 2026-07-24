export type PersistedProject = {
  path: string;
  pinned: boolean;
  addedAt: number;
  name?: string;
};

export type ProjectPersistenceState<T extends PersistedProject> = {
  projects: T[];
  stalePaths: string[];
  expandedProjects: Set<string>;
  searchCollapsedProjects: Set<string>;
  showArchivedProjects: Set<string>;
  expandedAgentGroups: Set<string>;
  normalizePath: (value: string) => string;
};

export type ProjectsListPayload<T> = {
  projects: T[];
  staleProjectPaths: string[];
};

/** Accept pre-migration array responses while preferring the explicit response contract. */
export function normalizeProjectsListPayload<T>(
  payload: T[] | ProjectsListPayload<T>,
): ProjectsListPayload<T> {
  if (Array.isArray(payload)) return { projects: payload, staleProjectPaths: [] };
  return {
    projects: Array.isArray(payload?.projects) ? payload.projects : [],
    staleProjectPaths: Array.isArray(payload?.staleProjectPaths) ? payload.staleProjectPaths : [],
  };
}

/**
 * Remove backend-confirmed stale paths from every persisted sidebar state
 * collection. The caller remains responsible for writing the resulting sets.
 */
export function cleanupStaleProjectPersistence<T extends PersistedProject>(
  state: ProjectPersistenceState<T>,
): Omit<ProjectPersistenceState<T>, 'stalePaths' | 'normalizePath'> {
  const staleKeys = new Set(state.stalePaths.map(state.normalizePath));
  const removeKeys = (values: Set<string>): Set<string> =>
    new Set(Array.from(values).filter((value) => !staleKeys.has(state.normalizePath(value))));
  const expandedAgentGroups = new Set(Array.from(state.expandedAgentGroups).filter((groupKey) => {
    const separator = groupKey.lastIndexOf('::');
    if (separator < 0) return true;
    return !staleKeys.has(state.normalizePath(groupKey.slice(0, separator)));
  }));

  return {
    projects: state.projects.filter((project) => !staleKeys.has(state.normalizePath(project.path))),
    expandedProjects: removeKeys(state.expandedProjects),
    searchCollapsedProjects: removeKeys(state.searchCollapsedProjects),
    showArchivedProjects: removeKeys(state.showArchivedProjects),
    expandedAgentGroups,
  };
}
