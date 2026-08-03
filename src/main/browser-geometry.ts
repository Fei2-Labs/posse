import type { Rectangle } from 'electron';

export type BrowserRawBounds = Rectangle & { visible: boolean };

/** Convert renderer CSS-pixel edges into owner WebContentsView DIP bounds. */
export function scaleAndClampBrowserBounds(
  raw: BrowserRawBounds,
  zoomFactor: number,
  contentBounds: Pick<Rectangle, 'width' | 'height'>,
): Rectangle | null {
  if (!raw.visible || raw.width <= 0 || raw.height <= 0) return null;
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const width = Math.max(0, Math.round(contentBounds.width));
  const height = Math.max(0, Math.round(contentBounds.height));
  const left = Math.round(raw.x * zoom);
  const top = Math.round(raw.y * zoom);
  const right = Math.round((raw.x + raw.width) * zoom);
  const bottom = Math.round((raw.y + raw.height) * zoom);
  const clampedLeft = Math.max(0, Math.min(left, width));
  const clampedTop = Math.max(0, Math.min(top, height));
  const clampedRight = Math.max(clampedLeft, Math.min(right, width));
  const clampedBottom = Math.max(clampedTop, Math.min(bottom, height));
  if (clampedRight <= clampedLeft || clampedBottom <= clampedTop) return null;
  return {
    x: clampedLeft,
    y: clampedTop,
    width: clampedRight - clampedLeft,
    height: clampedBottom - clampedTop,
  };
}
