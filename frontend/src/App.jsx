import React, { useState, useEffect, useRef } from 'react'
import GodsEyeView from './components/GodsEyeView'
import SettlementView from './components/SettlementView'

const API_BASE = (import.meta.env.VITE_API_BASE ?? 'https://tfe-hub.onrender.com').replace(/\/+$/, '')

const DEFAULT_GROUPS = 'starlink,oneweb,iridium-next,gps,galileo,glonass,beidou,geo,iss'

// Stream reader for the Code Forge SSE responses (POST + fetch reader; the
// server paces chunks casually so the reveal feels live without racing).
async function readSse(resp, onEvent) {
  const ct = resp.headers.get('content-type') || ''
  if (!ct.includes('text/event-stream')) return false
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const evt = buf.slice(0, i); buf = buf.slice(i + 2)
      for (const ln of evt.split('\n')) {
        if (ln.startsWith('data: ')) {
          try { onEvent(JSON.parse(ln.slice(6))) } catch { /* skip malformed frame */ }
        }
      }
    }
  }
  return true
}

function getDeviceId() {
  let id = localStorage.getItem('fortress_device_id')
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => (c === 'x' ? Math.random() * 16 | 0 : 8 | Math.random() * 16).toString(16))
    localStorage.setItem('fortress_device_id', id)
  }
  return id
}
const DEVICE_ID = getDeviceId()

const STARS = Array.from({ length: 90 }, (_, i) => ({
  left: (i * 137.5) % 100,
  top: (i * 61.8) % 100,
  size: 1 + (i % 3) * 0.6,
  tw: `${2.5 + (i % 5)}s`,
}))

const VIEWS = [
  { id: 'command', label: 'Command Core', icon: '◉', desc: 'JARV mind — chat + AI relay over the Genie mesh' },
  { id: 'gods-eye', label: "God's Eye", icon: '◍', desc: 'Live global satellite OSINT on the Earth globe' },
  { id: 'forge', label: 'Code Forge', icon: '⌁', desc: 'Sandboxed CLI + MCP + IDE to build from the hub' },
]

