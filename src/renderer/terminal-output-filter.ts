const COLOR_RESPONSE_TOKEN_LENGTH = 21;
const ESC = '\x1b';
const OSC = '\x9d';
const STRING_TERMINATOR = '\x9c';
const COLOR_RESPONSE_TEMPLATES = [
  '10;rgb:####/####/####',
  '11;rgb:####/####/####',
] as const;

function matchesTokenPrefix(value: string): boolean {
  if (value.length > COLOR_RESPONSE_TOKEN_LENGTH) return false;
  return COLOR_RESPONSE_TEMPLATES.some((template) => {
    for (let index = 0; index < value.length; index += 1) {
      const expected = template[index];
      const actual = value[index];
      if (expected === '#') {
        if (!/[0-9a-f]/i.test(actual)) return false;
      } else if (actual !== expected) {
        return false;
      }
    }
    return true;
  });
}

export class BareOscColorResponseFilter {
  private pending = '';
  private isInsideOsc = false;
  private previousCharacterWasEscape = false;

  private updateControlSequenceState(character: string): void {
    if (this.isInsideOsc) {
      if (character === '\x07' || character === STRING_TERMINATOR
        || (this.previousCharacterWasEscape && character === '\\')) {
        this.isInsideOsc = false;
      }
    } else if (character === OSC
      || (this.previousCharacterWasEscape && character === ']')) {
      this.isInsideOsc = true;
    }
    this.previousCharacterWasEscape = character === ESC;
  }

  write(data: string): string {
    const input = this.pending + data;
    this.pending = '';
    let output = '';
    let index = 0;

    while (index < input.length) {
      if (this.isInsideOsc) {
        const character = input[index];
        output += character;
        this.updateControlSequenceState(character);
        index += 1;
        continue;
      }

      const remaining = input.slice(index);
      const token = remaining.slice(0, COLOR_RESPONSE_TOKEN_LENGTH);
      if (token.length === COLOR_RESPONSE_TOKEN_LENGTH && matchesTokenPrefix(token)) {
        this.previousCharacterWasEscape = false;
        index += COLOR_RESPONSE_TOKEN_LENGTH;
        continue;
      }
      if (remaining.length < COLOR_RESPONSE_TOKEN_LENGTH && matchesTokenPrefix(remaining)) {
        this.pending = remaining;
        this.previousCharacterWasEscape = false;
        break;
      }
      const character = input[index];
      output += character;
      this.updateControlSequenceState(character);
      index += 1;
    }

    return output;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  drain(): string {
    const pending = this.pending;
    this.pending = '';
    return pending;
  }
}
