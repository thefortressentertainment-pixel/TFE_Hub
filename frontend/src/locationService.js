import { Capacitor, registerPlugin } from '@capacitor/core'

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation')

let nativePlugin = null
let watcherId = null
let fallbackWatchId = null
let currentHandler = null
let lastPos = null
let milesAccum = 0

function haversineMiles(a, b) {
  if (!a || !b) return 0
  const R = 3958.8
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function isNative() {
  return Capacitor.isNativePlatform()
}

export function loadNativePlugin() {
  if (nativePlugin) return nativePlugin
  if (!Capacitor.isNativePlatform()) return null
  nativePlugin = BackgroundGeolocation
  return nativePlugin
}

export async function requestPermission() {
  if (Capacitor.isNativePlatform()) {
    const plugin = loadNativePlugin()
    if (plugin) return true
  }
  if (navigator.geolocation) {
    try {
      await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 }))
      return true
    } catch (e) {
      return false
    }
  }
  return false
}

export async function startTracking(onUpdate, onError) {
  currentHandler = onUpdate
  lastPos = null
  milesAccum = 0

  if (Capacitor.isNativePlatform()) {
    const plugin = loadNativePlugin()
    if (plugin) {
      watcherId = await plugin.addWatcher(
        { requestPermissions: true, stale: false, backgroundMessage: 'Fortress Hub is tracking your shift miles', backgroundTitle: 'Shift in progress', distanceFilter: 10 },
        (position, error) => {
          if (error) return onError && onError(error)
          if (!position || position.latitude === undefined) return
          const coords = { lat: position.latitude, lng: position.longitude }
          if (lastPos) {
            const d = haversineMiles(lastPos, coords)
            if (d > 0.005) milesAccum += d
          }
          lastPos = coords
          onUpdate && onUpdate({ miles: milesAccum, coords })
        }
      )
      return true
    }
  }

  if (navigator.geolocation) {
    fallbackWatchId = navigator.geolocation.watchPosition(
      pos => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        if (lastPos) {
          const d = haversineMiles(lastPos, coords)
          if (d > 0.005) milesAccum += d
        }
        lastPos = coords
        onUpdate && onUpdate({ miles: milesAccum, coords })
      },
      err => onError && onError(err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    )
    return true
  }
  return false
}

export async function stopTracking() {
  if (watcherId && nativePlugin) {
    try { await nativePlugin.removeWatcher({ id: watcherId }) } catch (e) {}
  }
  if (fallbackWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(fallbackWatchId)
  }
  watcherId = null
  fallbackWatchId = null
  const total = milesAccum
  milesAccum = 0
  lastPos = null
  return total
}

export function getAccumulatedMiles() {
  return milesAccum
}
