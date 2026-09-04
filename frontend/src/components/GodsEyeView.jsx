import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const R = 6
const GEO_KM = 35786
const SKIN = 0.04

const MAX_SATS_PER_GROUP = { starlink: 2200, oneweb: 500, geo: 400, other: 700, default: 800 }

const GROUP_COLORS = {
  starlink: { c: [0.62, 0.78, 1.0], label: 'Starlink' },
  oneweb: { c: [0.35, 0.65, 1.0], label: 'OneWeb' },
  iridium: { c: [1.0, 0.72, 0.35], label: 'Iridium' },
  'iridium-next': { c: [1.0, 0.72, 0.35], label: 'Iridium N' },
  gps: { c: [0.5, 1.0, 0.6], label: 'GPS' },
  galileo: { c: [0.95, 0.55, 0.9], label: 'Galileo' },
  glonass: { c: [1.0, 0.5, 0.5], label: 'GLONASS' },
  beidou: { c: [0.9, 0.85, 0.4], label: 'BeiDou' },
  geo: { c: [0.9, 0.85, 0.4], label: 'GEO' },
  iss: { c: [1.0, 1.0, 1.0], label: 'ISS' },
  other: { c: [0.8, 0.85, 1.0], label: 'Other' },
}

function latLonToVec(lat, lon, r) {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lon + 180) * Math.PI) / 180
  return new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
}

function groupOf(positions) {
  const counts = {}
  for (const p of positions) counts[p.group || 'other'] = (counts[p.group || 'other'] || 0) + 1
  return counts
}

function decimate(list, cap) {
  if (list.length <= cap) return list
  const step = Math.ceil(list.length / cap)
  return list.filter((_, i) => i % step === 0)
}

// Procedural equirectangular Earth — an always-available fallback when no
// texture file can be fetched. Uses a coarse land grid so continents read
// clearly (roughly shaped, not navigational grade).
const EARTH_LAND_GRID = [
  '....###..####...##...####......#....####..........##....##.##........####..###..##.....###..',
  '..######..###...####...###...##..#..#...#......##...####...##.##...#..####..###..###....##..',
  '.######....##..#####...###...#.####.#.###.......##..#####...##.##.#...#..#..###..####...##..',
  '.######.....#.######...###..#.####..####.#########..#####...###..####...##...###.##.##..##..',
  '.#####......##.#####..#.###########.#########...##.##..##...###.######...#########.####.###.',
  '.###...............####..#######.####..##.......##....#......#########.##..#..####...####...',
  '.##..................#.....##.##.#.##...#.........#....#.....####.......###.#.#.##....##....',
  '##..................................##.#..#......................####...##.#..##..............',
  '##......###......................#...##.................#....#.....##......................###',
  '........##.............#####......###......###..........#..#.....#..................#######',
  '...............##.....#######....####.#..########..##.....#......##..................#######',
  '....#####....####..###########..#####..###########..###.##......##.....................####',
  '.##..#####..######.#############.######..######..########......#............................',
  '.###..#####.######.#######..##..###...##........#......##.#....................................',
  '..###..####.##.....##............##......................#..#...................................',
  '.....#..###....................................##.......................................###....',
  '.......##.........................................##....................................####...',
  '.................................................##.........................................##...',
  '.........................................................#......................................',
  '........#.................................................##.............................#........',
  '............................................................................................#...',
  '.......................................................##.............................####..#..',
  '..........#..#.........................................###..........................#########...',
  '.......######.#......#..........................#####..##.###......................##########.',
  '...##########..####..................................####.#..###.......#.#.#...##############',
  '...###########.#######.................................###..........##..##.##.###..####.#####.',
  '....##########..#######....###........................##................###..##.....#....###..',
  '....###########..#####....###...####.............##....##..............###..#.....##.........',
  '....############..........####..########.#.......##########..##.....######..##........##......',
  '...#############...........###..#########...##..###########.#############.....................',
  '...##############...........##....######...###..###########.##......###..###..................',
  '..############................................##################....###..###.##...............',
  '..############................................####################..........###...###.........',
  '......................##...................########################......####..####........##',
  '......................###........####......###########.##....#####......####...####..##...###',
  '......................##....#..######.......######..........#####.......###....####..###...##',
  '.....................##....##..######........###..............###.......####............#..##',
  '............................##..####.###.......#..............##.....##..###..................',
]

