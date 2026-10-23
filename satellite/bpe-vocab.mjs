// 热词要用模型的 BPE 词表（bpe.vocab），模型包里只有 sentencepiece 的 bpe.model。
// 官方用 Python sentencepiece 导出；这里直接读 protobuf，免得用户装 Python（与官方导出逐行一致，2026-10-23 核对）。
// ModelProto.pieces 是字段 1（重复），每个 SentencePiece 里 piece 是字段 1（字符串）、score 是字段 2（float）。
import fs from 'node:fs';

export function bpeVocab(modelFile) {
  const b = fs.readFileSync(modelFile);
  let i = 0;
  const varint = () => { let v = 0, s = 0, x; do { x = b[i++]; v += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return v; };
  const skip = (wt) => { if (wt === 0) varint(); else if (wt === 1) i += 8; else if (wt === 5) i += 4; else if (wt === 2) i += varint(); };
  const lines = [];
  while (i < b.length) {
    const tag = varint();
    if (tag !== ((1 << 3) | 2)) { skip(tag & 7); continue; }
    const end = varint() + i;
    let piece = '', score = 0;
    while (i < end) {
      const t = varint();
      if (t === ((1 << 3) | 2)) { const l = varint(); piece = b.toString('utf8', i, i + l); i += l; }
      else if (t === ((2 << 3) | 5)) { score = b.readFloatLE(i); i += 4; }
      else skip(t & 7);
    }
    lines.push(`${piece}\t${score}`);
  }
  return lines.join('\n') + '\n';
}

/** 模型目录里没有 bpe.vocab 就生成一份，返回它的路径。 */
export function ensureBpeVocab(dir) {
  const out = `${dir}/bpe.vocab`;
  if (!fs.existsSync(out)) fs.writeFileSync(out, bpeVocab(`${dir}/bpe.model`));
  return out;
}
