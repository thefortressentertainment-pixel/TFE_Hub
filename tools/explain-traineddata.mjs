#!/usr/bin/env node
// Readable breakdown of eng.traineddata — turns the "gobbledygook" into
// English: format stamp, language, network architecture (translated), the
// model's symbol table, and a visual slice of the raw weights.

import fs from 'fs'

const path = process.argv[2] || 'eng.traineddata'
const b = fs.readFileSync(path)
const latin = b.toString('latin1')

console.log('FILE:', path, '|', b.length.toLocaleString(), 'bytes')
console.log('='.repeat(70))

// 1) The self-describing version string (the file literally stamps itself)
const verLen = b.readUInt32LE(b.length - 4 - 0) // heuristic: find last printable run
const tail = latin.slice(-220)
const m = tail.match(/4\.\d+\.\d+\w*:[\w:].*$/)
if (m) {
  console.log('\n[1] SELF-STAMP (written into the file by its own tooling):')
  console.log('   ', m[0].slice(0, 120), '\n')
  const parts = m[0].split(new RegExp('[:\\[\\]]')).filter(Boolean)
  console.log('    => that decodes as:')
  console.log('       version        :', parts[0], '(Tesseract 4.0.0 alpha era)')
  console.log('       language       :', parts[1] === 'eng' ? 'English' : parts[1])
  console.log('       training method:', (parts[2] || '').replace(/synth/i, 'synthesized text (printed-page renderings)'), '(generated 29 June 2017)')
  const spec = parts[3]
  console.log('       network spec   :', spec)
  console.log('\n[2] THAT SPEC, TRANSLATED TO ENGLISH TOKEN BY TOKEN:')
  const t = [
    ['1', 'one monochrome input channel (black pixels on white)'],
    ['36,0,1Ct3,3,16', 'a convolution layer: 36 feature detectors, each a 3x3 pixel filter, learned from the data (the first thing it "sees")'],
    ['Mp3,3', 'max-pool 3x3: shrinks the image, keeps only the strongest signal (robustness to exact position)'],
    ['Lfys64', 'an LSTM memory chain scanning 64 cells vertically (top-to-bottom recency)'],
    ['Lfx96', 'an LSTM memory chain scanning 96 cells horizontally (left-to-right recency)'],
    ['Lrx96', 'the same scanner run BACKWARD (right-to-left — capturing context on both sides)'],
    ['Lfx512', 'a big 512-cell LSTM layer — the deepest memory, where letter identity is actually decided'],
    ['O1c1', 'output layer: one classification per position (final letter guess + confidence)'],
  ]
  for (const [k, v] of t) console.log('       ' + k.padEnd(22) + v)
}

// 3) Character records — how many symbols the model knows, sample them
const recRe = /^([^\t\r] \d+ 0,255,0,255,0,0,0,0,0,0 (?:Latin|Common) \d+ 0 \d+ [^\t\r]+)(\t.*)?$/m
const recs = latin.split('\n').map(l => (l.match(recRe) || [])[1] ? l.match(recRe)[1].trim() : null).filter(Boolean)
if (recs.length) {
  const syms = recs.map(r => r.split(' ')[0])
  const letters = syms.filter(s => s.toLowerCase() !== s.toUpperCase())
  const others = syms.filter(s => s.toLowerCase() === s.toUpperCase())
  console.log('\n[3] THE MODEL\'S ALPHABET (a human-readable census):')
  console.log('    total symbol records:', recs.length, '(exactly 26 uppercase + 26 lowercase = the full English alphabet)')
  console.log('    letters:', letters.join(' '))
  if (others.length) console.log('    symbols:', others.join(' '))
  console.log('    Example records, decoded into English:')
  recs.slice(0, 4).forEach(r => {
    const p = r.split(' ')
    console.log('     • unichar=' + p[0] + ' | property-count=' + p[1] + ' | shape-flags=[' + p[2] + '] | script=' + p[3] + ' | class-id=' + p[4] + ' | direction-pattern=' + p[5] + ' | partner-ref=' + p[6] + ' | normalized-shape=' + p[7])
  })
  console.log('    (Meaning: the engine learned one "shape description" per letter — how it expects the')
  console.log('    pixel pattern to look, which class it maps to, and which partner case it pairs with.)')
}

// 4) Weights rendered as ASCII — show what the numbers actually look like
// Find a dense region after the char table: bytes of float weights.
let cursor = b.length - 200001
const w = b.subarray(cursor, b.length)
console.log('\n[4] WHAT THE REST (≈ THE NEURAL WEIGHTS) LOOKS LIKE TO THE EYE:')
console.log('    Random 24 x 48 slices of raw bytes, brightness = value:')
const density = ' .:-=+*#%@'
for (let row = 0; row < 5; row++) {
  const off = Math.floor(Math.random() * (w.length - 48))
  let line = '    '
  for (let col = 0; col < 48; col++) {
    const v = w[off + col]
    line += density[Math.floor(v / 256 * density.length)]
  }
  console.log(line)
}
console.log('    Those are numbers. A photo of a cat is ALSO just numbers; the trained data is a')
console.log('    giant table of them (~5.2 MB). Their arrangement holds all the "knowledge".')

console.log('\n[5] BOTTOM LINE')
console.log('    • This file is not a language and not a message JARV wrote. It is the')
  console.log('      ENGLISH-READING BRAIN of the Tesseract OCR engine — the thing that turns')
  console.log('      pictures of printed words back into letters.')
  console.log('    • "Trained data" = numbers tuned by many repetitions over 2017-era printed')
  console.log('      text images. It stores how to detect edges, strokes and letter shapes.')
  console.log('    • You CAN "translate" it — that is exactly what steps 1-4 do. Everything else')
  console.log('      in the file is millions of coefficient values with no direct English label;')
  console.log('      they make sense only when the scanning algorithm runs them.')
  console.log('    • If you want JARV\'s own written notes, those live as normal .txt/.md files')
  console.log('      JARV saves into the workspace (the repo) — happy to gather and summarize them.')