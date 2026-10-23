// 唤醒词匹配合同（satellite/wake.mjs）：默认词在真人口语转写的常见变体下能叫醒、日常句子不误唤醒；自定义词同一套规则。
import assert from 'node:assert/strict';
import { compileWake, matchWake, validWakeWord } from '../satellite/wake.mjs';

let n = 0;
const ok = (name, cond) => { assert.ok(cond, name); n++; };

const def = compileWake();
// 真人录音里实际转写出来的样子
for (const s of ['小卡拉米', '小卡了你', '小康老你', '小咖拉面', '小康了没', '小卡你']) ok(`默认词叫醒：${s}`, matchWake(s, def));
ok('一口气连着说：取唤醒词后面的话', matchWake('就卡了米帮我看看测试为什么挂了', def)?.rest === '帮我看看测试为什么挂了');
ok('前面有语气词', matchWake('嗯，小卡拉米，跑一下构建', def)?.rest === '跑一下构建');
for (const s of ['帮我看看测试为什么挂了', '小区门口卡了一辆车', '开始工作吧', '把登录页的按钮颜色改成蓝色']) ok(`默认词不误唤醒：${s}`, !matchWake(s, def));

// 自定义词：门槛按字数缩放
const xa = compileWake('小爱同学');
ok('自定义词叫醒（近音）', matchWake('小艾同学', xa));
ok('自定义词连着说', matchWake('小爱同学，回滚上一个提交', xa)?.rest === '回滚上一个提交');
ok('自定义词不被默认词叫醒', !matchWake('小卡拉米', xa));
ok('换了词默认词不再叫醒', !matchWake('小爱同学', def));
const three = compileWake('嘿小乐');
ok('三个字门槛更紧', three.maxCost < def.maxCost && matchWake('嘿小乐', three) && !matchWake('嘿小王', three) && !!matchWake('嘿小王', three, def.maxCost));

ok('校验：3～6 个汉字', validWakeWord('小爱同学') && validWakeWord('嘿小乐') && !validWakeWord('小卡') && !validWakeWord('hey siri') && !validWakeWord('小卡拉米同学们好') && !validWakeWord(''));

console.log(`voice-wake contracts: ${n} PASS`);
