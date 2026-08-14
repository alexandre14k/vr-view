let padCanvas = null, padCtx = null;
let outCanvas = null, outCtx = null;
let outImageData = null;

const MIN_FACTOR = 1e-3;
const LENS_RSQ_EDGE = 0.64;
const MAX_PAD = 2.5;
let warpMapCache = null;

function sizedCanvas(kind, w, h) {
  if (kind === 'pad') {
    if (!padCanvas || padCanvas.width !== w || padCanvas.height !== h) {
      padCanvas = new OffscreenCanvas(w, h);
      padCtx = padCanvas.getContext('2d', { willReadFrequently: true });
    }
    return padCtx;
  }
  if (!outCanvas || outCanvas.width !== w || outCanvas.height !== h) {
    outCanvas = new OffscreenCanvas(w, h);
    outCtx = outCanvas.getContext('2d');
    outImageData = null;
  }
  return outCtx;
}

function bilinearSample(pixels, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const cx0 = Math.min(Math.max(x0, 0), w - 1);
  const cx1 = Math.min(Math.max(x0 + 1, 0), w - 1);
  const cy0 = Math.min(Math.max(y0, 0), h - 1);
  const cy1 = Math.min(Math.max(y0 + 1, 0), h - 1);

  const i00 = (cy0 * w + cx0) * 4;
  const i10 = (cy0 * w + cx1) * 4;
  const i01 = (cy1 * w + cx0) * 4;
  const i11 = (cy1 * w + cx1) * 4;

  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = pixels[i00 + c] * (1 - fx) + pixels[i10 + c] * fx;
    const bot = pixels[i01 + c] * (1 - fx) + pixels[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

function computePadding(cw, ch, k) {
  const worstFactor = 1 + Math.min(0, k) * LENS_RSQ_EDGE;
  const padFactor = k < 0
    ? Math.min(MAX_PAD, 1 / Math.max(0.15, worstFactor))
    : 1;
  return {
    bw: Math.max(1, Math.ceil(cw * padFactor)),
    bh: Math.max(1, Math.ceil(ch * padFactor)),
    padFactor,
  };
}

function drawPadded(bitmap, cw, ch, bw, bh, padFactor) {
  const sw = bitmap.width;
  const sh = bitmap.height;
  const pCtx = sizedCanvas('pad', bw, bh);
  pCtx.clearRect(0, 0, bw, bh);
  const scale = Math.max(cw / sw, ch / sh) * padFactor;
  const dw = sw * scale, dh = sh * scale;
  const dx = (bw - dw) / 2, dy = (bh - dh) / 2;
  pCtx.drawImage(bitmap, dx, dy, dw, dh);
  bitmap.close();
  return pCtx.getImageData(0, 0, bw, bh).data;
}

function prepareOutput(cw, ch) {
  const oCtx = sizedCanvas('out', cw, ch);
  if (!outImageData || outImageData.width !== cw ||
      outImageData.height !== ch) {
    outImageData = oCtx.createImageData(cw, ch);
  }
  return { oCtx, output: outImageData };
}

function warpPixels(srcPixels, bw, bh, padX, padY, cw, ch, k, dstPixels) {
  const halfW = cw / 2, halfH = ch / 2;
  for (let y = 0; y < ch; y++) {
    const ny = (y - halfH) / halfH;
    const rowOff = y * cw;
    for (let x = 0; x < cw; x++) {
      const nx = (x - halfW) / halfW;
      const rSq = nx * nx + ny * ny;
      const factor = Math.max(MIN_FACTOR, 1 + k * rSq);

      const sxp = (nx / factor) * halfW + halfW + padX;
      const syp = (ny / factor) * halfH + halfH + padY;

      const di = (rowOff + x) * 4;
      if (sxp >= 0 && sxp < bw && syp >= 0 && syp < bh) {
        const [r, g, b, a] = bilinearSample(srcPixels, bw, bh, sxp, syp);
        dstPixels[di] = r; dstPixels[di + 1] = g;
        dstPixels[di + 2] = b; dstPixels[di + 3] = a;
      } else {
        dstPixels[di] = 0; dstPixels[di + 1] = 0;
        dstPixels[di + 2] = 0; dstPixels[di + 3] = 255;
      }
    }
  }
}

function buildWarpMap(cw, ch, bw, bh, padX, padY, k) {
  const halfW = cw / 2, halfH = ch / 2;
  const count = cw * ch;
  const ix00 = new Int32Array(count);
  const ix10 = new Int32Array(count);
  const ix01 = new Int32Array(count);
  const ix11 = new Int32Array(count);
  const wfx = new Float32Array(count);
  const wfy = new Float32Array(count);
  const inBounds = new Uint8Array(count);

  for (let y = 0; y < ch; y++) {
    const ny = (y - halfH) / halfH;
    const rowOff = y * cw;
    for (let x = 0; x < cw; x++) {
      const nx = (x - halfW) / halfW;
      const rSq = nx * nx + ny * ny;
      const factor = Math.max(MIN_FACTOR, 1 + k * rSq);
      const sxp = (nx / factor) * halfW + halfW + padX;
      const syp = (ny / factor) * halfH + halfH + padY;
      const p = rowOff + x;

      if (sxp >= 0 && sxp < bw && syp >= 0 && syp < bh) {
        const x0 = Math.floor(sxp), y0 = Math.floor(syp);
        const cx0 = Math.min(Math.max(x0, 0), bw - 1);
        const cx1 = Math.min(Math.max(x0 + 1, 0), bw - 1);
        const cy0 = Math.min(Math.max(y0, 0), bh - 1);
        const cy1 = Math.min(Math.max(y0 + 1, 0), bh - 1);
        ix00[p] = (cy0 * bw + cx0) * 4;
        ix10[p] = (cy0 * bw + cx1) * 4;
        ix01[p] = (cy1 * bw + cx0) * 4;
        ix11[p] = (cy1 * bw + cx1) * 4;
        wfx[p] = sxp - x0;
        wfy[p] = syp - y0;
        inBounds[p] = 1;
      }
    }
  }
  return { cw, ch, bw, bh, padX, padY, k,
    ix00, ix10, ix01, ix11, wfx, wfy, inBounds };
}

function getWarpMap(cw, ch, bw, bh, padX, padY, k) {
  const c = warpMapCache;
  if (c && c.cw === cw && c.ch === ch && c.bw === bw &&
      c.bh === bh && c.padX === padX && c.padY === padY &&
      c.k === k) {
    return c;
  }
  warpMapCache = buildWarpMap(cw, ch, bw, bh, padX, padY, k);
  return warpMapCache;
}

function warpWithMap(srcPixels, map, dstPixels) {
  const { ix00, ix10, ix01, ix11, wfx, wfy, inBounds } = map;
  const count = ix00.length;
  for (let p = 0; p < count; p++) {
    const di = p * 4;
    if (!inBounds[p]) {
      dstPixels[di] = 0; dstPixels[di + 1] = 0;
      dstPixels[di + 2] = 0; dstPixels[di + 3] = 255;
      continue;
    }
    const i00 = ix00[p], i10 = ix10[p];
    const i01 = ix01[p], i11 = ix11[p];
    const fx = wfx[p], fy = wfy[p];
    const ifx = 1 - fx, ify = 1 - fy;
    for (let c = 0; c < 4; c++) {
      const top = srcPixels[i00 + c] * ifx + srcPixels[i10 + c] * fx;
      const bot = srcPixels[i01 + c] * ifx + srcPixels[i11 + c] * fx;
      dstPixels[di + c] = top * ify + bot * fy;
    }
  }
}

// TODO: use hardware processing to improve fps
// INFO: smooth quality requires min 15/60 fps
function distort(bitmap, cw, ch, k) {
  const { bw, bh, padFactor } = computePadding(cw, ch, k);
  const srcPixels = drawPadded(bitmap, cw, ch, bw, bh, padFactor);
  const { oCtx, output } = prepareOutput(cw, ch);
  const padX = (bw - cw) / 2, padY = (bh - ch) / 2;
  const map = getWarpMap(cw, ch, bw, bh, padX, padY, k);
  warpWithMap(srcPixels, map, output.data);
  oCtx.putImageData(output, 0, 0);
  return oCtx.canvas.transferToImageBitmap();
}

self.onmessage = (e) => {
  const { id, cw, ch, k, bitmap } = e.data;
  try {
    if (cw === 0 || ch === 0) {
      bitmap.close();
      self.postMessage({ id, bitmap: null });
      return;
    }
    const resultBitmap = distort(bitmap, cw, ch, k);
    self.postMessage({ id, bitmap: resultBitmap }, [resultBitmap]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};