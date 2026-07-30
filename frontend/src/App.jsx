import React, { useState, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4002'

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0))
}

export default function App() {
  const [profiles, setProfiles] = useState([])
  const [profileSummaries, setProfileSummaries] = useState([])
  const [newProfile, setNewProfile] = useState('')
  const [selectedProfile, setSelectedProfile] = useState('')
  const [file, setFile] = useState(null)
  const [status, setStatus] = useState('Ready to upload a receipt')
  const [jobId, setJobId] = useState(null)
  const [showDashboard, setShowDashboard] = useState(false)
  const [dashboardReceipts, setDashboardReceipts] = useState([])
  const [selectedReceipt, setSelectedReceipt] = useState(null)
  const [isUploading, setIsUploading] = useState(false)

  useEffect(() => { fetchProfiles(); fetchProfileSummaries(); }, [])

  useEffect(() => {
    if (!selectedProfile && profiles.length === 1) {
      const singleProfileId = profiles[0].id
      setSelectedProfile(singleProfileId)
      loadReceiptsForProfile(singleProfileId)
    }
  }, [profiles, selectedProfile])

  const fetchProfiles = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/profiles`)
      const j = await res.json()
      setProfiles(j.profiles || [])
    } catch (e) {}
  }

  const fetchProfileSummaries = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/profiles/summary`)
      const j = await res.json()
      setProfileSummaries(j.profiles || [])
    } catch (e) {}
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
    const res = await fetch(`${API_BASE}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newProfile }) })
    const j = await res.json()
    if (j.profile) {
      setNewProfile('')
      await fetchProfiles()
      await fetchProfileSummaries()
      await selectProfile(j.profile.id)
    }
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
      setJobId(data.jobId)
      setShowDashboard(true)
      setStatus('Receipt uploaded. We are processing it now...')
      if (selectedProfile) {
        await loadReceiptsForProfile(selectedProfile)
      }
      pollJob(data.jobId)
    } else {
      setIsUploading(false)
      setStatus('Upload failed: ' + (data.error || JSON.stringify(data)))
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
              setStatus('Receipt saved for profile')
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

  const selectedSummary = profileSummaries.find(p => p.id === selectedProfile) || null

  return (
    <div className="pipboy-app">
      <style>{`
        :root { color-scheme: dark; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #030503; }
        .pipboy-app {
          min-height: 100vh;
          padding: 24px;
          background: radial-gradient(circle at top, #183423 0%, #07120a 45%, #020402 100%);
          color: #dfe8c8;
          font-family: 'Courier New', Consolas, monospace;
          position: relative;
          overflow: hidden;
        }
        .pipboy-app::before {
          content: '';
          position: fixed;
          inset: 0;
          background-image: linear-gradient(transparent 0%, rgba(255,255,255,0.03) 50%, transparent 100%);
          background-size: 100% 4px;
          pointer-events: none;
          opacity: 0.2;
        }
        .pipboy-shell {
          max-width: 1200px;
          margin: 0 auto;
          padding: 24px;
          border: 2px solid #7f8f57;
          border-radius: 24px;
          background: rgba(6, 12, 8, 0.95);
          box-shadow: 0 0 0 1px rgba(148, 182, 96, 0.25), 0 0 45px rgba(0, 0, 0, 0.45), inset 0 0 28px rgba(88, 119, 49, 0.16);
          position: relative;
          overflow: hidden;
        }
        .pipboy-shell::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(135deg, rgba(255,255,255,0.04), transparent 42%, rgba(129, 164, 81, 0.06));
          pointer-events: none;
        }
        .scanlines {
          position: absolute;
          inset: 0;
          background: repeating-linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.03) 1px, transparent 1px, transparent 3px);
          mix-blend-mode: screen;
          opacity: 0.16;
          pointer-events: none;
          animation: scan 4s linear infinite;
        }
        .flicker { animation: flicker 3.4s infinite; }
        @keyframes flicker {
          0%, 18%, 22%, 25%, 53%, 57%, 100% { opacity: 1; }
          20%, 24%, 55% { opacity: 0.95; }
          19%, 21%, 56% { opacity: 0.92; }
        }
        @keyframes scan {
          from { transform: translateY(-100%); }
          to { transform: translateY(100%); }
        }
        .pipboy-title { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; }
        .pipboy-title h1 { margin: 0; font-size: 28px; letter-spacing: 0.22em; text-transform: uppercase; color: #eaf2c7; }
        .pipboy-title p { margin: 0; color: #8fa06d; font-size: 13px; text-transform: uppercase; letter-spacing: 0.16em; }
        .vault-chip { display: inline-flex; width: fit-content; padding: 5px 9px; border: 1px solid #7f8f57; border-radius: 999px; font-size: 11px; letter-spacing: 0.2em; color: #a8c055; background: rgba(163, 190, 96, 0.08); }
        .stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
        .stat-card, .panel-card { background: rgba(13, 24, 15, 0.9); border: 1px solid #6d7b46; border-radius: 14px; padding: 12px; box-shadow: inset 0 0 14px rgba(103, 128, 53, 0.12); }
        .stat-label { font-size: 11px; letter-spacing: 0.2em; color: #8fa06d; text-transform: uppercase; }
        .stat-value { font-size: 20px; font-weight: 700; margin-top: 4px; color: #f4f8d9; }
        .main-grid { display: grid; grid-template-columns: 1.08fr 0.92fr; gap: 16px; }
        .panel-card h2, .panel-card h3, .panel-card h4 { margin-top: 0; color: #ecf4c4; letter-spacing: 0.14em; text-transform: uppercase; font-size: 15px; }
        .panel-card label { display: block; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8fa06d; margin-bottom: 8px; }
        .panel-card input, .panel-card select, .panel-card button { font: inherit; }
        .panel-card input, .panel-card select {
          width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #57643c; background: rgba(5, 10, 7, 0.9); color: #f4f8d9;
        }
        .panel-card button {
          border: 1px solid #8ca455; background: linear-gradient(180deg, #334923, #1b2815); color: #f3f8cb; padding: 8px 12px; border-radius: 8px; cursor: pointer;
          box-shadow: inset 0 0 10px rgba(164, 196, 92, 0.16);
        }
        .panel-card button:hover { filter: brightness(1.1); }
        .panel-card button:disabled { cursor: wait; opacity: 0.75; }
        .pill { display: inline-block; padding: 6px 10px; border-radius: 999px; background: rgba(133, 159, 82, 0.16); color: #cddfae; border: 1px solid #6d7b46; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; }
        .status-box { margin-top: 12px; padding: 12px; border-radius: 10px; background: rgba(14, 32, 16, 0.95); border: 1px solid #607143; color: #dfeac4; }
        .profile-list button, .receipt-item {
          width: 100%; text-align: left; border: 1px solid #596b3f; background: rgba(10, 20, 12, 0.82); border-radius: 10px; padding: 10px; cursor: pointer; color: #eef4cb; margin-bottom: 8px;
        }
        .profile-list button.active { border-color: #b8e64b; box-shadow: inset 0 0 10px rgba(184, 230, 75, 0.15); }
        .receipt-item { cursor: default; }
        .muted { color: #7b8f63; font-size: 13px; }
        .spacer { height: 8px; }
        @media (max-width: 900px) {
          .main-grid { grid-template-columns: 1fr; }
          .stats-grid { grid-template-columns: 1fr; }
        }
      `}</style>
      <div className="scanlines" />
      <div className="pipboy-shell">
        <div className="pipboy-title flicker">
          <span className="vault-chip">Vault-Tec / Interface</span>
          <h1>Fortress Hub // Pip-Boy Link</h1>
          <p>Receipt routing stable. Vault profile sync active.</p>
        </div>

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
                <input placeholder="Vault name" value={newProfile} onChange={e => setNewProfile(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button type="button" onClick={createProfile}>Create Profile</button>
                <label style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 10px', borderRadius: 8, border: '1px solid #57643c', background: 'rgba(5, 10, 7, 0.9)', cursor: 'pointer', color: '#f4f8d9' }}>
                  <span>{file ? file.name : 'Choose file'}</span>
                  <input type="file" accept="image/*,.pdf" onChange={e => setFile(e.target.files[0])} style={{ display: 'none' }} />
                </label>
              </div>
              <button type="submit" disabled={isUploading}>{isUploading ? 'Processing…' : 'Upload'}</button>
            </form>
            <div className="status-box">
              <strong>Status:</strong> {status}
            </div>
            <div className="muted" style={{ marginTop: 8 }}>Uploads appear in the dashboard automatically once processing finishes.</div>
            {jobId && <div className="muted" style={{ marginTop: 8 }}>Job ID: {jobId}</div>}
            {selectedReceipt && (
              <div className="status-box" style={{ marginTop: 14 }}>
                <h3>Latest Receipt</h3>
                <div><strong>ID:</strong> {selectedReceipt.id}</div>
                <div><strong>Vendor:</strong> {selectedReceipt.vendor}</div>
                <div><strong>Date:</strong> {selectedReceipt.date}</div>
                <div><strong>Total:</strong> {money(selectedReceipt.total)}</div>
              </div>
            )}
          </div>

          <div className="panel-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Dashboard</h2>
              <button onClick={openDashboard}>{showDashboard ? 'Refresh' : 'Open Dashboard'}</button>
            </div>

            {selectedSummary && (
              <div className="status-box" style={{ marginBottom: 12 }}>
                <strong>{selectedSummary.name}</strong><br />
                Receipts: {selectedSummary.receipt_count || 0} • Total: {money(selectedSummary.total_spent || 0)}
              </div>
            )}

            {showDashboard && (
              <div>
                <h4>Profiles</h4>
                <div className="profile-list">
                  {profileSummaries.map(p => (
                    <button key={p.id} className={selectedProfile === p.id ? 'active' : ''} onClick={() => selectProfile(p.id)}>
                      <strong>{p.name}</strong><br />
                      <span className="muted">{p.receipt_count || 0} receipts • {money(p.total_spent || 0)}</span>
                    </button>
                  ))}
                </div>

                <h4 style={{ marginTop: 16 }}>Receipts for Selected Profile</h4>
                <div>
                  {dashboardReceipts.length === 0 && <div className="muted">No receipts yet for this profile.</div>}
                  {dashboardReceipts.map(r => (
                    <div key={r.id} className="receipt-item">
                      <div style={{ fontWeight: 700 }}>{r.vendor}</div>
                      <div className="muted">{r.date} • {money(r.total)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
