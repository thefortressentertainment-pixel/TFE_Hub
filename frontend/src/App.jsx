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
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', background: '#f5f7fb', minHeight: '100vh' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ background: 'linear-gradient(135deg, #132a4d 0%, #274b8d 100%)', color: '#fff', borderRadius: 20, padding: 24, boxShadow: '0 12px 30px rgba(0,0,0,0.15)' }}>
          <h1 style={{ margin: 0, fontSize: 28 }}>🏰 Fortress Hub</h1>
          <p style={{ margin: '8px 0 0', opacity: 0.9 }}>Route receipts into the right profile, view them cleanly, and keep the portfolio organized.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 24, marginTop: 20 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.06)' }}>
            <h2 style={{ marginTop: 0 }}>Upload Receipt</h2>
            <form onSubmit={uploadReceipt}>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontWeight: 600, marginBottom: 8 }}>Profile</label>
                <select value={selectedProfile} onChange={e => selectProfile(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #cfd8e3', minWidth: 220 }}>
                  <option value="">(none)</option>
                  {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div style={{ marginBottom: 10 }}>
                <input placeholder="New profile name" value={newProfile} onChange={e => setNewProfile(e.target.value)} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #cfd8e3', marginRight: 8 }} />
                <button type="button" onClick={createProfile} style={{ padding: '8px 12px', borderRadius: 8, border: 0, background: '#274b8d', color: '#fff', cursor: 'pointer' }}>Create Profile</button>
              </div>
              <input type="file" accept="image/*,.pdf" onChange={e => setFile(e.target.files[0])} />
              <button type="submit" disabled={isUploading} style={{ marginLeft: 12, padding: '8px 14px', borderRadius: 8, border: 0, background: isUploading ? '#8ec49d' : '#16a34a', color: '#fff', cursor: isUploading ? 'wait' : 'pointer' }}>{isUploading ? 'Processing…' : 'Upload'}</button>
            </form>
            <div style={{ marginTop: 16, padding: 12, background: '#f8fafc', borderRadius: 10 }}><strong>Status:</strong> {status}</div>
            <div style={{ marginTop: 8, color: '#64748b', fontSize: 13 }}>Uploads appear in the dashboard automatically once processing finishes.</div>
            {jobId && <div style={{ marginTop: 8 }}>Job ID: {jobId}</div>}
            {selectedReceipt && (
              <div style={{ marginTop: 14, padding: 14, border: '1px solid #dbe4f0', borderRadius: 12 }}>
                <h3 style={{ marginTop: 0 }}>Latest Receipt</h3>
                <div><strong>ID:</strong> {selectedReceipt.id}</div>
                <div><strong>Vendor:</strong> {selectedReceipt.vendor}</div>
                <div><strong>Date:</strong> {selectedReceipt.date}</div>
                <div><strong>Total:</strong> {money(selectedReceipt.total)}</div>
              </div>
            )}
          </div>

          <div style={{ background: '#fff', borderRadius: 16, padding: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ marginTop: 0 }}>Dashboard</h2>
              <button onClick={openDashboard} style={{ padding: '8px 12px', borderRadius: 8, border: 0, background: '#132a4d', color: '#fff', cursor: 'pointer' }}>{showDashboard ? 'Refresh' : 'Open Dashboard'}</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
              <div style={{ background: '#eef4ff', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#5b6b82' }}>Profiles</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{profileSummaries.length}</div>
              </div>
              <div style={{ background: '#eefdf3', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#5b6b82' }}>Receipts</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{profileSummaries.reduce((acc, p) => acc + Number(p.receipt_count || 0), 0)}</div>
              </div>
              <div style={{ background: '#fff7e8', borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 12, color: '#5b6b82' }}>Spent</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{money(profileSummaries.reduce((acc, p) => acc + Number(p.total_spent || 0), 0))}</div>
              </div>
            </div>

            {selectedSummary && (
              <div style={{ marginBottom: 14, padding: 12, background: '#f8fafc', borderRadius: 10 }}>
                <strong>{selectedSummary.name}</strong><br />
                Receipts: {selectedSummary.receipt_count || 0} • Total: {money(selectedSummary.total_spent || 0)}
              </div>
            )}

            {showDashboard && (
              <div>
                <h4 style={{ marginTop: 0 }}>Profiles</h4>
                <div style={{ display: 'grid', gap: 8 }}>
                  {profileSummaries.map(p => (
                    <button key={p.id} onClick={() => selectProfile(p.id)} style={{ textAlign: 'left', border: selectedProfile === p.id ? '1px solid #274b8d' : '1px solid #dbe4f0', background: selectedProfile === p.id ? '#eef4ff' : '#fff', borderRadius: 10, padding: 10, cursor: 'pointer' }}>
                      <strong>{p.name}</strong><br />
                      {p.receipt_count || 0} receipts • {money(p.total_spent || 0)}
                    </button>
                  ))}
                </div>

                <h4 style={{ marginTop: 16 }}>Receipts for Selected Profile</h4>
                <div style={{ display: 'grid', gap: 8 }}>
                  {dashboardReceipts.length === 0 && <div style={{ color: '#64748b' }}>No receipts yet for this profile.</div>}
                  {dashboardReceipts.map(r => (
                    <div key={r.id} style={{ padding: 10, border: '1px solid #e2e8f0', borderRadius: 10 }}>
                      <div style={{ fontWeight: 700 }}>{r.vendor}</div>
                      <div style={{ color: '#64748b', fontSize: 13 }}>{r.date} • {money(r.total)}</div>
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
