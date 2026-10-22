#!/usr/bin/env bash
# 下载收音端用的三个离线模型到 ~/.ntr/cache/models（可删，删了重跑本脚本即可）：
#   唤醒词检测（中文，36MB）、语音转文字 SenseVoice（中英日韩粤，约 230MB）、人声检测 silero VAD（1MB）
set -euo pipefail
DIR="${NTR_HOME:-$HOME/.ntr}/cache/models"
BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download
mkdir -p "$DIR"
cd "$DIR"
fetch_tar() { # <release tag> <名字>
  [ -d "$2" ] && { echo "已有 $2"; return; }
  echo "下载 $2 …"
  curl -fL --retry 3 -o "$2.tar.bz2.part" "$BASE/$1/$2.tar.bz2"
  tar xjf "$2.tar.bz2.part"
  rm "$2.tar.bz2.part"
}
fetch_tar kws-models sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01
fetch_tar asr-models sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09
[ -f silero_vad.onnx ] || curl -fL --retry 3 -o silero_vad.onnx "$BASE/asr-models/silero_vad.onnx"
echo "模型就绪：$DIR"
