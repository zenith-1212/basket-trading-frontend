import { useState } from 'react'
import toast from 'react-hot-toast'
import { useStore } from '../store'

const API = () => import.meta.env.VITE_API_URL || 'https://api.baskettrading.in'

function Section({ title, children }) {
  return (
    <div className="card" style={{ padding:16 }}>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--text2)', letterSpacing:'0.08em',
        textTransform:'uppercase', marginBottom:14, fontFamily:'var(--sans)',
        paddingBottom:8, borderBottom:'1px solid var(--border)' }}>{title}</div>
      {children}
    </div>
  )
}

function Field({ label, note, ...props }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:10, color:'var(--text3)', marginBottom:4, letterSpacing:'0.06em' }}>{label}</div>
      <input className="input" {...props} />
      {note && <div style={{ fontSize:10, color:'var(--text3)', marginTop:3 }}>{note}</div>}
    </div>
  )
}

export default function SettingsPage() {
  const { token } = useStore()

  const [engine, setEngine] = useState(() => ({
    url: localStorage.getItem('engine_url') || 'https://api.baskettrading.in'
  }))
  const [engineStatus, setEngineStatus] = useState(null)

  const [dhan, setDhan] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dhan_config') || '{}') } catch { return {} }
  })
  const [dhanFields, setDhanFields] = useState({
    client_id:   dhan.client_id   || '',
    pin:         dhan.pin         || '',
    totp_secret: dhan.totp_secret || '',
    access_token: dhan.access_token || '',
  })

  const [kotak, setKotak] = useState({ consumer_key:'', mobile:'', password:'', mpin:'', ucc:'', totp_secret:'' })

  const [refreshing, setRefreshing]   = useState(false)
  const [refreshStatus, setRefreshStatus] = useState(null)  // null | 'ok' | 'error'
  const [refreshMsg, setRefreshMsg]   = useState('')

  async function testEngine() {
    setEngineStatus('Testing...')
    try {
      const res = await fetch(engine.url.replace(/\/$/, '') + '/health')
      if (res.ok) {
        const d = await res.json()
        setEngineStatus(`✓ Connected — ${d.subscribed_tokens || d.prices_cached || 0} tokens`)
      } else {
        setEngineStatus(`✗ HTTP ${res.status}`)
      }
    } catch (e) {
      setEngineStatus(`✗ Cannot reach engine`)
    }
  }

  function saveEngine() {
    localStorage.setItem('engine_url', engine.url)
    fetch(API() + '/api/engine/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ url: engine.url })
    }).catch(() => {})
    toast.success('Cloud Engine URL saved')
  }

  function saveDhan() {
    localStorage.setItem('dhan_config', JSON.stringify(dhanFields))
    toast.success('Dhan credentials saved locally')
  }

  function saveKotak() {
    localStorage.setItem('kotak_config', JSON.stringify(kotak))
    toast.success('Kotak credentials saved locally')
  }

  // ── Refresh Dhan Token ──────────────────────────────────────────────────────
  async function refreshDhanToken() {
    const { client_id, pin, totp_secret } = dhanFields

    if (!client_id || !pin || !totp_secret) {
      toast.error('Fill in CLIENT ID, PIN and TOTP SECRET first, then click Refresh Token.')
      return
    }

    setRefreshing(true)
    setRefreshStatus(null)
    setRefreshMsg('')
    toast.loading('Fetching new Dhan token...', { id: 'dhan-refresh' })

    try {
      const res = await fetch(API() + '/api/orders/refresh_dhan_token', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          client_id,
          pin,
          totp_secret,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.detail || `HTTP ${res.status}`)
      }

      // Update displayed access token field with the new token preview
      setDhanFields(f => ({ ...f, access_token: data.token_preview + ' (saved to backend .env)' }))
      localStorage.setItem('dhan_config', JSON.stringify({ ...dhanFields, access_token: data.token_preview }))

      const reloadInfo = data.engine_reload || data.engine_restart || {}
      const restartNote = reloadInfo.status === 'ok'
        ? 'Engine token hot-reloaded ✓ (no restart)'
        : reloadInfo.status === 'restarted'
        ? `Engine restarted (${reloadInfo.service})`
        : reloadInfo.error
        ? `Engine: ${reloadInfo.error}`
        : 'Token saved to .env'

      setRefreshStatus('ok')
      setRefreshMsg(`✅ Token refreshed · ${restartNote}`)
      toast.success(`Dhan token refreshed! ${restartNote}`, { id: 'dhan-refresh', duration: 6000 })

    } catch (err) {
      setRefreshStatus('error')
      setRefreshMsg(`❌ ${err.message}`)
      toast.error(`Token refresh failed: ${err.message}`, { id: 'dhan-refresh', duration: 8000 })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div style={{ flex:1, overflow:'auto', padding:16, display:'flex', flexDirection:'column', gap:12, maxWidth:800, margin:'0 auto', width:'100%' }}>

      <div style={{ padding:'12px 16px', background:'var(--amber-dim)', border:'1px solid rgba(255,171,0,0.3)',
        borderRadius:8, fontSize:11, color:'var(--amber)', display:'flex', gap:8, alignItems:'flex-start' }}>
        <span style={{ fontSize:16 }}>⚠</span>
        <span>Credentials are saved to <strong>your browser's local storage</strong> only. Never share them. For production, store them in your backend .env file.</span>
      </div>

      {/* Cloud Engine */}
      <Section title="☁ Cloud Engine">
        <Field label="BACKEND / ENGINE URL" placeholder="https://your-app.railway.app"
          value={engine.url} onChange={e => setEngine({url:e.target.value})} />
        {engineStatus && <div style={{ fontSize:11, color: engineStatus.startsWith('✓') ? 'var(--green-txt)' : 'var(--red-txt)', marginBottom:8 }}>{engineStatus}</div>}
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn-outline" onClick={testEngine} style={{ flex:1, justifyContent:'center' }}>🔌 Test Connection</button>
          <button className="btn btn-green" onClick={saveEngine} style={{ flex:1, justifyContent:'center' }}>Save URL</button>
        </div>
      </Section>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>

        {/* Dhan */}
        <Section title="Dhan API — Price Feed">
          <Field label="CLIENT ID" placeholder="1105862545" value={dhanFields.client_id}
            onChange={e => setDhanFields(d=>({...d, client_id:e.target.value}))} />
          <Field label="PIN (4–6 digits)" type="password" placeholder="••••••" value={dhanFields.pin}
            onChange={e => setDhanFields(d=>({...d, pin:e.target.value}))} />
          <Field label="TOTP SECRET (32 chars)" type="password" placeholder="D6SRY..." value={dhanFields.totp_secret}
            onChange={e => setDhanFields(d=>({...d, totp_secret:e.target.value}))}
            note="From developer.dhanhq.co > Enable TOTP > copy base32 key" />
          <Field label="CURRENT ACCESS TOKEN" type="password"
            placeholder="eyJ0eXAiOi... (auto-filled on refresh)"
            value={dhanFields.access_token}
            onChange={e => setDhanFields(d=>({...d, access_token:e.target.value}))} />

          {/* Status message */}
          {refreshMsg && (
            <div style={{
              fontSize:11, marginBottom:10, padding:'7px 10px', borderRadius:6,
              background: refreshStatus === 'ok' ? 'var(--green-dim)' : 'var(--red-dim)',
              color:      refreshStatus === 'ok' ? 'var(--green-txt)' : 'var(--red-txt)',
              border:     `1px solid ${refreshStatus === 'ok' ? 'rgba(0,135,90,0.25)' : 'rgba(192,57,43,0.25)'}`,
            }}>
              {refreshMsg}
            </div>
          )}

          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-green" onClick={saveDhan}
              style={{ flex:1, justifyContent:'center', fontSize:12 }}>
              Save Config
            </button>
            {/* THE REFRESH BUTTON */}
            <button
              onClick={refreshDhanToken}
              disabled={refreshing}
              style={{
                flex: 2,
                padding: '9px 0',
                border: 'none',
                borderRadius: 6,
                cursor: refreshing ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--sans)',
                fontSize: 13,
                fontWeight: 700,
                background: refreshing ? 'var(--border)' : 'var(--blue)',
                color: refreshing ? 'var(--text3)' : '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'all 0.15s',
              }}>
              {refreshing
                ? <><span style={{ animation:'spin 1s linear infinite', display:'inline-block' }}>⏳</span> Refreshing...</>
                : '🔄 Refresh Dhan Token'}
            </button>
          </div>
          <div style={{ fontSize:10, color:'var(--text3)', marginTop:6, lineHeight:1.6 }}>
            Fetches a new Dhan access token → saves it to .env → hot-reloads engine WebSocket (no restart needed).
          </div>
        </Section>

        {/* Kotak */}
        <Section title="Kotak Neo API — Live Orders">
          <Field label="CONSUMER KEY" placeholder="83e7e748-8fcd-..." value={kotak.consumer_key}
            onChange={e => setKotak(k=>({...k, consumer_key:e.target.value}))}
            note="From Kotak Neo app > More > Trade API" />
          <Field label="MOBILE NUMBER" placeholder="+919764322546" value={kotak.mobile}
            onChange={e => setKotak(k=>({...k, mobile:e.target.value}))} />
          <Field label="PASSWORD" type="password" placeholder="••••••••" value={kotak.password}
            onChange={e => setKotak(k=>({...k, password:e.target.value}))} />
          <Field label="MPIN (6 digits)" type="password" placeholder="••••••" value={kotak.mpin}
            onChange={e => setKotak(k=>({...k, mpin:e.target.value}))} />
          <Field label="UCC (Client Code)" placeholder="YWIC2" value={kotak.ucc}
            onChange={e => setKotak(k=>({...k, ucc:e.target.value}))} />
          <Field label="TOTP SECRET" type="password" placeholder="EIHWPACXF..." value={kotak.totp_secret}
            onChange={e => setKotak(k=>({...k, totp_secret:e.target.value}))} />
          <button className="btn btn-amber" onClick={saveKotak} style={{ width:'100%', justifyContent:'center' }}>
            SAVE KOTAK CONFIG
          </button>
        </Section>

      </div>

      {/* Info */}
      <Section title="How to get API credentials">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, fontSize:11, color:'var(--text2)', lineHeight:1.7 }}>
          <div>
            <div style={{ color:'var(--green-txt)', fontWeight:700, marginBottom:6 }}>Dhan API (for price feed)</div>
            <ol style={{ paddingLeft:16 }}>
              <li>Go to <a href="https://developer.dhanhq.co" target="_blank" style={{color:'var(--blue)'}}>developer.dhanhq.co</a></li>
              <li>Login with your Dhan account</li>
              <li>Create an app → copy CLIENT_ID</li>
              <li>Enable TOTP → save the 32-char base32 secret</li>
              <li>Enter PIN + TOTP SECRET above, click <strong>Refresh Token + Restart Engine</strong></li>
            </ol>
          </div>
          <div>
            <div style={{ color:'var(--amber)', fontWeight:700, marginBottom:6 }}>Kotak Neo API (for live orders)</div>
            <ol style={{ paddingLeft:16 }}>
              <li>Open Kotak Neo mobile app</li>
              <li>Go to More → Trade API → Default Application</li>
              <li>Copy your Consumer Key</li>
              <li>Set up TOTP in Profile → Security</li>
              <li>Note your UCC (client code) from Profile</li>
            </ol>
          </div>
        </div>
      </Section>

    </div>
  )
}
