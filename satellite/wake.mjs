// 唤醒词匹配：在转写文字里按拼音找「小卡拉米」，容忍口语和麦克风造成的近音。
// 真人录音里它常被转写成「小卡了你」「小康老你」「就卡了你」「小咖你」：拉弱读成了/老、米听成你、小听成就、卡拉连成康，偶尔吞掉一个字。
import { pinyin } from 'pinyin-pro';

const WAKE = [['x', 'iao'], ['k', 'a'], ['l', 'a'], ['m', 'i']];
// 近音对：声母 l/n、m/n 等，韵母 a 与 e/ao/ang 等。命中算半个错
const NEAR_INITIAL = ['l|n', 'm|n', 'z|zh', 'c|ch', 's|sh', 'k|g', 'f|h', 'k|q', 'x|j', 'x|q', 'j|q'];
const NEAR_FINAL = ['a|e', 'a|ao', 'a|ang', 'a|an', 'an|ang', 'en|eng', 'in|ing', 'i|in', 'iao|ao', 'iao|iu', 'i|ie'];
const near = (pairs, a, b) => a === b ? 0 : pairs.includes(`${a}|${b}`) || pairs.includes(`${b}|${a}`) ? 0.5 : 1;
// 一个字的代价：声母、韵母各占一半；完全对上 0，近音 0.25，对不上 1
const sub = (s, w) => 0.5 * near(NEAR_INITIAL, s.initial, w[0]) + 0.5 * near(NEAR_FINAL, s.final, w[1]);
const SKIP = 1; // 多一个字或少一个字
export const WAKE_MAX_COST = 1.25;

/**
 * 在 text 里找唤醒词。命中返回 { cost, rest }：rest 是唤醒词之后的话（一口气连着说的那件事）；没命中返回 null。
 * 唤醒词可以出现在任何位置（前面可能有"嗯""那个"或上一句的尾巴），取代价最小的一处。
 */
export function matchWake(text, maxCost = WAKE_MAX_COST) {
  const syl = pinyin(text, { toneType: 'none', type: 'all' })
    .map((x, i) => ({ ...x, i }))
    .filter((x) => x.isZh);
  if (!syl.length) return null;
  // 半全局编辑距离：唤醒词必须完整对齐，转写里的起止位置自由
  const n = WAKE.length, m = syl.length;
  let prev = new Array(m + 1).fill(0);
  for (let a = 1; a <= n; a++) {
    const cur = [prev[0] + SKIP];
    for (let b = 1; b <= m; b++) cur[b] = Math.min(prev[b - 1] + sub(syl[b - 1], WAKE[a - 1]), prev[b] + SKIP, cur[b - 1] + SKIP);
    prev = cur;
  }
  let end = 1;
  for (let b = 1; b <= m; b++) if (prev[b] < prev[end]) end = b;
  if (prev[end] > maxCost) return null;
  // 唤醒词最后一个字在原文里的位置之后，就是要派的活
  const rest = text.slice(syl[end - 1].i + 1).replace(/^[\s，,。.、！!？?]+/, '').trim();
  return { cost: prev[end], rest };
}
