// chatgpt-selectors.ts
//
// Selector registry for the ChatGPT bridge service (#121). ChatGPT's DOM is not stable
// across releases; a small JSON registry maps logical names to CSS/role selectors keyed
// by URL path. On each ask/doctor, the service checks each selector still matches; if not,
// it walks a documented fallback chain (css -> role+name -> text -> xpath). On total
// failure the bridge reports `selectors_stale` and points the user to the override file.
//
// The bundled registry is best-effort (built from first principles, not derived from
// Cavendish or any third-party source). A user-editable override file at
// <userData>/chatgpt-selectors.json takes precedence over the bundled values, so a user
// can fix drift locally without waiting for a Posse release.
//
// SECURITY: this module stores only selector strings — never secrets, cookies, or auth
// state. The override file is loaded with 0600 owner-only perms (written by the service
// when the user saves edits; read defensively).

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SelectorValue = string;
export type SelectorEntry = {
  /** Primary CSS selector. */
  css: SelectorValue;
  /** Fallback: role + optional name (aria-label substring). */
  role?: SelectorValue;
  role_name?: SelectorValue;
  /** Fallback: visible text substring. */
  text?: SelectorValue;
  /** Fallback: XPath expression. */
  xpath?: SelectorValue;
};
export type SelectorRegistry = Record<string, SelectorEntry>;

// Logical names used across the bridge. Keep this list narrow on purpose — only what the
// ask/wait/reply/doctor flow needs. Adding a name here is a contract with the runtime
// probe script (chatgpt-bridge-service.ts builds a JS probe that reads these keys).
export const SELECTOR_NAMES = [
  'composer',
  'send_button',
  'stop_button',
  'assistant_message_last',
  'assistant_message_all',
  'login_indicator',
] as const;
export type SelectorName = (typeof SELECTOR_NAMES)[number];

// Bundled registry. Keyed by URL host-path prefix so the same names can resolve
// differently on chatgpt.com vs chatgpt.com/c/<id>. The 'default' key applies when no
// path-specific entry matches. Values are best-effort starting points — the override
// file + fallback chain exist precisely because these drift.
const BUNDLED_REGISTRY: Record<string, SelectorRegistry> = {
  default: {
    composer: {
      // The rich-text ProseMirror composer ChatGPT uses.
      css: 'div[contenteditable="true"]#prompt-textarea, textarea#prompt-textarea, div[contenteditable="true"]',
      role: 'textbox',
      text: 'Message ChatGPT',
    },
    send_button: {
      // Send button: data-testid first (most stable), then aria-label, then role.
      css: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
      role: 'button',
      role_name: 'Send',
      text: 'Send',
    },
    stop_button: {
      // Visible only while generating. Disappearance is completion signal #1.
      css: 'button[data-testid="stop-button"], button[aria-label="Stop generating"]',
      role: 'button',
      role_name: 'Stop',
      text: 'Stop',
    },
    assistant_message_last: {
      // Resolve all assistant turns, then the fixed browser-world probe selects the last
      // visible match. CSS :last-of-type is wrong here because turns are not one sibling type.
      css: '[data-message-author-role="assistant"]',
      role: 'article',
    },
    assistant_message_all: {
      css: '[data-message-author-role="assistant"]',
      role: 'article',
    },
    login_indicator: {
      // Positive logged-in indicators only. Never use "Log in" as a text fallback: its
      // presence means the opposite and would authorize prompt submission on the login wall.
      css: 'button[aria-label="New chat"], [data-testid="profile-button"]',
      role: 'button',
      role_name: 'New chat',
    },
  },
};

function overrideFilePath(): string {
  return path.join(app.getPath('userData'), 'chatgpt-selectors.json');
}

// Load the user override file (0600). Returns an empty record on missing/corrupt rather
// than throwing — drift recovery must never crash the bridge. Only well-formed
// { [path]: { [name]: SelectorEntry } } objects are merged.
export function loadSelectorOverrides(): Record<string, SelectorRegistry> {
  const file = overrideFilePath();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, SelectorRegistry> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const registry: SelectorRegistry = {};
      for (const [name, sel] of Object.entries(entry as Record<string, unknown>)) {
        if (!sel || typeof sel !== 'object') continue;
        const s = sel as Record<string, unknown>;
        if (typeof s.css !== 'string') continue;
        const clean: SelectorEntry = { css: s.css };
        if (typeof s.role === 'string') clean.role = s.role;
        if (typeof s.role_name === 'string') clean.role_name = s.role_name;
        if (typeof s.text === 'string') clean.text = s.text;
        if (typeof s.xpath === 'string') clean.xpath = s.xpath;
        registry[name] = clean;
      }
      out[key] = registry;
    }
    return out;
  } catch {
    return {};
  }
}

// Save user overrides with 0600 perms. Best-effort; never throws into the UI path.
export function saveSelectorOverrides(overrides: Record<string, SelectorRegistry>): void {
  const file = overrideFilePath();
  try {
    fs.writeFileSync(file, JSON.stringify(overrides, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

// Resolve the merged registry for a URL: bundled default <- bundled path-specific <-
// override default <- override path-specific. Later writes win, so a user override for a
// specific path beats the bundled default.
export function resolveRegistry(url: string): SelectorRegistry {
  const hostPath = urlPathKey(url);
  const overrides = loadSelectorOverrides();
  const merged: SelectorRegistry = {
    ...BUNDLED_REGISTRY.default,
    ...(BUNDLED_REGISTRY[hostPath] || {}),
    ...(overrides.default || {}),
    ...(overrides[hostPath] || {}),
  };
  return merged;
}

// Reduce a URL to a host+path-prefix key. Only the leading path segment matters for
// ChatGPT (chatgpt.com vs chatgpt.com/c/<id> vs chatgpt.com/g/<id>). Invalid URLs AND
// URLs with no hostname (about:blank, data:, file:) collapse to 'default' so a blank page
// still resolves the default selectors.
export function urlPathKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (!host) return 'default'; // about:blank, data:, etc. have no hostname
    const seg = parsed.pathname.split('/').filter(Boolean).slice(0, 1).join('/');
    return seg ? `${host}/${seg}` : host;
  } catch {
    return 'default';
  }
}

export function bundledRegistryForTesting(): Record<string, SelectorRegistry> {
  return JSON.parse(JSON.stringify(BUNDLED_REGISTRY));
}

export { overrideFilePath, BUNDLED_REGISTRY };
