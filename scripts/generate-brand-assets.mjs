#!/usr/bin/env node
/**
 * Regenerates every SultiAI brand raster from the master artwork.
 *
 *   npm run assets:brand
 *
 * The master is `assets/Icon & Logo/Glossy Blue Voice Chat Icon.png`: a 1254x1254
 * rendering of a glossy blue squircle carrying two white overlapping speech
 * bubbles, with transparent corners around the squircle.
 *
 * Run this whenever the master changes, then rebuild (`npx expo prebuild
 * --platform android` for the launcher icons, `npm run deploy:web` for the
 * site). The generated files are committed, so an ordinary checkout builds the
 * right icons without ever running this script.
 *
 * The master cannot be shipped as-is, so it gets taken apart once:
 *
 * - The **background** is the squircle's own gradient, bled outward to fill the
 *   whole square. The corner gap cannot be filled with a flat colour because the
 *   edge is a gradient: cyan rgb(4,225,232) along the top but blue
 *   rgb(0,93,244) down the sides, so any single fill shows a seam. Bleeding
 *   continues the gradient instead, and it is what both platforms expect -
 *   iOS rejects an alpha channel and masks the corners itself, so an icon has
 *   to bleed edge to edge.
 * - The **foreground** is just the white bubbles, lifted out on transparency.
 *   They read cleanly at launcher size and they double as the Android 13
 *   themed icon, which tints by alpha alone, since the mark is already white.
 *
 * Where a flat colour is still unavoidable it is deep blue rgb(3,68,172) from
 * the middle of the body, spelled `#0344AC` in app.json for the splash field
 * and the adaptive-icon fallback that launchers use when they cannot load a
 * background image.
 *
 * Bubble extraction keys on `min(r,g,b)`. The body is saturated blue or cyan
 * and so has a red channel of 2-5, while the bubbles are white with all three
 * channels high; the glossy sheen only reaches min 181, so a ramp of
 * BUBBLE_LO..BUBBLE_HI separates them with the sheen left as a soft halo.
 *
 * Glyph sizes are quoted against Android's adaptive-icon geometry: the canvas
 * is 108dp, the mask reveals 72dp, and the guaranteed-safe circle is 66dp
 * across, i.e. 61.1% of the canvas width. At 600px of 1024 (58.6%) the bubbles
 * clear even a circular mask on the smallest supported launcher.
 */
/* global Buffer -- Node script, but the repo config is the Expo/React Native one */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const ROOT = process.cwd();
const MASTER = path.join(ROOT, 'assets', 'Icon & Logo', 'Glossy Blue Voice Chat Icon.png');

/** `min(r,g,b)` ramp that separates the white bubbles from the glossy body. */
const BUBBLE_LO = 150;
const BUBBLE_HI = 215;

/**
 * `min(r,g,b)` above which a pixel counts as bubble rather than body when
 * solving the bleed, so the field comes out without a mark in it. Set above
 * the glossy sheen, which only reaches 181, so the sheen still seeds the field.
 */
const BUBBLE_INPAINT = 190;

/** Longest side of the bubble glyph, in px, per output. See file header. */
const GLYPH = {
  /** Android adaptive foreground, 1024x1024: 600/1024 = 58.6%, inside the 61.1% safe circle. */
  adaptive: 600,
  /** Android 13 monochrome layer, 432x432: same proportion as the foreground. */
  monochrome: 253,
  /** Splash mark, 1024x1024. */
  splash: 640,
  /**
   * PWA maskable tile, 1024x1024: the bubbles' diagonal is capped at 80% of the
   * canvas, which is the guaranteed-safe circle a launcher may crop to. The
   * mark is 777x763 in the master, so 584 keeps sqrt(584^2 + 573^2) at 819 px,
   * exactly 80% of 1024.
   */
  maskable: 584,
};

/**
 * Encoder settings for the assets the website actually downloads.
 *
 * The master is a heavily dithered render, so an honest PNG of the logo costs
 * ~350 KB at 512px even though it is displayed at 36px. An indexed PNG lands
 * at ~72 KB for a mean error of about 1/255, which is below what dithered
 * gradients hide anyway. Native assets skip this: they are never web-served and
 * are the pixels a store reviewer looks at.
 */
const WEB_PNG = { palette: true, dither: 1, effort: 10, compressionLevel: 9 };

/** Picks the encoder for an asset the site serves versus one baked into an APK. */
const pngFor = (web) => (web ? WEB_PNG : { compressionLevel: 9 });

/**
 * Resolution divisor for the bleed. See `loadBledBackground` for why the
 * extension is solved small and scaled back up.
 */
const BLEED_DIVISOR = 8;

/** Jacobi passes used to relax the extension toward a smooth field. */
const BLEED_PASSES = 2000;

