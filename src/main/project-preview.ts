import { protocol } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_PREVIEW_SCHEME = 'posse-project';

type RegisteredProject = {
  ownerWebContentsId: number;
  rootPath: string;
};

type ProjectPreviewResult =
  | { ok: true; token: string; rootName: string }
  | { ok: false; error: string };

type ProjectPreviewUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const projectsByToken = new Map<string, RegisteredProject>();

const mimeByExtension: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeRelativePath(rawPath: string): string | null {
  try {
    const decoded = decodeURIComponent(rawPath);
    if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return null;
    const segments = decoded.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '.' || segment === '..')) return null;
    return segments.join(path.sep);
  } catch {
    return null;
  }
}

function mimeForPath(filePath: string): string {
  return mimeByExtension[path.extname(filePath).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export function registerProjectPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROJECT_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function installProjectPreviewProtocol(): void {
  protocol.registerBufferProtocol(PROJECT_PREVIEW_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const project = projectsByToken.get(url.hostname);
      const relativePath = normalizeRelativePath(url.pathname);
      if (!project || !relativePath) {
        callback({ error: -6 });
        return;
      }

      const requestedPath = path.resolve(project.rootPath, relativePath);
      if (!isWithinRoot(project.rootPath, requestedPath)) {
        callback({ error: -6 });
        return;
      }

      const canonicalPath = fs.realpathSync(requestedPath);
      if (!isWithinRoot(project.rootPath, canonicalPath) || !fs.statSync(canonicalPath).isFile()) {
        callback({ error: -6 });
        return;
      }

      callback({ data: fs.readFileSync(canonicalPath), mimeType: mimeForPath(canonicalPath) });
    } catch {
      callback({ error: -6 });
    }
  });
}

export function registerProjectPreviewRoot(ownerWebContentsId: number, rootPath: string): ProjectPreviewResult {
  if (!Number.isInteger(ownerWebContentsId) || typeof rootPath !== 'string' || !rootPath.trim()) {
    return { ok: false, error: 'invalid-project-root' };
  }

  try {
    const canonicalRoot = fs.realpathSync(rootPath);
    if (!fs.statSync(canonicalRoot).isDirectory()) return { ok: false, error: 'not-a-directory' };
    const token = crypto.randomBytes(32).toString('hex');
    projectsByToken.set(token, { ownerWebContentsId, rootPath: canonicalRoot });
    return { ok: true, token, rootName: path.basename(canonicalRoot) || canonicalRoot };
  } catch {
    return { ok: false, error: 'project-root-unavailable' };
  }
}

export function createProjectPreviewUrl(
  ownerWebContentsId: number,
  token: string,
  relativePath: string,
): ProjectPreviewUrlResult {
  const project = projectsByToken.get(token);
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!project || project.ownerWebContentsId !== ownerWebContentsId || !normalizedPath) {
    return { ok: false, error: 'invalid-project-preview-request' };
  }
  return { ok: true, url: `${PROJECT_PREVIEW_SCHEME}://${token}/${normalizedPath.split(path.sep).map(encodeURIComponent).join('/')}` };
}

export function revokeProjectPreviewRoots(ownerWebContentsId: number): void {
  for (const [token, project] of projectsByToken) {
    if (project.ownerWebContentsId === ownerWebContentsId) projectsByToken.delete(token);
  }
}
