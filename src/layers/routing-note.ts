// 分叉档送达时加在正文前的路由说明：让收到消息的 Agent 自己做最后一道闸。
// 措辞固定、不含本机路径；正文含汉字用中文，否则英文。置信度保留两位小数。
// 原生历史里会留下这段说明，索引读卡片时用 stripRoutingNote 去掉，免得它进入下一次路由的提示词。

const ZH = (c: string) => `[路由说明] 这句话由 Native Task Router 自动送达，对项目的置信度 ${c}。如果它与这个项目或会话正在做的事无关，请说明原因并停下，不要修改任何文件。`;
const EN = (c: string) => `[Routing note] This message was delivered automatically by Native Task Router (project confidence ${c}). If it is unrelated to what this project or session is working on, say so and stop without changing any files.`;

export const hasHan = (text: string): boolean => /\p{Script=Han}/u.test(text);

export function routingNote(text: string, confidence: number): string {
  const c = confidence.toFixed(2);
  return `${hasHan(text) ? ZH(c) : EN(c)}\n\n${text}`;
}

const NOTE_LINE = /^(?:\[路由说明\] 这句话由 Native Task Router 自动送达[^\n]*|\[Routing note\] This message was delivered automatically by Native Task Router[^\n]*)\n\n/;

/** 去掉开头的路由说明，返回用户原话；没有说明则原样返回。 */
export function stripRoutingNote(text: string): string {
  return text.replace(NOTE_LINE, '');
}
