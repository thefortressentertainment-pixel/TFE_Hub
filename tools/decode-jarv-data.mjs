#!/usr/bin/env node
/*
 * JARV Data Decode tool
 * ---------------------
 * Takes a file or directory, detects what kind of data it actually is
 * (magic bytes + byte statistics), extracts every readable string, and
 * writes a plain-English Markdown report OUTSIDE the repo so it can be
 * studied personally (default: ~/jarv-data/).
 *
 * Usage:  node tools/decode-jarv-data.mjs [path] [outDir]
 *   path   — file or directory to decode (default: ./eng.traineddata)
 *   outDir — report output dir (default: ~/jarv-data)
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const MAGIC = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], kind: 'PNG image' },
  { bytes: [0xff, 0xd8, 0xff], kind: 'JPEG image' },
  { bytes: [0x25, 0x50, 0x44, 0x46], kind: 'PDF document' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], kind: 'ZIP archive (or Office/WAR/VSIX)' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], kind: 'ZIP archive (empty)' },
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], kind: 'macOS Mach-O 64-bit executable' },
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], kind: 'macOS Mach-O 32-bit executable' },
  { bytes: [0x63, 0x66, 0x61, 0xed, 0xfe], kind: 'macOS Mach-O 64-bit (arm64) binary' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], kind: 'ELF binary (Linux)' },
  { bytes: [0x4d, 0x5a], kind: 'PE/Windows executable' },
  { bytes: [0x52, 0x61, 0x72], kind: 'RAR archive' },
  { bytes: [0x1f, 0x8b], kind: 'GZIP (tarball)' },
  { bytes: [0x42, 0x5a, 0x68], kind: 'BZIP2 archive' },
  { bytes: [0x38, 0x35, 0x5b], kind: 'XZ archive' },
  { bytes: [0x00, 0x00, 0x01, 0x00], kind: 'ICO/ICNS icon' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], kind: 'OGG audio' },
  { bytes: [0x49, 0x44, 0x33], kind: 'MP3 audio (ID3 tag)' },
  { bytes: [0x51, 0x57, 0x56], kind: 'QOI image' },
  { bytes: [0x53, 0x51, 0x4c, 0x69], kind: 'SQLite database' },
]

function isTesseract(buf) {
  const head = buf.subarray(0, 16).toString('latin1')
  return head.startsWith('pow ') || head.startsWith('LSTM Data File')
}

function detectKind(buf) {
  for (const cand of MAGIC) {
    const m = Buffer.from(cand.bytes)
    if (buf.length >= m.length && buf.subarray(0, m.length).equals(m)) return cand.kind
  }
  const head512 = buf.subarray(0, 512).toString('latin1')
  if (head512.includes('LSTM Data File Specification') || head512.startsWith('pow ')) {
    return 'Tesseract OCR ".traineddata" language model — compiled LSTM neural network (layer weights + character-shape tables + word dictionaries). Not prose; cannot be "translated".'
  }
  const lt = buf.length > 200000 ? buf.subarray(0, 200000).toString('latin1') : head512
  if (/SummLSTM|Lfys\d+|Lfx\d+|RevLSTM/.test(lt)) {
    return 'Tesseract OCR ".traineddata" LSTM language model — compiled neural network (a "traineddata" file used by the Tesseract OCR engine). Its layers encode how printed English characters are recognized; it is not a written language.'
  }
  const head = buf.subarray(0, 64).toString('latin1')
  if (head.startsWith('<!DOCTYPE') || head.startsWith('<html')) return 'HTML document'
  if (head.startsWith('{"')) return 'JSON text file'
  if (head.match(/^[\w\s.,;:()\[\]{}\-+*\/'"=*#]*\r?\n/m)) return 'text-like file'
  return 'binary / unrecognized format'
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192)
  const sample = buf.subarray(0, n)
  let ctrl = 0
  let nul = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) nul++
    if (sample[i] < 32 && sample[i] !== 9 && sample[i] !== 10 && sample[i] !== 13) ctrl++
  }
  return (nul && nul / n > 0.005) || ctrl / n > 0.03
}

function printableRuns(buf, max = 200) {
  const out = []
  let cur = ''
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b >= 32 && b < 127) {
      cur += String.fromCharCode(b)
      if ((cur.length === 8 && out.length % 7 === 0) || (cur.length > 1 && out.length < max * 0.15 && !out.includes(cur) && cur.length >= 6)) {
        if (cur.length >= 6 && !out.includes(cur)) out.push(cur)
      }
    } else {
      if (cur.length >= 6 && !out.includes(cur)) out.push(cur)
      cur = ''
    }
  }
  if (out.length > max) {
    const step = Math.ceil(out.length / max)
    return out.filter((_, i) => i % step === 0)
  }
  return out.slice(0, max)
}

function byteProfile(buf) {
  const hist = new Array(256).fill(0)
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++
  let nonzero = 0
  for (const c of hist) if (c > 0) nonzero++
  const entropy = -hist.reduce((s, c) => (c ? s + (c / buf.length) * Math.log2(c / buf.length) : s), 0)
  return { distinctBytes: nonzero, entropy: entropy.toFixed(4), topBytes: [...hist.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, c]) => `0x${v.toString(16).padStart(2, '0')}×${c}`).join(', ') }
  }

function collectFiles(target, out = []) {
  const st = fs.statSync(target)
  if (st.isFile()) return [target]
  for (const name of fs.readdirSync(target)) {
    if (['.git', 'node_modules', 'dist', '.build'].includes(name)) continue
    const p = path.join(target, name)
    try {
      if (fs.statSync(p).isDirectory()) collectFiles(p, out)
      else out.push(p)
    } catch (e) { /* skip */ }
  }
  return out
}

