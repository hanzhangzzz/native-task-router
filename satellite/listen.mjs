// 收音端：听到唤醒词（默认「小卡拉米」，NTR_WAKE_WORD 换成别的 3～6 个汉字）→ 叮一声 → 录下要派的活（也可以一口气连着说）→ 本地转文字 → 交给 Native Task Router 路由 → 把结果读出来。
// 全部离线（sherpa-onnx）：人声检测切出每一句，X-ASR 中英 zipformer 转文字（带热词），再按拼音模糊匹配唤醒词（wake.mjs）。
// 为什么不用 SenseVoice（0.9.x 用的）：开发任务里常夹英文，它把 codex 听成 CAX、debug 听成 DEABI，「登录页」也会成「灯笼液」；
// 同一批句子 X-ASR 加热词几乎全对，速度相当（2026-10-23 对比 SenseVoice / FireRedASR2 / Qwen3-ASR）。
// 不用专门的唤醒词模型：真人口语里「小卡拉米」常被说成「小卡了你」，小模型逐音素比对认不出，大模型转写加近音匹配认得出。
// 先 npm run models 把模型下到 ~/.ntr/cache/models；Native Task Router 要在运行（它提供 127.0.0.1 语音入口）。
//   npm start                     麦克风：ffmpeg 采集系统默认输入，NTR_MIC 换设备（macOS 填 ffmpeg -f avfoundation -list_devices true -i "" 列出的序号）
//   npm start -- --wav x.wav      用 16kHz 单声道录音代替麦克风（排障、验收）
//   --stdin                       从标准输入读 16kHz 单声道 s16le（App 菜单栏「语音唤醒」用这个）
//   --events                      不自己路由和播报，改为往标准输出写事件（每行一个 JSON），由 App 弹出输入框：
//                                 {"ev":"wake"} 唤醒 · {"ev":"partial","text"} 边说边出的字 · {"ev":"final","text"} 说完 · {"ev":"timeout"} 唤醒后没开口
//   NTR_WAKE_WORD=小爱同学         换唤醒词（App 里在菜单栏「修改唤醒词…」设置）
//   NTR_HOTWORDS                  额外的热词，一行一个（App 传入最近会话的项目名），让它们更容易被认对
//   NTR_VOICE_DEBUG=1             打印每一句听到的话（调试唤醒用；默认只打印唤醒之后的话）
import sherpa from 'sherpa-onnx-node';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileWake, DEFAULT_WAKE_WORD, matchWake, validWakeWord } from './wake.mjs';
import { ensureBpeVocab } from './bpe-vocab.mjs';

const NTR_HOME = process.env.NTR_HOME || path.join(os.homedir(), '.ntr');
const MODELS = path.join(NTR_HOME, 'cache', 'models');
const ENDPOINT = `http://127.0.0.1:${process.env.NTR_VOICE_PORT || 47615}/utterance`;
const DEBUG = process.env.NTR_VOICE_DEBUG === '1';
const EVENTS = process.argv.includes('--events');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const WORD = (process.env.NTR_WAKE_WORD || DEFAULT_WAKE_WORD).trim();
if (!validWakeWord(WORD)) { console.error(`唤醒词要 3～6 个汉字：${WORD}`); process.exit(1); }
const WAKE = compileWake(WORD);
const RATE = 16000;
const WIN = 512; // silero VAD 每次吃 512 个采样
const WAIT_SEC = 8; // 唤醒后这么久没开口就放弃
// 自己切句：VAD 只判断"此刻有没有人在说话"。它自带的分段会切掉开头的字、把一句拆碎（真人录音里「小卡了你」被切成「就卡嘢」）
const PRE = 0.6 * RATE; // 从检测到说话前 0.6 秒截起
const HANG = 0.8 * RATE; // 停顿超过 0.8 秒算一句结束
const MAX_UTT = 20 * RATE;
const MIN_SPEECH = 0.3 * RATE; // 说话不到 0.3 秒的当作杂音
const PARTIAL_EVERY = 0.5 * RATE; // 说话途中每半秒把这一句重新转写一次：唤醒词说完就能弹框，后面的字边说边出
// 还没唤醒时每次只转写这一句最近 3 秒找唤醒词：背景一直有人说话（电视）时一句会拖得很长，
// 只看开头的话中途喊的唤醒词要等这句结束才认出来；每次重转整句又太费 CPU
const WAKE_WINDOW = 3 * RATE;