const PROVIDER_KEYS = [
  { name: 'Groq', env: 'GROQ_API_KEY', url: 'https://console.groq.com/keys', note: 'fast Llama + large context' },
  { name: 'Cerebras', env: 'CEREBRAS_API_KEY', url: 'https://cloud.cerebras.ai/', note: 'fastest inference' },
  { name: 'Google Gemini', env: 'GEMINI_API_KEY', url: 'https://aistudio.google.com/app/apikey', note: 'frontier models, big free tier' },
  { name: 'Mistral', env: 'MISTRAL_API_KEY', url: 'https://console.mistral.ai/', note: '1B tokens/mo free' },
  { name: 'OpenRouter', env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/keys', note: 'many :free model routes' },
  { name: 'NVIDIA', env: 'NVIDIA_API_KEY', url: 'https://build.nvidia.com/', note: 'no card needed' },
  { name: 'SambaNova', env: 'SAMBANOVA_API_KEY', url: 'https://cloud.sambanova.ai/', note: 'no card needed' },
  { name: 'GitHub Models', env: 'GITHUB_MODELS_TOKEN', url: 'https://github.com/marketplace/models', note: 'GPT-4o / o3' },
  { name: 'Cohere', env: 'COHERE_API_KEY', url: 'https://dashboard.cohere.com/', note: '1K calls/mo' },
  { name: 'SiliconFlow', env: 'SILICONFLOW_API_KEY', url: 'https://cloud.siliconflow.cn/', note: 'no card needed' },
  { name: 'Together', env: 'TOGETHER_API_KEY', url: 'https://api.together.xyz/', note: 'no card needed' },
  { name: 'Hugging Face', env: 'HUGGINGFACE_API_KEY', url: 'https://huggingface.co/settings/tokens', note: '300+ models' },
  { name: 'Fireworks', env: 'FIREWORKS_API_KEY', url: 'https://fireworks.ai/', note: 'no card needed' },
  { name: 'Nebius', env: 'NEBIUS_API_KEY', url: 'https://studio.nebius.ai/', note: 'DeepSeek V3' },
  { name: 'Scaleway', env: 'SCALEWAY_API_KEY', url: 'https://console.scaleway.com/', note: 'generative APIs' },
  { name: 'Z.AI', env: 'ZAI_API_KEY', url: 'https://open.bigmodel.cn/', note: 'GLM models' },
  { name: 'Venice', env: 'VENICE_API_KEY', url: 'https://venice.ai/', note: 'no card needed' },
  { name: 'Hyperbolic', env: 'HYPERBOLIC_API_KEY', url: 'https://app.hyperbolic.xyz/', note: 'no card needed' },
  { name: 'Novita', env: 'NOVITA_API_KEY', url: 'https://novita.ai/', note: 'no card needed' },
  { name: 'Cloudflare', env: 'CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID', url: 'https://dash.cloudflare.com/profile/api-tokens', note: 'Workers AI' },
]
const KEYS_DEST = "backend/.env"

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

function linkMeta(comms) {
  if (!comms || !comms.peer) return { label: 'Genie Link standby', tone: 'gray' }
  const socketOnline = comms.outbound && comms.outbound.socket === true
  const peer = comms.peer
  let label, tone
  if (socketOnline) { label = 'Genie Link online'; tone = 'green' }
  else if (peer.status === 'reconnecting') { label = 'Genie Link reconnecting'; tone = 'amber' }
  else { label = 'Genie Link standby'; tone = 'gray' }
  if (comms.mode === 'satellite') label = `Sat-link · ${label.replace('Genie Link ', '')}`
  const backlog = comms.outbox && comms.outbox.pending
  if (backlog > 0) label += ` · queue ${backlog}`
  if (comms.ai && comms.ai.enabled) {
    label += ' · DeepSeek ready'
    if (comms.ai.model && !label.includes(comms.ai.model)) label += ` (${comms.ai.model})`
  }
  return { label, tone }
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

  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)
  const showToast = (msg) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3000)
  }

  const [showSettings, setShowSettings] = useState(false)
  // Deep links: the URL fragment names a view (defaults to Command Core). JARV and
  // the docks open the hub with e.g. /#gods-eye to land on the God's Eye globe.
  const viewFromHash = () => {
    const h = (typeof window !== 'undefined' ? window.location.hash : '#').replace(/^#\/?/, '').toLowerCase()
    return VIEWS.some((v) => v.id === h) ? h : 'command'
  }
  const [view, setView] = useState(viewFromHash)
  useEffect(() => {
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [theme, setTheme] = useState(() => localStorage.getItem('fortress_theme') || 'light')
  const [comms, setComms] = useState(null)
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)

  const [keyProviders, setKeyProviders] = useState([])
  const [keyInputs, setKeyInputs] = useState({})
  const [keyStatus, setKeyStatus] = useState('')
  const [keysBusy, setKeysBusy] = useState(false)

  const [vibePending, setVibePending] = useState(null)
  const [cliPending, setCliPending] = useState(null)

  const [workspace, setWorkspace] = useState(null)
  const [autoShell, setAutoShell] = useState(false)
  const [autoNet, setAutoNet] = useState(false)
  const [autoStatus, setAutoStatus] = useState('')

  const [hubLocation, setHubLocation] = useState(null)
  const [hubLocSource, setHubLocSource] = useState('no fix')
  const [locError, setLocError] = useState('')
  const [manualLat, setManualLat] = useState('')
  const [manualLon, setManualLon] = useState('')
  const [globePositions, setGlobePositions] = useState([])
  const [globeLoading, setGlobeLoading] = useState(false)
  const [globeError, setGlobeError] = useState('')
  const [selectedSatellite, setSelectedSatellite] = useState(null)

  const [chatMsgs, setChatMsgs] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatEndRef = useRef(null)
  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [chatMsgs, chatLoading])

  const [cliLines, setCliLines] = useState([])
  const [cliInput, setCliInput] = useState('')
  const [cliBusy, setCliBusy] = useState(false)
  const [liveCli, setLiveCli] = useState('')
  const cliAcc = useRef('')
  const cliEndRef = useRef(null)
  useEffect(() => { if (cliEndRef.current) cliEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [cliLines, cliBusy, liveCli])
  const [cliApprove, setCliApprove] = useState(false)
  const [forgeTab, setForgeTab] = useState('vibe')
  const [vibeInput, setVibeInput] = useState('')
  const [vibeBusy, setVibeBusy] = useState(false)
  const [vibeLines, setVibeLines] = useState([])
  const [liveVibe, setLiveVibe] = useState('')
  const vibeAcc = useRef('')
  const vibeEndRef = useRef(null)
  useEffect(() => { if (vibeEndRef.current) vibeEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [vibeLines, vibeBusy, liveVibe])

  // ---- Mac permissions (TCC) card ----
  const [perm, setPerm] = useState(null)
  const [permBusy, setPermBusy] = useState(false)

  // ---- OSINT quick-query prefs ----
  const [osintPrefs, setOsintPrefs] = useState(null)
  const [scanGroups, setScanGroups] = useState(DEFAULT_GROUPS)
  const [scanMinEl, setScanMinEl] = useState(10)
  const [scanPasses, setScanPasses] = useState(3)
  const [scanBusy, setScanBusy] = useState(false)
  const [scanResult, setScanResult] = useState(null)

  const [tree, setTree] = useState([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [currentFile, setCurrentFile] = useState('')
  const [editor, setEditor] = useState('')
  const [fileMeta, setFileMeta] = useState(null)
  const [saving, setSaving] = useState(false)
  const [runLog, setRunLog] = useState('')

  const sendJarvMessage = async () => {
    const text = chatInput.trim()
    if (!text || chatLoading) return
    const history = chatMsgs
      .map(m => ({ role: m.role === 'jarv' ? 'assistant' : 'user', content: m.text }))
      .slice(-10)
    const next = [...chatMsgs, { role: 'user', text }]
    setChatMsgs(next)
    setChatInput('')
    setChatLoading(true)
    try {
      const r = await fetch(`${API_BASE}/api/jarv/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      })
      const j = await r.json()
      if (j.ok) {
        setChatMsgs(prev => [...prev, { role: 'jarv', text: j.reply, meta: `${j.provider || 'jarv-mesh'}${j.model ? ` · ${j.model}` : ''}${j.turns ? ` · ${j.turns} turn${j.turns > 1 ? 's' : ''}` : ''}${j.toolCalls && j.toolCalls.length ? ` · tools: ${j.toolCalls.map(t => t.name).join(', ')}` : ''}` }])
      } else {
        setChatMsgs(prev => [...prev, { role: 'jarv', text: `⚠ ${j.error || 'JARV relay failed'}`, meta: 'error' }])
      }
    } catch (e) {
      setChatMsgs(prev => [...prev, { role: 'jarv', text: `⚠ Cannot reach JARV: ${String(e)}`, meta: 'error' }])
    }
    setChatLoading(false)
  }

  const promptLine = (s) => `[jarv@hub ${'jarv-sandbox'}]# ${s}`

  const pushCli = (kind, text) => setCliLines(prev => [...prev, { kind, text }])

  const runCli = async (approve) => {
    const line = (approve && cliPending && cliPending.command) || cliInput.trim()
    if (!line || cliBusy) return
    if (!approve) { pushCli('in', promptLine(line)); setCliInput('') }
    setCliBusy(true)
    cliAcc.current = ''
    const handleStream = (j) => {
      if (j.type === 'chunk') { cliAcc.current += j.text; setLiveCli(cliAcc.current) }
      else if (j.type === 'approval') {
        cliAcc.current = ''; setLiveCli('')
        setCliPending({ command: line, needsApproval: j.needsApproval || [] })
        pushCli('out', `JARV wants to ${(j.needsApproval || []).map(t => t.name.replace('jarv_', '')).join(' + ')} — choose approval below.`)
        if (j.reply) pushCli('out', `   ${j.reply.slice(0, 300)}`)
      } else if (j.type === 'done') {
        const full = cliAcc.current; cliAcc.current = ''; setLiveCli('')
        if (j.ok) {
          pushCli('out', `[${j.provider || 'jarv'}]${j.model ? ` (${j.model})` : ''}: ${full}${j.toolCalls && j.toolCalls.length ? `\n   ↳ tools: ${j.toolCalls.map(t => t.name + (t.args && Object.keys(t.args).length ? ' ' + JSON.stringify(t.args) : '')).join(', ')}` : ''}`)
          if (j.turns) pushCli('out', `   ↳ ${j.turns} turn${j.turns > 1 ? 's' : ''}`)
          if ((j.toolCalls || []).some(t => t.name === 'jarv_write')) loadTree()
        } else {
          pushCli('err', `⛔ ${j.error || 'no reply'}`)
        }
      } else if (j.type === 'error') { cliAcc.current = ''; setLiveCli(''); pushCli('err', `⛔ ${j.message || 'stream failed'}`) }
    }
    try {
      const r = await fetch(`${API_BASE}/api/jarv/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(approve ? { command: line, approval: approve, stream: true } : { command: line, unlock: cliApprove, stream: true }),
      })
      const usedStream = await readSse(r, handleStream)
      if (usedStream) { setCliBusy(false); return }
      const j = await r.json()
      if (j.needsApproval && j.needsApproval.length && !approve) {
        setCliPending({ command: line, needsApproval: j.needsApproval })
        pushCli('out', `JARV wants to ${j.needsApproval.map(t => t.name.replace('jarv_', '')).join(' + ')} — choose approval below.`)
        if (j.reply) pushCli('out', `   ${j.reply.slice(0, 300)}`)
      } else {
        setCliPending(null)
        if (j.ok && (j.reply !== undefined)) {
          pushCli('out', `[${j.provider || 'jarv'}]${j.model ? ` (${j.model})` : ''}: ${j.reply}${j.toolCalls && j.toolCalls.length ? `\n   ↳ tools: ${j.toolCalls.map(t => t.name + (t.args && Object.keys(t.args).length ? ' ' + JSON.stringify(t.args) : '')).join(', ')}` : ''}`)
          if (j.turns) pushCli('out', `   ↳ ${j.turns} turn${j.turns > 1 ? 's' : ''}`)
        } else if (j.blocked && !j.tool) {
          pushCli('err', `⛔ ${j.error}`)
          pushCli('err', `   tip: tick the "approve write/edit/run" box to allow one-shot, or pick an approval level below.`)
        } else if (j.tool) {
          if (j.ok && j.exitCode === undefined) {
            pushCli('out', j.stdout ? j.stdout : JSON.stringify(j, null, 2).slice(0, 4000))
          } else if (j.exitCode !== undefined) {
            pushCli('out', `exit ${j.exitCode}${j.stdout ? `\n${j.stdout}` : ''}${j.stderr ? `\n[stderr] ${j.stderr}` : ''}`)
          } else {
            pushCli('err', `⛔ ${j.error || 'command failed'}`)
          }
        } else {
          pushCli('err', `⛔ ${j.error || ('HTTP ' + r.status)}`)
        }
      }
    } catch (e) {
      pushCli('err', `⛔ connection failed: ${String(e.message || e)}`)
    }
    setCliBusy(false)
  }

  const pushVibe = (kind, text) => setVibeLines(prev => [...prev, { kind, text }])

  const runVibe = async (approve) => {
    const ask = (approve && vibePending && vibePending.command) || vibeInput.trim()
    if (!ask || vibeBusy) return
    if (!approve) { pushVibe('in', ask); setVibeInput('') }
    setVibeBusy(true)
    vibeAcc.current = ''
    pushVibe('out', approve ? '…re-running with your approval…' : '…JARV is shaping that into workspace scripts…')
    const handleStream = (j) => {
      if (j.type === 'start') { setVibeLines(prev => prev.filter(l => !l.text.startsWith('…'))) }
      else if (j.type === 'chunk') { vibeAcc.current += j.text; setLiveVibe(vibeAcc.current) }
      else if (j.type === 'approval') {
        vibeAcc.current = ''; setLiveVibe('')
        setVibePending({ command: ask, needsApproval: j.needsApproval || [] })
        pushVibe('out', `JARV wants to ${(j.needsApproval || []).map(t => t.name.replace('jarv_', '')).join(' + ')}`)
        if (j.reply) pushVibe('code', j.reply.slice(0, 400))
      } else if (j.type === 'done') {
        const full = vibeAcc.current; vibeAcc.current = ''; setLiveVibe('')
        if (j.ok) {
          pushVibe('out', `[${j.provider || 'jarv'}${j.model ? ` · ${j.model}` : ''}${j.turns ? ` · ${j.turns} turn${j.turns > 1 ? 's' : ''}` : ''}]`)
          pushVibe('code', full || '(no reply)')
          if (j.toolCalls && j.toolCalls.length) {
            pushVibe('out', `↳ tools used: ${j.toolCalls.map(t => t.name).join(', ')}`)
            const written = j.toolCalls.find(t => t.name === 'jarv_write')
            if (written && written.args && written.args.path) {
              pushVibe('out', `↳ wrote ${written.args.path} — open it in the IDE tab.`)
              loadTree()
            }
          }
        } else {
          pushVibe('err', `⛔ ${j.error || 'no reply'}`)
        }
      } else if (j.type === 'error') { vibeAcc.current = ''; setLiveVibe(''); pushVibe('err', `⛔ ${j.message || 'stream failed'}`) }
    }
    try {
      const r = await fetch(`${API_BASE}/api/jarv/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(approve ? { command: ask, approval: approve, stream: true } : { command: ask, stream: true }),
      })
      const usedStream = await readSse(r, handleStream)
      if (usedStream) { setVibeBusy(false); return }
      const j = await r.json()
      const stain = approve ? '…re-running with your approval…' : '…JARV is shaping that into workspace scripts…'
      setVibeLines(prev => prev.filter(l => l.text !== stain))
      if (j.needsApproval && j.needsApproval.length && !approve) {
        setVibePending({ command: ask, needsApproval: j.needsApproval })
        pushVibe('out', `JARV wants to ${j.needsApproval.map(t => t.name.replace('jarv_', '')).join(' + ')}`)
        if (j.reply) pushVibe('code', j.reply.slice(0, 400))
      } else {
        setVibePending(null)
        if (j.ok) {
          pushVibe('out', `[${j.provider || 'jarv'}${j.model ? ` · ${j.model}` : ''}${j.turns ? ` · ${j.turns} turn${j.turns > 1 ? 's' : ''}` : ''}]`)
          pushVibe('code', j.reply || '(no reply)')
          if (j.toolCalls && j.toolCalls.length) {
            pushVibe('out', `↳ tools used: ${j.toolCalls.map(t => t.name).join(', ')}`)
            const written = j.toolCalls.find(t => t.name === 'jarv_write')
            if (written && written.args && written.args.path) {
              pushVibe('out', `↳ wrote ${written.args.path} — open it in the IDE tab.`)
              loadTree()
            }
          }
        } else {
          pushVibe('err', `⛔ ${j.error || ('HTTP ' + r.status)}`)
        }
      }
    } catch (e) {
      setVibeLines(prev => prev.filter(l => l.text.startsWith('…')))
      pushVibe('err', `⛔ connection failed: ${String(e.message || e)}`)
    }
    setVibeBusy(false)
  }

  const openVibeFile = async (name) => {
    setRunLog('')
    await openFile(name)
  }

  const loadTree = async () => {
    setTreeLoading(true)
    try {
      const r = await fetch(`${API_BASE}/api/jarv/code/list`)
      const j = await r.json()
      if (j.ok) setTree(j.entries || [])
    } catch (e) { /* ignore */ }
    setTreeLoading(false)
  }
  useEffect(() => { if (user) loadTree() }, [user])

  const openFile = async (name) => {
    let path = name
    const r = await fetch(`${API_BASE}/api/jarv/code/read?path=${encodeURIComponent(path)}`)
    const j = await r.json()
    if (j.ok) {
      setCurrentFile(path)
      setFileMeta(j)
      setEditor(j.binary ? '' : (j.content || ''))
      setRunLog('')
    }
  }

  const saveFile = async () => {
    if (!currentFile) return
    setSaving(true)
    try {
      const r = await fetch(`${API_BASE}/api/jarv/code/write`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentFile, content: editor }),
      })
      const j = await r.json()
      showToast(j.ok ? `Saved ${currentFile}` : `Save failed: ${j.error || 'HTTP ' + r.status}`)
    } catch (e) { showToast(`Save failed: ${String(e)}`) }
    setSaving(false)
  }

  const runEditor = async () => {
    if (!currentFile) return
    setRunLog('running…')
    try {
      const r = await fetch(`${API_BASE}/api/jarv/code/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `node ${currentFile}` }),
      })
      const j = await r.json()
      setRunLog(j.ok ? `$ node ${currentFile}\n${j.stdout || ''}${j.stderr ? `\n[stderr] ${j.stderr}` : ''}${j.exitCode !== undefined ? `\n[exit ${j.exitCode}]` : ''}` : `⛔ ${j.error || 'HTTP ' + r.status}`)
    } catch (e) { setRunLog(`⛔ ${String(e)}`) }
  }

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
  }

  useEffect(() => {
    // Genie Link + connectivity status (polls `/api/comms/status` every 30s).
    if (!user) return
    const tick = () => {
      fetch(`${API_BASE}/api/comms/status`)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('comms unavailable'))))
        .then(j => setComms(j.mesh))
        .catch(() => {})
    }
    tick()
    const t = setInterval(tick, 30000)
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      clearInterval(t)
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [user])

  // ---- Settings: cloud API keys ----
  const loadKeys = async (silent) => {
    if (!user) return
    try {
      const r = await fetch(`${API_BASE}/api/ai/providers`)
      const j = await r.json()
      if (j.ok && Array.isArray(j.providers)) {
        setKeyProviders(j.providers)
        if (!silent) setKeyStatus('')
      }
    } catch (e) { if (!silent) setKeyStatus('Cannot reach server') }
  }
  const saveKeys = async () => {
    if (!user) return
    setKeysBusy(true)
    setKeyStatus('Saving…')
    try {
      const r = await fetch(`${API_BASE}/api/ai/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keyInputs }),
      })
      const j = await r.json()
      if (j.ok) {
        setKeyStatus(j.errors && j.errors.length ? ('Saved — ' + j.errors.join('; ')) : 'Saved. Keys activate immediately.')
        if (Array.isArray(j.providers)) setKeyProviders(j.providers)
        setKeyInputs({})
      } else {
        setKeyStatus(j.error || 'Save failed')
      }
    } catch (e) { setKeyStatus('Cannot reach server') }
    setKeysBusy(false)
  }

  // ---- Mac permissions (TCC): verify JARV's hands are granted ----
  const checkPermissions = async (deep) => {
    if (!user) return
    setPermBusy(true)
    try {
      const opts = deep ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deep: true }) } : undefined
      const r = await fetch(`${API_BASE}/api/jarv/permissions`, opts)
      const j = await r.json()
      setPerm(j.ok ? j : { ok: false, axTrusted: false, ocr: { ok: false }, error: j.error || ('HTTP ' + r.status) })
    } catch (e) { setPerm({ ok: false, axTrusted: false, ocr: { ok: false }, error: String(e) }) }
    setPermBusy(false)
  }
  useEffect(() => { if (user) checkPermissions(false) }, [user])

  // ---- JARV workspace + autonomy ----
  const loadWorkspace = async () => {
    if (!user) return
    try {
      const r = await fetch(`${API_BASE}/api/jarv/workspace`)
      const j = await r.json()
      if (j.ok) {
        setWorkspace(j)
        setAutoShell(j.autonomousShell)
        setAutoNet(j.autonomousNet)
      }
    } catch (e) { /* ignore */ }
  }
  const saveAutonomy = async () => {
    if (!user) return
    setAutoStatus('Saving…')
    try {
      const r = await fetch(`${API_BASE}/api/settings/autonomy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shell: autoShell, net: autoNet }),
      })
      const j = await r.json()
      setAutoStatus(j.ok ? 'Saved.' : (j.error || 'Save failed'))
      if (j.ok) { setAutoShell(j.autonomousShell); setAutoNet(j.autonomousNet) }
    } catch (e) { setAutoStatus('Cannot reach server') }
  }
  const resetSessionApprovals = async () => {
    if (!user) return
    try {
      await fetch(`${API_BASE}/api/settings/autonomy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetSession: true }),
      })
      setAutoStatus('Session approval cleared.')
      setVibePending(null)
      setCliPending(null)
    } catch (e) { setAutoStatus('Cannot reach server') }
  }

  // ---- OSINT: JARV satellite-comms intelligence (OrbitDeck) ----
  // ---- Hub location services + sanctuary globe ----
  const loadHubLocation = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/location`)
      const j = await r.json()
      if (j.ok) {
        setHubLocation({ lat: Number(j.lat), lon: Number(j.lon) })
        setHubLocSource(j.source || 'hub')
        return { lat: j.lat, lon: j.lon, source: j.source }
      }
      setHubLocation(null)
      setHubLocSource('no fix')
      return null
    } catch (e) {
      setHubLocation(null)
      return null
    }
  }

  const reportDeviceLocation = async () => {
    setLocError('')
    if (!navigator.geolocation) return setLocError('Geolocation is not available on this device')
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 }))
      const r = await fetch(`${API_BASE}/api/location/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy || null }),
      })
      const j = await r.json()
      if (j.ok) {
        const here = await loadHubLocation()
        setLocError('')
        return j
      }
      setLocError(j.error || 'position report failed')
    } catch (e) {
      if (e && e.code === 1) setLocError('Location permission denied — grant it or set the manual grid.')
      else setLocError(String((e && e.message) || e))
    }
  }

  const setManualGrid = async () => {
    const lat = Number(manualLat); const lon = Number(manualLon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return setLocError('Enter valid latitude and longitude')
    setLocError('')
    const r = await fetch(`${API_BASE}/api/location/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon }),
    })
    const j = await r.json()
    if (j.ok) {
      await loadHubLocation()
      setManualLat(''); setManualLon('')
    } else {
      setLocError(j.error || 'manual grid failed')
    }
  }

  const loadGlobe = async () => {
    setGlobeLoading(true)
    setGlobeError('')
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 20000)
    try {
      const groups = (osintPrefs && osintPrefs.groups) || DEFAULT_GROUPS
      const r = await fetch(`${API_BASE}/api/osint/globe?satellites=${encodeURIComponent(groups)}`, { signal: ctrl.signal })
      const j = await r.json()
      if (j.ok && Array.isArray(j.positions)) {
        setGlobePositions(j.positions)
        setGlobeError((j.satellites_tracked === 0) ? 'No satellites reported — CelesTrak may be unavailable; cached constellations fall back automatically.' : '')
      } else setGlobeError((j && j.error) || 'globe projection unavailable')
    } catch (e) {
      if (e.name === 'AbortError') setGlobeError('satellite feed timed out (CelesTrak unreachable) — the globe still renders; cached data will fill in when the link returns')
      else setGlobeError(String(e))
    } finally {
      clearTimeout(to)
      setGlobeLoading(false)
    }
  }

  // ---- OSINT quick-query: remember last scan params + one-tap sky scan ----
  const loadOsintPrefsState = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/osint/prefs`)
      const j = await r.json()
      if (j.ok && j.prefs) {
        setOsintPrefs(j.prefs)
        if (j.prefs.groups) setScanGroups(j.prefs.groups)
        if (j.prefs.min_el != null) setScanMinEl(Number(j.prefs.min_el))
        if (j.prefs.passes != null) setScanPasses(Number(j.prefs.passes))
      }
    } catch (e) { /* ignore */ }
  }

  const runQuickScan = async () => {
    if (scanBusy) return
    setScanBusy(true)
    setScanResult(null)
    try {
      const r = await fetch(`${API_BASE}/api/osint/satvision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ satellites: scanGroups, min_el: scanMinEl, passes: scanPasses }),
      })
      const j = await r.json()
      let passes = null
      let at = null
      if (j.ok) {
        if (Array.isArray(j.passes)) { passes = j.passes; at = j.at || null }
        else if (j.stdout) {
          try { const data = JSON.parse(j.stdout); passes = Array.isArray(data.passes) ? data.passes : null; at = data.timestamp || null } catch { /* ignore */ }
        }
      }
      if (passes) {
        setScanResult({ passes: passes.slice(0, 12), at, groups: scanGroups })
        setOsintPrefs({ groups: scanGroups, min_el: scanMinEl, passes: scanPasses })
      } else {
        setGlobeError((j && j.error) || 'sky scan returned no passes')
      }
    } catch (e) { setGlobeError(`sky scan: ${String(e)}`) }
    setScanBusy(false)
  }

  useEffect(() => {
    if (!user) return
    loadHubLocation()
    loadGlobe()
    loadOsintPrefsState()
    const t = setInterval(loadGlobe, 60000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const globeGroupCounts = globePositions.reduce((acc, p) => {
    const g = p.group || 'other'
    acc[g] = (acc[g] || 0) + 1
    return acc
  }, {})
  const globeConstellations = Object.keys(globeGroupCounts).length

  return (
    <div className="app" data-theme={theme}>
      <style>{`
        .app { color-scheme: light; }
        .app[data-theme='dark'] { color-scheme: dark; }
        .app {
          --bg: #eef1fb;
          --bg-grad-1: #e6eaff;
          --bg-grad-2: #eef1fb;
          --surface: rgba(255,255,255,0.82);
          --surface-2: rgba(248,250,255,0.9);
          --surface-3: rgba(238,242,255,0.95);
          --border: #dfe3f5;
          --border-strong: #cdd3f0;
          --text: #10162e;
          --text-2: #4a5278;
          --text-3: #6a7399;
          --accent: #6a4ff5;
          --accent-2: #8a5bff;
          --accent-soft: rgba(106,79,245,0.10);
          --accent-border: rgba(106,79,245,0.35);
          --teal: #2dd4bf;
          --gold: #f5b84f;
          --success: #10b981;
          --danger: #ef4444;
          --warn: #f59e0b;
          --shadow-sm: 0 1px 3px rgba(28,20,80,0.10);
          --shadow-md: 0 8px 28px rgba(28,20,80,0.16);
          --shadow-lg: 0 20px 48px rgba(28,20,80,0.26);
          --radius: 16px;
        }
        .app[data-theme='dark'] {
          --bg: #06030f;
          --bg-grad-1: #0b0520;
          --bg-grad-2: #06030f;
          --surface: rgba(20,14,44,0.72);
          --surface-2: rgba(28,20,60,0.78);
          --surface-3: rgba(38,28,78,0.85);
          --border: #2a1f52;
          --border-strong: #3b2f6e;
          --text: #ede7ff;
          --text-2: #c2b6ee;
          --text-3: #9489c9;
          --accent: #8a5bff;
          --accent-2: #b06aff;
          --accent-soft: rgba(138,91,255,0.18);
          --accent-border: rgba(138,91,255,0.45);
          --teal: #2dd4bf;
          --gold: #f5b84f;
          --success: #34d399;
          --danger: #f87171;
          --warn: #fbbf24;
          --shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
          --shadow-md: 0 10px 34px rgba(80,20,200,0.28);
          --shadow-lg: 0 24px 56px rgba(80,20,200,0.4);
        }
        .app {
          position: relative;
          isolation: isolate;
        }
        .app::before {
          content: '';
          position: fixed; inset: 0; z-index: -2;
          background:
            radial-gradient(circle at 18% 12%, var(--bg-grad-1) 0%, transparent 46%),
            radial-gradient(circle at 84% 8%, rgba(122,90,255,0.28) 0%, transparent 42%),
            radial-gradient(circle at 70% 92%, rgba(45,212,191,0.18) 0%, transparent 46%),
            var(--bg);
        }
        .app[data-theme='dark']::before {
          background:
            radial-gradient(circle at 18% 12%, rgba(74,32,160,0.5) 0%, transparent 46%),
            radial-gradient(circle at 84% 8%, rgba(122,90,255,0.28) 0%, transparent 42%),
            radial-gradient(circle at 40% 80%, rgba(45,120,160,0.22) 0%, transparent 50%),
            radial-gradient(circle at 70% 92%, rgba(190,90,255,0.18) 0%, transparent 46%),
            var(--bg);
        }
        .starfield { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
        .starfield i {
          position: absolute; border-radius: 50%; background: #fff;
          animation: starTwinkle var(--tw, 4s) ease-in-out infinite alternate;
        }
        .starfield i:nth-child(3n) { background: var(--teal); }
        .starfield i:nth-child(4n) { background: var(--gold); }
        @keyframes starTwinkle { from { opacity: 0.15; } to { opacity: 0.9; } }
        .sphere { position: fixed; border-radius: 50%; pointer-events: none; z-index: -1; opacity: 0.7; filter: blur(0.2px); }
        .sphere-1 { width: 150px; height: 150px; top: 12%; left: -40px; background: radial-gradient(circle at 32% 30%, #ffd9a0, #b06aff 55%, #4a2a7a 90%); box-shadow: inset -18px -16px 40px rgba(0,0,0,0.5), 0 0 40px rgba(176,106,255,0.35); }
        .sphere-2 { width: 90px; height: 90px; top: 34%; right: 6%; background: radial-gradient(circle at 34% 30%, #b7f5ff, #2dd4bf 55%, #0b4a5a 92%); box-shadow: inset -12px -10px 28px rgba(0,0,0,0.5), 0 0 30px rgba(45,212,191,0.35); }
        .orbit-ring { position: fixed; border-radius: 50%; pointer-events: none; z-index: -1; opacity: 0.5; }
        .orbit-ring::after { content: ''; position: absolute; inset: -2px; border-radius: 50%; border: 1px dashed rgba(176,106,255,0.5); }
        .sat-dot { position: absolute; width: 7px; height: 7px; border-radius: 50%; background: var(--gold); box-shadow: 0 0 8px 2px rgba(245,184,79,0.6); }
        @keyframes orbitSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .app[data-theme='dark'] .sphere, .app[data-theme='dark'] .orbit-ring { opacity: 0.85; }
        .app[data-theme='light'] .sphere-1 { opacity: 0.5; }
        .app[data-theme='light'] .sphere-2 { opacity: 0.5; }
        .brand-sub { font-size: 11px; color: var(--text-3); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
        .sanctuary-grid { display: grid; grid-template-columns: 1fr 1.6fr; gap: 16px; margin-bottom: 18px; }
        .jarv-chat { display: flex; flex-direction: column; height: 560px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; box-shadow: var(--shadow-sm); }
        .jarv-chat-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
        .jarv-chat-head .jarv-orb { width: 10px; height: 10px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px rgba(34,197,94,0.16); flex: none; }
        .jarv-body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: var(--bg-grad-1); }
        .jarv-msg { max-width: 82%; padding: 9px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
        .jarv-msg.user { align-self: flex-end; background: linear-gradient(180deg, var(--accent), var(--accent-2)); color: #fff; border-bottom-right-radius: 4px; }
        .jarv-msg.jarv { align-self: flex-start; background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: 4px; color: var(--text); }
        .jarv-msg .jarv-meta { display: block; font-size: 10.5px; color: var(--text-3); margin-top: 5px; }
        .jarv-typing { align-self: flex-start; color: var(--text-3); font-size: 13px; }
        .jarv-compose { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface); }
        .jarv-compose input { flex: 1; }
        .jarv-suggest { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 12px; background: var(--surface); }
        .jarv-suggest .chip { font-size: 11.5px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text-2); cursor: pointer; }
        .jarv-suggest .chip:hover { border-color: var(--accent-border); color: var(--text); }
        @media (max-width: 700px) { .jarv-chat { height: 520px; } }
        .ws-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
        .ws-tab { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text-2); font-size: 12.5px; font-weight: 700; cursor: pointer; }
        .ws-tab[data-on='true'] { background: var(--accent); border-color: var(--accent); color: #fff; }
        .cli-term { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 12px; overflow: hidden; }
        .cli-body { height: 320px; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 4px; }
        .cli-line.in { color: #8b949e; white-space: pre-wrap; word-break: break-word; }
        .cli-line.in::before { content: '❯ '; color: var(--success); font-weight: 700; }
        .cli-line.out { color: #e6edf3; white-space: pre-wrap; word-break: break-word; }
        .cli-line.err { color: #ff7b72; white-space: pre-wrap; word-break: break-word; }
        .cli-foot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #30363d; background: #161b22; align-items: center; }
        .cli-foot input { flex: 1; background: transparent; border: none; color: #e6edf3; font-family: inherit; font-size: 12.5px; padding: 4px 0; }
        .cli-foot input::placeholder { color: #6e7681; }
        .ide-split { display: grid; grid-template-columns: 200px 1fr; gap: 10px; }
        .ide-tree { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); padding: 8px; max-height: 420px; overflow-y: auto; }
        .ide-tree .file { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; font-size: 12.5px; cursor: pointer; color: var(--text-2); }
        .ide-tree .file:hover { background: var(--surface-3); color: var(--text); }
        .ide-tree .file.active { background: var(--accent-soft); border: 1px solid var(--accent-border); color: var(--text); font-weight: 600; }
        .ide-tree .file.dir { color: var(--accent); font-weight: 600; cursor: default; }
        .ide-editor { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; background: var(--surface-2); }
        .ide-editor textarea { width: 100%; min-height: 300px; flex: 1; resize: vertical; border: none; background: #0d1117; color: #c9d1d9; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; padding: 14px; outline: none; }
        .ide-editor-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
        .ide-editor-bar .path { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: var(--text-3); flex: 1; }
        .ide-run { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; color: #8b949e; background: #0d1117; border: 1px solid #30363d; border-radius: 10px; padding: 10px 12px; margin-top: 10px; white-space: pre-wrap; min-height: 40px; }
        .binary-note { padding: 14px 16px; font-size: 13px; color: var(--text); line-height: 1.55; background: color-mix(in srgb, var(--surface-3) 60%, transparent); border-bottom: 1px solid var(--border); }
        .binary-note code { font-size: 11.5px; color: var(--text-2); word-break: break-all; }
        .vibe-box { display: flex; flex-direction: column; gap: 10px; }
        .vibe-prompt {
          width: 100%; min-height: 96px; resize: vertical; border-radius: 12px;
          border: 1px solid var(--border-strong); background: #0d1117; color: #e6edf3;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px;
          line-height: 1.5; padding: 12px 14px; outline: none;
        }
        .vibe-prompt:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .vibe-suggests { display: flex; flex-wrap: wrap; gap: 6px; }
        .vibe-log { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 12px; overflow: hidden; }
        .vibe-log .vibe-body { max-height: 300px; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
        .vibe-line.in { color: #8b949e; white-space: pre-wrap; word-break: break-word; }
        .vibe-line.in::before { content: '✦ '; color: var(--gold); font-weight: 700; }
        .vibe-line.out { color: #e6edf3; white-space: pre-wrap; word-break: break-word; }
        .vibe-line.code { color: #7ee787; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
        .vibe-line.err { color: #ff7b72; white-space: pre-wrap; word-break: break-word; }
        .approval-bar { background: #1c2128; border: 1px solid var(--gold); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
        .approval-bar .btn-sm { font-size: 12px; }
        .keys-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
        .key-card { border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2); padding: 10px 12px; }
        .key-card .k-name { font-size: 13px; font-weight: 700; color: var(--text); }
        .key-card .k-env { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--accent); background: var(--accent-soft); border-radius: 6px; padding: 2px 6px; display: inline-block; margin-top: 4px; word-break: break-all; }
        .key-card .k-note { font-size: 11.5px; color: var(--text-3); margin-top: 4px; }
        .key-card .k-link { font-size: 11px; color: var(--accent); text-decoration: none; }
        .key-card .k-link:hover { text-decoration: underline; }
        @media (max-width: 700px) { .keys-grid { grid-template-columns: 1fr; } }
        @media (max-width: 700px) { .ide-split { grid-template-columns: 1fr; } .cli-body { height: 240px; } }
        .sanctuary-globe { position: relative; width: 100%; height: 440px; min-height: 320px; }
        .globe-canvas { width: 100%; height: 100%; display: block; touch-action: none; }
        .globe-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; }
        .globe-overlay button { pointer-events: auto; }
        .globe-legend { position: absolute; top: 10px; left: 12px; display: flex; flex-wrap: wrap; gap: 8px 12px; max-width: 80%; }
        .legend-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--text-2); background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 3px 9px; }
        .legend-chip em { font-style: normal; color: var(--text-3); }
        .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .globe-count { position: absolute; bottom: 10px; left: 12px; font-size: 11px; }
        .globe-card { position: absolute; right: 12px; bottom: 10px; width: 230px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; padding: 12px; box-shadow: var(--shadow-md); font-size: 12px; pointer-events: auto; }
        .globe-card .row { display: flex; justify-content: space-between; padding: 2px 0; }
        .globe-card .k { color: var(--text-3); }
        .globe-card .v { font-weight: 700; }
        .location-readout { background: var(--surface-2); border: 1px dashed var(--accent-border); border-radius: 10px; padding: 10px 12px; margin-bottom: 4px; }
        .location-fix { font-weight: 800; font-size: 18px; letter-spacing: 0.01em; }
        @media (max-width: 900px) {
          .sanctuary-grid { grid-template-columns: 1fr; }
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
        .auth-card .auth-logo {
          display: flex; align-items: center; justify-content: center;
          width: 52px; height: 52px; border-radius: 14px; margin-bottom: 16px;
          background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff;
        }
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
        .app-header .brand-glyph {
          display: flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; border-radius: 10px;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          color: #fff;
        }
        .app-header h1 {
          margin: 0; font-size: 19px; font-weight: 800; color: var(--text);
          background: linear-gradient(90deg, var(--accent), var(--accent-2));
          -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
        }
        .app-header .user-chip { display: flex; align-items: center; gap: 8px; }
        .app-header .user-email { font-size: 13px; color: var(--text-3); }
        .link-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 11px; white-space: nowrap; }
        .link-chip .link-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
        .link-chip .link-dot.green { background: var(--success); box-shadow: 0 0 0 3px rgba(22,163,74,0.16); }
        .link-chip .link-dot.amber { background: var(--warn); box-shadow: 0 0 0 3px rgba(245,158,11,0.20); }
        .link-chip .link-dot.gray { background: var(--text-3); }
        .galactic-nav {
          display: flex; align-items: center; gap: 6px; justify-content: center;
          margin: 14px auto 4px; max-width: 1100px; padding: 6px;
          background: color-mix(in srgb, var(--surface-3) 96%, transparent);
          border: 1px solid var(--border-strong);
          border-radius: 999px; backdrop-filter: blur(18px) saturate(170%);
          box-shadow: var(--shadow-sm); position: sticky; top: 68px; z-index: 40; width: fit-content;
        }
        .nav-seg { display: flex; align-items: center; gap: 7px; padding: 8px 16px; border-radius: 999px; font-size: 13px; font-weight: 700; color: var(--text-3); cursor: pointer; border: 1px solid transparent; background: transparent; transition: all 0.18s ease; white-space: nowrap; }
        .nav-seg:hover { color: var(--text); background: var(--surface-3); }
        .nav-seg[data-on='true'] { background: linear-gradient(180deg, var(--accent), var(--accent-2)); color: #fff; box-shadow: 0 4px 16px rgba(138,91,255,0.4); }
        .nav-seg .nav-orb { width: 8px; height: 8px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
        .nav-seg .nav-dot { width: 8px; height: 8px; border-radius: 50%; }
        .nav-seg .nav-dot.on { background: var(--success); box-shadow: 0 0 0 3px rgba(52,211,153,0.22); }
        .nav-seg .nav-dot.off { background: var(--text-3); }
        @media (max-width: 700px) {
          .galactic-nav { flex-wrap: wrap; border-radius: 18px; top: auto; position: static; width: 100%; }
          .nav-seg { flex: 1 1 auto; justify-content: center; padding: 8px 10px; font-size: 12px; }
        }
        .view-head { display: flex; align-items: center; gap: 10px; margin: 4px 0 16px; }
        .view-head .view-pill { width: 10px; height: 10px; border-radius: 50%; }
        .view-head h2 { margin: 0; font-size: 21px; font-weight: 800; letter-spacing: 0.01em; }
        .view-head .muted { margin-top: 1px; }
        .satline-banner { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); background: var(--surface-2); border: 1px dashed var(--border-strong); border-radius: var(--radius); padding: 10px 14px; margin-bottom: 14px; }
        .container { max-width: 1100px; margin: 0 auto; padding: 22px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 22px; }
        .stat-card, .panel-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; box-shadow: var(--shadow-sm); transition: box-shadow 0.2s ease; backdrop-filter: blur(10px) saturate(150%); }
        .stat-card:hover { box-shadow: var(--shadow-md); }
        .stat-label { font-size: 12px; color: var(--text-3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
        .stat-value { font-size: 23px; font-weight: 800; margin-top: 4px; color: var(--text); }
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
        .status-box { margin-top: 12px; padding: 12px 14px; border-radius: 10px; background: var(--accent-soft); border: 1px solid var(--accent-border); color: var(--text); }
        .muted { color: var(--text-3); font-size: 13px; }
        .flex { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .flex-between { display: flex; justify-content: space-between; align-items: center; }
        .mb-8 { margin-bottom: 8px; }
        .mt-8 { margin-top: 8px; }
        .theme-toggle { display: flex; align-items: center; gap: 8px; }
        .theme-toggle .toggle-track { width: 44px; height: 24px; border-radius: 999px; background: var(--surface-3); border: 1px solid var(--border-strong); position: relative; cursor: pointer; transition: background 0.2s; }
        .theme-toggle .toggle-track[data-on='true'] { background: var(--accent); }
        .theme-toggle .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: left 0.2s; }
        .theme-toggle .toggle-track[data-on='true'] .toggle-thumb { left: 22px; }
        .toast {
          position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
          background: var(--text); color: var(--surface); padding: 10px 18px; border-radius: 10px;
          font-size: 14px; font-weight: 600; box-shadow: var(--shadow-lg); z-index: 200;
          animation: toastIn 0.25s ease;
        }
        @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 10px) } to { opacity: 1; transform: translate(-50%, 0) } }
        @media (max-width: 900px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
          .container { padding: 14px; }
        }
        @media (max-width: 600px) {
          .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
          .stat-card { padding: 12px; }
          .stat-value { font-size: 19px; }
          .panel-card { padding: 14px; }
          .panel-card input, .panel-card select, .panel-card button { font-size: 15px; padding: 10px; }
          .app-header { padding: 12px 16px; }
          .app-header h1 { font-size: 17px; }
        }
        @media (hover: none) and (pointer: coarse) {
          .panel-card button, .btn-sm { min-height: 44px; }
          .panel-card input, .panel-card select, .panel-card textarea { min-height: 44px; font-size: 16px; }
        }
      `}</style>
      <div className="starfield">
        {STARS.map((s, i) => (
          <i key={i} style={{ left: `${s.left}%`, top: `${s.top}%`, width: s.size, height: s.size, '--tw': s.tw }} />
        ))}
      </div>
      <div className="sphere sphere-1" />
      <div className="sphere sphere-2" />
      <div className="orbit-ring" style={{ width: 340, height: 340, left: '82%', top: '18%' }}>
        <div className="sat-dot" style={{ top: '4%', left: '50%' }} />
      </div>
      <div className="orbit-ring" style={{ width: 190, height: 190, left: '6%', top: '64%' }}>
        <div className="sat-dot" style={{ top: '50%', left: '94%' }} />
      </div>
      {!user ? (
        <div className="auth-screen">
          <div className="auth-card">
            <div className="auth-logo">
              <svg viewBox="0 0 24 24" fill="none" width="30" height="30">
                <path d="M12 3l7 4v5a9 9 0 0 1-7 9 9 9 0 0 1-7-9V7l7-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </div>
            <h1>Fortress Hub</h1>
            <div className="auth-sub">
              {resetToken
                ? 'Set a new password'
                : viewFromHash() === 'gods-eye'
                  ? 'God\u2019s Eye requested \u2014 sign in once, and the satellite globe will spin right here.'
                  : authMode === 'login'
                    ? 'Welcome back \u2014 family grid & field intel'
                    : 'Create the family vault \u2014 your data, private to you'}
            </div>
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
            <div className="brand-glyph">
              <svg viewBox="0 0 24 24" fill="none" width="22" height="22">
                <path d="M12 3l7 4v5a9 9 0 0 1-7 9 9 9 0 0 1-7-9V7l7-4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <h1 style={{ lineHeight: 1.1 }}>Fortress Hub</h1>
              <div className="brand-sub">family survival &amp; field intel</div>
            </div>
          </div>
          <div className="link-chip" title={comms ? `peer: ${comms.peer ? comms.peer.name : '—'} · mode: ${comms.mode || 'terrestrial'} · outbox pending: ${(comms.outbox && comms.outbox.pending) || 0}${comms.ai ? ` · ai: ${comms.ai.enabled ? `${comms.ai.tier === 'free' ? 'free ' : ''}${comms.ai.model || ''}` : 'not configured'}` : ''}` : 'Not connected to an assistant peer yet'}>
            <span className={`link-dot ${linkMeta(comms).tone}`} />
            <span>{linkMeta(comms).label}</span>
          </div>
          <div className="user-chip">
            <span className="user-email">{user.email}</span>
            <button className="btn-sm" onClick={() => { setShowSettings(!showSettings); if (!showSettings) { loadKeys(); loadWorkspace() } }}>
              {showSettings ? 'Close' : 'Settings'}
            </button>
            <button className="btn-sm" onClick={logout}>Sign Out</button>
          </div>
        </header>
        <div className="container">
          {!online && (
            <div className="satline-banner" role="status">
              <span>⚠️</span>
              <span><strong>You're off-line (or on a spotty satellite/cellular link).</strong> Your changes are held locally and will sync to JARV-Genie automatically when the link returns — nothing is lost.</span>
            </div>
          )}
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

              <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0 14px', paddingTop: 14 }}>
                <div className="flex-between" style={{ marginBottom: 6 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Mac permissions — JARV's hands</div>
                    <div className="muted">Accessibility + Screen Recording must be granted to the process hosting JARV, or the drive/click toolkit can't reach the screen. Only a human can flip these in System Settings; the buttons below open the right pane.</div>
                  </div>
                  <div className="flex" style={{ gap: 6 }}>
                    <button className="btn-sm" onClick={() => checkPermissions(false)} disabled={permBusy}>{permBusy ? '…' : 'Verify'}</button>
                    <button className="btn-sm" onClick={() => checkPermissions(true)} disabled={permBusy}>{permBusy ? '…' : 'Verify + OCR test'}</button>
                  </div>
                </div>

                {perm && (
                  <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className={`link-chip`} style={{ fontSize: 11 }}>
                      <span className={`link-dot ${perm.axTrusted ? 'green' : 'gray'}`} style={{ display: 'inline-block' }} />
                      Accessibility {perm.axTrusted ? 'granted' : 'missing'}
                    </span>
                    {perm.screen && <span className="link-chip" style={{ fontSize: 11 }}>screen: {perm.screen}</span>}
                    {perm.frontmost && <span className="link-chip" style={{ fontSize: 11 }}>frontmost: {perm.frontmost}</span>}
                    {perm.ocr && (
                      <span className="link-chip" style={{ fontSize: 11 }}>
                        <span className={`link-dot ${perm.ocr.ok ? 'green' : 'gray'}`} style={{ display: 'inline-block' }} />
                        Screen capture + OCR {perm.ocr.ok ? 'ok' : 'not verified'}{perm.ocr.rows ? ` · ${perm.ocr.rows} line${perm.ocr.rows > 1 ? 's' : ''} read` : ''}
                      </span>
                    )}
                    {perm.error && <span className="muted" style={{ fontSize: 11 }}>⚠ {perm.error}</span>}
                  </div>
                )}
                {perm && perm.ocr && perm.ocr.sample && <div className="muted" style={{ fontSize: 11, marginBottom: 8, fontStyle: 'italic' }}>OCR picked up: “{perm.ocr.sample}”</div>}

                <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <a className="btn-sm" target="_blank" rel="noreferrer" href="x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility">Open Accessibility pane</a>
                  <a className="btn-sm" target="_blank" rel="noreferrer" href="x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture">Open Screen Recording pane</a>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0 14px', paddingTop: 14 }}>
                <div className="flex-between" style={{ marginBottom: 6 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>Cloud API keys</div>
                    <div className="muted">JARV falls back across these keyed providers when local Ollama is unavailable. Keys are stored in <code>{KEYS_DEST}</code> and activate immediately. Leave a field blank to keep its current value; enter a blank "spacer" to clear.</div>
                  </div>
                  <button className="btn-sm" onClick={() => loadKeys()} disabled={keysBusy}>Refresh</button>
                </div>

                {keyProviders.length === 0 && (
                  <div className="muted" style={{ fontSize: 13, padding: '10px 0' }}>Loading providers…</div>
                )}

                <div className="keys-grid">
                  {keyProviders.map(p => (
                    <div className="key-card" key={p.env}>
                      <div className="flex-between" style={{ marginBottom: 6, gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                        <span style={{ fontSize: 11 }} className={`link-dot ${p.set ? 'green' : 'gray'}`} title={p.set ? `Configured (${p.masked})` : 'Not set'} />
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{p.note || ''} · {p.env}{p.set ? ` · ${p.masked}` : ''}</div>
                      <div className="flex" style={{ gap: 6 }}>
                        <input
                          type="password"
                          placeholder={p.set ? '•••••••• (leave blank to keep)' : 'Paste API key'}
                          value={keyInputs[p.env] || ''}
                          onChange={e => setKeyInputs({ ...keyInputs, [p.env]: e.target.value })}
                          autoComplete="off"
                          style={{ flex: 1 }}
                        />
                        {p.url && <a className="btn-sm" href={p.url} target="_blank" rel="noreferrer" style={{ whiteSpace: 'nowrap' }}>Get key</a>}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex-between" style={{ marginTop: 14, gap: 12 }}>
                  <button className="btn-sm" onClick={() => { setKeyInputs({}); setKeyStatus('') }}>Clear drafts</button>
                  <button className="btn-primary btn-sm" onClick={saveKeys} disabled={keysBusy}>
                    {keysBusy ? 'Saving…' : 'Save keys'}
                  </button>
                </div>
                {keyStatus && <div className="status-box" style={{ marginTop: 10, fontSize: 12 }}>{keyStatus}</div>}
              </div>

              <div style={{ borderTop: '1px solid var(--border)', margin: '6px 0 14px', paddingTop: 14 }}>
                <div className="flex-between" style={{ marginBottom: 6 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>JARV workspace &amp; autonomy</div>
                    <div className="muted">Where JARV codes, and how much he may do on his own. The "ask first" level surfaces an approve prompt in the Vibe Code / Terminal tabs.</div>
                  </div>
                  <button className="btn-sm" onClick={() => loadWorkspace()}>Refresh</button>
                </div>

                <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Workspace root: <code style={{ wordBreak: 'break-all' }}>{workspace ? workspace.sandboxRoot : '…'}</code>
                  {workspace && workspace.sessionTools && workspace.sessionTools.length > 0 && (
                    <span className="link-chip" style={{ marginLeft: 8, fontSize: 11 }}>session-approved: {workspace.sessionTools.join(', ')}</span>
                  )}
                </div>

                <div className="flex-between" style={{ marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Autonomous shell</div>
                    <div className="muted" style={{ fontSize: 11 }}>Allow jarv_run without asking (still allowlisted; no rm/sudo). "Allow all" in a prompt sets this permanently.</div>
                  </div>
                  <div className="theme-toggle" onClick={() => setAutoShell(!autoShell)}>
                    <span style={{ fontSize: 13 }}>{autoShell ? 'On' : 'Off'}</span>
                    <div className="toggle-track" data-on={autoShell}><div className="toggle-thumb" /></div>
                  </div>
                </div>

                <div className="flex-between" style={{ marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Network access</div>
                    <div className="muted" style={{ fontSize: 11 }}>Allow curl/wget inside jarv_run — JARV can reach the internet when running shell.</div>
                  </div>
                  <div className="theme-toggle" onClick={() => setAutoNet(!autoNet)}>
                    <span style={{ fontSize: 13 }}>{autoNet ? 'On' : 'Off'}</span>
                    <div className="toggle-track" data-on={autoNet}><div className="toggle-thumb" /></div>
                  </div>
                </div>

                <div className="flex" style={{ gap: 8, marginTop: 10 }}>
                  <button className="btn-sm btn-primary" onClick={saveAutonomy} disabled={!workspace}>Save autonomy</button>
                  <button className="btn-sm" onClick={resetSessionApprovals} disabled={!workspace}>Clear session approval</button>
                </div>
                {autoStatus && <div className="status-box" style={{ marginTop: 10, fontSize: 12 }}>{autoStatus}</div>}
              </div>
            </div>
          )}

        <div className="galactic-nav" role="tablist" aria-label="Fortress Hub command center">
          {VIEWS.map(v => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className="nav-seg" data-on={view === v.id} onClick={() => { setView(v.id); if (String(window.location.hash).replace(/^#\/?/, '') !== v.id) window.location.hash = v.id }}>
              <span className="nav-orb">{v.icon === '◍' ? '' : v.icon}</span>
              <span>{v.label}</span>
              <span className={`nav-dot ${v.id === 'command' || v.id === 'forge' ? 'on' : (comms && comms.ai ? 'on' : 'off')}`} style={{ display: 'none' }} />
            </button>
          ))}
        </div>

        {view === 'gods-eye' && (<>
        <div className="view-head">
          <span className="view-pill" style={{ background: 'var(--accent)', boxShadow: '0 0 12px var(--accent)' }} />
          <div>
            <h2>God's Eye — Global Orbital OSINT</h2>
            <div className="muted">Live Earth globe · satellite constellations · your grid fix, projected from where you are.</div>
          </div>
        </div>
        <div className="sanctuary-grid">
          <div className="panel-card">
            <div className="flex-between" style={{ marginBottom: 6 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Family Grid Fix</h2>
              <span className={`link-dot ${hubLocation ? 'green' : 'gray'}`} style={{ display: 'inline-block' }} title={hubLocSource} />
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
              Hub-node location services: device fixes, a manual grid, or IP geolocation. JARV pings this live
              (<code>jarv_location</code>) before every sky scan — so OSINT is computed from where you actually are.
            </div>
            {hubLocation ? (
              <div className="location-readout">
                <div className="location-fix">{hubLocation.lat.toFixed(4)}°, {hubLocation.lon.toFixed(4)}°</div>
                <div className="muted">via {hubLocSource}</div>
              </div>
            ) : (
              <div className="muted">No fix yet — report from this device or set a manual grid.</div>
            )}
            <div className="flex" style={{ gap: 8, margin: '10px 0' }}>
              <button className="btn-sm btn-primary" onClick={reportDeviceLocation}>Report my position</button>
            </div>
            <div className="flex" style={{ gap: 8, alignItems: 'stretch' }}>
              <input placeholder="Manual lat" type="number" step="any" value={manualLat} onChange={e => setManualLat(e.target.value)} style={{ width: 110 }} />
              <input placeholder="Manual lon" type="number" step="any" value={manualLon} onChange={e => setManualLon(e.target.value)} style={{ width: 110 }} />
              <button className="btn-sm" onClick={setManualGrid}>Set Grid</button>
            </div>
            {locError && <div className="status-box" style={{ marginTop: 8, color: '#b42318', background: '#fef3f2', fontSize: 12 }}>{locError}</div>}
          </div>
        </div>
        </>)}

        {view === 'command' && (<>
        <div className="view-head">
          <span className="view-pill" style={{ background: 'var(--success)', boxShadow: '0 0 12px var(--success)' }} />
          <div>
            <h2>Command Core</h2>
            <div className="muted">JARV's mind — chat driven by the local-first LLM, routed over the Genie mesh with free-provider failover.</div>
          </div>
        </div>
        <div className="panel-card" style={{ marginBottom: 18 }}>
          <div className="flex-between" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>JARV Command Center</h2>
            <span className="link-chip" title="Talk to JARV — sat OSINT, location, shipping, field intel. Runs over the Genie mesh.">
              <span className={`link-dot ${comms && comms.ai ? 'green' : 'gray'}`} style={{ display: 'inline-block' }} />
              <span>{chatMsgs.length ? `${chatMsgs.length} messages` : 'live relay'}</span>
            </span>
          </div>
          {comms && comms.ai && (
            <div className="ai-relay" style={{ fontSize: 11.5, marginBottom: 10, padding: '8px 12px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text-3)' }}>
              <div className="ai-relay-row" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: 'var(--text)' }}>AI relay</span>
                <span className="link-chip" style={{ fontSize: 11 }}>
                  <span className="link-dot green" style={{ display: 'inline-block' }} />
                  answering now: <strong>{comms.ai.lastProviderUsed || comms.ai.provider || 'idle'}</strong>
                  {comms.ai.lastModelUsed ? ` · ${comms.ai.lastModelUsed}` : ''}
                </span>
                <span className="muted" style={{ fontSize: 11 }}>failover chain:</span>
                {(comms.ai.providers || []).map((p, i) => {
                  const h = comms.ai.providerHealth && comms.ai.providerHealth[p]
                  const cooling = h && h.cooling
                  const answered = p === (comms.ai.lastProviderUsed)
                  return (
                    <span key={p} className="link-chip" style={{ fontSize: 10.5, padding: '2px 8px', borderColor: answered ? 'var(--accent-border)' : 'var(--border)', color: answered ? 'var(--text)' : 'var(--text-3)', boxShadow: answered ? '0 0 0 2px var(--accent-soft)' : 'none' }}>
                      {answered ? '●' : cooling ? '◌' : '·'} {p}
                      {cooling ? ' (cooling)' : ''}
                      {answered ? ' ←live' : ''}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
          <div className="jarv-chat">
            <div className="jarv-chat-head">
              <span className="jarv-orb" />
              <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>JARV</span>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {chatMsgs.length ? 'in session' : 'synced — ask anything'}
                {comms && comms.ai ? ` · brain: ${comms.ai.lastModelUsed || (comms.ai.localModels && comms.ai.localModels[0]) || comms.ai.provider || 'local'}` : ''}
              </span>
            </div>
            <div className="jarv-body">
              {chatMsgs.length === 0 && !chatLoading && (
                <div className="muted" style={{ fontSize: 12.5, alignSelf: 'center', textAlign: 'center', padding: '20px 0' }}>
                  Command center ready. Ask JARV to scan the sky, check your grid fix,
                  <br />or run field intel — it answers from local relays.
                </div>
              )}
              {chatMsgs.map((m, i) => (
                <div key={i} className={`jarv-msg ${m.role}`}>
                  {m.text}
                  {m.meta && <span className="jarv-meta">{m.meta}</span>}
                </div>
              ))}
              {chatLoading && <div className="jarv-typing">JARV is thinking…</div>}
              <div ref={chatEndRef} />
            </div>
            <div className="jarv-compose">
              <input
                placeholder="Talk to JARV…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendJarvMessage()}
                disabled={chatLoading}
              />
              <button className="btn-primary" onClick={sendJarvMessage} disabled={chatLoading || !chatInput.trim()}>
                Send
              </button>
            </div>
            {chatMsgs.length === 0 && (
              <div className="jarv-suggest">
                {['What satellites are overhead right now?', 'How do I contact a satellite manually?', 'Where is the family grid fix centered?', 'Give me tonight\'s overhead pass predictions'].
                  map(s => (
                    <button key={s} className="chip" onClick={() => { setChatInput(s); setChatMsgs([]) }}>{s}</button>
                  ))}
              </div>
            )}
          </div>
        </div>
        </>)}

        {view === 'forge' && (<>
        <div className="view-head">
          <span className="view-pill" style={{ background: 'var(--gold)', boxShadow: '0 0 12px var(--gold)' }} />
          <div>
            <h2>Code Forge</h2>
            <div className="muted">JARV's hands — sandboxed terminal, IDE, and the MCP server AI coding clients plug into (MoltenJarv on Telegram can drive the same tools).</div>
          </div>
        </div>
        <div className="panel-card" style={{ marginBottom: 16 }}>
          <div className="flex-between" style={{ marginBottom: 6 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Coding Workspace — JARV Hub Developer</h2>
            <span className="link-chip" title="Code right from the hub: sandboxed terminal + editor, exposed to AI clients over MCP.">
              <span className="link-dot green" style={{ display: 'inline-block' }} />
              <span>cli · mcp · ide</span>
            </span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Workspace ({workspace ? workspace.sandboxRoot : 'backend/jarv-sandbox'}). Run via <strong>Terminal</strong> or edit files in the <strong>IDE</strong> — also reachable by any MCP client at <code>http://&lt;this-mac&gt;:4002/api/jarv/mcp</code>. Write/edit/run ask for approval.
          </div>
          <div className="ws-tabs">
            <button className="ws-tab" data-on={forgeTab === 'vibe'} onClick={() => setForgeTab('vibe')}>Vibe Code</button>
            <button className="ws-tab" data-on={forgeTab === 'ide'} onClick={() => setForgeTab('ide')}>Scripts (IDE)</button>
            <button className="ws-tab" data-on={forgeTab === 'cli'} onClick={() => setForgeTab('cli')}>Terminal (CLI)</button>
            <button className="ws-tab" data-on={forgeTab === 'keys'} onClick={() => setForgeTab('keys')}>Provider Keys</button>
          </div>

          {forgeTab === 'cli' && (
            <>
              <div className="cli-term">
                <div className="cli-body">
                  {cliLines.length === 0 && !cliBusy && (
                    <div className="cli-line out" style={{ color: '#8b949e' }}>
                      JARV Hub terminal — type a command.
                      {`\nCommands: jarv_list, jarv_read &lt;file&gt;, jarv_run &lt;cmd&gt;, jarv_write &lt;path&gt; &lt;content&gt;,`}
                      {`\n  jarv_satvision, jarv_globe, jarv_location, jarv_osint_handbook.`}
                      {`\nFree text (no command) talks to the JARV agent.`}
                    </div>
                  )}
                  {cliLines.map((l, i) => <div key={i} className={`cli-line ${l.kind}`}>{l.text}</div>)}
                  {liveCli && <div className="cli-line out" style={{ whiteSpace: 'pre-wrap' }}>{liveCli}</div>}
                  {cliBusy && <div className="cli-line out" style={{ color: '#8b949e' }}>running…</div>}
                  <div ref={cliEndRef} />
                </div>
                {cliPending && (
                  <div className="approval-bar">
                    <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 12 }}>Approve {cliPending.needsApproval.map(t => t.name.replace('jarv_', '')).join(', ')}?</span>
                      <span className="muted" style={{ fontSize: 11 }}>write/edit mutate workspace files; run executes shell (allowlisted).</span>
                    </div>
                    <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn-sm" onClick={() => runCli('once')} disabled={cliBusy}>Allow once</button>
                      <button className="btn-sm" onClick={() => runCli('session')} disabled={cliBusy}>Allow this session</button>
                      <button className="btn-sm" onClick={() => runCli('all')} disabled={cliBusy}>Allow all</button>
                      <button className="btn-sm" onClick={() => setCliPending(null)} disabled={cliBusy}>Deny</button>
                    </div>
                  </div>
                )}
                <div className="cli-foot">
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#8b949e', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={cliApprove} onChange={e => setCliApprove(e.target.checked)} style={{ accentColor: 'var(--success)' }} />
                    approve write/edit/run
                  </label>
                  <input
                    placeholder="jarv_run ls -la   (or just ask JARV something)"
                    value={cliInput}
                    onChange={e => setCliInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && runCli()}
                    disabled={cliBusy}
                  />
                  <button className="btn-primary" onClick={runCli} disabled={cliBusy || !cliInput.trim()}>Run</button>
                </div>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                Write/edit/run need the approve box ON (operator-approval policy gates those three tools inside the sandbox).
              </div>
            </>
          )}

          {forgeTab === 'ide' && (
            <div className="ide-split">
              <div className="ide-tree">
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', padding: '4px 8px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>jarv-sandbox</span>
                  <button className="btn-sm" onClick={loadTree} disabled={treeLoading}>{treeLoading ? '…' : '↻'}</button>
                </div>
                {(tree || []).map((e, i) => (
                  <div
                    key={i}
                    className={`file ${e.type === 'dir' ? 'dir' : ''} ${e.name === currentFile ? 'active' : ''}`}
                    onClick={() => e.type !== 'dir' && openFile(e.name)}
                  >
                    {e.type === 'dir' ? '📁' : '📄'} {e.name}
                  </div>
                ))}
                {treeLoading && <div className="muted" style={{ fontSize: 11, padding: '8px' }}>loading…</div>}
                {!treeLoading && tree.length === 0 && <div className="muted" style={{ fontSize: 11, padding: '8px' }}>empty workspace</div>}
              </div>
              <div>
                <div className="ide-editor">
                  {currentFile && fileMeta && fileMeta.binary ? (
                    <>
                      <div className="binary-note">
                        <strong>Binary file — not text.</strong>
                        <p>{fileMeta.note || 'This file is not a readable text file; the garbled "replacement characters" are just how binary bytes render.'}</p>
                        {fileMeta.kind ? <p><em>Detected: {fileMeta.kind}</em></p> : null}
                        {fileMeta.excerpt ? <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Readable strings inside: <code>{fileMeta.excerpt}</code></p> : null}
                        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>{fileMeta.size?.toLocaleString?.() ?? fileMeta.size} bytes. Use the JARV Data Decode tool to study it.</p>
                      </div>
                      <div className="ide-editor-bar">
                        <span className="path">{currentFile}</span>
                        <button className="btn-sm" onClick={() => setFileMeta(null)}>Show raw view</button>
                      </div>
                    </>
                  ) : currentFile ? (
                    <>
                      <textarea spellCheck={false} value={editor} onChange={e => setEditor(e.target.value)} />
                      <div className="ide-editor-bar">
                        <span className="path">{currentFile}</span>
                        <button className="btn-sm" onClick={runEditor}>Run</button>
                        <button className="btn-primary" onClick={saveFile} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                      </div>
                    </>
                  ) : (
                    <textarea readOnly placeholder="// select a file from the tree to open the editor" style={{ color: '#8b949e' }} />
                  )}
                </div>
                {runLog && <div className="ide-run">{runLog}</div>}
              </div>
            </div>
          )}

          {forgeTab === 'vibe' && (
            <>
              <div className="vibe-box">
                <textarea
                  className="vibe-prompt"
                  placeholder="Describe what to build in plain language — JARV writes it into the workspace for you. e.g. 'Build a todo CLI that saves to a JSON file and lets me add/list/done items' — Enter to send, Shift+Enter for a new line."
                  value={vibeInput}
                  onChange={e => setVibeInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runVibe() } }}
                  disabled={vibeBusy}
                />
                <div className="flex-between">
                  <div className="vibe-suggests">
                    {['Build a markdown daily-log CLI', 'Write a Python script that fetches today\'s satellite passes', 'Make a node script that sums a CSV file', 'Create an HTML dashboard from a JSON data file'].map(s => (
                      <button key={s} className="chip" onClick={() => setVibeInput(s)}>{s}</button>
                    ))}
                  </div>
                  <button className="btn-primary" onClick={runVibe} disabled={vibeBusy || !vibeInput.trim()}>{vibeBusy ? 'Shaping…' : 'Vibe'}</button>
                </div>
                {vibePending && (
                  <div className="approval-bar" style={{ marginTop: 10 }}>
                    <div className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>JARV needs approval to run {vibePending.needsApproval.map(t => t.name.replace('jarv_', '')).join(', ')}</span>
                      <span className="muted" style={{ fontSize: 11 }}>write/edit mutate files in the workspace; run executes shell.</span>
                    </div>
                    <div className="flex" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button className="btn-sm" onClick={() => runVibe('once')} disabled={vibeBusy}>Allow once</button>
                      <button className="btn-sm" onClick={() => runVibe('session')} disabled={vibeBusy}>Allow this session</button>
                      <button className="btn-sm" onClick={() => runVibe('all')} disabled={vibeBusy}>Allow all</button>
                      <button className="btn-sm" onClick={() => setVibePending(null)} disabled={vibeBusy}>Deny</button>
                    </div>
                  </div>
                )}
                {vibeLines.length > 0 && (
                  <div className="vibe-log">
                    <div className="vibe-body">
                      {vibeLines.map((l, i) => <div key={i} className={`vibe-line ${l.kind}`}>{l.text}</div>)}
                      {liveVibe && <div className="vibe-line code" style={{ whiteSpace: 'pre-wrap' }}>{liveVibe}</div>}
                      {vibeBusy && <div className="vibe-line out" style={{ color: '#8b949e' }}>…</div>}
                      <div ref={vibeEndRef} />
                    </div>
                  </div>
                )}
                <div className="muted" style={{ fontSize: 11 }}>
                  Vibe code works in the JARV workspace ({workspace ? workspace.sandboxRoot : 'backend/jarv-sandbox'}). Write/edit/run ask for your approval the first time — pick Allow once, this session, or all.
                  Adding any <button className="chip" style={{ padding: '1px 6px' }} onClick={() => setForgeTab('keys')}>Provider Key</button> makes vibe-coding stronger (a bigger brain plans better).
                </div>
              </div>
            </>
          )}

          {forgeTab === 'keys' && (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                Every key below is one more link in JARV's failover chain. Add it to <code>{KEYS_DEST}</code>, then restart the backend. No key is required
                — local Ollama (qwen2.5:1.5b) + Pollinations run as always-on fallbacks.
              </div>
              <div className="keys-grid">
                {PROVIDER_KEYS.map(k => (
                  <div key={k.env} className="key-card">
                    <div className="k-name">{k.name}</div>
                    <div className="k-env">{k.env}=</div>
                    <div className="k-note">{k.note}</div>
                    <a className="k-link" href={k.url} target="_blank" rel="noreferrer">get key ↗</a>
                  </div>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                Override order with <code>GENIE_AI_PROVIDERS=gemini,groq,openrouter</code> in {KEYS_DEST}. Full docs: <code>backend/.env.example</code>.
              </div>
            </>
          )}
        </div>
        </>)}

        {view === 'gods-eye' && (<>
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Sats Online</div>
            <div className="stat-value">{(globePositions.length || 0).toLocaleString()}</div>
            <div className="muted">projected across the wire</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Constellations</div>
            <div className="stat-value">{globeConstellations}</div>
            <div className="muted">groups reporting</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Grid Fix</div>
            <div className="stat-value" style={{ fontSize: 16 }}>{hubLocation ? `${hubLocation.lat.toFixed(1)}°, ${hubLocation.lon.toFixed(1)}°` : '—'}</div>
            <div className="muted">{hubLocSource}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Genie Link</div>
            <div className="stat-value" style={{ fontSize: 18 }}>{linkMeta(comms).label.replace('Genie Link ', '').split(' · ')[0]}</div>
            <div className="muted">tunnel to JARV-Genie</div>
          </div>
        </div>

        <div className="panel-card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
          <div className="flex-between" style={{ padding: '14px 16px 0' }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>God's Eye View — Live Global Satellite Intelligence</h2>
            <button className="btn-sm" onClick={loadGlobe} disabled={globeLoading}>{globeLoading ? 'Projecting…' : 'Refresh Grid'}</button>
          </div>
          <div className="muted" style={{ fontSize: 12, padding: '4px 16px 8px' }}>
            Photorealistic 3D globe — live satellites from CelesTrak (OrbitDeck), color-coded by constellation. Click a dot to inspect it, then <strong>Focus ◉</strong> to center the camera.
          </div>
          <div className="flex" style={{ gap: 8, alignItems: 'center', padding: '0 16px 10px', flexWrap: 'wrap' }}>
            <span className="muted" style={{ fontSize: 11 }}>Quick sky scan:</span>
            <select value={scanGroups} onChange={e => setScanGroups(e.target.value)} style={{ maxWidth: 340, fontSize: 12 }} title="Satellite groups (comma-separated)">
              <option value="starlink,oneweb,iridium-next,gps">Starlink · OneWeb · Iridium · GPS</option>
              <option value="starlink,oneweb,iridium-next,gps,galileo,glonass,beidou,geo,iss">starlink, oneweb, iridium-next, gps, galileo, glonass, beidou, geo, iss</option>
              <option value="starlink">Starlink only</option>
              <option value="gps">GPS only</option>
              <option value="iss,geo">ISS + GEO</option>
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
              min el
              <input type="range" min="0" max="80" step="1" value={scanMinEl} onChange={e => setScanMinEl(Number(e.target.value))} style={{ width: 90 }} />
              <b>{scanMinEl}°</b>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
              passes
              <input type="range" min="1" max="5" step="1" value={scanPasses} onChange={e => setScanPasses(Number(e.target.value))} style={{ width: 70 }} />
              <b>{scanPasses}</b>
            </label>
            <button className="btn-sm btn-primary" onClick={runQuickScan} disabled={scanBusy}>{scanBusy ? 'Scanning…' : 'Scan'}</button>
          </div>
          <GodsEyeView positions={globePositions} hubLocation={hubLocation} theme={theme} onSelect={setSelectedSatellite} />
          {globeError && <div className="status-box" style={{ margin: 10, fontSize: 12, borderRadius: 8 }}>Globe: {globeError}</div>}
          {scanResult && (
            <div style={{ padding: '0 16px 14px', maxHeight: 200, overflowY: 'auto' }}>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>Next passes — {scanResult.groups}</div>
              {scanResult.passes.slice(0, 8).map((p, i) => (
                <div key={i} className="flex" style={{ gap: 10, fontSize: 11.5, padding: '3px 0', borderBottom: '1px solid var(--border)', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600 }}>{p.satellite}</span>
                  <span className="muted">{p.aos ? new Date(p.aos).toLocaleTimeString() : '—'} · max {p.max_elevation_deg}° · {p.duration_min}min</span>
                </div>
              ))}
              <div className="muted" style={{ fontSize: 10.5, marginTop: 6 }}>lat/lon auto-filled from the hub grid fix. Scan params are remembered for next time.</div>
            </div>
          )}
          {selectedSatellite && (
            <div style={{ padding: '0 16px 14px' }}>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>Pass forecast — {selectedSatellite.satellite} (#{selectedSatellite.norad})</div>
              {(() => {
                const match = (scanResult && scanResult.passes.find(p => String(p.norad) === String(selectedSatellite.norad))) || null
                if (match) {
                  const etaMs = new Date(match.aos).getTime() - Date.now()
                  const eta = etaMs > 0 ? (etaMs > 60000 ? `${Math.floor(etaMs / 60000)}m ${Math.floor((etaMs % 60000) / 1000)}s` : `${Math.floor(etaMs / 1000)}s`) : 'now'
                  return (
                    <div className="muted" style={{ fontSize: 12 }}>
                      <span style={{ fontWeight: 700, color: 'var(--text)' }}>{match.aos ? new Date(match.aos).toLocaleString() : '—'}</span> · AOS in <b>{eta}</b> · max elevation {match.max_elevation_deg}° · duration {match.duration_min}min
                    </div>
                  )
                }
                return (
                  <div className="muted" style={{ fontSize: 11.5 }}>No forecast cached for this satellite yet — run a sky scan (above) for its constellation and the next-pass window will appear here.</div>
                )
              })()}
            </div>
          )}
        </div>
        <SettlementView apiBase={API_BASE} />
        </>)}
      </div>

      {toast && <div className="toast">{toast}</div>}
      </>
    )}
    </div>
  )
}