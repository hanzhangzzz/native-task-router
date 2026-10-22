// 收音端：听到唤醒词「小卡拉米」→ 叮一声 → 录下接着说的一句话 → 本地转文字 → 交给 Native Task Router 路由 → 把结果读出来。
// 全部离线（sherpa-onnx）。先 npm run models 把模型下到 ~/.ntr/cache/models；Native Task Router 要在运行（它提供 127.0.0.1 语音入口）。
//   npm start                     麦克风：ffmpeg 采集系统默认输入，NTR_MIC 换设备（macOS 填 ffmpeg -f avfoundation -list_devices true -i "" 列出的序号）
//   npm start -- --wav x.wav      用 16kHz 单声道录音代替麦克风（排障、验收）
//   NTR_WAKE_THRESHOLD=0.15       唤醒灵敏度（越小越容易唤醒，也越容易误唤醒；默认 0.25）
import sherpa from 'sherpa-onnx-node';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NTR_HOME = process.env.NTR_HOME || path.join(os.homedir(), '.ntr');
const MODELS = path.join(NTR_HOME, 'cache', 'models');
const ENDPOINT = `http://127.0.0.1:${process.env.NTR_VOICE_PORT || 47615}/utterance`;
const RATE = 16000;
const WIN = 512; // silero VAD 每次吃 512 个采样
const NO_SPEECH_SEC = 6; // 唤醒后这么久没开口就放弃

const KWS = path.join(MODELS, 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01');
const ASR = path.join(MODELS, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09');
if (!fs.existsSync(KWS) || !fs.existsSync(ASR) || !fs.existsSync(path.join(MODELS, 'silero_vad.onnx'))) {
  console.error(`缺模型：先运行 npm run models（下载到 ${MODELS}）`);
  process.exit(1);
}
// 唤醒词按模型的拼音单元写：声母 + 带调韵母
const keywordsFile = path.join(MODELS, 'ntr-wake-keywords.txt');
fs.writeFileSync(keywordsFile, 'x iǎo k ǎ l ā m ǐ @小卡拉米\n');

const kws = new sherpa.KeywordSpotter({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(KWS, 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      decoder: path.join(KWS, 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
      joiner: path.join(KWS, 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
    },
    tokens: path.join(KWS, 'tokens.txt'), numThreads: 1, provider: 'cpu',
  },
  keywordsFile,
  keywordsThreshold: Number(process.env.NTR_WAKE_THRESHOLD) || 0.25,
});
const vad = new sherpa.Vad({
  sileroVad: { model: path.join(MODELS, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.8, minSpeechDuration: 0.25, windowSize: WIN, maxSpeechDuration: 20 },
  sampleRate: RATE, numThreads: 1, provider: 'cpu',
}, 30);
const asr = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: RATE, featureDim: 80 },
  modelConfig: {
    senseVoice: { model: path.join(ASR, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
    tokens: path.join(ASR, 'tokens.txt'), numThreads: 2, provider: 'cpu',
  },
});

const log = (s) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);
const run = (cmd, args) => new Promise((r) => execFile(cmd, args, () => r()));
const chime = () => process.platform === 'darwin' && void run('afplay', ['/System/Library/Sounds/Tink.aiff']);
// 播报期间不收音（state=busy），免得把自己的声音当成下一句
const speak = (s) => { log(`播报：${s}`); return process.platform === 'darwin' ? run('say', [s.slice(0, 120)]) : Promise.resolve(); };

// idle 等唤醒 | listen 录这一句 | busy 转写、路由、播报（期间丢弃音频）
let state = 'idle';
let kwsStream = kws.createStream();
// 唤醒词要说完半秒左右才报出来：等待唤醒时留着最近 3 秒，唤醒后从唤醒词结尾接着录，一口气连着说的开头不丢
let recent = [];
let recentLen = 0;
let kwsFed = 0;
let pending = new Float32Array(0);
let heard = 0;
let job = null;

function onAudio(samples) {
  if (state === 'busy') return;
  if (state === 'idle') {
    kwsStream.acceptWaveform({ sampleRate: RATE, samples });
    kwsFed += samples.length;
    recent.push(samples); recentLen += samples.length;
    while (recentLen - recent[0].length > 3 * RATE) recentLen -= recent.shift().length;
    while (kws.isReady(kwsStream)) {
      kws.decode(kwsStream);
      const r = kws.getResult(kwsStream);
      if (r.keyword) return wake(r);
    }
    return;
  }
  heard += samples.length;
  const buf = new Float32Array(pending.length + samples.length);
  buf.set(pending); buf.set(samples, pending.length);
  let i = 0;
  for (; i + WIN <= buf.length; i += WIN) vad.acceptWaveform(buf.subarray(i, i + WIN));
  pending = buf.slice(i);
  if (!vad.isEmpty()) {
    const seg = Float32Array.from(vad.front(false).samples);
    vad.clear();
    job = handle(seg).finally(() => { job = null; });
  } else if (!vad.isDetected() && heard > NO_SPEECH_SEC * RATE) {
    job = finish(speak('没听到，下次再叫我'));
  }
}

function wake(r) {
  log('唤醒');
  kws.reset(kwsStream);
  state = 'listen'; vad.reset(); pending = new Float32Array(0); heard = 0;
  chime();
  // 时间戳是每个拼音单元的起点，最后一个韵母再往后 0.25 秒算唤醒词结束
  const end = Math.round((r.start_time + r.timestamps.at(-1) + 0.25) * RATE);
  const tail = Math.max(0, Math.min(recentLen, kwsFed - end));
  const buf = new Float32Array(recentLen);
  let o = 0;
  for (const c of recent) { buf.set(c, o); o += c.length; }
  recent = []; recentLen = 0;
  if (tail) onAudio(buf.subarray(buf.length - tail));
}

async function finish(p) {
  state = 'busy';
  await p;
  kwsStream = kws.createStream(); kwsFed = 0;
  state = 'idle';
  job = null;
}

async function handle(seg) {
  state = 'busy';
  const st = asr.createStream();
  st.acceptWaveform({ sampleRate: RATE, samples: seg });
  asr.decode(st);
  // 一口气连着唤醒词说时，转写会带上唤醒词
  const text = asr.getResult(st).text.trim().replace(/^小卡拉米[，,。.\s]*/, '');
  if (!text) return finish(speak('没听清，再说一次'));
  log(`听到：${text}`);
  return finish(route(text).then(speak));
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
  if (state === 'listen') log('录音结束时还在等这一句');
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
  log('在听：说「小卡拉米」唤醒');
}
