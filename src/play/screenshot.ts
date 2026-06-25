// Page-screenshot helper for the bug-report flow. Wraps html2canvas in a
// lazy-import so the ~250KB rasterizer isn't bundled into the main chunk —
// only fetched when the player clicks "Report a problem".
//
// We capture the document body BEFORE the report modal mounts so the
// screenshot shows what the player was looking at, not the modal itself.
// Returns base64 PNG without the data-URL prefix.
/** Whether it's safe to auto-capture a page screenshot for the bug report.
 *  html2canvas does heavy SYNCHRONOUS main-thread work (it clones the DOM and
 *  rasterizes every image on the board). On phones/tablets that routinely
 *  freezes the page for many seconds or OOM-crashes the tab — a player on
 *  mobile Chrome reported the whole site locking up the moment they pressed
 *  "Report a problem". The screenshot is only a nice-to-have (the report's text
 *  + game-state snapshot are what matter), so we skip it on touch / small-
 *  viewport devices and keep it on desktop, where it's reliable. */
export function screenshotAutoCaptureSafe(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const narrow = (window.innerWidth || 0) < 820;
    return !coarse && !narrow;
  } catch {
    return false;
  }
}

export async function capturePageScreenshot(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas');
    const canvas = await html2canvas(document.body, {
      width: window.innerWidth,
      height: window.innerHeight,
      x: window.scrollX,
      y: window.scrollY,
      // Cap output resolution to avoid huge files on hi-DPR displays.
      scale: Math.min(window.devicePixelRatio || 1, 1.5),
      useCORS: true,
      logging: false,
      backgroundColor: '#15171c',
    });
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : null;
  } catch (err) {
    console.warn('[screenshot] capture failed:', err);
    return null;
  }
}