const targetArg = process.argv[2] || 'eng.traineddata'
const outDir = process.argv[3] || path.join(os.homedir(), 'jarv-data')
const target = path.resolve(targetArg)
fs.mkdirSync(outDir, { recursive: true })

const header = `# JARV Data Decode Report

Generated: ${new Date().toISOString()}
Target: \`${target}\`
`

const files = collectFiles(target)
const sections = [header]
let binaryCount = 0
let textCount = 0

for (const file of files.sort()) {
  const rel = path.relative(path.dirname(target), file) || path.basename(file)
  let buf
  try { buf = fs.readFileSync(file) } catch (e) { sections.push(`\n## ${rel}\n\n(unreadable: ${e.message})`); continue }
  if (buf.length > 100 * 1024 * 1024) { sections.push(`\n## ${rel}\n\nToo large (${buf.length} bytes) — skipped.`); continue }

  const isText = !isBinary(buf)
  const kind = isText ? 'text file' : detectKind(buf)
  const prof = byteProfile(buf)
  const strings = kind.startsWith('Tesseract') && isText ? [] : printableRuns(buf)
  const headHex = buf.subarray(0, 48).toString('hex')

  let md = `\n## ${rel}\n\n`
  md += `- **${isText ? 'TEXT' : 'BINARY'}** · ${buf.length.toLocaleString()} bytes · ${prof.entropy} bits/byte entropy · ${prof.distinctBytes} distinct byte values\n`
  md += `- **Detected type:** ${kind}\n`
  md += `- First bytes (hex): \`${headHex}\`\n`
  md += `- Byte mix (top 8): ${prof.topBytes}\n`

  if (kind.startsWith('Tesseract')) {
    const h = buf.subarray(0, 2048).toString('latin1')
    const ver = (h.match(/LSTM Data File Specification v[\d.]+/i) || [])[0]
    const specs = [...h.matchAll(/\[[0-9][^\]]{3,120}\]/g)].map(m => m[0])
    md += ver ? `- **Language-model header:** \`${ver}\` (Tesseract's "English" OCR brain)\n` : `- **Format:** legacy LSTM layout (no version header string; begins with its weight tables directly).\n`
    md += `- **Recognized neural-network layout specs:**\n\n${specs.map(s => `  - \`${s}\``).join('\n') || '  (none plainly visible)'}\n`
    md += `\nWhat each layer abbreviation means: "c"/"Ct" = convolution, "Mp" = max-pool, "Lfys"/"Lfx" = LSTM frame (64/96/512 cells), "Lrx" = reversed LSTM, "O" = output layer. High entropy (≥5 bits/byte) confirms the bulk is model weights, not text.\n`
  }

  if (isText) textCount++
  else {
    binaryCount++
    if (strings.length === 0) {
      md += `- **Readable strings: none found** — this is not prose or a script; it is compiled/encoded machine data (e.g. a neural network, compression stream, or binary database). There is nothing to "translate" into English; it can only be decoded by the program that writes it.\n`
    } else {
      md += `- **Readable string fragments (${strings.length}):**\n\n`
      md += strings.map(s => `  - \`${s}\``).join('\n') + '\n'
    }
  }

  sections.push(md)
}

sections.push(`\n---\n\n## Summary\n\n- ${binaryCount} binary file(s), ${textCount} text file(s) examined.\n- "White circled question marks" in a text viewer = binary bytes that are not valid UTF-8, not a secret language. Each \`�\` is one undecodable byte.\n`)

const reportName = `jarv-data-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`
const reportPath = path.join(outDir, reportName)
fs.writeFileSync(reportPath, sections.join('\n'), 'utf8')
console.log(`Report written to:\n  ${reportPath}`)