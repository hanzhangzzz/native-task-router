// 收音端：听到「小卡拉米」→ 叮一声 → 录下要派的活（也可以一口气连着说）→ 本地转文字 → 交给 Native Task Router 路由 → 把结果读出来。
// 全部离线（sherpa-onnx）：人声检测切出每一句，SenseVoice 转文字，再按拼音模糊匹配唤醒词（wake.mjs）。
// 不用专门的唤醒词模型：真人口语里「小卡拉米」常被说成「小卡了你」，小模型逐音素比对认不出，大模型转写加近音匹配认得出。
// 先 npm run models 把模型下到 ~/.ntr/cache/models；Native Task Router 要在运行（它提供 127.0.0.1 语音入口）。
//   npm start                     麦克风：ffmpeg 采集系统默认输入，NTR_MIC 换设备（macOS 填 ffmpeg -f avfoundation -list_devices true -i "" 列出的序号）
//   npm start -- --wav x.wav      用 16kHz 单声道录音代替麦克风（排障、验收）
//   NTR_VOICE_DEBUG=1             打印每一句听到的话（调试唤醒用；默认只打印唤醒之后的话）
import sherpa from 'sherpa-onnx-node';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchWake } from './wake.mjs';

const NTR_HOME = process.env.NTR_HOME || path.join(os.homedir(), '.ntr');
const MODELS = path.join(NTR_HOME, 'cache', 'models');
const ENDPOINT = `http://127.0.0.1:${process.env.NTR_VOICE_PORT || 47615}/utterance`;
const DEBUG = process.env.NTR_VOICE_DEBUG === '1';
const RATE = 16000;
const WIN = 512; // silero VAD 每次吃 512 个采样
const WAIT_SEC = 8; // 唤醒后这么久没开口就放弃
// 自己切句：VAD 只判断"此刻有没有人在说话"。它自带的分段会切掉开头的字、把一句拆碎（真人录音里「小卡了你」被切成「就卡嘢」）
const PRE = 0.6 * RATE; // 从检测到说话前 0.6 秒截起
const HANG = 0.8 * RATE; // 停顿超过 0.8 秒算一句结束
const MAX_UTT = 20 * RATE;
const MIN_SPEECH = 0.3 * RATE; // 说话不到 0.3 秒的当作杂音

const ASR = path.join(MODELS, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09');
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
    // 固定普通话：自动判断语种时短句常被当成粤语（「就卡嘢」）
    senseVoice: { model: path.join(ASR, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: 1 },
    tokens: path.join(ASR, 'tokens.txt'), numThreads: 2, provider: 'cpu',
  },
});

const log = (s) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);
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

const ringRead = (from, to) => {
  const out = new Float32Array(to - from);
  for (let k = from; k < to; k++) out[k - from] = ring[k % ring.length];
  return out;
};
const resetUtt = () => { uttStart = -1; speechLen = 0; };

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
  if (state === 'listen' && uttStart < 0) {
    waited += samples.length;
    if (waited > WAIT_SEC * RATE) job = finish(speak('没听到，下次再叫我'));
  }
}

function transcribe(seg) {
  // 下一句的 VAD 增益按这句的峰值调（放大到 0.5，最多 32 倍）
  let peak = 0;
  for (const x of seg) peak = Math.max(peak, Math.abs(x));
  if (peak > 0) gain = Math.min(32, Math.max(1, 0.5 / peak));
  // 前后各补 1 秒静音：短短一句「小卡拉米」不补时更容易听错（真人录音实测）
  const padded = new Float32Array(seg.length + 2 * RATE);
  padded.set(seg, RATE);
  const st = asr.createStream();
  st.acceptWaveform({ sampleRate: RATE, samples: padded });
  asr.decode(st);
  return asr.getResult(st).text.trim();
}

async function handle(seg) {
  const listening = state === 'listen';
  state = 'busy';
  const text = transcribe(seg);
  if (DEBUG) log(`（听到）${text}`);
  const wake = matchWake(text);
  const zhLen = text.replace(/[^一-龥]/g, '').length;
  // 已唤醒时又叫了一遍但没叫准（「小康你」），按再叫一次处理，不当成要派的活
  if (!wake && listening && zhLen <= 6 && matchWake(text, 1.75)) { state = 'listen'; waited = 0; return; }
  const task = wake ? wake.rest : listening ? text : '';
  if (wake) { log(`唤醒（差异 ${wake.cost}）`); chime(); }
  if (!wake && !listening) return finish();
  // 唤醒词后面的话太短（"嗯""好"之类）当作没说，接着等
  if (task.replace(/[^一-龥a-zA-Z0-9]/g, '').length < 2) {
    if (!wake) return finish(speak('没听清，再说一次'));
    state = 'listen'; waited = 0;
    return;
  }
  log(`听到：${task}`);
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
  const w = sherpa.readWave(process.argv[wavAt + 1]);
  if (w.sampleRate !== RATE) { console.error(`录音要 ${RATE}Hz，这个是 ${w.sampleRate}Hz`); process.exit(1); }
  const all = new Float32Array(w.samples.length + 2 * RATE);
  all.set(w.samples);
  for (let i = 0; i < all.length; i += RATE / 10) { onAudio(all.subarray(i, i + RATE / 10)); if (job) await job; }
  if (state === 'listen') log('录音结束时还在等要派的活');
} else {
  const input = process.platform === 'darwin'
    ? ['-f', 'avfoundation', '-i', `:${process.env.NTR_MIC || 'default'}`]
    : ['-f', 'alsa', '-i', process.env.NTR_MIC || 'default'];
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  ff.on('error', () => { console.error('需要 ffmpeg 采集麦克风（macOS：brew install ffmpeg）'); process.exit(1); });
  ff.on('exit', (code) => { console.error(`麦克风采集退出（${code}）。macOS 要在「系统设置 → 隐私与安全性 → 麦克风」允许运行本程序的终端`); process.exit(1); });
  let rest = Buffer.alloc(0);
  ff.stdout.on('data', (chunk) => {
    const b = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const n = b.length >> 1;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = b.readInt16LE(i * 2) / 32768;
    rest = b.subarray(n * 2);
    onAudio(f);
  });
  log('在听：说「小卡拉米」唤醒，可以接着一口气说要派的活');
}
