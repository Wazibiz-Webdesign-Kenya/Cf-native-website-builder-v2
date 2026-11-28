// Unreadable-text measurement (FDR decision 139). Computed styles cannot say
// what lies behind text that sits on a photograph, a gradient or a hero image
// that fails to cover it, so this measures pixels: one screen at a time,
// record every visible line of text and its colour, screenshot with all text
// made transparent, then compare each colour with the pixels behind its line.
// (A full-page screenshot is not usable: it resizes the viewport, so
// viewport-height sections grow and recorded positions stop matching.)
//
// The bar is deliberately "can this be read at all", far below WCAG AA, so a
// finding is never a matter of taste.

export const UNREADABLE_CONTRAST_RATIO = 2;
/** A line fails when more than this share of its background is unreadable. */
export const UNREADABLE_SHARE = 0.5;
/** Screens overlap by this much so every line is fully visible, clear of a
 *  fixed header, on at least one of them. */
const SCREEN_OVERLAP_PX = 200;
const FIXED_HEADER_ZONE_PX = 100;
const MAX_SCREENS = 24;

export interface TextContrastResult {
  violations: number;
  offenders: string[];
}

export interface ContrastPage {
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { type: "png"; fullPage: boolean }): Promise<Uint8Array | ArrayBuffer>;
}

const HIDE_STYLE_ID = "wz-contrast-hide-text";

// Plain strings, like the rest of the browser adapter: the Worker has no DOM.
const PREPARE_PAGE = `(async () => {
  for (const image of Array.from(document.images)) image.loading = "eager";
  await Promise.race([
    Promise.all(Array.from(document.images).map((image) => image.decode().catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  document.documentElement.style.scrollBehavior = "auto";
  window.scrollTo(0, 0);
  return { pageHeight: document.documentElement.scrollHeight, screenHeight: window.innerHeight };
})()`;

function collectScript(scrollTop: number): string {
  return `(async (scrollTop) => {
  window.scrollTo(0, scrollTop);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const width = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const firstScreen = window.scrollY < 1;
  const lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let index = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    index += 1;
    const label = (node.textContent || "").replace(/\\s+/g, " ").trim();
    const element = node.parentElement;
    if (label.length < 2 || !element || element.closest("script,style,noscript,option,[aria-hidden='true'],[hidden]")) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible") continue;
    let opacity = 1;
    let pinned = false;
    const clips = [];
    for (let current = element; current; current = current.parentElement) {
      const currentStyle = getComputedStyle(current);
      opacity *= Number(currentStyle.opacity);
      if (currentStyle.position === "fixed" || currentStyle.position === "sticky") pinned = true;
      const clipped = currentStyle.overflow !== "visible" || currentStyle.clipPath !== "none" || currentStyle.clip !== "auto";
      if (clipped && current !== document.body && current !== document.documentElement) clips.push(current.getBoundingClientRect());
    }
    // Pinned chrome is judged once, as the page first appears.
    if (opacity < 0.1 || (pinned && !firstScreen)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    Array.from(range.getClientRects()).forEach((rect, part) => {
      if (rect.width < 12 || rect.height < 8) return;
      if (rect.left < -1 || rect.right > width + 1 || rect.top < -1 || rect.bottom > height + 1) return;
      if (!pinned && !firstScreen && rect.top < ${FIXED_HEADER_ZONE_PX}) return;
      const clippedAway = clips.some((clip) => {
        const seenWidth = Math.max(0, Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left));
        const seenHeight = Math.max(0, Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top));
        return seenWidth * seenHeight < rect.width * rect.height * 0.5;
      });
      if (clippedAway) return;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit && hit !== element && !element.contains(hit) && !hit.contains(element)) return;
      lines.push({ key: index + ":" + part, label: label.slice(0, 40), x: rect.left, y: rect.top, w: rect.width, h: rect.height, color: style.color, opacity });
    });
  }
  return { lines, pageWidth: width };
})(${scrollTop})`;
}

