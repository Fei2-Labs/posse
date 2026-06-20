import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Storage for the user's Claude subscription OAuth token (from `claude setup-token`).
 *
 * This token is a 1-year, inference-only long-lived OAuth token minted from the user's
 * Claude Pro/Max subscription. Setting `CLAUDE_CODE_OAUTH_TOKEN=<token>` in a remote
 * claude agent's environment makes that agent use the user's subscription — independent
 * of the Mac being online (truly 24/7). This is the supported Claude Code auth primitive
 * (auth precedence includes `CLAUDE_CODE_OAUTH_TOKEN`).
 *
 * SECURITY:
 *  - It is a CREDENTIAL. Stored in a dedicated file under userData with mode 0600.
 *  - Never logged. Never returned to the renderer in full — `status()` returns only a
 *    boolean + a short masked suffix.
 *  - It IS injected into the remote session env (that's the point); it travels over the
 *    token-auth'd remote-server to the user's own remote host. The user opts in per session.
 */

function tokenFilePath(): string {
  return path.join(app.getPath('userData'), 'claude-subscription-token.json');
}

/** Read the stored token, or null if not set / unreadable. Never logs the token. */
export function loadSubscriptionToken(): string | null {
  try {
    const raw = fs.readFileSync(tokenFilePath(), 'utf-8');
    const data = JSON.parse(raw) as { token?: unknown };
    if (typeof data.token === 'string' && data.token.length > 0) return data.token;
    return null;
  } catch {
    return null;
  }
}

/** Persist the token with restrictive (0600) permissions. Trims whitespace. */
export function saveSubscriptionToken(token: string): void {
  const trimmed = token.trim();
  const file = tokenFilePath();
  // Write with mode 0600 from the start so the secret is never briefly world-readable.
  fs.writeFileSync(file, JSON.stringify({ token: trimmed }), { mode: 0o600 });
  // Defensively re-assert perms in case the file pre-existed with looser perms.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

/** Remove the stored token. */
export function clearSubscriptionToken(): void {
  try {
    fs.unlinkSync(tokenFilePath());
  } catch {
    // already absent — fine
  }
}

export interface SubscriptionTokenStatus {
  set: boolean;
  /** Last few characters of the token, for at-a-glance "is this the right one" UX. Never the full token. */
  maskedSuffix?: string;
}

/** Renderer-safe status: whether a token is set + a short masked suffix. Never the full token. */
export function subscriptionTokenStatus(): SubscriptionTokenStatus {
  const token = loadSubscriptionToken();
  if (!token) return { set: false };
  const suffix = token.length > 4 ? token.slice(-4) : token;
  return { set: true, maskedSuffix: suffix };
}
