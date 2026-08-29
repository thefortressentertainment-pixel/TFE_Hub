import React, { useEffect, useRef, useState } from 'react'
import {
  Engine, Scene, ArcRotateCamera, HemisphericLight,
  MeshBuilder, StandardMaterial, Color3, Vector3, TransformNode,
  PointerEventTypes, GlowLayer,
} from '@babylonjs/core'

const R = 6
const GEO_KM = 35786
const SKIN = 0.04

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

function SanctuaryGlobe({ positions, hubLocation, onSelect }) {
  const mountRef = useRef(null)
  const [selected, setSelected] = useState(null)
  const [groups, setGroups] = useState({})
  const [ctxNotice, setCtxNotice] = useState('')

  useEffect(() => { setGroups(groupOf(positions || [])) }, [positions])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let engine, scene, globeGroup, instances = [], observerMesh = null
    let disposed = false

    try {
      engine = new Engine(mount, true, { preserveDrawingBuffer: true, stencil: true })
    } catch (e) {
      setCtxNotice('WebGL unavailable — globe disabled on this device.')
      return
    }

    scene = new Scene(engine)

    const camera = new ArcRotateCamera('cam', -Math.PI / 3, Math.PI / 2.4, 22, Vector3.Zero(), scene)
    camera.lowerRadiusLimit = 9
    camera.upperRadiusLimit = 40
    camera.attachControl(mount, true)

    const hemi = new HemisphericLight('hemi', new Vector3(0.4, 1, -0.3), scene)
    hemi.intensity = 0.5
    const back = new HemisphericLight('back', new Vector3(-0.5, -0.2, -0.8), scene)
    back.intensity = 0.3
    scene.clearColor = Color3.FromHexString('#0b1017')

    const glow = new GlowLayer('glow', scene, { mainTextureRatio: 0.5, intensity: 0.7 })
    glow.intensity = 0.8

    globeGroup = new TransformNode('globeGroup', scene)

    const globe = MeshBuilder.CreateSphere('globe', { diameter: R * 2, segments: 48 }, scene)
    const globeMat = new StandardMaterial('globeMat', scene)
    globeMat.diffuseColor = Color3.FromHexString('#0c1420')
    globeMat.emissiveColor = Color3.FromHexString('#0e1a2b')
    globeMat.specularColor = Color3.Black()
    globe.material = globeMat
    globe.parent = globeGroup

    const grid = MeshBuilder.CreateLines('grid', { points: [] }, scene)
    const gridMat = new StandardMaterial('gridMat', scene)
    gridMat.emissiveColor = Color3.FromHexString('#1d3a5f')
    grid.material = gridMat
    grid.parent = globeGroup

    // Graticule: parallels every 20°, meridians every 20°.
    const pts = []
    for (let lat = -80; lat <= 80; lat += 20) {
      const ring = []
      for (let lon = -180; lon <= 180; lon += 3) ring.push(latLonToVec(lat, ((lon + 180) % 360) - 180, R * 1.002))
      pts.push(ring)
    }
    for (let lon = -180; lon < 180; lon += 20) {
      const ring = []
      for (let lat = -90; lat <= 90; lat += 3) ring.push(latLonToVec(lat, lon, R * 1.002))
      pts.push(ring)
    }
    const lineGroups = MeshBuilder.CreateLineSystem('latlon', { lines: pts, updatable: true, instance: null }, scene)
    lineGroups.parent = globeGroup

    function makeInstanceMesh(g, color) {
      const mat = new StandardMaterial(`satMat-${g}`, scene)
      mat.emissiveColor = new Color3(color[0], color[1], color[2])
      mat.diffuseColor = Color3.Black()
      mat.specularColor = Color3.Black()
      const m = MeshBuilder.CreateSphere(`sats-${g}`, { diameter: 0.14, segments: 8 }, scene)
      m.material = mat
      m.parent = globeGroup
      m.isPickable = true
      Tag.AddTagsTo(m, 'sat')
      m.satCount = 0
      return m
    }

    const satMeshByGroup = new Map()

    function rebuildSats() {
      for (const m of satMeshByGroup.values()) { m.dispose(); }
      satMeshByGroup.clear()
      instances = []
      const byGroup = {}
      for (const p of positions || []) {
        const g = p.group || 'other'
        ;(byGroup[g] = byGroup[g] || []).push(p)
      }
      for (const [g, list] of Object.entries(byGroup)) {
        const meta = GROUP_COLORS[g] || GROUP_COLORS.other
        const mesh = makeInstanceMesh(g, meta.c)
        for (const p of list) {
          const r = R + SKIN + Math.max(0, p.alt_km || 550) / GEO_KM * (R * 0.5)
          const inst = mesh.createInstance(`i-${p.norad}-${g}`)
          inst.position.copyFrom(latLonToVec(p.lat, p.lon, r))
          instances.push({ mesh: inst, sat: p, r })
        }
        satMeshByGroup.set(g, mesh)
      }
    }
    rebuildSats()

    function rebuildObserver() {
      if (observerMesh) { observerMesh.dispose(); observerMesh = null; }
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
    rebuildObserver()

    scene.onPointerObservable.add((ev) => {
      if (ev.type !== PointerEventTypes.POINTERPICK) return
      const pick = ev.pickInfo
      if (!pick || !pick.hit) { setSelected(null); onSelect && onSelect(null); return }
      const m = pick.pickedMesh
      if (!m || !String(m.name).startsWith('i-')) { setSelected(null); onSelect && onSelect(null); return }
      // Nearest satellite to the picked point.
      const pp = pick.pickedPoint
      let best = null, bestD = Infinity
      for (const e of instances) {
        const d = Vector3.DistanceSquared(e.mesh.position, pp)
        if (d < bestD) { bestD = d; best = e.sat }
      }
      if (best) { setSelected(best); onSelect && onSelect(best) }
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

    if (engine) engine.runRenderLoop(() => scene.render())

    return () => {
      disposed = true
      ro.disconnect()
      if (engine) { engine.stopRenderLoop(); engine.dispose() }
      scene.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="sanctuary-globe">
      <div ref={mountRef} className="globe-canvas" />
      <div className="globe-overlay">
        <div className="globe-legend">
          {Object.entries(groups).filter(([, n]) => n > 0).map(([g, n]) => (
            <span key={g} className="legend-chip">
              <span className="legend-dot" style={{ background: `rgb(${(GROUP_COLORS[g] || GROUP_COLORS.other).c.map(v => Math.round(v * 255)).join(',')})` }} />
              {(GROUP_COLORS[g] || GROUP_COLORS.other).label} <em>{n}</em>
            </span>
          ))}
          {hubLocation && Number.isFinite(hubLocation.lat) && (
            <span className="legend-chip"><span className="legend-dot" style={{ background: '#9fff7a' }} />Family grid fix</span>
          )}
        </div>
        <div className="globe-count muted">
          {(positions || []).length} satellites projected · drag to spin · click a dot to inspect
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