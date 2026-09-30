// Turns a product photo on a white background into a transparent PNG cutout.
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const MAX = 640;

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 });
    return { w: j.width, h: j.height, d: j.data };
  }
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const p = PNG.sync.read(buf);
    return { w: p.width, h: p.height, d: p.data };
  }
  throw new Error('Unsupported image type');
}

function shrink({ w, h, d }) {
  const f = Math.max(w, h) / MAX;
  if (f <= 1) return { w, h, d };
  const nw = Math.round(w / f), nh = Math.round(h / f), out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * f)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * f)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * w + xx) * 4;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { w: nw, h: nh, d: out };
}

export function cutout(buf) {
  const { w, h, d } = shrink(decode(buf));
  const N = w * h, gone = new Uint8Array(N), seen = new Uint8Array(N), q = new Int32Array(N);
  const lo = (p) => Math.min(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
  const bgLike = (p) => {
    if (d[p * 4 + 3] < 10) return true;
    const hi = Math.max(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
    return lo(p) >= 236 && hi - lo(p) <= 14;
  };
  let head = 0, tail = 0;
  const push = (p) => { if (!seen[p] && bgLike(p)) { seen[p] = 1; q[tail++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (head < tail) {
    const p = q[head++], x = p % w, y = (p / w) | 0;
    gone[p] = 1;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const near = (p) => {
    const x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && gone[ny * w + nx]) return true;
    }
    return false;
  };
  // Trim the light fringe left by anti-aliasing so no white halo shows on a dark page.
  for (let pass = 0; pass < 2; pass++) {
    const kill = [];
    for (let p = 0; p < N; p++) if (!gone[p] && lo(p) >= 205 && near(p)) kill.push(p);
    kill.forEach((p) => { gone[p] = 1; });
  }
  let removed = 0;
  for (let p = 0; p < N; p++) {
    if (gone[p]) { d[p * 4 + 3] = 0; removed++; } else d[p * 4 + 3] = near(p) ? 170 : 255;
  }
  const share = removed / N;
  if (share < 0.05 || share > 0.9) throw new Error('No clean cutout');
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(d);
  return PNG.sync.write(png, { deflateLevel: 6 });
}
