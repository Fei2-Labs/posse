export type BrowserUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const LOCAL_HOST_PATTERN = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|10(?:\.\d{1,3}){3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?(?:[/?#]|$)/i;
const LOCAL_HOSTNAME_PATTERN = /^(localhost|127(?:\.\d{1,3}){3}|::1|10(?:\.\d{1,3}){3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/i;

export function normalizeBrowserUrl(input: string): BrowserUrlResult {
  const value = input.trim();
  if (!value) return { ok: false, error: 'Enter a URL to open.' };

  // A colon followed by digits is a host port (localhost:3000), not a URI scheme.
  const candidate = /^[a-z][a-z\d+.-]*:(?!\d)/i.test(value)
    ? value
    : `${LOCAL_HOST_PATTERN.test(value) ? 'http' : 'https'}://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'Enter a valid HTTP or HTTPS URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTP and HTTPS URLs can open in the browser.' };
  }
  if (!parsed.hostname) return { ok: false, error: 'The URL must include a host.' };
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URLs containing embedded credentials are not supported.' };
  }

  return { ok: true, url: parsed.toString() };
}

export function browserSecurityState(url: string): 'secure' | 'local' | 'insecure' | 'neutral' {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return 'secure';
    if (parsed.protocol !== 'http:') return 'neutral';
    const hostname = parsed.hostname.toLowerCase();
    if (LOCAL_HOSTNAME_PATTERN.test(hostname)) return 'local';
    return 'insecure';
  } catch {
    return 'neutral';
  }
}
