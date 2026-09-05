#!/usr/bin/env node
// jarv-drive — JARV's hands on the operator's Mac: see the screen (screenshot +
// Vision OCR with point coordinates), then click / right-click / drag / scroll /
// type / press keys / activate apps, all through two tiny Swift drivers.
//
// Subcommands:
//   status                       → axTrusted, main display size, frontmost app
//   snap [file]                  → full-screen PNG of the main display (default /tmp/jarv-screen.png)
//   see  [file]                  → snap + OCR digest on stdout (numbered, x,y,w,h in POINTS)
//   front                        → frontmost app name
//   apps                         → all running app names
//   activate <name>              → bring that app to front (no permission needed)
//   click <x> <y> | right <x> <y> · <x>,<y> = POINTS, origin top-left of main display
//   move <x> <y>
//   drag <x1> <y1> <x2> <y2>     → press-drag-release
//   scroll <dx> <dy>             → scroll wheel (small ints; dy<0 scrolls down)
//   type <text>                  → type text into the focused field
//   key <combo>                  → e.g. key cmd-tab · key ctrl-c · key enter · key cmd-shift-g
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(HERE, 'bin')
const CG = path.join(BIN, 'jarv-drive-cg')
const OCR = path.join(BIN, 'jarv-drive-ocr')

function run(bin, args, opts = {}) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...opts })
  } catch (e) {
    return String((e.stdout || '') + (e.stderr || e.message || e)).trim()
  }
}

function mainScreen() {
  try { return JSON.parse(run(CG, ['status'])).screens[0] } catch { return null }
}

function snap(file) {
  const out = file || '/tmp/jarv-screen.png'
  run('screencapture', ['-x', '-m', out])
  return out
}

function digestOf(j) {
  const head = `<SCREEN ${j.ptW}x${j.ptH}pt @scale${j.scale} | OCR lines: ${j.lines ? j.lines.length : 0}>`
  const rows = (j.lines || []).slice(0, 48).map((l, i) => `[${i}] "${l.t}" @ ${l.px},${l.py} ${l.pw}x${l.ph}`)
  return [head, ...rows].join('\n')
}

const [cmd, ...rest] = process.argv.slice(2)

switch (cmd) {
  case 'status': {
    const s = JSON.parse(run(CG, ['status']))
    console.log(`axTrusted:${s.axTrusted}  main:${s.screens[0] ? `${s.screens[0].ptW}x${s.screens[0].ptH}pt @${s.screens[0].scale}x` : 'none'}  frontmost:${s.frontmost}`)
    break
  }
  case 'snap': {
    const f = snap(rest[0])
    console.log(`saved ${f}`)
    break
  }
  case 'see': {
    const f = snap(rest[0])
    const raw = run(OCR, [f], { timeout: 30000 }).trim()
    if (!raw.startsWith('{')) { console.log('ERR ocr: ' + raw.slice(0, 120)); break }
    const json = f + '.json'
    writeFileSync(json, raw)
    console.log(digestOf(JSON.parse(raw)))
    break
  }
  case 'see-current': {
    const f = '/tmp/jarv-screen.png'
    if (!existsSync(f)) { console.log('no snapshot yet — run: jarv-drive see'); break }
    const raw = run(OCR, [f], { timeout: 30000 }).trim()
    if (!raw.startsWith('{')) { console.log('ERR ocr: ' + raw.slice(0, 120)); break }
    console.log(digestOf(JSON.parse(raw)))
    break
  }
  case 'front': console.log(run(CG, ['front']).trim() || 'none'); break
  case 'apps': console.log(run(CG, ['apps']).trim()); break
  case 'activate': console.log(run(CG, ['activate', ...rest]).trim()); break
  case 'click':
  case 'right':
  case 'move':
    guardCoords(rest[0], rest[1]); console.log(run(CG, [cmd, rest[0], rest[1]]).trim()); break
  case 'drag':
    rest.slice(0, 4).forEach((v, i) => guardCoords(v, v, i)); console.log(run(CG, ['drag', ...rest.slice(0, 4)]).trim()); break
  case 'scroll':
    if (rest.length < 2 || !/^-?\d+$/.test(rest[0]) || !/^-?\d+$/.test(rest[1])) { console.log('ERR scroll needs two integers like "scroll 0 -6"'); break }
    console.log(run(CG, ['scroll', rest[0], rest[1]]).trim()); break
  case 'type': {
    const text = rest.join(' ')
    if (text.length > 2000) { console.log('ERR type text capped at 2000 chars'); break }
    console.log(run(CG, ['type', text]).trim()); break
  }
  case 'key': {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(rest[0] || '')) { console.log(`ERR bad combo "${rest[0]}" (use e.g. cmd-shift-g, enter, ctrl-c)`); break }
    console.log(run(CG, ['key', rest[0]]).trim()); break
  }
  default:
    console.log('usage: jarv-drive status|snap [file]|see [file]|front|apps|activate <name>|click <x> <y>|right <x> <y>|move <x> <y>|drag <x1> <y1> <x2> <y2>|scroll <dx> <dy>|type <text>|key <combo>')
}

function guardCoords(x, y, _i) {
  if (!/^-?\d+$/.test(String(x)) || !/^-?\d+$/.test(String(y))) {
    console.log(`ERR bad coord ${x},${y} (integers in points)`); process.exit(1)
  }
  const s = mainScreen()
  if (s) {
    const bx = Number(x), by = Number(y)
    if (bx < 0 || bx > s.ptW || by < 0 || by > s.ptH) {
      console.log(`ERR coord ${bx},${by} outside main screen ${s.ptW}x${s.ptH}`); process.exit(1)
    }
  }
}