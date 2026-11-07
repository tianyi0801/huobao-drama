/**
 * 产出 wav 质量校验 — 纯 Node 实现，不依赖 Python / 第三方音频库
 *
 * 判据来自 Breeze-TTS-2 实测经验：自然语音的换气会留下 25~30% 静音；
 * 静音占比过低往往意味着 instruction 程度词堆太多、模型「过度表演」。
 * 生成失败（全静音 / 文本被截断）必须在这里挡住，不把坏音频交给用户。
 */
import fs from 'fs'

export interface WavMetrics {
  duration: number
  sampleRate: number
  channels: number
  peak: number
  rms: number
  silenceRatio: number
  verdict: 'PASS' | 'WARN' | 'FAIL'
  reason: string
}

const SILENCE_ABS = 0.01
const SILENCE_WIN_S = 0.05

export function inspectWav(filePath: string): WavMetrics {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('产出文件不是有效的 RIFF/WAVE 音频')
  }

  // 逐 chunk 扫描，兼容 fmt 扩展块与 LIST 等元数据块
  let offset = 12
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bitsPerSample = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, buf.length - body)
      break
    }
    offset = body + size + (size % 2)
  }

  if (dataOffset < 0 || !channels || !sampleRate || bitsPerSample !== 16) {
    throw new Error('仅支持 16-bit PCM wav，无法解析产出的音频')
  }

  const stride = 2 * channels
  const frameCount = Math.floor(dataSize / stride)
  if (frameCount <= 0) throw new Error('产出音频没有有效采样数据')

  const winSize = Math.max(1, Math.floor(sampleRate * SILENCE_WIN_S))
  let peak = 0
  let sumSq = 0
  let winMax = 0
  let winFrames = 0
  let totalWin = 0
  let silentWin = 0

  for (let i = 0; i < frameCount; i++) {
    const off = dataOffset + i * stride
    let sample = buf.readInt16LE(off)
    if (channels > 1) {
      // 多声道先平均再计算，与单声道判据保持一致
      let sum = sample
      for (let ch = 1; ch < channels; ch++) sum += buf.readInt16LE(off + ch * 2)
      sample = Math.round(sum / channels)
    }
    const value = Math.abs(sample) / 32768
    if (value > peak) peak = value
    sumSq += value * value
    if (value > winMax) winMax = value
    winFrames++
    if (winFrames >= winSize) {
      totalWin++
      if (winMax < SILENCE_ABS) silentWin++
      winMax = 0
      winFrames = 0
    }
  }
  if (winFrames > 0) {
    totalWin++
    if (winMax < SILENCE_ABS) silentWin++
  }

  const duration = frameCount / sampleRate
  const rms = Math.sqrt(sumSq / frameCount)
  const silenceRatio = totalWin ? silentWin / totalWin : 0

  let verdict: WavMetrics['verdict'] = 'PASS'
  let reason = '正常'
  if (peak < 0.05) {
    verdict = 'FAIL'
    reason = '基本是静音，生成失败，请换 seed 或检查 cfg_scale'
  } else if (duration < 0.3) {
    verdict = 'FAIL'
    reason = '时长过短，文本可能被截断'
  } else if (silenceRatio < 0.05) {
    verdict = 'WARN'
    reason = '静音占比过低，可能过度表演，建议减少音色描述里的程度词'
  } else if (silenceRatio > 0.55) {
    verdict = 'WARN'
    reason = '停顿过多，可能存在拖尾或截断'
  } else if (rms < 0.02) {
    verdict = 'WARN'
    reason = '音量偏低或波形被压平'
  }

  return {
    duration: Math.round(duration * 100) / 100,
    sampleRate,
    channels,
    peak: Math.round(peak * 10000) / 10000,
    rms: Math.round(rms * 10000) / 10000,
    silenceRatio: Math.round(silenceRatio * 1000) / 1000,
    verdict,
    reason,
  }
}
