export interface ConversationPreferences {
  expandThoughtsByDefault: boolean;
  expandToolsByDefault: boolean;
}

export const CONVERSATION_PREFERENCES_STORAGE_KEY = 'posse_conversation_preferences_v1';

export const DEFAULT_CONVERSATION_PREFERENCES: ConversationPreferences = {
  expandThoughtsByDefault: false,
  expandToolsByDefault: false,
};

export function parseConversationPreferences(raw: string | null): ConversationPreferences {
  if (!raw) return { ...DEFAULT_CONVERSATION_PREFERENCES };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { ...DEFAULT_CONVERSATION_PREFERENCES };
    const candidate = value as Partial<ConversationPreferences>;
    return {
      expandThoughtsByDefault: candidate.expandThoughtsByDefault === true,
      expandToolsByDefault: candidate.expandToolsByDefault === true,
    };
  } catch {
    return { ...DEFAULT_CONVERSATION_PREFERENCES };
  }
}

export function loadConversationPreferences(storage: Pick<Storage, 'getItem'> = localStorage): ConversationPreferences {
  try {
    return parseConversationPreferences(storage.getItem(CONVERSATION_PREFERENCES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_CONVERSATION_PREFERENCES };
  }
}

export function saveConversationPreferences(
  preferences: ConversationPreferences,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(CONVERSATION_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // A display preference must never block the conversation UI.
  }
}
