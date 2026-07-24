# Terminal Output Compatibility

## Scenario: Bare OSC color responses from agent CLIs

### 1. Scope / Trigger

- Trigger: an agent CLI emits the parameter body of an OSC 10/11 color response
  as plain PTY text after the escape wrapper has already been lost.
- Apply compatibility filtering only at the final renderer-to-xterm boundary
  and only for the affected agent family.

### 2. Signatures

```typescript
class BareOscColorResponseFilter {
  write(data: string): string;
  hasPending(): boolean;
  drain(): string;
}
```

### 3. Contracts

- Remove only complete bare tokens matching
  `10;rgb:hhhh/hhhh/hhhh` or `11;rgb:hhhh/hhhh/hhhh`.
- Preserve valid wrapped OSC sequences byte-for-byte so xterm remains the
  control-sequence parser.
- Preserve all malformed lookalikes and surrounding output.
- Carry a possible token suffix across chunks and drain it after a short
  bounded delay.
- Use the same writer for live PTY data and retained raw-buffer replay.
- Clear filter and timer state when the PTY session is cleared.

### 4. Validation & Error Matrix

| Input | Required behavior |
| --- | --- |
| Complete bare OSC 10/11 RGB token | Remove |
| Token split across adjacent chunks | Reassemble, then remove |
| Wrapped OSC using BEL, ST, or C1 controls | Preserve |
| Malformed or incomplete lookalike | Preserve; bounded drain if pending |
| Output from an unaffected agent | Bypass unchanged |

### 5. Good/Base/Bad Cases

- Good: `before10;rgb:d8d8/dede/e9e9after` becomes `beforeafter`.
- Base: normal terminal output is unchanged.
- Bad: stripping `ESC]10;rgb:...BEL` would prevent xterm from parsing a valid
  control sequence.

### 6. Tests Required

- Assert complete foreground/background tokens are removed.
- Assert every split point and one-character chunking produce no leak.
- Assert malformed and incomplete candidates are preserved.
- Assert BEL-, ST-, and C1-wrapped OSC sequences are preserved at every split.
- Assert both live and replay write sites use the compatibility writer.

### 7. Wrong vs Correct

#### Wrong

```typescript
termManager.write(id, data.replace(/(?:10|11);rgb:[0-9a-f/]+/gi, ''));
```

This strips imprecisely, cannot handle chunks, and can damage valid wrapped
OSC sequences.

#### Correct

```typescript
const output = filter.write(data);
if (output) termManager.write(id, output);
```

Use a stateful exact-grammar filter, preserve xterm-owned control sequences,
and bound any pending suffix with a timer.
