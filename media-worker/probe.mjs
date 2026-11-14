// Checks of finished pictures before they go to a network. FERMA draws nothing itself: the cards come from Gudini.
// Here: format, size and colour space for Instagram and Threads, a SHA-256 and a perceptual hash (dHash) to find
// pictures that look the same, and signs of a bad picture (empty or one-colour, cut-off edge).
import { createHash } from 'node:crypto';
import sharp from 'sharp';

const MAX_BYTES = 8 * 1024 * 1024;
const fail = (message, code = 'BAD_INPUT') => Object.assign(new Error(message), { code, status: 422 });

/** 64-bit difference hash: two pictures that look the same have hashes a few bits apart. */
export async function dhash(buffer) {
  const pixels = await sharp(buffer).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let value = 0n;
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) value = (value << 1n) | (pixels[row * 9 + col] > pixels[row * 9 + col + 1] ? 1n : 0n);
  return value.toString(16).padStart(16, '0');
}

/** Problems a network would refuse or a reader would notice. Empty list: the picture is fine. */
export async function pictureProblems(buffer, meta, { platform } = {}) {
  const problems = [];
  if (!['jpeg', 'png'].includes(meta.format)) problems.push(`формат ${meta.format}: нужен JPEG или PNG`);
  if (platform === 'instagram' && meta.format !== 'jpeg') problems.push('Instagram принимает только JPEG');
  if (buffer.length > MAX_BYTES) problems.push(`файл ${Math.round(buffer.length / 1048576)} МБ: больше 8 МБ`);
  const ratio = meta.width / meta.height;
  if (platform === 'instagram' && (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005)) problems.push(`пропорции ${meta.width}×${meta.height}: Instagram принимает от 4:5 до 1,91:1`);
  if (meta.width < 320) problems.push(`ширина ${meta.width}: меньше 320 точек`);
  // A picture of one colour (a failed render) has almost no spread of brightness.
  const stats = await sharp(buffer).greyscale().stats();
  if (stats.channels[0].stdev < 4) problems.push('картинка почти одного цвета: похоже на пустой рендер');
  // A hard cut: one edge row or column of the picture is uniform while the next one is busy text or image.
  const edge = await sharp(buffer).greyscale().resize(64, 80, { fit: 'fill' }).raw().toBuffer();
  const rowSpread = row => { let min = 255, max = 0; for (let col = 0; col < 64; col++) { const value = edge[row * 64 + col]; if (value < min) min = value; if (value > max) max = value; } return max - min; };
  if (rowSpread(0) > 200 && rowSpread(79) > 200 && stats.channels[0].stdev > 90) problems.push('по краям нет полей: возможно, картинка обрезана');
  return problems;
}

/** Facts about one picture: format, size, colour space, hashes and problems for the given platform. */
export async function probeImage(job) {
  const buffer = Buffer.from(String(job?.data || ''), 'base64');
  if (!buffer.length) throw fail('пустой файл');
  const meta = await sharp(buffer, { limitInputPixels: 60_000_000 }).metadata().catch(() => null);
  if (!meta) throw fail('файл не читается как картинка');
  return {
    format: meta.format, width: meta.width, height: meta.height, space: meta.space, size: buffer.length, hasAlpha: Boolean(meta.hasAlpha),
    sha256: createHash('sha256').update(buffer).digest('hex'), dhash: await dhash(buffer), problems: await pictureProblems(buffer, meta, { platform: job?.platform }),
  };
}
