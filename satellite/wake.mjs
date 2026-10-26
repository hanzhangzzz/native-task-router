// 唤醒词匹配：在转写文字里按拼音找唤醒词（默认「小卡拉米」，可在菜单栏改），容忍口语和麦克风造成的近音。
// 真人录音里「小卡拉米」常被转写成「小卡了你」「小康老你」「就卡了你」「小咖你」：拉弱读成了/老、米听成你、小听成就、卡拉连成康，偶尔吞掉一个字。
import { pinyin } from 'pinyin-pro';

export const DEFAULT_WAKE_WORD = '小卡拉米';
// 近音对：声母 l/n、m/n 等，韵母 a 与 e/ao/ang 等。命中算半个错
const NEAR_INITIAL = ['l|n', 'm|n', 'z|zh', 'c|ch', 's|sh', 'k|g', 'f|h', 'k|q', 'x|j', 'x|q', 'j|q'];
const NEAR_FINAL = ['a|e', 'a|ao', 'a|ang', 'a|an', 'an|ang', 'en|eng', 'in|ing', 'i|in', 'iao|ao', 'iao|iu', 'i|ie'];
const near = (pairs, a, b) => a === b ? 0 : pairs.includes(`${a}|${b}`) || pairs.includes(`${b}|${a}`) ? 0.5 : 1;
// 一个字的代价：声母、韵母各占一半；完全对上 0，近音 0.25，对不上 1
const sub = (s, w) => 0.5 * near(NEAR_INITIAL, s.initial, w.initial) + 0.5 * near(NEAR_FINAL, s.final, w.final);
const SKIP = 1; // 多一个字或少一个字
// 允许的总差异按字数算：4 个字 1.25（在 8149 句中文文档上零误唤醒、真人口语的常见变体都能叫醒）
const COST_PER_CHAR = 1.25 / 4;
// 已唤醒后「又叫了一遍但没叫准」的宽松门槛（4 个字 1.75）
const LOOSE_PER_CHAR = 1.75 / 4;
const syllables = (text) => pinyin(text, { toneType: 'none', type: 'all' }).map((x, i) => ({ ...x, i })).filter((x) => x.isZh);

/** 唤醒词只收 3～6 个汉字：太短日常说话里到处是近音，太长难一口气说准。 */
export const validWakeWord = (word) => /^[一-龥]{3,6}$/.test(String(word || '').trim());

/** 唤醒词 → 拼音与门槛。 */
export function compileWake(word = DEFAULT_WAKE_WORD) {
  const syl = syllables(word);
  return { word, syl, maxCost: COST_PER_CHAR * syl.length, looseCost: LOOSE_PER_CHAR * syl.length };
}

/**
 * 在 text 里找唤醒词。命中返回 { cost, rest }：rest 是唤醒词之后的话（一口气连着说的那件事）；没命中返回 null。
 * 唤醒词必须在句首附近（prefixSlack 个字以内的前缀，容纳"嗯""那个"这类口头垫字）：
 * 2026-10-26 真实事故——家人闲聊的长句在句中段凑出近音窗口、触发唤醒，后续聊天被当成任务送进路由。
 * 从那以后句子中后段的近音一律不认：真唤醒总是把唤醒词放在一句话的开头说。
 */
export function matchWake(text, wake, maxCost = wake.maxCost, prefixSlack = 2) {
  const syl = syllables(text);
  if (!syl.length) return null;
  // 半全局编辑距离：唤醒词必须完整对齐；起点限制在句首 prefixSlack 字内，终点自由（后面是要派的活）
  const n = wake.syl.length, m = syl.length;
  let prev = new Array(m + 1).fill(Infinity);
  for (let b = 0; b <= Math.min(prefixSlack, m); b++) prev[b] = 0;
  for (let a = 1; a <= n; a++) {
    const cur = [prev[0] + SKIP];
    for (let b = 1; b <= m; b++) cur[b] = Math.min(prev[b - 1] + sub(syl[b - 1], wake.syl[a - 1]), prev[b] + SKIP, cur[b - 1] + SKIP);
    prev = cur;
  }
  let end = 1;
  for (let b = 1; b <= m; b++) if (prev[b] < prev[end]) end = b;
  if (prev[end] > maxCost) return null;
  // 唤醒词最后一个字在原文里的位置之后，就是要派的活
  const rest = text.slice(syl[end - 1].i + 1).replace(/^[\s，,。.、！!？?]+/, '').trim();
  return { cost: prev[end], rest };
}
