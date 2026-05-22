// Page-screenshot helper for the bug-report flow. Wraps html2canvas in a
// lazy-import so the ~250KB rasterizer isn't bundled into the main chunk —
// only fetched when the player clicks "Report a problem".
//
// We capture the document body BEFORE the report modal mounts so the
// screenshot shows what the player was looking at, not the modal itself.
// Returns base64 PNG without the data-URL prefix.
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