const ASR = path.join(MODELS, 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03');
if (!fs.existsSync(ASR) || !fs.existsSync(path.join(MODELS, 'silero_vad.onnx'))) {
  console.error(`缺模型：先运行 npm run models（下载到 ${MODELS}）`);
  process.exit(1);
}
const vad = new sherpa.Vad({
  sileroVad: { model: path.join(MODELS, 'silero_vad.onnx'), threshold: 0.3, minSilenceDuration: 0.25, minSpeechDuration: 0.2, windowSize: WIN, maxSpeechDuration: 20 },
  sampleRate: RATE, numThreads: 1, provider: 'cpu',
}, 30);
const asr = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: path.join(ASR, 'encoder-epoch-99-avg-1.int8.onnx'), decoder: path.join(ASR, 'decoder-epoch-99-avg-1.onnx'), joiner: path.join(ASR, 'joiner-epoch-99-avg-1.int8.onnx') },
    tokens: path.join(ASR, 'tokens.txt'), numThreads: 2, provider: 'cpu',
    modelingUnit: 'bpe', bpeVocab: ensureBpeVocab(ASR),
  },
  // 热词只在 modified_beam_search 下生效
  decodingMethod: 'modified_beam_search', maxActivePaths: 4, hotwordsScore: 1.5,
});
// 热词：唤醒词本身、开发里常说的英文词、App 传来的项目名。'/' 是 sherpa-onnx 的分隔符，' :5' 是这个词单独的加分。
// 唤醒词加得重：它不是真词，模型是中英双语的，真人随口说的「小卡拉米」会被转成英文「so color me」，拼音就对不上了
// （2026-10-24 真人录音：加分 5 时开着电视也能认出、电视对白零误唤醒；加到 8 开始吞字）
const DEV_TERMS = ['Claude', 'Claude Code', 'Codex', 'git', 'GitHub', 'PR', 'CI', 'README', 'commit', 'debug', 'bug', 'npm', 'API', 'TypeScript', 'JavaScript', 'Python', 'Docker', 'iTerm', 'merge', 'rebase'];
const HOTWORDS = [...new Set([`${WORD} :5`, ...DEV_TERMS, ...(process.env.NTR_HOTWORDS || '').split('\n')].map((w) => w.replace(/\//g, ' ').trim()).filter(Boolean))].join('/');

// --events 时标准输出留给事件，日志写到标准错误
const log = (s) => (EVENTS ? process.stderr : process.stdout).write(`[${new Date().toLocaleTimeString()}] ${s}\n`);
const run = (cmd, args) => new Promise((r) => execFile(cmd, args, () => r()));
const chime = () => process.platform === 'darwin' && void run('afplay', ['/System/Library/Sounds/Tink.aiff']);
// 播报期间不收音（state=busy），免得把自己的声音当成下一句
const speak = (s) => { log(`播报：${s}`); return process.platform === 'darwin' ? run('say', [s.slice(0, 120)]) : Promise.resolve(); };

// idle 等唤醒 | listen 已唤醒，等要派的活 | busy 转写、路由、播报（期间丢弃音频，免得把自己的播报当成下一句）
let state = 'idle';
let job = null;
// 最近 30 秒原始音频的环形缓冲；fed 是送进来的采样总数（绝对位置）
const ring = new Float32Array(30 * RATE);
let fed = 0;
let pending = new Float32Array(0);
// 麦克风电平常常很低（系统输入音量低、离得远），VAD 吃放大后的音频；增益按上一句的峰值自动调
let gain = 16;
let uttStart = -1, lastSpeech = 0, speechLen = 0;
let waited = 0; // listen 状态下已过去的采样数
let lastPartial = 0; // 上次中途转写时的 fed
let uttWake = false; // 这一句里含唤醒词（要派的活是它后面的部分）
let lastSaid = ''; // 这一句里要派的活，最近一次转写的结果

const ringRead = (from, to) => {
  const out = new Float32Array(to - from);
  for (let k = from; k < to; k++) out[k - from] = ring[k % ring.length];
  return out;
};
const resetUtt = () => { uttStart = -1; speechLen = 0; lastPartial = 0; };

function onAudio(samples) {
  if (state === 'busy') return;
  for (let k = 0; k < samples.length; k++) ring[(fed + k) % ring.length] = samples[k];
  const base = fed - pending.length;
  fed += samples.length;
  const buf = new Float32Array(pending.length + samples.length);
  buf.set(pending); buf.set(samples, pending.length);
  let i = 0;
  for (; i + WIN <= buf.length; i += WIN) {
    vad.acceptWaveform(buf.subarray(i, i + WIN).map((x) => Math.max(-1, Math.min(1, x * gain))));
    while (!vad.isEmpty()) vad.pop(); // 不用它的分段
    const pos = base + i + WIN;
    if (vad.isDetected()) {
      if (uttStart < 0) uttStart = Math.max(pos - WIN - PRE, fed - ring.length, 0);
      lastSpeech = pos; speechLen += WIN;
    }
    if (uttStart >= 0 && (pos - lastSpeech > HANG || pos - uttStart > MAX_UTT)) {
      const seg = ringRead(uttStart, Math.min(lastSpeech + HANG / 2, fed));
      const real = speechLen >= MIN_SPEECH;
      resetUtt();
      if (real) { pending = new Float32Array(0); job = handle(seg).finally(() => { job = null; }); return; }
    }
  }
  pending = buf.slice(i);
  // 还没唤醒时每秒找一次唤醒词就够了（背景一直有人说话时省一半 CPU）；唤醒后每半秒出一次字
  if (uttStart >= 0 && fed - Math.max(lastPartial, uttStart) >= (state === 'idle' ? 2 : 1) * PARTIAL_EVERY) { lastPartial = fed; partial(); }
  if (state === 'listen' && uttStart < 0) {
    waited += samples.length;
    if (waited > WAIT_SEC * RATE) {
      if (EVENTS) { emit({ ev: 'timeout' }); state = 'idle'; } else job = finish(speak('没听到，下次再叫我'));
    }
  }
}

function woke(cost, text) {
  log(`唤醒（差异 ${cost}）`);
  // 唤醒触发记一行到 cache（可删）：下次再误触，看这行就知道是哪句话、差异多少，不用猜
  try { fs.mkdirSync(path.join(NTR_HOME, 'cache'), { recursive: true }); fs.appendFileSync(path.join(NTR_HOME, 'cache', 'wake-log.jsonl'), JSON.stringify({ t: new Date().toISOString(), cost, text: String(text).slice(0, 80) }) + '\n'); } catch { /* 记不上不影响唤醒 */ }
  if (EVENTS) emit({ ev: 'wake' });
  chime();
  state = 'listen'; waited = 0; uttWake = true;
}

// 这一句里要派的活：含唤醒词就取它后面的部分（这次没认出唤醒词就沿用上次的）
function said(text) {
  if (!uttWake) return text;
  const m = matchWake(text, WAKE);
  return m ? m.rest : lastSaid;
}

function partial() {
  const from = state === 'idle' ? Math.max(uttStart, fed - WAKE_WINDOW) : uttStart;
  const text = transcribe(ringRead(from, fed));
  if (state === 'idle') {
    // 只在窗口还盖着句首时找唤醒词（配合 wake.mjs 的句首锚定）：长句说到一半后，滑动窗口里句子中段的
    // 近音不再触发唤醒——2026-10-26 家人聊天误触就是这么来的；句首喊的唤醒词在前 3 秒窗口内就能认出。
    if (from !== uttStart) return;
    const m = matchWake(text, WAKE);
    if (!m) return;
    woke(m.cost, text);
  }
  const s = said(text);
  if (s !== lastSaid) { lastSaid = s; if (EVENTS) emit({ ev: 'partial', text: s }); }
}

function transcribe(seg) {
  // 下一句的 VAD 增益按这句的峰值调（放大到 0.5，最多 32 倍）
  let peak = 0;
  for (const x of seg) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) gain = Math.min(32, Math.max(1, 0.5 / peak));
  // 前后各补 1 秒静音：短短一句「小卡拉米」不补时更容易听错（真人录音实测）
  const padded = new Float32Array(seg.length + 2 * RATE);
  padded.set(seg, RATE);
  const st = asr.createStream(HOTWORDS);
  st.acceptWaveform({ sampleRate: RATE, samples: padded });
  asr.decode(st);
  // 模型会给整句加句号，派活的话不需要
  return asr.getResult(st).text.trim().replace(/[。.]$/, '');
}

async function handle(seg) {
  const text = transcribe(seg);
  if (DEBUG) log(`（听到）${text}`);
  if (state === 'idle') {
    const m = matchWake(text, WAKE);
    if (!m) return;
    woke(m.cost, text);
  }
  let task = said(text);
  if (!uttWake) {
    const m = matchWake(text, WAKE);
    // 已唤醒时又叫了一遍：叫准了取后面的话；没叫准（「小卡拉米」说成「小康你」）按再叫一次处理，不当成要派的活
    if (m) task = m.rest;
    else if (text.replace(/[^一-龥]/g, '').length <= WAKE.syl.length + 2 && matchWake(text, WAKE, WAKE.looseCost)) task = '';
  }
  uttWake = false; lastSaid = '';
  // 太短（"嗯""好"或只有唤醒词）当作没说，接着等
  if (task.replace(/[^一-龥a-zA-Z0-9]/g, '').length < 2) { waited = 0; return; }
  log(`听到：${task}`);
  if (EVENTS) { emit({ ev: 'final', text: task }); state = 'idle'; return; }
  return finish(route(task).then(speak));
}

async function finish(p) {
  state = 'busy';
  await p;
  vad.reset(); pending = new Float32Array(0); resetUtt();
  state = 'idle';
  job = null;
}

async function route(text) {
  let token;
  try { token = fs.readFileSync(path.join(NTR_HOME, 'voice-token'), 'utf8').trim(); } catch { return '先打开 Native Task Router'; }
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (res.status === 401) return '口令不对，重启一下 Native Task Router';
    const r = await res.json();
    log(`结果：${r.action}`);
    return r.line || r.action;
  } catch {
    return 'Native Task Router 没在运行';
  }
}

const wavAt = process.argv.indexOf('--wav');
if (wavAt > 0) {
  // 录音文件：按 100ms 一块喂，末尾补 2 秒静音让最后一句收尾；一句处理完再继续喂
  const w = sherpa.readWave(process.argv[wavAt + 1], false); // false：复制一份；Electron 的内存隔离不允许外部缓冲区
  if (w.sampleRate !== RATE) { console.error(`录音要 ${RATE}Hz，这个是 ${w.sampleRate}Hz`); process.exit(1); }
  const all = new Float32Array(w.samples.length + 2 * RATE);
  all.set(w.samples);
  for (let i = 0; i < all.length; i += RATE / 10) { onAudio(all.subarray(i, i + RATE / 10)); if (job) await job; }
  if (state === 'listen') log('录音结束时还在等要派的活');
} else {
  // 16kHz 单声道 s16le 流：默认 ffmpeg 采集麦克风；--stdin 时由 Native Task Router 菜单栏「语音唤醒」从 App 里采集后喂进来
  let source = process.stdin;
  if (!process.argv.includes('--stdin')) {
    const input = process.platform === 'darwin'
      ? ['-f', 'avfoundation', '-i', `:${process.env.NTR_MIC || 'default'}`]
      : ['-f', 'alsa', '-i', process.env.NTR_MIC || 'default'];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    ff.on('error', () => { console.error('需要 ffmpeg 采集麦克风（macOS：brew install ffmpeg）'); process.exit(1); });
    ff.on('exit', (code) => { console.error(`麦克风采集退出（${code}）。macOS 要在「系统设置 → 隐私与安全性 → 麦克风」允许运行本程序的终端`); process.exit(1); });
    source = ff.stdout;
  }
  source.on('end', () => process.exit(0));
  let rest = Buffer.alloc(0);
  source.on('data', (chunk) => {
    const b = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const n = b.length >> 1;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = b.readInt16LE(i * 2) / 32768;
    rest = b.subarray(n * 2);
    onAudio(f);
  });
  log(`在听：说「${WORD}」唤醒，可以接着一口气说要派的活`);
}