/**
 * The master's gradient, extended outward so it covers the full square.
 *
 * Solved at 1/BLEED_DIVISOR scale and then scaled back up. The extension is
 * ~290 px deep at full size, and diffusion evens out a discontinuity over a
 * radius that only grows as the square root of the pass count, so evening out
 * the whole corner at full size would need on the order of depth-squared passes
 * and minutes of CPU. An eighth of that in each direction cuts the work by ~64x,
 * and enlarging afterwards hides the coarseness, because this region is nothing
 * but a smooth gradient - there is no detail in it to lose.
 *
 * Two stages:
 *
 * 1. Grow the solid artwork outward one pixel at a time, each new pixel taking
 *    the mean of the neighbours already filled. Working in distance order from
 *    the artwork means every pixel is touched about twice, so the fill costs a
 *    few million operations rather than one pass per pixel of depth.
 * 2. Relax the result. Step 1 alone leaves a visible step where a column fed by
 *    the artwork's top edge meets one fed from its side, because those two
 *    neighbourhoods barely overlap. Averaging against all four neighbours for
 *    BLEED_PASSES passes washes that out and converges on the harmonic
 *    extension, which is the smoothest field that still agrees with the
 *    artwork along its boundary.
 *
 * The squircle's soft outer glow is kept, and composited with the master's own
 * alpha rather than being flattened away. That matters: the glow only reaches
 * alpha 88 before the squircle body jumps to 250, so treating the glow's colour
 * as opaque turns it into a pale ring around the icon. Compositing it as the
 * translucent veil it is lets it lighten the field gently and leaves the one
 * crisp boundary the artwork actually contains - the edge of the squircle.
 */
