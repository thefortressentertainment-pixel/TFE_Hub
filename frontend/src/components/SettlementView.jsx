import { useEffect, useState } from 'react'

export default function SettlementView({ apiBase }) {
  const [team, setTeam] = useState(null)
  const [agentId, setAgentId] = useState('core')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [exchange, setExchange] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch(`${apiBase}/api/settlement/team`)
      .then(r => r.json())
      .then(j => { if (!cancelled && j.ok) setTeam(j) })
      .catch(() => { if (!cancelled) setError('Settlement roster unavailable') })
    return () => { cancelled = true }
  }, [apiBase])

  const talk = async (e) => {
    e.preventDefault()
    if (!msg.trim() || busy) return
    setBusy(true); setError(''); setExchange(null)
    try {
      const r = await fetch(`${apiBase}/api/settlement/talk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentId, message: msg }),
      })
      const j = await r.json()
      setExchange(j)
      if (!j.ok) setError(j.error || 'talk failed')
      const t = await fetch(`${apiBase}/api/settlement/team`).then(x => x.json())
      if (t.ok) setTeam(t)
    } catch (err) {
      setError(String(err))
    } finally { setBusy(false) }
  }

  if (error && !team) return <div className="muted" style={{ padding: 12, fontSize: 12 }}>Settlement: {error}</div>

  return (
    <div style={{ padding: '0 16px 14px' }}>
      <div style={{ fontWeight: 700, fontSize: 12, margin: '2px 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span role="img" aria-label="settlement">🏰</span> Fortress Settlement
        <span className="muted" style={{ fontWeight: 400 }}>Moltis-era agent team — {team ? `${team.rosterCount} agents · ${team.tiers.length} tiers` : '…'}</span>
      </div>
      {team && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {team.tiers.map(g => (
            <div key={g.tier} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8, minWidth: 150, flex: '1 1 150px' }}>
              <div className="muted" style={{ fontSize: 10.5, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>{g.label}</div>
              {g.agents.map(a => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }} onClick={() => setAgentId(a.id)}>
                  <span style={{ fontWeight: 600, color: agentId === a.id ? 'var(--accent, #7cc0ff)' : 'var(--text)', fontSize: 11.5 }}>{a.name}</span>
                  <span title={`ROI ${a.roi}/100 · used ${a.uses}x`} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 6, background: a.roi >= 75 ? 'rgba(60,180,120,.16)' : 'rgba(220,140,60,.16)', color: a.roi >= 75 ? '#57c787' : '#e8a45c', whiteSpace: 'nowrap' }}>{a.roi}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <form onSubmit={talk} className="flex" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ fontSize: 12, maxWidth: 210 }} title="Pick an agent">
          {team ? team.tiers.flatMap(g => g.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)) : null}
        </select>
        <input
          value={msg} onChange={e => setMsg(e.target.value)} placeholder="Talk to the agent…"
          style={{ flex: 1, minWidth: 220, fontSize: 12 }}
        />
        <button className="btn-sm btn-primary" disabled={busy || !msg.trim()}>{busy ? 'Contacting…' : 'Contact'}</button>
      </form>
      {error && <div className="status-box" style={{ marginTop: 8, fontSize: 11.5, borderRadius: 8 }}>{error}</div>}
      {exchange && exchange.ok && (
        <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
          <div className="muted" style={{ fontSize: 10.5, marginBottom: 4 }}>
            {exchange.agent.name} · via {exchange.provider}/{exchange.model || '—'}
          </div>
          <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{exchange.reply}</div>
        </div>
      )}
    </div>
  )
}