function makeProceduralEarth() {
  const w = 1024
  const h = 512
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const ocean = ctx.createLinearGradient(0, 0, 0, h)
  ocean.addColorStop(0, '#0e2f52')
  ocean.addColorStop(0.5, '#0a1f3a')
  ocean.addColorStop(1, '#0b2547')
  ctx.fillStyle = ocean
  ctx.fillRect(0, 0, w, h)
  const rows = EARTH_LAND_GRID.length
  const cols = 68
  for (let r = 0; r < rows; r++) {
    const row = EARTH_LAND_GRID[r]
    for (let c = 0; c < cols; c++) {
      if (row[c] === '#') {
        const x = (c / cols) * w
        const y = (r / rows) * h
        ctx.fillStyle = r < 4 ? '#d8e6f2' : '#2f6b38'
        ctx.fillRect(x, y, w / cols + 0.5, h / rows + 0.5)
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    const row = EARTH_LAND_GRID[r]
    for (let c = 0; c < cols; c++) {
      if (row[c] === '#') {
        const x = (c / cols) * w
        const y = (r / rows) * h
        ctx.fillStyle = 'rgba(120,170,120,0.35)'
        ctx.fillRect(x - w / cols * 0.3, y - h / rows * 0.3, w / cols * 0.6, h / rows * 0.6)
        ctx.fillStyle = r < 4 ? 'rgba(255,255,255,0.4)' : 'rgba(60,90,40,0.4)'
        ctx.fillRect(x + w / cols * 0.15, y + h / rows * 0.15, w / cols * 0.25, h / rows * 0.25)
      }
    }
  }
  return canvas
}

function GodsEyeView({ positions, hubLocation, onSelect, theme }) {
  const mountRef = useRef(null)
  const [selected, setSelected] = useState(null)
  const [groups, setGroups] = useState({})
  const [ctxNotice, setCtxNotice] = useState('')

  // The mount effect builds the static scene once and hands a "rebuild"
  // function up through this ref. The data effect calls it whenever the
  // satellite feed / family fix changes. This mirrors the proven SanctuaryGlobe
  // architecture and keeps live data from getting lost in a one-shot effect.
  const apiRef = useRef({ rebuild: null, select: null })

  useEffect(() => { setGroups(groupOf(positions || [])) }, [positions])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false
    let animationFrame = null
    let controls = null
    const satMeshes = []
    let observerMesh = null
    let globeGroup = null

    const doSelect = (p) => { setSelected(p); onSelect && onSelect(p) }
    apiRef.current.select = doSelect

    const clearSats = () => {
      for (const m of satMeshes) {
        if (m.parent) m.parent.remove(m)
        m.geometry.dispose()
        m.material.dispose()
      }
      satMeshes.length = 0
    }

    const rebuild = (positions, hubLocation) => {
      if (!globeGroup) return
      clearSats()
      const byGroup = {}
      for (const p of positions || []) {
        const g = p.group || 'other'
        ;(byGroup[g] = byGroup[g] || []).push(p)
      }
      for (const [g, list] of Object.entries(byGroup)) {
        const meta = GROUP_COLORS[g] || GROUP_COLORS.other
        const cap = MAX_SATS_PER_GROUP[g] || MAX_SATS_PER_GROUP.default
        const color = new THREE.Color(meta.c[0], meta.c[1], meta.c[2])
        for (const p of decimate(list, cap)) {
          const r = R + SKIN + Math.max(0, p.alt_km || 550) / GEO_KM * (R * 0.5)
          const pos = latLonToVec(p.lat, p.lon, r)
          const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.09, 8, 8),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
          )
          mesh.position.copy(pos)
          mesh.userData.sat = p
          globeGroup.add(mesh)
          satMeshes.push(mesh)
        }
      }
      if (observerMesh) { globeGroup.remove(observerMesh); observerMesh.geometry.dispose(); observerMesh.material.dispose(); observerMesh = null }
      if (hubLocation && Number.isFinite(hubLocation.lat) && Number.isFinite(hubLocation.lon)) {
        const pinPos = latLonToVec(hubLocation.lat, hubLocation.lon, R + SKIN + 0.02)
        const pin = new THREE.Mesh(
          new THREE.SphereGeometry(0.17, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0x9fff7a, transparent: true, opacity: 0.95 })
        )
        pin.position.copy(pinPos)
        globeGroup.add(pin)
        observerMesh = pin
      }
    }
    apiRef.current.rebuild = rebuild

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas: mount, antialias: true, alpha: true, preserveDrawingBuffer: true })
    } catch (e) {
      setCtxNotice('WebGL unavailable — globe disabled on this device (' + String(e && e.message ? e.message : e).slice(0, 120) + ').')
      return
    }
    const w = Math.max(mount.clientWidth, 1)
    const h = Math.max(mount.clientHeight, 1)
    renderer.setSize(w, h, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(theme === 'dark' ? 0x05070d : 0x0a1018)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 200)
    camera.position.set(0, 0, 15)

    controls = new OrbitControls(camera, mount)
    controls.enableDamping = true
    controls.dampingFactor = 0.05
    controls.minDistance = 7.5
    controls.maxDistance = 40
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.5

    const hemi = new THREE.HemisphereLight(0x4488cc, 0x112233, 0.6)
    scene.add(hemi)

    globeGroup = new THREE.Group()
    scene.add(globeGroup)

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 64),
      new THREE.MeshStandardMaterial({ color: 0x244d73, roughness: 0.85, metalness: 0.05 })
    )
    globeGroup.add(globe)

    const texLoader = new THREE.TextureLoader()
    const isDark = theme === 'dark'
    texLoader.crossOrigin = 'Anonymous'
    const earthTexUrls = [
      isDark ? '/assets/earth-dark.jpg' : '/assets/earth-blue-marble.jpg',
      isDark ? 'https://unpkg.com/three-globe/example/img/earth-dark.jpg' : 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg',
    ]
    let texIdx = 0
    const applyTexture = (source) => {
      if (disposed || !globe.material) return
      if (source === 'canvas') {
        globe.material.map = new THREE.CanvasTexture(makeProceduralEarth())
        globe.material.color.setHex(0xffffff)
        globe.material.needsUpdate = true
        return
      }
      const tex = source
      tex.colorSpace = THREE.SRGBColorSpace
      globe.material.map = tex
      globe.material.color.setHex(0xffffff)
      globe.material.needsUpdate = true
    }
    const tryNextTexture = () => {
      if (disposed || texIdx >= earthTexUrls.length) { applyTexture('canvas'); return }
      texLoader.load(
        earthTexUrls[texIdx],
        applyTexture,
        undefined,
        () => { texIdx += 1; setTimeout(tryNextTexture, 0) }
      )
    }
    tryNextTexture()

    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.06, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x3d7bd6, transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false })
    )
    globeGroup.add(atmo)

    const gridMat = new THREE.LineBasicMaterial({ color: 0xbfd9f7, transparent: true, opacity: 0.28 })
    const pts = []
    for (let lat = -80; lat <= 80; lat += 20) {
      const ring = []
      for (let lon = -180; lon <= 180; lon += 3) ring.push(latLonToVec(lat, ((lon + 180) % 360) - 180, R * 1.004))
      pts.push(ring)
    }
    for (let lon = -180; lon < 180; lon += 20) {
      const ring = []
      for (let lat = -90; lat <= 90; lat += 3) ring.push(latLonToVec(lat, lon, R * 1.004))
      pts.push(ring)
    }
    for (const ring of pts) {
      const geometry = new THREE.BufferGeometry().setFromPoints(ring)
      globeGroup.add(new THREE.Line(geometry, gridMat))
    }

    const eqPts = []
    for (let lon = -180; lon <= 180; lon += 1) eqPts.push(latLonToVec(0, lon, R * 1.012))
    const eqGeometry = new THREE.BufferGeometry().setFromPoints(eqPts)
    globeGroup.add(new THREE.Line(eqGeometry, new THREE.LineBasicMaterial({ color: 0x54c8ff, transparent: true, opacity: 0.6 })))

    rebuild(positions, hubLocation)

    const raycaster = new THREE.Raycaster()
    const mouse = new THREE.Vector2()
    const onPointerPick = (ev) => {
      const rect = mount.getBoundingClientRect()
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(mouse, camera)
      const intersects = raycaster.intersectObjects(satMeshes, false)
      if (intersects.length > 0) {
        doSelect(intersects[0].object.userData.sat)
      } else {
        setSelected(null)
        onSelect && onSelect(null)
      }
    }
    mount.addEventListener('click', onPointerPick)

    const animate = () => {
      if (disposed) return
      animationFrame = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const ro = new ResizeObserver(() => {
      const cw = Math.max(mount.clientWidth, 1)
      const ch = Math.max(mount.clientHeight, 1)
      camera.aspect = cw / ch
      camera.updateProjectionMatrix()
      renderer.setSize(cw, ch, false)
    })
    ro.observe(mount)

    return () => {
      disposed = true
      ro.disconnect()
      mount.removeEventListener('click', onPointerPick)
      if (animationFrame) cancelAnimationFrame(animationFrame)
      if (controls) controls.dispose()
      if (renderer) renderer.dispose()
      if (scene) scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && !Array.isArray(o.material)) o.material.dispose() })
      apiRef.current.rebuild = null
      apiRef.current.select = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lastSig = useRef('')
  useEffect(() => {
    const sig = (positions || []).length + '|' + (hubLocation ? `${hubLocation.lat},${hubLocation.lon}` : 'none')
    if (sig === lastSig.current) return
    lastSig.current = sig
    if (apiRef.current.rebuild) apiRef.current.rebuild(positions, hubLocation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, hubLocation])

  return (
    <div className="sanctuary-globe" style={{ position: 'relative', width: '100%', height: '440px', minHeight: '320px' }}>
      <canvas ref={mountRef} className="globe-canvas" style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />
      <div className="globe-overlay" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
        {!ctxNotice && (positions || []).length === 0 && (
          <div className="globe-empty" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', color: 'var(--text-3)', fontSize: 13, pointerEvents: 'none' }}>
            <div style={{ marginBottom: 6 }}>Awaiting satellite projection…</div>
            <div className="muted">CelesTrak feeds stream into OrbitDeck; constellations fill this wire as they report.</div>
          </div>
        )}
        <div className="globe-legend" style={{ position: 'absolute', top: 10, left: 12, display: 'flex', flexWrap: 'wrap', gap: '8px 12px', maxWidth: '80%' }}>
          {Object.entries(groups).sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 0).map(([g, n]) => (
            <span key={g} className="legend-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-2)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: '3px 9px' }}>
              <span className="legend-dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: `rgb(${(GROUP_COLORS[g] || GROUP_COLORS.other).c.map(v => Math.round(v * 255)).join(',')})` }} />
              {(GROUP_COLORS[g] || GROUP_COLORS.other).label} <em style={{ fontStyle: 'normal', color: 'var(--text-3)' }}>{n.toLocaleString()}</em>
            </span>
          ))}
          {hubLocation && Number.isFinite(hubLocation.lat) && (
            <span className="legend-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-2)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: '3px 9px' }}>
              <span className="legend-dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: '#9fff7a' }} />
              Family grid fix
            </span>
          )}
        </div>
        <div className="globe-count muted" style={{ position: 'absolute', bottom: 10, left: 12, fontSize: 11 }}>
          {(positions || []).length.toLocaleString()} satellites projected · drag to spin · click a dot to inspect
        </div>
        {ctxNotice && <div className="status-box" style={{ marginTop: 8, fontSize: 12 }}>{ctxNotice}</div>}
        {selected && (
          <div className="globe-card" style={{ position: 'absolute', right: 12, bottom: 10, width: 230, background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: 12, boxShadow: 'var(--shadow-md)', fontSize: 12, pointerEvents: 'auto' }}>
            <button className="btn-sm" style={{ float: 'right', border: 'none', background: 'var(--surface-2)', color: 'var(--text-2)', padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11 }} onClick={() => setSelected(null)}>✕</button>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{selected.satellite}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span style={{ color: 'var(--text-3)' }}>NORAD</span><span style={{ fontWeight: 700 }}>#{selected.norad}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span style={{ color: 'var(--text-3)' }}>Group</span><span style={{ fontWeight: 700 }}>{(GROUP_COLORS[selected.group] || {}).label || selected.group}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span style={{ color: 'var(--text-3)' }}>Subpoint</span><span style={{ fontWeight: 700 }}>{selected.lat}°, {selected.lon}°</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}><span style={{ color: 'var(--text-3)' }}>Alt</span><span style={{ fontWeight: 700 }}>{selected.alt_km} km</span></div>
          </div>
        )}
      </div>
    </div>
  )
}

export default GodsEyeView