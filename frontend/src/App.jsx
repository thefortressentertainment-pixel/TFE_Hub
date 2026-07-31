import React, { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import { startTracking, stopTracking, requestPermission, isNative } from './locationService'

function resolveApiBase() {
  const saved = localStorage.getItem('fortress_api_base')
  if (saved) return saved.replace(/\/+$/, '')
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL.replace(/\/+$/, '')
  if (isNative()) {
    return 'http://localhost:4002'
  }
  return ''
}
const API_BASE = resolveApiBase()

function getDeviceId() {
  let id = localStorage.getItem('fortress_device_id')
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => (c === 'x' ? Math.random() * 16 | 0 : 8 | Math.random() * 16).toString(16))
    localStorage.setItem('fortress_device_id', id)
  }
  return id
}
const DEVICE_ID = getDeviceId()

function getToken() {
  return localStorage.getItem('fortress_token') || ''
}

const origFetch = window.fetch.bind(window)
window.fetch = (url, opts) => {
  if (typeof url === 'string' && (url.startsWith('/api/') || url.startsWith(`${API_BASE}/api/`))) {
    const headers = { ...(opts?.headers || {}), 'X-Device-Id': DEVICE_ID }
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    return origFetch(url, { ...opts, headers })
  }
  return origFetch(url, opts)
}

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0))
}

const DEDUCIBILITY_HINTS = {
  'Fuel': { pct: 100, hint: 'Fully deductible as business fuel. Tag to your shift or job.' },
  'Vehicle': { pct: 100, hint: 'Maintenance/repair deductible if the vehicle is used for work. Log odometer.' },
  'Food & Drink': { pct: 50, hint: 'Meals often 50% deductible — write the business purpose (e.g. "meeting with client").' },
  'Food Delivery': { pct: 100, hint: 'Business meal — tag who/what it was for.' },
  'Transport': { pct: 100, hint: 'Uber/parking/tolls deductible as business travel.' },
  'Travel': { pct: 100, hint: 'Hotel/travel deductible for business trips. Keep the dates.' },
  'Utilities': { pct: 100, hint: 'Phone/internet — a % may be deductible if used for work.' },
  'Medical': { pct: 0, hint: 'Not a business deduction unless directly work-related.' },
  'Groceries': { pct: 0, hint: 'Personal unless it is a business supply. Usually not deductible.' },
  'Shopping': { pct: 0, hint: 'Deductible only if it is equipment/tools for your work.' },
  'Subscriptions': { pct: 50, hint: 'Software/tools used for work may be 50-100% deductible.' },
}