// Text shadows stay: they are part of what the glyphs are read against.
const HIDE_TEXT = `(() => {
  const style = document.createElement("style");
  style.id = "${HIDE_STYLE_ID}";
  style.textContent = "*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-decoration-color:transparent!important;caret-color:transparent!important;transition:none!important}";
  document.head.appendChild(style);
  return true;
})()`;

const SHOW_TEXT = `(() => { document.getElementById("${HIDE_STYLE_ID}")?.remove(); return true; })()`;

function analyseScript(dataUrl: string, collected: unknown): string {
  return `(async (dataUrl, collected) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const scale = image.naturalWidth / window.innerWidth;
    const swatch = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (color) => {
      swatch.clearRect(0, 0, 1, 1);
      swatch.fillStyle = color;
      swatch.fillRect(0, 0, 1, 1);
      const data = swatch.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2], data[3] / 255];
    };
    const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const luminance = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const offenders = [];
    for (const line of collected.lines) {
      const x = Math.max(0, Math.floor(line.x * scale));
      const y = Math.max(0, Math.floor(line.y * scale));
      const w = Math.min(canvas.width - x, Math.ceil(line.w * scale));
      const h = Math.min(canvas.height - y, Math.ceil(line.h * scale));
      if (w < 2 || h < 2) continue;
      const pixels = context.getImageData(x, y, w, h).data;
      const [r, g, b, a] = rgba(line.color);
      const alpha = a * line.opacity;
      const ratios = [];
      for (let row = 0; row < 8; row++) {
        for (let column = 0; column < 32; column++) {
          const px = Math.floor(((column + 0.5) / 32) * w);
          const py = Math.floor(((row + 0.5) / 8) * h);
          const offset = (py * w + px) * 4;
          const back = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
          const front = [r, g, b].map((value, index) => value * alpha + back[index] * (1 - alpha));
          const one = luminance(front[0], front[1], front[2]);
          const two = luminance(back[0], back[1], back[2]);
          ratios.push((Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05));
        }
      }
      const unreadable = ratios.filter((ratio) => ratio < ${UNREADABLE_CONTRAST_RATIO}).length / ratios.length;
      if (unreadable > ${UNREADABLE_SHARE}) {
        ratios.sort((left, right) => left - right);
        offenders.push('"' + line.label + '" (contrast ' + ratios[Math.floor(ratios.length / 2)].toFixed(1) + ':1)');
      }
    }
    return offenders;
  })(${JSON.stringify(dataUrl)}, ${JSON.stringify(collected)})`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** Mutates the page only temporarily (scroll position and a style tag it
 *  removes again). */
export async function measureTextContrastOnPage(page: ContrastPage): Promise<TextContrastResult> {
  const { pageHeight, screenHeight } = (await page.evaluate(PREPARE_PAGE)) as { pageHeight: number; screenHeight: number };
  const step = Math.max(200, screenHeight - SCREEN_OVERLAP_PX);
  const measured = new Set<string>();
  const offenders: string[] = [];
  for (let screen = 0; screen < MAX_SCREENS; screen++) {
    const scrollTop = screen * step;
    const collected = (await page.evaluate(collectScript(scrollTop))) as { lines: Array<{ key: string }> };
    const fresh = collected.lines.filter((line) => !measured.has(line.key));
    for (const line of fresh) measured.add(line.key);
    if (fresh.length > 0) {
      await page.evaluate(HIDE_TEXT);
      try {
        const shot = await page.screenshot({ type: "png", fullPage: false });
        const bytes = shot instanceof Uint8Array ? shot : new Uint8Array(shot);
        offenders.push(...((await page.evaluate(analyseScript(`data:image/png;base64,${toBase64(bytes)}`, { lines: fresh }))) as string[]));
      } finally {
        await page.evaluate(SHOW_TEXT);
      }
    }
    if (scrollTop + screenHeight >= pageHeight) break;
  }
  await page.evaluate("window.scrollTo(0, 0)");
  const unique = [...new Set(offenders)];
  return { violations: unique.length, offenders: unique.slice(0, 5) };
}
