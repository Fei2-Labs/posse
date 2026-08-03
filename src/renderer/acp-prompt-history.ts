const DEFAULT_HISTORY_LIMIT = 100;

export type PromptHistoryDirection = 'older' | 'newer';

export class AcpPromptHistory {
  private entries: string[];
  private index: number;
  private draft = '';

  constructor(entries: string[] = [], private readonly limit = DEFAULT_HISTORY_LIMIT) {
    this.entries = entries.filter(Boolean).slice(-limit);
    this.index = this.entries.length;
  }

  static load(key: string, storage: Pick<Storage, 'getItem'> = localStorage): AcpPromptHistory {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(key) || '[]');
      return new AcpPromptHistory(Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : []);
    } catch {
      return new AcpPromptHistory();
    }
  }

  add(prompt: string): void {
    const value = prompt.trim();
    if (!value) return;
    if (this.entries[this.entries.length - 1] !== value) this.entries.push(value);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.reset();
  }

  navigate(direction: PromptHistoryDirection, currentValue: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.index === this.entries.length) this.draft = currentValue;

    if (direction === 'older') {
      if (this.index === 0) return this.entries[0] ?? null;
      this.index -= 1;
      return this.entries[this.index] ?? null;
    }

    if (this.index >= this.entries.length) return null;
    this.index += 1;
    return this.index === this.entries.length ? this.draft : this.entries[this.index] ?? null;
  }

  reset(): void {
    this.index = this.entries.length;
    this.draft = '';
  }

  save(key: string, storage: Pick<Storage, 'setItem'> = localStorage): void {
    try { storage.setItem(key, JSON.stringify(this.entries)); } catch { /* ignore storage failures */ }
  }

  values(): string[] {
    return this.entries.slice();
  }
}

export function canNavigatePromptHistory(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: PromptHistoryDirection,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  if (direction === 'older') return !value.slice(0, selectionStart).includes('\n');
  return !value.slice(selectionEnd).includes('\n');
}
