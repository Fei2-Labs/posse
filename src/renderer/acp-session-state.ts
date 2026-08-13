import type { AvailableCommand, ContentBlock, SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';

export type ContextUsageState =
  | {
    kind: 'active';
    used: number;
    size: number;
    remaining: number;
    percentage: number;
  }
  | {
    kind: 'unknown';
    reason: 'invalid' | 'over-capacity';
  };

export function normalizeContextUsage(used: unknown, size: unknown): ContextUsageState {
  const hasValidNumbers = typeof used === 'number'
    && typeof size === 'number'
    && Number.isSafeInteger(used)
    && Number.isSafeInteger(size)
    && used >= 0
    && size > 0;
  if (!hasValidNumbers) return { kind: 'unknown', reason: 'invalid' };
  if (used > size) return { kind: 'unknown', reason: 'over-capacity' };
  return {
    kind: 'active',
    used,
    size,
    remaining: size - used,
    percentage: (used / size) * 100,
  };
}

export function slashCommandQuery(value: string): string | null {
  const match = value.match(/^\/([^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function availableSlashCommands(
  commands: AvailableCommand[],
  value: string,
): AvailableCommand[] {
  const query = slashCommandQuery(value);
  if (query === null) return [];
  const seen = new Set<string>();
  return commands.filter((command) => {
    const name = command.name.trim();
    if (!name || /\s/.test(name)) return false;
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return !query
      || key.includes(query)
      || command.description.toLowerCase().includes(query);
  });
}

export function slashCommandCompletion(command: AvailableCommand): string {
  return `/${command.name.trim()}${command.input ? ' ' : ''}`;
}

export interface PersistedAcpForeground {
  kind: 'acp';
  presetCommand: string;
  sessionId: string;
  cwd: string;
  displayName: string;
  title: string;
}

export interface PersistedActiveAcpSession extends PersistedAcpForeground {
  createdAt: number;
  updatedAt: number;
}

export class AcpPromptQueue<T> {
  private queued: T[] = [];
  private interruptNext: T | null = null;

  enqueue(item: T): void {
    this.queued.push(item);
  }

  setInterruptNext(item: T): void {
    this.interruptNext = item;
  }

  next(): T | null {
    if (this.interruptNext !== null) {
      const item = this.interruptNext;
      this.interruptNext = null;
      return item;
    }
    return this.queued.shift() || null;
  }

  removeQueued(index: number): void {
    if (index >= 0 && index < this.queued.length) this.queued.splice(index, 1);
  }

  queuedItems(): readonly T[] {
    return this.queued;
  }

  interruptItem(): T | null {
    return this.interruptNext;
  }
}

const STATUS_CONFIG_IDS = ['model', 'model_config', 'context_window', 'context-window', 'context', 'context-window-size', 'context_window_size', 'context_length', 'max_context_tokens', 'reasoning_effort', 'effort', 'fast-mode', 'mode'];

function flattenedConfigValues(option: Extract<SessionConfigOption, { type: 'select' }>): SessionConfigSelectOption[] {
  return option.options.flatMap(item => 'group' in item ? item.options : [item]);
}

function contextSize(value: string): number | null {
  const text = value.replace(/,/g, '').toLowerCase();
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(m|k)\b/g)];
  if (matches.length) return Math.max(...matches.map(match => Number(match[1]) * (match[2] === 'm' ? 1_000_000 : 1_000)));
  const tokenCount = text.match(/(\d{4,})\s*(?:tokens?|token|context|window)/);
  if (tokenCount) return Number(tokenCount[1]);
  return /^\d{4,}$/.test(text) ? Number(text) : null;
}

function isModelConfigOption(option: SessionConfigOption): boolean {
  return option.type === 'select' && (/^(model|model_config)$/.test(option.id) || option.category === 'model');
}

function isContextConfigOption(option: SessionConfigOption): boolean {
  if (option.type !== 'select') return false;
  const metadata = `${option.id} ${option.name} ${option.category || ''} ${option.description || ''}`.toLowerCase();
  if (/context|window|token.?limit|context.?length/.test(metadata)) return true;
  return flattenedConfigValues(option).some(value => contextSize(`${value.value} ${value.name} ${value.description || ''}`) !== null);
}

export function contextWindowConfigOption(configOptions: SessionConfigOption[]): SessionConfigOption | null {
  const model = configOptions.find(isModelConfigOption);
  if (!model || model.type !== 'select') return null;
  const options = flattenedConfigValues(model).filter(option => contextSize(`${option.value} ${option.name} ${option.description || ''}`) !== null);
  if (options.length < 2) return null;
  return {
    id: 'context_window',
    name: 'Context window',
    description: 'Select model variant by context window size',
    type: 'select',
    currentValue: model.currentValue,
    options,
    _meta: { sourceConfigId: model.id },
  } as SessionConfigOption;
}

export function statusConfigOptions(configOptions: SessionConfigOption[]): SessionConfigOption[] {
  const byId = new Map(configOptions.map(option => [option.id, option]));
  const ordered = STATUS_CONFIG_IDS
    .map(id => byId.get(id))
    .filter((option): option is SessionConfigOption => option?.type === 'select');
  for (const option of configOptions) {
    if (option.type === 'select' && isContextConfigOption(option) && !ordered.includes(option)) ordered.splice(1, 0, option);
  }
  if (!ordered.some(option => option.id === 'context_window')) {
    const synthetic = contextWindowConfigOption(configOptions);
    if (synthetic) ordered.splice(1, 0, synthetic);
  }
  return ordered;
}

export function configControlLabel(option: SessionConfigOption): string {
  if (option.id === 'reasoning_effort' || option.id === 'effort') return 'Effort';
  if (option.id === 'fast-mode') return 'Speed';
  if (option.id === 'mode') return 'Access';
  return option.name;
}

export function configValueLabel(option: SessionConfigOption): string {
  if (option.type !== 'select') return String(option.currentValue);
  if (option.id === 'fast-mode') return option.currentValue === 'on' ? 'Fast' : 'Standard';
  if (/context|window|token.?limit|context.?length/i.test(`${option.id} ${option.name}`)) return `Context ${String(option.currentValue)}`;
  const flattened = option.options.flatMap(item => 'group' in item ? item.options : [item]);
  return flattened.find(item => item.value === option.currentValue)?.name || String(option.currentValue);
}

export function imageContentFromDataUrl(dataUrl: string): ContentBlock | null {
  const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return { type: 'image', mimeType: match[1], data: match[2].replace(/\s/g, '') };
}

export function parsePersistedAcpForeground(raw: string | null): PersistedAcpForeground | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<PersistedAcpForeground>;
    if (candidate.kind !== 'acp'
      || typeof candidate.presetCommand !== 'string' || !candidate.presetCommand
      || typeof candidate.sessionId !== 'string' || !candidate.sessionId
      || typeof candidate.cwd !== 'string' || !candidate.cwd
      || typeof candidate.displayName !== 'string'
      || typeof candidate.title !== 'string') return null;
    return candidate as PersistedAcpForeground;
  } catch {
    return null;
  }
}

export function parsePersistedActiveAcpSessions(raw: string | null): PersistedActiveAcpSession[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is PersistedActiveAcpSession => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<PersistedActiveAcpSession>;
      return candidate.kind === 'acp'
        && typeof candidate.presetCommand === 'string' && Boolean(candidate.presetCommand)
        && typeof candidate.sessionId === 'string' && Boolean(candidate.sessionId)
        && typeof candidate.cwd === 'string' && Boolean(candidate.cwd)
        && typeof candidate.displayName === 'string'
        && typeof candidate.title === 'string'
        && typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        && typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt);
    });
  } catch {
    return [];
  }
}
