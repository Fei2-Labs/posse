# xterm OSC color flow

- Posse uses `@xterm/xterm@5.5.0`.
- xterm maintains parser state across `Terminal.write` calls; a split valid OSC
  10/11 set sequence is consumed and does not render.
- OSC 10/11 queries (`ESC]10;?BEL`, `ESC]11;?BEL`) cause xterm to emit RGB
  responses through `onData`.
- Posse forwards `onData` to the PTY unchanged.
- A hidden Electron harness reproduced the exact response bytes.
- A read-only daemon raw-buffer inspection showed affected sessions output the
  response payload as plain text before Posse receives it. The escape wrappers
  are already absent, ruling out renderer sanitization and transport framing.

Implementation implication: use a narrow renderer output compatibility filter
for exact bare response tokens, scoped to Devin-family sessions.
