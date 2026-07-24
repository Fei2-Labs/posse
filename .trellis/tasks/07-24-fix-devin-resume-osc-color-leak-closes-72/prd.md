# Fix Devin resume OSC color leak (closes #72)

## Goal

Prevent bare OSC 10/11 color-response payloads from appearing as visible text
when a Devin session starts or resumes, without changing ordinary terminal
output or xterm's handling of valid escape sequences.

## Requirements

- Filter only complete bare color-response tokens with the exact shape
  `10;rgb:hhhh/hhhh/hhhh` or `11;rgb:hhhh/hhhh/hhhh`.
- Apply the filter to Devin-family terminal output before it is written to
  xterm, for both retained raw-buffer replay and live PTY chunks.
- Reassemble tokens split across adjacent PTY chunks.
- Flush an incomplete candidate after a short bounded delay so legitimate
  output is not retained indefinitely.
- Preserve all surrounding text, control sequences, whitespace, and output
  from non-Devin agents.
- Remove per-session filter state when the PTY exits.

## Acceptance Criteria

- [ ] A complete foreground/background response pair is not rendered.
- [ ] Every split point inside either token is handled without leaking text.
- [ ] Normal text containing `rgb`, numbers, or malformed lookalikes is
      preserved byte-for-byte.
- [ ] Non-Devin sessions receive their original data unchanged.
- [ ] Existing terminal behavior and TypeScript builds remain green.

## Definition of Done

- Regression tests exercise complete, concatenated, split, and malformed
  inputs.
- TypeScript build and targeted tests pass.
- The implementation is committed, pushed, rebuilt, and installed.
- Issue #72 is closed by the commit.

## Technical Approach

Add a small pure streaming filter under `src/renderer/` and route both terminal
write sites in `app.ts` through one Devin-aware writer. The filter recognizes a
fixed 21-character token grammar, keeps only a possible token suffix between
chunks, and exposes a drain operation for bounded fallback flushing.

## Decision (ADR-lite)

**Context**: xterm correctly parses split OSC sequences. Live daemon
`rawBuffer` inspection showed that affected Devin sessions already emit the
payload as ordinary text with no ESC/BEL/ST wrapper, so transport and renderer
status sanitization cannot recover the original control sequence.

**Decision**: Remove only exact bare OSC 10/11 RGB response tokens at the final
renderer output boundary and scope the behavior to Devin-family sessions.

**Consequences**: The workaround is narrow and does not change daemon protocol
or other agents. If Devin later emits a different color format, its grammar
must be added deliberately with tests.

## Out of Scope

- Changing xterm.js or suppressing valid OSC color queries/responses.
- Rewriting daemon raw buffers or PTY protocol framing.
- Filtering arbitrary ANSI-looking text from other agents.
- Fixing issue #71 in the same change.

## Technical Notes

- Issue: https://github.com/Fei2-Labs/posse/issues/72
- `termManager.write(id, data)` runs before the status-only sanitizer in
  `src/renderer/app.ts`; that sanitizer cannot cause visible terminal output.
- Electron reproduction confirmed xterm 5.5 emits:
  `ESC]10;rgb:d8d8/dede/e9e9ESC\` and
  `ESC]11;rgb:2e2e/3434/4040ESC\` for OSC 10/11 queries.
- Daemon raw buffers for affected live sessions contain plain concatenated
  payloads such as
  `10;rgb:d8d8/dede/e9e911;rgb:2e2e/3434/4040`.
