import React, { useEffect, useRef, useState } from 'react'
import {
  Engine, Scene, ArcRotateCamera, HemisphericLight,
  MeshBuilder, StandardMaterial, Color3, Vector3, TransformNode,
  PointerEventTypes,
} from '@babylonjs/core'

const R = 6
const GEO_KM = 35786
const SKIN = 0.04

// Rendering caps per group (instanced meshes, but keep the canvas snappy on
// phones). Stride-decimated evenly so the shape of the constellation is kept.
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
  return new Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
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

function SanctuaryGlobe({ positions, hubLocation, onSelect }) {
  const mountRef = useRef(null)
  const [selected, setSelected] = useState(null)
  const [groups, setGroups] = useState({})
  const [ctxNotice, setCtxNotice] = useState('')

  useEffect(() => { setGroups(groupOf(positions || [])) }, [positions])

  const handleSelect = (p) => { setSelected(p); onSelect && onSelect(p) }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let engine, scene, globeGroup, observerMesh = null
    let instances = []
    const satMeshes = new Map()
    let disposed = false

    const rebuildSats = (positions) => {
      for (const m of satMeshes.values()) { m.dispose() }
      satMeshes.clear()
      instances = []
      const byGroup = {}
      for (const p of positions || []) {
        const g = p.group || 'other'
        ;(byGroup[g] = byGroup[g] || []).push(p)
      }
      for (const [g, list] of Object.entries(byGroup)) {
        const meta = GROUP_COLORS[g] || GROUP_COLORS.other
        const cap = MAX_SATS_PER_GROUP[g] || MAX_SATS_PER_GROUP.default
        const mat = new StandardMaterial(`satMat-${g}`, scene)
        mat.emissiveColor = new Color3(meta.c[0], meta.c[1], meta.c[2])
        mat.diffuseColor = Color3.Black()
        mat.specularColor = Color3.Black()
        const mesh = MeshBuilder.CreateSphere(`sats-${g}`, { diameter: 0.14, segments: 8 }, scene)
        mesh.material = mat
        mesh.parent = globeGroup
        mesh.isPickable = true
        for (const p of decimate(list, cap)) {
          const r = R + SKIN + Math.max(0, p.alt_km || 550) / GEO_KM * (R * 0.5)
          const inst = mesh.createInstance(`i-${p.norad}-${g}`)
          inst.position.copyFrom(latLonToVec(p.lat, p.lon, r))
          instances.push({ mesh: inst, sat: p, r })
        }
        satMeshes.set(g, mesh)
      }
    }

    const rebuildObserver = (hubLocation) => {
      if (observerMesh) { observerMesh.dispose(); observerMesh = null }
      if (!hubLocation || !Number.isFinite(hubLocation.lat) || !Number.isFinite(hubLocation.lon)) return
      const pos = latLonToVec(hubLocation.lat, hubLocation.lon, R + SKIN + 0.02)
      const pin = MeshBuilder.CreateSphere('pin', { diameter: 0.34, segments: 8 }, scene)
      const pinMat = new StandardMaterial('pinMat', scene)
      pinMat.emissiveColor = Color3.FromHexString('#9fff7a')
      pin.material = pinMat
      pin.position.copyFrom(pos)
      pin.parent = globeGroup
      observerMesh = pin
    }

    try {
      engine = new Engine(mount, true, { preserveDrawingBuffer: true, stencil: true })
    } catch (e) {
      try {
        engine = new Engine(mount, true, { stencil: true })
      } catch (e2) {
        try {
          engine = new Engine(mount, false)
        } catch (e3) {
          setCtxNotice('WebGL unavailable — globe disabled on this device (' + String(e && e.message ? e.message : e).slice(0, 120) + ').')
          return
        }
      }
    }

    scene = new Scene(engine)
    if (scene.onErrorObservable) {
      scene.onErrorObservable.add((e) => {
        if (!disposed) setCtxNotice('Globe render error: ' + (e && e.message ? e.message : String(e)))
      })
    }

    const camera = new ArcRotateCamera('cam', -Math.PI / 3, Math.PI / 2.4, 22, Vector3.Zero(), scene)
    camera.lowerRadiusLimit = 9
    camera.upperRadiusLimit = 40
    camera.attachControl(mount, true)

    const hemi = new HemisphericLight('hemi', new Vector3(0.4, 1, -0.3), scene)
    hemi.intensity = 0.6
    const back = new HemisphericLight('back', new Vector3(-0.5, -0.2, -0.8), scene)
    back.intensity = 0.35
    scene.clearColor = Color3.FromHexString('#05070d')

    globeGroup = new TransformNode('globeGroup', scene)

    // Globe body — brighter than before so it reads clearly against the void.
    const globe = MeshBuilder.CreateSphere('globe', { diameter: R * 2, segments: 48 }, scene)
    const globeMat = new StandardMaterial('globeMat', scene)
    globeMat.diffuseColor = Color3.FromHexString('#244d73')
    globeMat.emissiveColor = Color3.FromHexString('#16324e')
    globeMat.specularColor = Color3.FromHexString('#2c3e50')
    globeMat.specularPower = 32
    globe.material = globeMat
    globe.parent = globeGroup

    // Thin atmosphere rim so the limb always glows, even with zero satellites.
    const atmo = MeshBuilder.CreateSphere('atmo', { diameter: R * 2.18, segments: 48 }, scene)
    const atmoMat = new StandardMaterial('atmoMat', scene)
    atmoMat.emissiveColor = Color3.FromHexString('#3d7bd6')
    atmoMat.alpha = 0.12
    atmoMat.backFaceCulling = false
    atmoMat.disableLighting = true
    atmoMat.freeze()
    atmo.material = atmoMat
    atmo.parent = globeGroup

    // (Starfield omitted — PointsCloudSystem position semantics differ across
    // Babylon versions and a throw here unmounts the whole React tree. The
    // globe + satellites are the critical content; void behind them is fine.)

    // Graticule + brighter meridian grid.
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
    const lineGroups = MeshBuilder.CreateLineSystem('latlon', { lines: pts }, scene)
    const gridMat = new StandardMaterial('gridMat', scene)
    gridMat.emissiveColor = Color3.FromHexString('#2c6aa8')
    gridMat.disableLighting = true
    lineGroups.material = gridMat
    lineGroups.parent = globeGroup

    // Equator ring, brighter still — the "wire" anchor.
    const eqPts = []
    for (let lon = -180; lon <= 180; lon += 1) eqPts.push(latLonToVec(0, lon, R * 1.012))
    const eq = MeshBuilder.CreateLines('equator', { points: eqPts }, scene)
    const eqMat = new StandardMaterial('eqMat', scene)
    eqMat.emissiveColor = Color3.FromHexString('#54c8ff')
    eqMat.disableLighting = true
    eq.material = eqMat
    eq.parent = globeGroup

    rebuildSats(positions)
    rebuildObserver(hubLocation)

    scene.onPointerObservable.add((ev) => {
      if (ev.type !== PointerEventTypes.POINTERPICK) return
      const pick = ev.pickInfo
      if (!pick || !pick.hit) { setSelected(null); onSelect && onSelect(null); return }
      const m = pick.pickedMesh
      if (!m || !String(m.name).startsWith('i-')) { setSelected(null); onSelect && onSelect(null); return }
      const pp = pick.pickedPoint
      let best = null, bestD = Infinity
      for (const e of instances) {
        const d = Vector3.DistanceSquared(e.mesh.position, pp)
        if (d < bestD) { bestD = d; best = e.sat }
      }
      if (best) handleSelect(best)
    })

    const pointerState = { down: false }
    scene.onPointerObservable.add((ev) => {
      if (ev.type === PointerEventTypes.POINTERDOWN) pointerState.down = true
      if (ev.type === PointerEventTypes.POINTERUP || ev.type === PointerEventTypes.POINTEROUT) pointerState.down = false
    })

    const fps = (f) => {
      if (disposed) return
      if (!pointerState.down) globeGroup.rotation.y += f.elapsedTime * 0.0035
    }
    scene.onBeforeRenderObservable.add(fps)

    const ro = new ResizeObserver(() => { if (engine) engine.resize() })
    ro.observe(mount)
    if (engine) {
      engine.runRenderLoop(() => { if (scene && !disposed) scene.render() })
    }

    if (import.meta.env.DEV && window.__GLOBE_DIAG) {
      const diag = () => {
        if (disposed) return
        try {
          const meshes = scene.meshes.length
          const vis = scene.meshes.filter((m) => m.isEnabled() && m.isVisible && m.material).length
          const camR = camera.radius.toFixed(1)
          const cv = mount
          const img = new Image()
          img.onload = () => {
            const sc = document.createElement('canvas'); sc.width = img.width; sc.height = img.height
            const ctx = sc.getContext('2d'); if (!ctx) return
            ctx.drawImage(img, 0, 0)
            const px = ctx.getImageData(0, 0, sc.width, sc.height).data
            let lit = 0; const n = px.length / 4
            for (let p = 0; p < px.length; p += 4) { const l = 0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]; if (l > 24) lit++ }
            const msg = 'diag: cw=' + cv.clientWidth + ' ch=' + cv.clientHeight + ' attr=' + cv.width + 'x' + cv.height +
              ' camR=' + camR + ' meshes=' + meshes + ' vis=' + vis + ' lit=' + (100 * lit / n).toFixed(2) + '%'
            window.__globeDiag = msg; if (window.__globeLog) window.__globeLog(msg)
          }
          img.src = cv.toDataURL('image/png')
        } catch (e) { if (window.__globeLog) window.__globeLog('diag err ' + e.message) }
      }
      window.__globeStopDiag = diag
      window.__globeDiagTimer = setInterval(diag, 400)
    }

    architectureRef.current.rebuildSats = rebuildSats
    architectureRef.current.rebuildObserver = rebuildObserver

    return () => {
      disposed = true
      ro.disconnect()
      if (engine) { engine.stopRenderLoop(); engine.dispose() }
      if (scene) scene.dispose()
      architectureRef.current.rebuildSats = null
      architectureRef.current.rebuildObserver = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Rebuild when fresh data arrives (initial mount or the 60s globe poll).
  const architectureRef = useRef({ rebuildSats: null, rebuildObserver: null })
  const lastSig = useRef('')
  useEffect(() => {
    const sig = (positions || []).length + '|' + (hubLocation ? `${hubLocation.lat},${hubLocation.lon}` : 'none')
    if (sig === lastSig.current) return
    lastSig.current = sig
    if (architectureRef.current.rebuildSats) architectureRef.current.rebuildSats(positions)
    if (architectureRef.current.rebuildObserver) architectureRef.current.rebuildObserver(hubLocation)
  }, [positions, hubLocation])

  return (
    <div className="sanctuary-globe">
      <canvas ref={mountRef} className="globe-canvas" />
      <div className="globe-overlay">
        {!ctxNotice && (positions || []).length === 0 && (
          <div className="globe-empty" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', color: 'var(--text-3)', fontSize: 13, pointerEvents: 'none' }}>
            <div style={{ marginBottom: 6 }}>Awaiting satellite projection…</div>
            <div className="muted">CelesTrak feeds stream into OrbitDeck; constellations fill this wire as they report.</div>
          </div>
        )}
        <div className="globe-legend">
          {Object.entries(groups).sort((a, b) => b[1] - a[1]).filter(([, n]) => n > 0).map(([g, n]) => (
            <span key={g} className="legend-chip">
              <span className="legend-dot" style={{ background: `rgb(${(GROUP_COLORS[g] || GROUP_COLORS.other).c.map(v => Math.round(v * 255)).join(',')})` }} />
              {(GROUP_COLORS[g] || GROUP_COLORS.other).label} <em>{n.toLocaleString()}</em>
            </span>
          ))}
          {hubLocation && Number.isFinite(hubLocation.lat) && (
            <span className="legend-chip"><span className="legend-dot" style={{ background: '#9fff7a' }} />Family grid fix</span>
          )}
        </div>
        <div className="globe-count muted">
          {(positions || []).length.toLocaleString()} satellites projected · drag to spin · click a dot to inspect
        </div>
        {ctxNotice && <div className="status-box" style={{ marginTop: 8, fontSize: 12 }}>{ctxNotice}</div>}
        {selected && (
          <div className="globe-card">
            <button className="btn-sm" style={{ float: 'right' }} onClick={() => setSelected(null)}>✕</button>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{selected.satellite}</div>
            <div className="row"><span className="k">NORAD</span><span className="v">#{selected.norad}</span></div>
            <div className="row"><span className="k">Group</span><span className="v">{(GROUP_COLORS[selected.group] || {}).label || selected.group}</span></div>
            <div className="row"><span className="k">Subpoint</span><span className="v">{selected.lat}°, {selected.lon}°</span></div>
            <div className="row"><span className="k">Alt</span><span className="v">{selected.alt_km} km</span></div>
          </div>
        )}
      </div>
    </div>
  )
}

export default SanctuaryGlobe