import { useState, useEffect } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

const useMobile = () => {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return mobile
}

export default function Header() {
  const {
    spotPrices, priceChanges, wsConnected, isLive, setLive,
    paperBalance, liveBalance, activeTab, setTab, selectedSymbol, setSymbol,
  } = useStore()

  const [time, setTime]         = useState(new Date())
  const [tokStatus, setTokStatus] = useState('idle')
  const mobile                  = useMobile()
  const API = import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const isMarketOpen = (() => {
    const now = new Date(), day = now.getDay()
    if (day === 0 || day === 6) return false
    const m = now.getHours() * 60 + now.getMinutes()
    return m >= 555 && m <= 930
  })()

  async function refreshToken() {
    const s = JSON.parse(localStorage.getItem('dhan_config') || '{}')
    if (!s.client_id || !s.pin || !s.totp_secret) {
      toast.error('Save Dhan credentials in Settings first'); return
    }
    setTokStatus('loading')
    toast.loading('Fetching token...', { id: 'tok' })
    try {
      const res  = await fetch(`${API}/api/token/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: s.client_id, pin: s.pin, totp_secret: s.totp_secret }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Failed')
      toast.success('Token refreshed!', { id: 'tok' })
      setTokStatus('done')
    } catch (e) {
      toast.error(e.message, { id: 'tok' })
      setTokStatus('error')
    } finally {
      setTimeout(() => setTokStatus('idle'), 3000)
    }
  }

  // ─── MOBILE HEADER ────────────────────────────────────────────────────────
  if (mobile) {
    return (
      <header style={{ background: 'var(--bg-header)', flexShrink: 0 }}>

        {/* Row 1: Logo + controls */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '6px 10px', gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          {/* Logo */}
          <div style={{
            width: 26, height: 26, background: 'var(--blue)', borderRadius: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 800, color: '#fff', flexShrink: 0,
          }}>B</div>

          <div style={{ fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
            Basket Loop Trader
          </div>

          <div style={{ flex: 1 }} />

          {/* Market dot */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: wsConnected ? '#4ade80' : '#64748b',
            }} />
            <span style={{ fontSize: 9, color: isMarketOpen ? '#4ade80' : 'rgba(255,255,255,0.4)' }}>
              {isMarketOpen ? 'OPEN' : 'CLOSED'}
            </span>
          </div>

          {/* Token button */}
          <button onClick={refreshToken} disabled={tokStatus === 'loading'} style={{
            padding: '4px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)',
            fontSize: 11, cursor: 'pointer', touchAction: 'manipulation',
          }}>
            {tokStatus === 'loading' ? '⏳' : tokStatus === 'done' ? '✓' : '🔑'}
          </button>

          {/* Live/Paper toggle */}
          <button onClick={() => setLive(!isLive)} style={{
            padding: '5px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 10, background: isLive ? '#16a34a' : '#d97706',
            color: '#fff', flexShrink: 0, touchAction: 'manipulation',
          }}>
            {isLive ? '● LIVE' : '◐ PAPER'}
          </button>
        </div>

        {/* Row 2: Index cards (horizontally scrollable) */}
        <div style={{
          display: 'flex', overflowX: 'auto', overflowY: 'hidden',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}>
          {['NIFTY', 'BANKNIFTY', 'SENSEX'].map(sym => {
            const price  = spotPrices[sym] || 0
            const change = priceChanges[sym] || 0
            const pct    = price > 0 ? (change / Math.max(1, price - change)) * 100 : 0
            const isUp   = change >= 0
            const active = selectedSymbol === sym
            return (
              <div key={sym} onClick={() => setSymbol(sym)} style={{
                padding: '6px 16px', cursor: 'pointer', flexShrink: 0,
                borderRight: '1px solid rgba(255,255,255,0.08)',
                background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                touchAction: 'manipulation',
              }}>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.06em' }}>{sym}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', fontFamily: 'var(--mono)', lineHeight: 1.3 }}>
                  {price > 0 ? price.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—'}
                </div>
                <div style={{ fontSize: 9, fontWeight: 600, color: isUp ? '#4ade80' : '#f87171' }}>
                  {isUp ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
                </div>
              </div>
            )
          })}

          {/* Balance — paper or live */}
          <div style={{ padding: '6px 14px', flexShrink: 0, marginLeft: 'auto' }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em' }}>
              {isLive ? 'KOTAK BAL' : 'PAPER BAL'}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono)',
              color: isLive ? '#4ade80' : '#fbbf24' }}>
              ₹{(isLive ? liveBalance : paperBalance).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </div>
        </div>

      </header>
    )
  }

  // ─── DESKTOP HEADER (unchanged) ──────────────────────────────────────────
  return (
    <header style={{ background: 'var(--bg-header)', flexShrink: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', padding: '0 0 0 16px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', flexShrink: 0 }}>
          <div style={{
            width: 30, height: 30, background: 'var(--blue)', borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 800, color: '#fff',
          }}>B</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Basket Loop Trader</div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em' }}>DHAN DATA · KOTAK NEO · HYBRID</div>
          </div>
        </div>

        {/* Index cards */}
        <div style={{ display: 'flex', flex: 1, marginLeft: 20 }}>
          {['NIFTY', 'BANKNIFTY', 'SENSEX'].map(sym => {
            const price  = spotPrices[sym] || 0
            const change = priceChanges[sym] || 0
            const pct    = price > 0 ? (change / Math.max(1, price - change)) * 100 : 0
            const isUp   = change >= 0
            return (
              <div key={sym} onClick={() => setSymbol(sym)} style={{
                padding: '8px 18px', cursor: 'pointer',
                borderRight: '1px solid rgba(255,255,255,0.1)',
                background: selectedSymbol === sym ? 'rgba(255,255,255,0.08)' : 'transparent',
                transition: 'background 0.15s', userSelect: 'none',
              }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.06em', marginBottom: 2 }}>{sym}</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: '#fff', letterSpacing: '-0.01em', fontFamily: 'var(--mono)' }}>
                  {price > 0 ? price.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
                </div>
                <div style={{ fontSize: 10, color: isUp ? '#4ade80' : '#f87171', fontWeight: 600 }}>
                  {isUp ? '▲' : '▼'} {Math.abs(change).toFixed(2)} ({Math.abs(pct).toFixed(2)}%)
                </div>
              </div>
            )
          })}
        </div>

        {/* Right controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div className={isMarketOpen ? 'dot-live' : 'dot-off'} />
            <span style={{ fontSize: 10, color: isMarketOpen ? '#4ade80' : 'rgba(255,255,255,0.35)' }}>
              {isMarketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: wsConnected ? '#4ade80' : '#64748b' }} />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{wsConnected ? 'FEED' : 'NO FEED'}</span>
          </div>
          <button onClick={refreshToken} disabled={tokStatus === 'loading'} style={{
            padding: '4px 10px', borderRadius: 4,
            background: tokStatus === 'done' ? 'rgba(74,222,128,0.2)' : tokStatus === 'error' ? 'rgba(248,113,113,0.2)' : 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.15)',
            color: tokStatus === 'done' ? '#4ade80' : tokStatus === 'error' ? '#f87171' : 'rgba(255,255,255,0.6)',
            fontSize: 10, cursor: 'pointer', fontFamily: 'var(--sans)',
          }}>
            {tokStatus === 'loading' ? '⏳ Refreshing...' : tokStatus === 'done' ? '✓ Token OK' : tokStatus === 'error' ? '✗ Failed' : '🔑 Refresh Token'}
          </button>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em' }}>
              {isLive ? 'KOTAK BAL' : 'PAPER'}
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--mono)',
              color: isLive ? '#4ade80' : '#fbbf24' }}>
              ₹{(isLive ? liveBalance : paperBalance).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </div>
          <button onClick={() => setLive(!isLive)} style={{
            padding: '6px 14px', borderRadius: 5, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 11, background: isLive ? '#16a34a' : '#d97706', color: '#fff',
          }}>
            {isLive ? '● LIVE' : '◐ PAPER'}
          </button>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--mono)', minWidth: 72, textAlign: 'right' }}>
            {time.toLocaleTimeString('en-IN')}
          </div>
        </div>
      </div>

      {/* Desktop nav tabs */}
      <div style={{ display: 'flex', paddingLeft: 16, background: 'rgba(0,0,0,0.2)' }}>
        {[['terminal', '📊 Terminal'], ['history', '📋 History'], ['settings', '⚙ Settings']].map(([tab, label]) => (
          <div key={tab} onClick={() => setTab(tab)} style={{
            padding: '8px 18px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
            color: activeTab === tab ? '#fff' : 'rgba(255,255,255,0.4)',
            borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
            transition: 'all 0.15s', userSelect: 'none',
          }}>{label}</div>
        ))}
      </div>
    </header>
  )
}