export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fortress_user') || 'null') } catch { return null }
  })
  const [authMode, setAuthMode] = useState('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [profiles, setProfiles] = useState([])
  const [profileSummaries, setProfileSummaries] = useState([])
  const [newProfile, setNewProfile] = useState('')
  const [newBudget, setNewBudget] = useState('')
  const [selectedProfile, setSelectedProfile] = useState('')
  const [file, setFile] = useState(null)
  const [status, setStatus] = useState('Ready to upload a receipt')
  const [jobId, setJobId] = useState(null)
  const [showDashboard, setShowDashboard] = useState(false)
  const [dashboardReceipts, setDashboardReceipts] = useState([])
  const [selectedReceipt, setSelectedReceipt] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const socketRef = useRef(null)

  const [showMileage, setShowMileage] = useState(false)
  const [mileageLogs, setMileageLogs] = useState([])
  const [mileageForm, setMileageForm] = useState({ start_odometer: '', end_odometer: '', purpose: '', project_name: '' })

  const [showProjects, setShowProjects] = useState(false)
  const [projects, setProjects] = useState([])
  const [newProjectName, setNewProjectName] = useState('')

  const [showTax, setShowTax] = useState(false)
  const [taxData, setTaxData] = useState(null)

  const [showTrends, setShowTrends] = useState(false)
  const [trends, setTrends] = useState([])

  const [categories, setCategories] = useState([])

  const [editReceipt, setEditReceipt] = useState(null)
  const [editForm, setEditForm] = useState({})

  const [errorMsg, setErrorMsg] = useState('')

  const [showSettings, setShowSettings] = useState(false)
  const [backendUrlInput, setBackendUrlInput] = useState(API_BASE)

  const saveBackendUrl = () => {
    const url = backendUrlInput.trim().replace(/\/+$/, '')
    localStorage.setItem('fortress_api_base', url)
    window.location.reload()
  }

  const doAuth = async (mode) => {
    if (!authEmail || !authPassword) return setAuthError('Enter your email and password')
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API_BASE}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      })
      const j = await res.json()
      if (!res.ok) {
        setAuthError(j.error || 'Authentication failed')
      } else {
        localStorage.setItem('fortress_token', j.token)
        localStorage.setItem('fortress_user', JSON.stringify(j.user))
        setUser(j.user)
        setAuthEmail('')
        setAuthPassword('')
      }
    } catch (e) {
      setAuthError('Cannot reach server: ' + String(e))
    }
    setAuthLoading(false)
  }

  const logout = () => {
    localStorage.removeItem('fortress_token')
    localStorage.removeItem('fortress_user')
    setUser(null)
    setProfiles([])
    setProfileSummaries([])
    setDashboardReceipts([])
    setSelectedProfile('')
  }

  const [activeShift, setActiveShift] = useState(null)
  const [shiftElapsed, setShiftElapsed] = useState(0)
  const [shiftMiles, setShiftMiles] = useState(0)
  const [shiftPurpose, setShiftPurpose] = useState('')
  const elapsedIntervalRef = useRef(null)
  const [dailySummary, setDailySummary] = useState(null)
  const [recentShifts, setRecentShifts] = useState([])

  useEffect(() => {
    fetchProfiles()
    fetchProfileSummaries()
    fetchCategories()
  }, [])

  useEffect(() => {
    if (selectedProfile) fetchDailySummary(selectedProfile)
  }, [selectedProfile])

  useEffect(() => {
    if (selectedProfile) {
      const res = fetch(`${API_BASE}/api/shifts/current?profileId=${selectedProfile}`)
      res.then(r => r.json()).then(j => {
        if (j.shift) {
          setActiveShift(j.shift)
          setShiftElapsed(Math.floor((Date.now() - new Date(j.shift.start_time).getTime()) / 1000))
        }
      }).catch(() => {})
    }
  }, [selectedProfile])

  useEffect(() => {
    if (selectedProfile) {
      fetch(`${API_BASE}/api/shifts?profileId=${selectedProfile}`)
        .then(r => r.json())
        .then(j => setRecentShifts(j.shifts || []))
        .catch(() => {})
    }
  }, [selectedProfile])

  useEffect(() => {
    if (activeShift) {
      elapsedIntervalRef.current = setInterval(() => {
        setShiftElapsed(Math.floor((Date.now() - new Date(activeShift.start_time).getTime()) / 1000))
      }, 1000)
    } else {
      clearInterval(elapsedIntervalRef.current)
    }
    return () => clearInterval(elapsedIntervalRef.current)
  }, [activeShift])

  useEffect(() => {
    if (activeShift) {
      startTracking(({ miles }) => setShiftMiles(miles), () => {})
    } else {
      stopTracking()
      setShiftMiles(0)
    }
  }, [activeShift])

  useEffect(() => {
    if (!selectedProfile && profiles.length === 1) {
      const singleProfileId = profiles[0].id
      setSelectedProfile(singleProfileId)
      loadReceiptsForProfile(singleProfileId)
    }
  }, [profiles, selectedProfile])

  useEffect(() => {
    const socket = io(API_BASE, { transportOptions: { polling: { extraHeaders: { 'X-Device-Id': DEVICE_ID } } } })
    socketRef.current = socket
    socket.on('connect', () => {
      if (selectedProfile) socket.emit('subscribe:profile', selectedProfile)
    })
    socket.on('receipt:new', data => {
      fetchProfileSummaries()
      if (selectedProfile) loadReceiptsForProfile(selectedProfile)
      setStatus(`New receipt: ${data.vendor} — ${money(data.total)}`)
    })
    socket.on('mileage:new', () => {
      if (selectedProfile) fetchMileage(selectedProfile)
    })
    return () => socket.close()
  }, [selectedProfile])

  useEffect(() => {
    if (socketRef.current?.connected && selectedProfile) {
      socketRef.current.emit('subscribe:profile', selectedProfile)
    }
  }, [selectedProfile])

  const fetchCategories = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/categories`)
      const j = await res.json()
      setCategories(j.categories || [])
    } catch {}
  }

  const fetchProfiles = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/profiles`)
      const j = await res.json()
      setProfiles(j.profiles || [])
    } catch {}
  }

  const fetchProfileSummaries = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/profiles/summary`)
      const j = await res.json()
      setProfileSummaries(j.profiles || [])
    } catch {}
  }

  const selectProfile = async (profileId) => {
    setSelectedProfile(profileId)
    if (profileId) {
      await loadReceiptsForProfile(profileId)
    } else {
      setDashboardReceipts([])
    }
  }

  const createProfile = async () => {
    if (!newProfile) return
    const body = { name: newProfile }
    if (newBudget) body.monthly_budget = Number(newBudget)
    const res = await fetch(`${API_BASE}/api/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json()
    if (j.profile) {
      setNewProfile('')
      setNewBudget('')
      await fetchProfiles()
      await fetchProfileSummaries()
      await selectProfile(j.profile.id)
    }
  }

  const setBudget = async (profileId, budget) => {
    const res = await fetch(`${API_BASE}/api/profiles/${profileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthly_budget: budget || null }),
    })
    if (res.ok) {
      await fetchProfileSummaries()
      await fetchProfiles()
    }
  }

  const fetchDailySummary = async (pid) => {
    try {
      const res = await fetch(`${API_BASE}/api/daily-summary?profileId=${pid}`)
      const j = await res.json()
      setDailySummary(j.today || null)
    } catch {}
  }

  const startShift = async () => {
    if (!selectedProfile) return setStatus('Choose a profile first')
    setStatus('Requesting GPS permission...')
    const granted = await requestPermission()
    if (!granted) {
      setStatus('GPS permission denied — cannot auto-track miles. You can still log mileage manually.')
      return
    }
    setStatus('Starting shift...')
    const res = await fetch(`${API_BASE}/api/shifts/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: selectedProfile, purpose: shiftPurpose || 'DoorDash shift' }),
    })
    const j = await res.json()
    if (j.shift) {
      setActiveShift(j.shift)
      setShiftElapsed(0)
      setShiftMiles(0)
      setStatus(`Shift started — ${j.shift.purpose || 'work shift'}` + (isNative() ? ' (tracking in background)' : ''))
      const r = await fetch(`${API_BASE}/api/shifts?profileId=${selectedProfile}`)
      const rs = await r.json()
      setRecentShifts(rs.shifts || [])
    } else {
      setStatus('Could not start shift')
    }
  }

  const endShift = async () => {
    if (!activeShift) return
    setStatus(`Ending shift — ${shiftMiles.toFixed(1)} mi tracked. Saving...`)
    const res = await fetch(`${API_BASE}/api/shifts/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shift_id: activeShift.id, miles: Math.round(shiftMiles * 10) / 10 }),
    })
    const j = await res.json()
    if (j.shift) {
      setStatus(`Shift ended — ${Number(j.shift.miles || 0).toFixed(1)} mi logged for the day.`)
      setActiveShift(null)
      setShiftElapsed(0)
      setShiftMiles(0)
      await fetchDailySummary(selectedProfile)
      const r = await fetch(`${API_BASE}/api/shifts?profileId=${selectedProfile}`)
      const rs = await r.json()
      setRecentShifts(rs.shifts || [])
    } else {
      setStatus('Could not end shift')
    }
  }

  const formatElapsed = (sec) => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const uploadReceipt = async (event) => {
    event.preventDefault()
    if (!file) return setStatus('Please select a receipt file')
    if (!selectedProfile) return setStatus('Please choose a profile before uploading')
    setIsUploading(true)
    setStatus(`Uploading receipt to ${profiles.find(p => p.id === selectedProfile)?.name || 'selected profile'}...`)

    const form = new FormData()
    form.append('receipt', file)
    if (selectedProfile) form.append('profileId', selectedProfile)

    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form })
    const data = await res.json()
    if (data.success) {
      if (data.inline && data.receiptId) {
        setShowDashboard(true)
        setIsUploading(false)
        setStatus('Receipt saved (queue unavailable, processed inline).')
        await fetchProfileSummaries()
        if (selectedProfile) await loadReceiptsForProfile(selectedProfile)
      } else {
        setJobId(data.jobId)
        setShowDashboard(true)
        setStatus('Receipt uploaded. We are processing it now...')
        if (selectedProfile) await loadReceiptsForProfile(selectedProfile)
        pollJob(data.jobId)
      }
    } else {
      if (res.status === 409) {
        setStatus('Duplicate receipt detected — this receipt already exists.')
      } else {
        setStatus('Upload failed: ' + (data.error || JSON.stringify(data)))
      }
      setIsUploading(false)
    }
  }

  const pollJob = async (id) => {
    setStatus('Working on it… the dashboard will refresh automatically when the receipt is ready.')
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/job/${id}`)
        const data = await res.json()
        if (data.error) {
          clearInterval(interval)
          setIsUploading(false)
          setStatus('Error: ' + data.error)
          return
        }
        if (!data.state || data.state === 'removed') {
          clearInterval(interval)
          setIsUploading(false)
          setStatus('Job completed or removed from queue')
          return
        }
        if (data.state === 'completed') {
          clearInterval(interval)
          setIsUploading(false)
          setStatus('Receipt ready')
          if (data.result && data.result.receiptId) {
            const rr = await fetch(`${API_BASE}/api/receipts/${data.result.receiptId}`)
            const jr = await rr.json()
            if (jr.receipt) {
              setSelectedReceipt(jr.receipt)
              setStatus(`Receipt saved — ${jr.receipt.vendor} ${money(jr.receipt.total)}`)
              await fetchProfileSummaries()
              if (selectedProfile) await loadReceiptsForProfile(selectedProfile)
            }
          }
        } else if (data.state === 'failed') {
          clearInterval(interval)
          setIsUploading(false)
          setStatus('Job failed')
        } else {
          setStatus(`Job ${id} status: ${data.state}`)
        }
      } catch (e) {
        clearInterval(interval)
        setIsUploading(false)
        setStatus('Polling error: ' + String(e))
      }
    }, 2000)
  }

  const openDashboard = async () => {
    setShowDashboard(true)
    if (!selectedProfile && profiles.length) {
      setSelectedProfile(profiles[0].id)
      await loadReceiptsForProfile(profiles[0].id)
      return
    }
    if (selectedProfile) await loadReceiptsForProfile(selectedProfile)
  }

  const loadReceiptsForProfile = async (pid) => {
    try {
      const res = await fetch(`${API_BASE}/api/profiles/${pid}/receipts`)
      const j = await res.json()
      setDashboardReceipts(j.receipts || [])
    } catch (e) { setDashboardReceipts([]) }
  }

  const exportCSV = async (pid) => {
    window.open(`${API_BASE}/api/profiles/${pid}/export/csv`, '_blank')
  }

  const exportPDF = async (pid) => {
    window.open(`${API_BASE}/api/profiles/${pid}/export/pdf`, '_blank')
  }

  const fetchMileage = async (pid) => {
    try {
      const res = await fetch(`${API_BASE}/api/mileage?profileId=${pid}`)
      const j = await res.json()
      setMileageLogs(j.mileage || [])
    } catch {}
  }

  const addMileage = async () => {
    if (!mileageForm.start_odometer && !mileageForm.end_odometer) return
    const res = await fetch(`${API_BASE}/api/mileage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: selectedProfile,
        start_odometer: mileageForm.start_odometer ? Number(mileageForm.start_odometer) : null,
        end_odometer: mileageForm.end_odometer ? Number(mileageForm.end_odometer) : null,
        purpose: mileageForm.purpose || null,
        project_name: mileageForm.project_name || null,
      }),
    })
    if (res.ok) {
      setMileageForm({ start_odometer: '', end_odometer: '', purpose: '', project_name: '' })
      fetchMileage(selectedProfile)
    }
  }

  const deleteProfile = async (id) => {
    if (!confirm('Delete this profile and all its receipts?')) return
    await fetch(`${API_BASE}/api/profiles/${id}`, { method: 'DELETE' })
    if (selectedProfile === id) {
      setSelectedProfile('')
      setDashboardReceipts([])
    }
    await fetchProfiles()
    await fetchProfileSummaries()
  }

  const deleteMileage = async (id) => {
    await fetch(`${API_BASE}/api/mileage/${id}`, { method: 'DELETE' })
    fetchMileage(selectedProfile)
  }

  const fetchProjects = async (pid) => {
    try {
      const res = await fetch(`${API_BASE}/api/projects?profileId=${pid}`)
      const j = await res.json()
      setProjects(j.projects || [])
    } catch {}
  }

  const addProject = async () => {
    if (!newProjectName) return
    const res = await fetch(`${API_BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProjectName, profile_id: selectedProfile }),
    })
    if (res.ok) {
      setNewProjectName('')
      fetchProjects(selectedProfile)
    }
  }

  const deleteProject = async (id) => {
    await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE' })
    fetchProjects(selectedProfile)
  }

  const fetchTaxData = async (pid) => {
    try {
      const res = await fetch(`${API_BASE}/api/analytics/business-tax?profileId=${pid}`)
      const j = await res.json()
      setTaxData(j)
    } catch {}
  }

  const fetchTrends = async (pid) => {
    try {
      const res = await fetch(`${API_BASE}/api/analytics/spending-trends?profileId=${pid}&months=6`)
      const j = await res.json()
      setTrends(j.trends || [])
    } catch {}
  }

  const openEditReceipt = (r) => {
    setEditReceipt(r.id)
    setEditForm({
      vendor: r.vendor || '',
      category: r.category || '',
      is_business: r.is_business !== false,
      business_notes: r.business_notes || '',
      project_name: r.project_name || '',
      tax_category: r.tax_category || '',
    })
  }

  const saveEditReceipt = async () => {
    const res = await fetch(`${API_BASE}/api/receipts/${editReceipt}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
    })
    if (res.ok) {
      setEditReceipt(null)
      await loadReceiptsForProfile(selectedProfile)
      await fetchProfileSummaries()
    }
  }

  const deleteReceipt = async (id) => {
    if (!confirm('Delete this receipt?')) return
    const res = await fetch(`${API_BASE}/api/receipts/${id}`, { method: 'DELETE' })
    if (res.ok) {
      await loadReceiptsForProfile(selectedProfile)
      await fetchProfileSummaries()
    }
  }

  const selectedSummary = profileSummaries.find(p => p.id === selectedProfile) || null

  const toggleMileage = async () => {
    const next = !showMileage
    setShowMileage(next)
    if (next && selectedProfile) fetchMileage(selectedProfile)
  }

  const toggleProjects = async () => {
    const next = !showProjects
    setShowProjects(next)
    if (next && selectedProfile) fetchProjects(selectedProfile)
  }

  const toggleTax = async () => {
    const next = !showTax
    setShowTax(next)
    if (next && selectedProfile) fetchTaxData(selectedProfile)
  }

  const toggleTrends = async () => {
    const next = !showTrends
    setShowTrends(next)
    if (next && selectedProfile) fetchTrends(selectedProfile)
  }

  const trendsByMonth = trends.reduce((acc, t) => {
    const m = t.month ? t.month.slice(0, 7) : 'unknown'
    if (!acc[m]) acc[m] = []
    acc[m].push(t)
    return acc
  }, {})

  return (
    <div className="app">
      <style>{`
        :root { color-scheme: light; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #f6f7f9; -webkit-tap-highlight-color: transparent; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .auth-screen {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: linear-gradient(160deg, #eef2f7 0%, #f6f7f9 100%);
        }
        .auth-card {
          width: 100%;
          max-width: 400px;
          background: #ffffff;
          border: 1px solid #e3e6ea;
          border-radius: 16px;
          padding: 32px;
          box-shadow: 0 8px 30px rgba(0,0,0,0.08);
        }
        .auth-card h1 { margin: 0 0 4px; color: #101828; font-size: 24px; font-weight: 700; }
        .auth-card .auth-sub { color: #667085; font-size: 14px; margin-bottom: 24px; }
        .auth-card label { display: block; font-size: 13px; font-weight: 600; color: #344054; margin-bottom: 6px; }
        .auth-card input {
          width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid #d0d5dd; background: #ffffff; color: #101828; font: inherit; margin-bottom: 16px;
        }
        .auth-card input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
        .auth-card button {
          width: 100%; border: none; background: #3b82f6; color: #ffffff; padding: 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 15px; font-weight: 600;
        }
        .auth-card button:hover { background: #2563eb; }
        .auth-card button:disabled { cursor: wait; opacity: 0.7; }
        .auth-toggle { text-align: center; margin-top: 16px; font-size: 14px; color: #667085; }
        .auth-toggle button { width: auto; background: none; border: none; color: #3b82f6; text-decoration: underline; padding: 0; font-size: 14px; }
        .auth-error { color: #dc2626; font-size: 14px; margin-bottom: 12px; }
        .app {
          min-height: 100vh;
          background: #f6f7f9;
          color: #101828;
        }
        .app-header {
          background: #ffffff;
          border-bottom: 1px solid #e3e6ea;
          padding: 14px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .app-header .brand { display: flex; align-items: center; gap: 10px; }
        .app-header h1 { margin: 0; font-size: 19px; font-weight: 700; color: #101828; }
        .app-header .user-chip { display: flex; align-items: center; gap: 8px; }
        .app-header .user-email { font-size: 13px; color: #667085; }
        .container { max-width: 1100px; margin: 0 auto; padding: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
        .stat-card, .panel-card { background: #ffffff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 14px; }
        .stat-label { font-size: 12px; color: #667085; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
        .stat-value { font-size: 22px; font-weight: 700; margin-top: 4px; color: #101828; }
        .main-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .panel-card h2, .panel-card h3, .panel-card h4 { margin-top: 0; color: #101828; font-size: 15px; font-weight: 700; }
        .panel-card label { display: block; font-size: 12px; font-weight: 600; color: #344054; margin-bottom: 6px; }
        .panel-card input, .panel-card select, .panel-card button, .panel-card textarea { font: inherit; font-size: 14px; }
        .panel-card input, .panel-card select, .panel-card textarea {
          width: 100%; padding: 9px 11px; border-radius: 8px; border: 1px solid #d0d5dd; background: #ffffff; color: #101828;
        }
        .panel-card input:focus, .panel-card select:focus, .panel-card textarea:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.12); }
        .panel-card textarea { resize: vertical; min-height: 50px; }
        .panel-card button {
          border: 1px solid #d0d5dd; background: #ffffff; color: #344054; padding: 9px 14px; border-radius: 8px; cursor: pointer;
        }
        .panel-card button:hover { background: #f2f4f7; }
        .panel-card button:disabled { cursor: wait; opacity: 0.7; }
        .btn-primary { border: none !important; background: #3b82f6 !important; color: #ffffff !important; font-weight: 600; }
        .btn-primary:hover { background: #2563eb !important; }
        .btn-sm { font-size: 12px; padding: 5px 9px; }
        .btn-danger { border-color: #fecaca !important; color: #dc2626 !important; }
        .btn-danger:hover { background: #fef2f2 !important; }
        .btn-warn { border-color: #fed7aa !important; color: #c2410c !important; }
        .btn-warn:hover { background: #fff7ed !important; }
        .status-box { margin-top: 12px; padding: 12px; border-radius: 10px; background: #f0f6ff; border: 1px solid #bfdbfe; color: #1e3a8a; }
        .shift-panel {
          background: #ffffff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 16px;
        }
        .shift-start {
          border: none; background: #16a34a; color: #ffffff; padding: 11px 18px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600;
        }
        .shift-start:hover { background: #15803d; }
        .shift-end {
          border: none; background: #dc2626; color: #ffffff; padding: 11px 18px; border-radius: 8px; cursor: pointer; font-size: 15px; font-weight: 600;
        }
        .shift-end:hover { background: #b91c1c; }
        .profile-list button, .receipt-item {
          width: 100%; text-align: left; border: 1px solid #e3e6ea; background: #ffffff; border-radius: 10px; padding: 12px; cursor: pointer; color: #101828; margin-bottom: 8px;
        }
        .profile-list button:hover { border-color: #3b82f6; }
        .profile-list button.active { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.12); }
        .receipt-item { cursor: default; }
        .muted { color: #667085; font-size: 13px; }
        .flex { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .flex-between { display: flex; justify-content: space-between; align-items: center; }
        .mb-8 { margin-bottom: 8px; }
        .mt-8 { margin-top: 8px; }
        .budget-bar { height: 8px; border-radius: 4px; background: #e5e7eb; margin-top: 4px; overflow: hidden; }
        .budget-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
        .budget-ok { background: #16a34a; }
        .budget-warn { background: #f59e0b; }
        .budget-danger { background: #dc2626; }
        .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid #d0d5dd; font-size: 11px; background: #f2f4f7; color: #344054; }
        .tag-green { border-color: #bbf7d0; background: #f0fdf4; color: #15803d; }
        .modal-overlay {
          position: fixed; inset: 0; background: rgba(16,24,40,0.5); display: flex; align-items: center; justify-content: center; z-index: 100;
        }
        .modal {
          background: #ffffff; border: 1px solid #e3e6ea; border-radius: 16px; padding: 24px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 40px rgba(0,0,0,0.15);
        }
        .modal h3 { margin-top: 0; }
        @media (max-width: 900px) {
          .main-grid { grid-template-columns: 1fr; }
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
          .container { padding: 12px; }
        }
        @media (max-width: 600px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
          .stat-card { padding: 10px; }
          .stat-value { font-size: 18px; }
          .panel-card { padding: 12px; }
          .panel-card input, .panel-card select, .panel-card button { font-size: 15px; padding: 10px; }
          .profile-list button, .receipt-item { padding: 12px; }
          .app-header { padding: 12px 14px; }
          .app-header h1 { font-size: 17px; }
          .modal { padding: 18px; width: 95%; }
        }
        @media (hover: none) and (pointer: coarse) {
          .panel-card button, .profile-list button, .btn-sm { min-height: 44px; }
          .panel-card input, .panel-card select, .panel-card textarea { min-height: 44px; font-size: 16px; }
        }
      `}</style>
      {!user ? (
        <div className="auth-screen">
          <div className="auth-card">
            <h1>ReceiptVault</h1>
            <div className="auth-sub">{authMode === 'login' ? 'Welcome back — sign in to your account' : 'Create an account — your receipts, private to you'}</div>
            {authError && <div className="auth-error">{authError}</div>}
            <label>Email</label>
            <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            <label>Password</label>
            <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="At least 8 characters" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} onKeyDown={e => e.key === 'Enter' && doAuth(authMode)} />
            <button onClick={() => doAuth(authMode)} disabled={authLoading}>
              {authLoading ? 'Please wait...' : authMode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
            <div className="auth-toggle">
              {authMode === 'login' ? "New here? " : 'Already have an account? '}
              <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError('') }}>
                {authMode === 'login' ? 'Create an account' : 'Sign in'}
              </button>
            </div>
          </div>
        </div>
      ) : (
      <>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <h1>ReceiptVault</h1>
          </div>
          <div className="user-chip">
            <span className="user-email">{user.email}</span>
            <button className="btn-sm" onClick={() => setShowSettings(!showSettings)}>
              {showSettings ? 'Close' : 'Settings'}
            </button>
            <button className="btn-sm" onClick={logout}>Sign Out</button>
          </div>
        </header>
        <div className="container">
          {showSettings && (
            <div className="panel-card" style={{ marginBottom: 16 }}>
              <div className="flex-between" style={{ marginBottom: 8 }}>
                <strong>Backend URL</strong>
                <span className="muted">hosted web page</span>
              </div>
              <div className="flex" style={{ gap: 6 }}>
                <input
                  placeholder="https://your-app.trycloudflare.com"
                  value={backendUrlInput}
                  onChange={e => setBackendUrlInput(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn-sm" onClick={saveBackendUrl}>Save</button>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                Current: {API_BASE || '(same origin)'}
              </div>
            </div>
          )}

        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Profiles</div>
            <div className="stat-value">{profileSummaries.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Receipts</div>
            <div className="stat-value">{profileSummaries.reduce((acc, p) => acc + Number(p.receipt_count || 0), 0)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Spent</div>
            <div className="stat-value">{money(profileSummaries.reduce((acc, p) => acc + Number(p.total_spent || 0), 0))}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Budget Used</div>
            <div className="stat-value">
              {(() => {
                const withBudget = profileSummaries.filter(p => p.monthly_budget)
                if (!withBudget.length) return '—'
                const avg = withBudget.reduce((a, p) => a + (p.budget_used_pct || 0), 0) / withBudget.length
                return `${Math.round(avg)}%`
              })()}
            </div>
          </div>
        </div>

        <div className="shift-panel" style={{ marginBottom: 16 }}>
          <div className="flex-between" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Shift Tracker</h2>
            {dailySummary && !activeShift && (
              <span className="muted">Today: {money(dailySummary.spend)} • {dailySummary.miles} mi</span>
            )}
          </div>

          {!activeShift ? (
            <div className="flex" style={{ gap: 8, alignItems: 'stretch' }}>
              <input
                placeholder="Shift purpose (e.g. DoorDash lunch rush)"
                value={shiftPurpose}
                onChange={e => setShiftPurpose(e.target.value)}
                style={{ flex: 1 }}
              />
              <button onClick={startShift} className="shift-start" style={{ whiteSpace: 'nowrap' }}>▶ Start Shift</button>
            </div>
          ) : (
            <div>
              <div className="flex" style={{ gap: 16, marginBottom: 10 }}>
                <div className="stat-card" style={{ flex: 1 }}>
                  <div className="stat-label">Elapsed</div>
                  <div className="stat-value" style={{ fontSize: 22 }}>{formatElapsed(shiftElapsed)}</div>
                </div>
                <div className="stat-card" style={{ flex: 1 }}>
                  <div className="stat-label">Miles (GPS)</div>
                  <div className="stat-value" style={{ fontSize: 22 }}>{shiftMiles.toFixed(1)}</div>
                </div>
                <div className="stat-card" style={{ flex: 1 }}>
                  <div className="stat-label">Est. Deduction</div>
                  <div className="stat-value" style={{ fontSize: 22 }}>{money(shiftMiles * 0.67)}</div>
                </div>
              </div>
              <button onClick={endShift} className="shift-end" style={{ width: '100%', whiteSpace: 'nowrap' }}>■ End Shift & Log Miles</button>
            </div>
          )}

          {recentShifts.length > 0 && !activeShift && (
            <div className="muted" style={{ marginTop: 8 }}>
              Last: {recentShifts.slice(0, 3).map(s => `${s.purpose || 'shift'} (${Number(s.miles || 0).toFixed(1)}mi)`).join(' • ')}
            </div>
          )}
        </div>

        <div className="main-grid">
          <div className="panel-card">
            <h2>Upload Receipt</h2>
            <form onSubmit={uploadReceipt}>
              <div style={{ marginBottom: 10 }}>
                <label>Profile</label>
                <select value={selectedProfile} onChange={e => selectProfile(e.target.value)}>
                  <option value="">(none)</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label>New profile</label>
                <div className="flex">
                  <input placeholder="Vault name" value={newProfile} onChange={e => setNewProfile(e.target.value)} style={{ flex: 1 }} />
                  <input placeholder="Budget" type="number" value={newBudget} onChange={e => setNewBudget(e.target.value)} style={{ width: 100 }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button type="button" onClick={createProfile}>Create Profile</button>
                <label style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '9px 11px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#ffffff', cursor: 'pointer', color: '#344054' }}>
                  <span>{file ? file.name : 'Choose file'}</span>
                  <input type="file" accept="image/*,.pdf" onChange={e => setFile(e.target.files[0])} style={{ display: 'none' }} />
                </label>
              </div>
              <button type="submit" disabled={isUploading}>{isUploading ? 'Processing…' : 'Upload'}</button>
            </form>
            <div className="status-box">
              <strong>Status:</strong> {status}
            </div>
            {jobId && <div className="muted" style={{ marginTop: 8 }}>Job ID: {jobId}</div>}
            {selectedReceipt && (
              <div className="status-box" style={{ marginTop: 14 }}>
                <h3>Latest Receipt</h3>
                <div><strong>Vendor:</strong> {selectedReceipt.vendor}</div>
                <div><strong>Date:</strong> {selectedReceipt.date}</div>
                <div><strong>Total:</strong> {money(selectedReceipt.total)}</div>
                {selectedReceipt.category && <div><strong>Category:</strong> <span className="tag">{selectedReceipt.category}</span></div>}
                {selectedReceipt.confidence_score && <div><strong>Confidence:</strong> {selectedReceipt.confidence_score}%</div>}
              </div>
            )}
          </div>

          <div className="panel-card">
            <div className="flex-between mb-8">
              <h2>Dashboard</h2>
              <button onClick={openDashboard}>{showDashboard ? 'Refresh' : 'Open'}</button>
            </div>

            {selectedSummary && (
              <div className="status-box" style={{ marginBottom: 12 }}>
                <div className="flex-between">
                  <strong>{selectedSummary.name}</strong>
                  {selectedSummary.monthly_budget && (
                    <span className="tag tag-green">Budget: {money(selectedSummary.monthly_budget)}</span>
                  )}
                </div>
                <div className="mt-8">
                  Receipts: {selectedSummary.receipt_count || 0} • Total: {money(selectedSummary.total_spent || 0)}
                </div>
                {selectedSummary.monthly_spent !== undefined && (
                  <div className="mt-8">
                    <span>This month: {money(selectedSummary.monthly_spent)}</span>
                    {selectedSummary.budget_used_pct !== null && (
                      <>
                        <div className="budget-bar">
                          <div className={`budget-fill ${selectedSummary.budget_used_pct >= 90 ? 'budget-danger' : selectedSummary.budget_used_pct >= 70 ? 'budget-warn' : 'budget-ok'}`}
                               style={{ width: `${Math.min(100, selectedSummary.budget_used_pct)}%` }} />
                        </div>
                        <div className="flex-between mt-8">
                          <span className="muted">{selectedSummary.budget_used_pct}% used</span>
                          <span className="muted">{money(selectedSummary.budget_remaining)} remaining</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div className="flex mt-8">
                  <button className="btn-sm" onClick={() => {
                    const b = prompt('Monthly budget:', selectedSummary.monthly_budget || '')
                    if (b !== null) setBudget(selectedProfile, b ? Number(b) : null)
                  }}>Set Budget</button>
                  <button className="btn-sm" onClick={() => exportCSV(selectedProfile)}>CSV</button>
                  <button className="btn-sm" onClick={() => exportPDF(selectedProfile)}>PDF</button>
                </div>
              </div>
            )}

            <div className="flex mb-8" style={{ gap: 6 }}>
              <button className="btn-sm" onClick={toggleMileage}>{showMileage ? 'Hide' : 'Mileage'}</button>
              <button className="btn-sm" onClick={toggleProjects}>{showProjects ? 'Hide' : 'Projects'}</button>
              <button className="btn-sm" onClick={toggleTax}>{showTax ? 'Hide' : 'Tax'}</button>
              <button className="btn-sm" onClick={toggleTrends}>{showTrends ? 'Hide' : 'Trends'}</button>
            </div>

            {showMileage && selectedProfile && (
              <div className="status-box" style={{ marginBottom: 12 }}>
                <div className="flex-between"><h3>Mileage</h3></div>
                <div className="flex mb-8">
                  <input placeholder="Start" type="number" style={{ width: 80 }} value={mileageForm.start_odometer} onChange={e => setMileageForm(f => ({...f, start_odometer: e.target.value}))} />
                  <input placeholder="End" type="number" style={{ width: 80 }} value={mileageForm.end_odometer} onChange={e => setMileageForm(f => ({...f, end_odometer: e.target.value}))} />
                  <input placeholder="Purpose" style={{ flex: 1 }} value={mileageForm.purpose} onChange={e => setMileageForm(f => ({...f, purpose: e.target.value}))} />
                  <button className="btn-sm" onClick={addMileage}>Log</button>
                </div>
                {mileageLogs.slice(0, 5).map(m => (
                  <div key={m.id} className="flex-between muted" style={{ marginBottom: 4 }}>
                    <span>{m.date} {m.miles ? `${m.miles}mi` : ''} {m.purpose ? `— ${m.purpose}` : ''}</span>
                    <button className="btn-sm btn-danger" onClick={() => deleteMileage(m.id)}>X</button>
                  </div>
                ))}
              </div>
            )}

            {showProjects && selectedProfile && (
              <div className="status-box" style={{ marginBottom: 12 }}>
                <div className="flex-between"><h3>Projects</h3></div>
                <div className="flex mb-8">
                  <input placeholder="Project name" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn-sm" onClick={addProject}>Add</button>
                </div>
                {projects.map(p => (
                  <div key={p.id} className="flex-between muted" style={{ marginBottom: 4 }}>
                    <span>{p.name}</span>
                    <button className="btn-sm btn-danger" onClick={() => deleteProject(p.id)}>X</button>
                  </div>
                ))}
              </div>
            )}

            {showTax && taxData && (
              <div className="status-box" style={{ marginBottom: 12 }}>
                <div className="flex-between"><h3>Business Tax Summary</h3></div>
                {taxData.deductions?.map(d => (
                  <div key={d.tax_category} className="flex-between" style={{ marginBottom: 4 }}>
                    <span>{d.tax_category}</span>
                    <span>{money(d.total_deduction)} ({d.count})</span>
                  </div>
                ))}
                <div className="mt-8 flex-between">
                  <strong>Total Deductions</strong>
                  <strong>{money(taxData.grand_total)}</strong>
                </div>
              </div>
            )}

            {showTrends && (
              <div className="status-box" style={{ marginBottom: 12 }}>
                <div className="flex-between"><h3>Spending Trends</h3></div>
                {Object.entries(trendsByMonth).slice(0, 6).map(([month, entries]) => (
                  <div key={month} style={{ marginBottom: 8 }}>
                    <div className="muted" style={{ marginBottom: 4 }}>{month}</div>
                    {entries.slice(0, 4).map((e, i) => (
                      <div key={i} className="flex-between" style={{ fontSize: 12, marginBottom: 2 }}>
                        <span>{e.category}</span>
                        <span>{money(e.total_spent)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {showDashboard && (
              <div>
                <h4>Profiles</h4>
                <div className="profile-list">
                  {profileSummaries.map(p => (
                    <button key={p.id} className={selectedProfile === p.id ? 'active' : ''} onClick={() => selectProfile(p.id)}>
                      <div className="flex-between">
                        <strong>{p.name}</strong>
                        <div className="flex" style={{ gap: 4, alignItems: 'center' }}>
                          {p.budget_used_pct !== null && (
                            <span className={`tag ${p.budget_used_pct >= 90 ? 'tag-green' : ''}`}>
                              {p.budget_used_pct}%
                            </span>
                          )}
                          <span className="btn-sm btn-danger" style={{ cursor: 'pointer', fontSize: 10, padding: '2px 6px' }}
                                onClick={e => { e.stopPropagation(); deleteProfile(p.id) }}>
                            Del
                          </span>
                        </div>
                      </div>
                      <span className="muted">{p.receipt_count || 0} receipts • {money(p.total_spent || 0)}</span>
                    </button>
                  ))}
                </div>

                <h4 style={{ marginTop: 16 }}>Receipts for Selected Profile</h4>
                <div>
                  {dashboardReceipts.length === 0 && <div className="muted">No receipts yet for this profile.</div>}
                  {dashboardReceipts.map(r => (
                    <div key={r.id} className="receipt-item">
                      <div className="flex-between">
                        <div style={{ fontWeight: 700 }}>{r.vendor}</div>
                        <div className="flex" style={{ gap: 4 }}>
                          {r.category && <span className="tag">{r.category}</span>}
                          {r.is_business === false && <span className="tag" style={{ borderColor: '#a18a45' }}>Personal</span>}
                          {r.project_name && <span className="tag">{r.project_name}</span>}
                        </div>
                      </div>
                      <div className="flex-between muted">
                        <span>{r.date} • {money(r.total)}</span>
                        <div className="flex" style={{ gap: 4 }}>
                          <button className="btn-sm" onClick={() => openEditReceipt(r)}>Edit</button>
                          <button className="btn-sm btn-danger" onClick={() => deleteReceipt(r.id)}>Del</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>

      {editReceipt && (
        <div className="modal-overlay" onClick={() => setEditReceipt(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Edit Receipt</h3>
            <div style={{ marginBottom: 10 }}>
              <label>Vendor</label>
              <input value={editForm.vendor} onChange={e => setEditForm(f => ({...f, vendor: e.target.value}))} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label>Category</label>
              <select value={editForm.category} onChange={e => setEditForm(f => ({...f, category: e.target.value}))}>
                <option value="">Uncategorized</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label>Tax Category</label>
              <select value={editForm.tax_category} onChange={e => setEditForm(f => ({...f, tax_category: e.target.value}))}>
                <option value="">None</option>
                <option value="Travel">Travel</option>
                <option value="Meals">Meals</option>
                <option value="Supplies">Supplies</option>
                <option value="Equipment">Equipment</option>
                <option value="Utilities">Utilities</option>
                <option value="Vehicle">Vehicle</option>
                <option value="Advertising">Advertising</option>
                <option value="Software">Software</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label>Type</label>
              <select value={editForm.is_business ? 'business' : 'personal'} onChange={e => setEditForm(f => ({...f, is_business: e.target.value === 'business'}))}>
                <option value="business">Business</option>
                <option value="personal">Personal</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label>Project</label>
              <select value={editForm.project_name} onChange={e => setEditForm(f => ({...f, project_name: e.target.value}))}>
                <option value="">None</option>
                {projects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label>Business Notes</label>
              <textarea value={editForm.business_notes} onChange={e => setEditForm(f => ({...f, business_notes: e.target.value}))} />
            </div>
            <div className="flex">
              <button onClick={saveEditReceipt}>Save</button>
              <button className="btn-warn" onClick={() => setEditReceipt(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      </>
    )}
    </div>
  )
}
