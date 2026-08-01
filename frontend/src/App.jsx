import React, { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import { startTracking, stopTracking, requestPermission, isNative } from './locationService'

const API_BASE = 'https://tfe-hub.onrender.com'

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

function deductibleMeta(receipt) {
  const isPersonal = receipt.is_business === false
  if (isPersonal) return { cls: 'tag-personal', label: 'Personal', hint: 'Marked personal — not deductible.' }
  const info = DEDUCIBILITY_HINTS[receipt.category] || DEDUCIBILITY_HINTS[receipt.tax_category]
  if (info && info.pct === 100) return { cls: 'tag-deductible', label: 'Deductible', hint: info.hint }
  if (info && info.pct > 0) return { cls: 'tag-partial', label: `${info.pct}%`, hint: info.hint }
  return { cls: 'tag-personal', label: 'Review', hint: 'Check deductibility — may not qualify.' }
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
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('token') || '')
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
  const [theme, setTheme] = useState(() => localStorage.getItem('fortress_theme') || 'light')

  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem('fortress_theme', next)
      return next
    })
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

  const doForgot = async () => {
    if (!authEmail) return setAuthError('Enter your email')
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API_BASE}/api/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail }),
      })
      const j = await res.json()
      if (res.ok && j.success) {
        setAuthError('If that email exists, a reset link has been sent.')
      } else {
        setAuthError(j.error || 'Could not send reset link')
      }
    } catch (e) {
      setAuthError('Cannot reach server: ' + String(e))
    }
    setAuthLoading(false)
  }

  const doReset = async () => {
    if (!authPassword || authPassword.length < 8) return setAuthError('Password must be at least 8 characters')
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch(`${API_BASE}/api/auth/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: authPassword }),
      })
      const j = await res.json()
      if (res.ok && j.success) {
        setAuthError('Password updated. You can now sign in.')
        setResetToken('')
        setAuthMode('login')
        setAuthPassword('')
      } else {
        setAuthError(j.error || 'Reset failed. The link may be invalid or expired.')
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
  const [lastShiftSummary, setLastShiftSummary] = useState(null)
  const [isRecording, setIsRecording] = useState(false)
  const recognitionRef = useRef(null)

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
      const summary = {
        purpose: j.shift.purpose || 'Work shift',
        miles: Number(j.shift.miles || 0),
        deduction: Number(j.shift.miles || 0) * 0.67,
      }
      setLastShiftSummary(summary)
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

  const shareShiftSummary = () => {
    if (!lastShiftSummary) return
    const text = `ReceiptVault — ${lastShiftSummary.purpose}\nMiles: ${lastShiftSummary.miles.toFixed(1)}\nEst. tax deduction: ${money(lastShiftSummary.deduction)}`
    if (navigator.share) {
      navigator.share({ title: 'ReceiptVault Shift', text }).catch(() => {})
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => setStatus('Shift summary copied to clipboard'))
    } else {
      setStatus(text)
    }
  }

  const toggleVoiceNote = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setStatus('Voice notes not supported on this browser')
      return
    }
    if (isRecording) {
      recognitionRef.current && recognitionRef.current.stop()
      setIsRecording(false)
      return
    }
    const rec = new SR()
    rec.lang = 'en-US'
    rec.interimResults = false
    recognitionRef.current = rec
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript
      setShiftPurpose(prev => prev ? prev + ' ' + text : text)
      setIsRecording(false)
    }
    rec.onend = () => setIsRecording(false)
    rec.onerror = () => setIsRecording(false)
    rec.start()
    setIsRecording(true)
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
    <div className="app" data-theme={theme}>
      <style>{`
        .app { color-scheme: light; }
        .app[data-theme='dark'] { color-scheme: dark; }
        .app {
          --bg: #f5f6fa;
          --bg-grad-1: #eef2f8;
          --bg-grad-2: #f5f6fa;
          --surface: #ffffff;
          --surface-2: #f8fafc;
          --surface-3: #f1f4f9;
          --border: #e2e6ee;
          --border-strong: #d2d8e3;
          --text: #101828;
          --text-2: #475467;
          --text-3: #667085;
          --accent: #4f6df5;
          --accent-2: #6a8bff;
          --accent-soft: rgba(79,109,245,0.10);
          --accent-border: rgba(79,109,245,0.35);
          --success: #16a34a;
          --danger: #dc2626;
          --warn: #f59e0b;
          --shadow-sm: 0 1px 3px rgba(16,24,40,0.06);
          --shadow-md: 0 8px 24px rgba(16,24,40,0.08);
          --shadow-lg: 0 20px 44px rgba(16,24,40,0.14);
          --radius: 14px;
        }
        .app[data-theme='dark'] {
          --bg: #0b1017;
          --bg-grad-1: #0d1420;
          --bg-grad-2: #0b1017;
          --surface: #141b26;
          --surface-2: #1a2230;
          --surface-3: #202a3a;
          --border: #263140;
          --border-strong: #334154;
          --text: #e7ecf5;
          --text-2: #b6c0cf;
          --text-3: #8794a8;
          --accent: #6a8bff;
          --accent-2: #8aa4ff;
          --accent-soft: rgba(106,139,255,0.14);
          --accent-border: rgba(106,139,255,0.4);
          --success: #22c55e;
          --danger: #f87171;
          --warn: #fbbf24;
          --shadow-sm: 0 1px 3px rgba(0,0,0,0.3);
          --shadow-md: 0 8px 24px rgba(0,0,0,0.4);
          --shadow-lg: 0 20px 44px rgba(0,0,0,0.55);
        }
        * { box-sizing: border-box; }
        body { margin: 0; background: var(--bg); -webkit-tap-highlight-color: transparent; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .auth-screen {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: linear-gradient(160deg, var(--bg-grad-1) 0%, var(--bg-grad-2) 100%);
        }
        .auth-card {
          width: 100%;
          max-width: 400px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 36px;
          box-shadow: var(--shadow-lg);
        }
        .auth-card h1 { margin: 0 0 4px; color: var(--text); font-size: 26px; font-weight: 800; background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
        .auth-card .auth-sub { color: var(--text-3); font-size: 14px; margin-bottom: 26px; }
        .auth-card label { display: block; font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
        .auth-card input {
          width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font: inherit; margin-bottom: 16px; transition: border-color 0.15s, box-shadow 0.15s;
        }
        .auth-card input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .auth-card button {
          width: 100%; border: none; background: linear-gradient(180deg, var(--accent), var(--accent-2)); color: #ffffff; padding: 12px; border-radius: 10px; cursor: pointer; font: inherit; font-size: 15px; font-weight: 600; transition: filter 0.15s, transform 0.05s;
        }
        .auth-card button:hover { filter: brightness(1.08); }
        .auth-card button:active { transform: translateY(1px); }
        .auth-card button:disabled { cursor: wait; opacity: 0.7; }
        .auth-toggle { text-align: center; margin-top: 16px; font-size: 14px; color: var(--text-3); }
        .auth-toggle button { width: auto; background: none; border: none; color: var(--accent); text-decoration: underline; padding: 0; font-size: 14px; }
        .auth-error { color: var(--danger); font-size: 14px; margin-bottom: 12px; }
        .app {
          min-height: 100vh;
          background: var(--bg);
          color: var(--text);
          transition: background 0.25s ease, color 0.25s ease;
        }
        .app-header {
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          padding: 14px 22px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
          position: sticky;
          top: 0;
          z-index: 50;
          backdrop-filter: saturate(180%) blur(8px);
        }
        .app-header .brand { display: flex; align-items: center; gap: 10px; }
        .app-header h1 { margin: 0; font-size: 19px; font-weight: 800; color: var(--text); }
        .app-header .user-chip { display: flex; align-items: center; gap: 8px; }
        .app-header .user-email { font-size: 13px; color: var(--text-3); }
        .container { max-width: 1100px; margin: 0 auto; padding: 22px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 22px; }
        .stat-card, .panel-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; box-shadow: var(--shadow-sm); transition: box-shadow 0.2s ease; }
        .stat-card:hover { box-shadow: var(--shadow-md); }
        .stat-label { font-size: 12px; color: var(--text-3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
        .stat-value { font-size: 23px; font-weight: 800; margin-top: 4px; color: var(--text); }
        .main-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        .panel-card h2, .panel-card h3, .panel-card h4 { margin-top: 0; color: var(--text); font-size: 15px; font-weight: 700; }
        .panel-card label { display: block; font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
        .panel-card input, .panel-card select, .panel-card button, .panel-card textarea { font: inherit; font-size: 14px; }
        .panel-card input, .panel-card select, .panel-card textarea {
          width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); transition: border-color 0.15s, box-shadow 0.15s;
        }
        .panel-card input:focus, .panel-card select:focus, .panel-card textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .panel-card textarea { resize: vertical; min-height: 50px; }
        .panel-card button {
          border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text-2); padding: 9px 14px; border-radius: 9px; cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s;
        }
        .panel-card button:hover { background: var(--surface-3); border-color: var(--accent-border); color: var(--text); }
        .panel-card button:disabled { cursor: wait; opacity: 0.7; }
        .btn-primary { border: none !important; background: linear-gradient(180deg, var(--accent), var(--accent-2)) !important; color: #ffffff !important; font-weight: 600; }
        .btn-primary:hover { background: linear-gradient(180deg, var(--accent), var(--accent-2)) !important; filter: brightness(1.08); color: #fff !important; }
        .btn-sm { font-size: 12px; padding: 6px 10px; }
        .btn-danger { border-color: rgba(220,38,38,0.4) !important; color: var(--danger) !important; }
        .btn-danger:hover { background: rgba(220,38,38,0.08) !important; }
        .btn-warn { border-color: rgba(245,158,11,0.4) !important; color: var(--warn) !important; }
        .btn-warn:hover { background: rgba(245,158,11,0.08) !important; }
        .status-box { margin-top: 12px; padding: 12px 14px; border-radius: 10px; background: var(--accent-soft); border: 1px solid var(--accent-border); color: var(--text); }
        .shift-panel {
          background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; box-shadow: var(--shadow-sm);
        }
        .shift-start {
          border: none; background: linear-gradient(180deg, #22c55e, #16a34a); color: #ffffff; padding: 11px 20px; border-radius: 10px; cursor: pointer; font-size: 15px; font-weight: 600; transition: filter 0.15s;
        }
        .shift-start:hover { filter: brightness(1.08); }
        .shift-end {
          border: none; background: linear-gradient(180deg, #f87171, #dc2626); color: #ffffff; padding: 11px 20px; border-radius: 10px; cursor: pointer; font-size: 15px; font-weight: 600; transition: filter 0.15s;
        }
        .shift-end:hover { filter: brightness(1.08); }
        .profile-list button, .receipt-item {
          width: 100%; text-align: left; border: 1px solid var(--border); background: var(--surface); border-radius: 11px; padding: 13px; cursor: pointer; color: var(--text); margin-bottom: 9px; box-shadow: var(--shadow-sm); transition: border-color 0.15s, box-shadow 0.15s, transform 0.05s;
        }
        .profile-list button:hover { border-color: var(--accent); box-shadow: var(--shadow-md); }
        .profile-list button.active { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .receipt-item { cursor: default; }
        .muted { color: var(--text-3); font-size: 13px; }
        .flex { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .flex-between { display: flex; justify-content: space-between; align-items: center; }
        .mb-8 { margin-bottom: 8px; }
        .mt-8 { margin-top: 8px; }
        .budget-bar { height: 8px; border-radius: 4px; background: var(--surface-3); margin-top: 4px; overflow: hidden; }
        .budget-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
        .budget-ok { background: var(--success); }
        .budget-warn { background: var(--warn); }
        .budget-danger { background: var(--danger); }
        .tag { display: inline-block; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border-strong); font-size: 11px; background: var(--surface-2); color: var(--text-2); }
        .tag-green { border-color: rgba(34,197,94,0.4); background: rgba(34,197,94,0.1); color: var(--success); }
        .tag-deductible { border-color: rgba(34,197,94,0.5); background: rgba(34,197,94,0.12); color: var(--success); font-weight: 600; }
        .tag-partial { border-color: rgba(245,158,11,0.5); background: rgba(245,158,11,0.12); color: var(--warn); font-weight: 600; }
        .tag-personal { border-color: rgba(148,163,184,0.5); background: rgba(148,163,184,0.12); color: var(--text-2); font-weight: 600; }
        .share-card {
          margin-top: 12px; padding: 14px; border-radius: 12px; background: var(--accent-soft); border: 1px solid var(--accent-border);
        }
        .share-card .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 14px; }
        .share-card .row .k { color: var(--text-3); }
        .share-card .row .v { font-weight: 700; }
        .mic-btn { cursor: pointer; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text-2); border-radius: 9px; padding: 8px 12px; font-size: 14px; }
        .mic-btn.recording { border-color: var(--danger); color: var(--danger); animation: pulse 1.2s infinite; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }
        .modal-overlay {
          position: fixed; inset: 0; background: rgba(16,24,40,0.5); display: flex; align-items: center; justify-content: center; z-index: 100;
        }
        .modal {
          background: var(--surface); border: 1px solid var(--border); border-radius: 18px; padding: 26px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: var(--shadow-lg);
        }
        .modal h3 { margin-top: 0; }
        .theme-toggle { display: flex; align-items: center; gap: 8px; }
        .theme-toggle .toggle-track { width: 44px; height: 24px; border-radius: 999px; background: var(--surface-3); border: 1px solid var(--border-strong); position: relative; cursor: pointer; transition: background 0.2s; }
        .theme-toggle .toggle-track[data-on='true'] { background: var(--accent); }
        .theme-toggle .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left 0.2s; }
        .theme-toggle .toggle-track[data-on='true'] .toggle-thumb { left: 22px; }
        @media (max-width: 900px) {
          .main-grid { grid-template-columns: 1fr; }
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
          .container { padding: 14px; }
        }
        @media (max-width: 600px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
          .stat-card { padding: 12px; }
          .stat-value { font-size: 19px; }
          .panel-card { padding: 14px; }
          .panel-card input, .panel-card select, .panel-card button { font-size: 15px; padding: 10px; }
          .profile-list button, .receipt-item { padding: 13px; }
          .app-header { padding: 12px 16px; }
          .app-header h1 { font-size: 17px; }
          .modal { padding: 20px; width: 95%; }
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
            <div className="auth-sub">{resetToken ? 'Set a new password' : authMode === 'login' ? 'Welcome back — sign in to your account' : 'Create an account — your receipts, private to you'}</div>
            {authError && <div className="auth-error">{authError}</div>}
            <label>Email</label>
            <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            <label>Password</label>
            <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="At least 8 characters" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} onKeyDown={e => e.key === 'Enter' && (resetToken ? doReset() : doAuth(authMode))} />
            {authMode === 'register' && (
              <div className="muted" style={{ marginTop: -8, marginBottom: 14, fontSize: 12 }}>
                Use 8+ characters with upper & lowercase letters and a number.
              </div>
            )}
            {resetToken ? (
              <button onClick={doReset} disabled={authLoading}>
                {authLoading ? 'Please wait...' : 'Reset Password'}
              </button>
            ) : (
              <button onClick={() => doAuth(authMode)} disabled={authLoading}>
                {authLoading ? 'Please wait...' : authMode === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            )}
            {authMode === 'login' && (
              <div className="auth-toggle">
                <button onClick={() => setAuthMode('forgot')}>Forgot your password?</button>
              </div>
            )}
            {authMode === 'forgot' ? (
              <div style={{ marginTop: 4 }}>
                <label>Email</label>
                <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
                <button onClick={doForgot} disabled={authLoading}>
                  {authLoading ? 'Please wait...' : 'Send Reset Link'}
                </button>
                {authError && <div className="auth-error">{authError}</div>}
                <div className="auth-toggle">
                  <button onClick={() => { setAuthMode('login'); setAuthError('') }}>Back to sign in</button>
                </div>
              </div>
            ) : (
              <div className="auth-toggle">
                {authMode === 'login' ? "New here? " : 'Already have an account? '}
                <button onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setAuthError('') }}>
                  {authMode === 'login' ? 'Create an account' : 'Sign in'}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
      <>
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
              <h3>Settings</h3>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Appearance</div>
                  <div className="muted">Switch between light and dark mode</div>
                </div>
                <div className="theme-toggle" onClick={toggleTheme}>
                  <span style={{ fontSize: 13 }}>{theme === 'dark' ? 'Dark' : 'Light'}</span>
                  <div className="toggle-track" data-on={theme === 'dark'}><div className="toggle-thumb" /></div>
                </div>
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
            <div>
              <div className="flex" style={{ gap: 8, alignItems: 'stretch' }}>
                <input
                  placeholder="Shift purpose (e.g. DoorDash lunch rush)"
                  value={shiftPurpose}
                  onChange={e => setShiftPurpose(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button onClick={toggleVoiceNote} className={`mic-btn ${isRecording ? 'recording' : ''}`} title="Speak the shift purpose">
                  {isRecording ? '● Listening…' : '🎤'}
                </button>
                <button onClick={startShift} className="shift-start" style={{ whiteSpace: 'nowrap' }}>▶ Start Shift</button>
              </div>
              {lastShiftSummary && !activeShift && (
                <div className="share-card">
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Last shift logged</div>
                  <div className="row"><span className="k">Purpose</span><span className="v">{lastShiftSummary.purpose}</span></div>
                  <div className="row"><span className="k">Miles</span><span className="v">{lastShiftSummary.miles.toFixed(1)} mi</span></div>
                  <div className="row"><span className="k">Est. deduction</span><span className="v">{money(lastShiftSummary.deduction)}</span></div>
                  <button className="btn-sm btn-primary" style={{ marginTop: 10, width: '100%' }} onClick={shareShiftSummary}>Share Summary</button>
                </div>
              )}
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
                  {dashboardReceipts.map(r => {
                    const dmeta = deductibleMeta(r)
                    return (
                    <div key={r.id} className="receipt-item">
                      <div className="flex-between">
                        <div style={{ fontWeight: 700 }}>{r.vendor}</div>
                        <div className="flex" style={{ gap: 4 }}>
                          <span className={`tag ${dmeta.cls}`} title={dmeta.hint}>{dmeta.label}</span>
                          {r.category && <span className="tag">{r.category}</span>}
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
                    )
                  })}
                </div>
              </div>
            )}
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