async function loadBledBackground() {
  const master = await sharp(MASTER).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = master.info;

  const w = Math.round(width / BLEED_DIVISOR);
  const h = Math.round(height / BLEED_DIVISOR);
  const low = await sharp(master.data, { raw: { width, height, channels } })
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const lowChannels = low.info.channels;

  const count = w * h;
  const val = new Float32Array(count * 3);
  const art = new Uint8Array(count);
  const filled = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * lowChannels;
    // Only solid artwork seeds the field. The squircle's own anti-aliased rim
    // is skipped, because averaging in near-transparent pixels would drag the
    // extension toward black.
    //
    // The bubbles are excluded too, so the solved field is a clean gradient
    // with no mark in it. The main icon covers that region with the artwork
    // anyway, and the maskable tile needs the bare gradient to draw its own
    // inset copy of the bubbles on top of.
    const isBubble = Math.min(low.data[o], low.data[o + 1], low.data[o + 2]) > BUBBLE_INPAINT;
    if (low.data[o + 3] > 128 && !isBubble) {
      val[i * 3] = low.data[o];
      val[i * 3 + 1] = low.data[o + 1];
      val[i * 3 + 2] = low.data[o + 2];
      art[i] = 1;
      filled[i] = 1;
    }
  }

  // Stage 1: grow outward from the artwork, in distance order.
  let frontier = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (filled[i]) continue;
      if (
        (x > 0 && filled[i - 1]) ||
        (x < w - 1 && filled[i + 1]) ||
        (y > 0 && filled[i - w]) ||
        (y < h - 1 && filled[i + w])
      ) {
        frontier.push(i);
      }
    }
  }
  while (frontier.length > 0) {
    const next = [];
    for (const i of frontier) {
      if (filled[i]) continue; // a neighbour may have claimed it already
      const x = i % w;
      const y = (i / w) | 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (const j of [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y < h - 1 ? i + w : -1,
      ]) {
        if (j < 0 || !filled[j]) continue;
        r += val[j * 3];
        g += val[j * 3 + 1];
        b += val[j * 3 + 2];
        n++;
      }
      if (n === 0) continue;
      val[i * 3] = r / n;
      val[i * 3 + 1] = g / n;
      val[i * 3 + 2] = b / n;
      filled[i] = 1;
      if (x > 0 && !filled[i - 1]) next.push(i - 1);
      if (x < w - 1 && !filled[i + 1]) next.push(i + 1);
      if (y > 0 && !filled[i - w]) next.push(i - w);
      if (y < h - 1 && !filled[i + w]) next.push(i + w);
    }
    frontier = next;
  }
  if (filled.reduce((sum, v) => sum + v, 0) < count) {
    throw new Error('gradient bleed left gaps; the master may contain empty regions');
  }

  // Stage 2: relax the extension toward the harmonic solution.
  const next = new Float32Array(count * 3);
  for (let pass = 0; pass < BLEED_PASSES; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const s = i * 3;
        if (art[i]) {
          next[s] = val[s];
          next[s + 1] = val[s + 1];
          next[s + 2] = val[s + 2];
          continue;
        }
        // The canvas border reflects, so the gradient does not darken against it.
        const n = (x > 0 ? 1 : 0) + (x < w - 1 ? 1 : 0) + (y > 0 ? 1 : 0) + (y < h - 1 ? 1 : 0);
        let r = 0;
        let g = 0;
        let b = 0;
        if (x > 0) {
          r += val[s - 3];
          g += val[s - 2];
          b += val[s - 1];
        }
        if (x < w - 1) {
          r += val[s + 3];
          g += val[s + 4];
          b += val[s + 5];
        }
        if (y > 0) {
          r += val[s - w * 3];
          g += val[s - w * 3 + 1];
          b += val[s - w * 3 + 2];
        }
        if (y < h - 1) {
          r += val[s + w * 3];
          g += val[s + w * 3 + 1];
          b += val[s + w * 3 + 2];
        }
        next[s] = r / n;
        next[s + 1] = g / n;
        next[s + 2] = b / n;
      }
    }
    val.set(next);
  }

  const field = Buffer.alloc(count * 3);
  for (let i = 0; i < count * 3; i++) {
    field[i] = Math.max(0, Math.min(255, Math.round(val[i])));
  }
  const scaled = await sharp(field, { raw: { width: w, height: h, channels: 3 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  if (scaled.length !== width * height * 3) {
    throw new Error(
      `bleed field came back as ${scaled.length} bytes, expected ${width * height * 3}`
    );
  }

  // Lay the artwork over the extension using the master's own alpha, and only
  // outside the artwork does the solved field show through. The artwork keeps
  // full resolution so the bubbles stay crisp instead of inheriting the blur.
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const s = i * 3;
    const veil = master.data[o + 3] / 255;
    out[s] = scaled[s] + (master.data[o] - scaled[s]) * veil;
    out[s + 1] = scaled[s + 1] + (master.data[o + 1] - scaled[s + 1]) * veil;
    out[s + 2] = scaled[s + 2] + (master.data[o + 2] - scaled[s + 2]) * veil;
  }

  return { raw: out, field: Buffer.from(scaled), width, height };
}

/** Lifts the white speech bubbles off transparency as their own layer. */
async function extractGlyph() {
  const { data, info } = await sharp(MASTER)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const rgba = Buffer.alloc(width * height * 4);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * channels;
      const q = i * 4;
      rgba[q] = 255;
      rgba[q + 1] = 255;
      rgba[q + 2] = 255;
      if (data[o + 3] <= 200) {
        rgba[q + 3] = 0;
        continue;
      }
      const weakest = Math.min(data[o], data[o + 1], data[o + 2]);
      const mix = Math.min(1, Math.max(0, (weakest - BUBBLE_LO) / (BUBBLE_HI - BUBBLE_LO)));
      const alpha = Math.round(mix * 255);
      rgba[q + 3] = alpha;
      if (alpha > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) throw new Error('no speech bubbles found: nothing in the master reads as white');

  return {
    rgba,
    width,
    height,
    box: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

/** Scales the glyph so its longest side is `targetMax` px, tightly cropped. */
async function glyphLayer(glyph, targetMax) {
  const scale = targetMax / Math.max(glyph.box.width, glyph.box.height);
  return sharp(glyph.rgba, { raw: { width: glyph.width, height: glyph.height, channels: 4 } })
    .extract(glyph.box)
    .resize(
      Math.max(1, Math.round(glyph.box.width * scale)),
      Math.max(1, Math.round(glyph.box.height * scale))
    )
    .png()
    .toBuffer();
}

/** Centres a layer on a transparent square of `size` px. */
async function centreOnCanvas(size, layer) {
  const { width, height } = await sharp(layer).metadata();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite([
    {
      input: layer,
      left: Math.round((size - width) / 2),
      top: Math.round((size - height) / 2),
    },
  ]);
}

/** Centres the glyph on a transparent square of `size` px, longest side `targetMax`. */
async function renderGlyph(glyph, size, targetMax, { web = false } = {}) {
  return (await centreOnCanvas(size, await glyphLayer(glyph, targetMax)))
    .png(pngFor(web))
    .toBuffer();
}

/**
 * The bare bleed field carrying an inset copy of the bubbles, for a PWA icon
 * declared `purpose: maskable`.
 *
 * A maskable icon is cropped to whatever shape the launcher uses, which may be
 * a circle as tight as 66% of the width, so the bubbles have to sit inside the
 * 80% guaranteed-safe circle rather than fill the canvas as they do elsewhere.
 * The field is used rather than the finished icon, which still has the full-size
 * bubbles in it.
 */
async function maskableTile(background, glyph, size, targetMax, { web = false } = {}) {
  const field = await fullBleed({ ...background, raw: background.field }, size, { web });
  const mark = await (
    await centreOnCanvas(size, await glyphLayer(glyph, targetMax))
  )
    .png()
    .toBuffer();
  return sharp(field)
    .composite([{ input: mark }])
    .png(pngFor(web))
    .toBuffer();
}

/**
 * The bled gradient as an opaque square, which is both the app icon and the
 * adaptive icon's background layer, so the two can never disagree.
 */
function fullBleed(background, size, { web = false, alpha = false } = {}) {
  let pipeline = sharp(background.raw, {
    raw: { width: background.width, height: background.height, channels: 3 },
  }).resize(size, size, { fit: 'fill' });
  // ICO entries must stay RGBA: the decoder Next.js uses to read favicon.ico
  // rejects indexed PNGs ("The PNG is not in RGBA format!"), and palette mode
  // silently collapses to 3 channels.
  if (alpha) pipeline = pipeline.ensureAlpha();
  return pipeline.png(alpha ? { compressionLevel: 9 } : pngFor(web)).toBuffer();
}

/**
 * Packs PNG-compressed entries into a multi-size .ico.
 *
 * `web/src/app/favicon.ico` has to stay a real .ico because that filename is
 * how Next.js emits the `/favicon.ico` route, and browsers ask for several
 * sizes from it. PNG-in-ICO has been readable everywhere since Windows Vista.
 */
async function buildIco(background, sizes) {
  const pngs = await Promise.all(sizes.map((size) => fullBleed(background, size, { alpha: true })));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  const directory = Buffer.alloc(16 * sizes.length);
  let offset = header.length + directory.length;
  sizes.forEach((size, i) => {
    const entry = i * 16;
    // 0 means 256 in the single-byte width/height fields.
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(pngs[i].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += pngs[i].length;
  });

  return Buffer.concat([header, directory, ...pngs]);
}

/** Writes `buffer` to `relativePath` and reports the result. */
async function emit(relativePath, buffer) {
  await writeFile(path.join(ROOT, relativePath), buffer);
  // .ico is a container, so sharp may not report a single size for it.
  const meta = await sharp(buffer)
    .metadata()
    .catch(() => ({}));
  const label = meta.width ? `${meta.width}x${meta.height}` : '(multi-size)';
  console.log(
    `  ${relativePath.padEnd(42)} ${label.padEnd(14)} ${(buffer.length / 1024).toFixed(1)} KB`
  );
}

async function main() {
  const background = await loadBledBackground();
  const glyph = await extractGlyph();
  console.log(
    `master ${background.width}x${background.height}, ` +
      `bubbles ${glyph.box.width}x${glyph.box.height} at (${glyph.box.left},${glyph.box.top})`
  );
  console.log('writing:');

  // Expo app (consumed by app.json; EAS and prebuild derive every native size).
  const icon = await fullBleed(background, 1024);
  await emit('assets/icon.png', icon);
  await emit('assets/android-icon-background.png', await fullBleed(background, 1024));
  await emit('assets/android-icon-foreground.png', await renderGlyph(glyph, 1024, GLYPH.adaptive));
  await emit('assets/android-icon-monochrome.png', await renderGlyph(glyph, 432, GLYPH.monochrome));
  await emit('assets/splash-icon.png', await renderGlyph(glyph, 1024, GLYPH.splash));
  await emit('assets/favicon.png', await fullBleed(background, 48, { web: true }));

  // Marketing site. public/ feeds the Logo lockup, the PWA manifest and the
  // OpenGraph image; src/app/ files are the Next.js metadata conventions.
  await emit('web/public/app-icon.png', await fullBleed(background, 512, { web: true }));
  await emit('web/public/icon-192.png', await fullBleed(background, 192, { web: true }));
  await emit('web/public/icon-512.png', await fullBleed(background, 512, { web: true }));
  await emit(
    'web/public/icon-maskable-512.png',
    await maskableTile(background, glyph, 512, Math.round((512 * GLYPH.maskable) / 1024), {
      web: true,
    })
  );
  await emit('web/public/splash-icon.png', await renderGlyph(glyph, 512, 320, { web: true }));
  await emit('web/src/app/icon.png', await fullBleed(background, 512, { web: true }));
  await emit('web/src/app/apple-icon.png', await fullBleed(background, 180, { web: true }));
  await emit('web/src/app/favicon.ico', await buildIco(background, [16, 32, 48]));

  // Fail loudly rather than shipping an icon the stores will reject.
  if ((await sharp(icon).metadata()).hasAlpha) {
    throw new Error('assets/icon.png must not carry an alpha channel');
  }
}

main().catch((error) => {
  console.error(`\n  error: ${error.message}\n`);
  process.exit(1);
});
