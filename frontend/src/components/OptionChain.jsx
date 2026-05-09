/**
 * OptionChain.jsx — Full chain with hybrid WS + REST pricing
 */
import { useStore, LOT_SIZES, STRIKE_GAP } from '../store'
import { useEffect, useRef, useCallback } from 'react'
import toast from 'react-hot-toast'

const API = import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'
const isMobile = () => window.innerWidth < 768
const ATM_WINDOW = 30
const REST_INTERVAL = 4000

export default function OptionChain() {
  const {
    selectedSymbol, selectedExpiry, chain, spotPrices, chainLoading,
    basket, basketSize, setSymbol, setExpiry, addToBasket, fetchChainLtps,
    applyChainSnapshot, setExpiriesFromBackend, token, wsConnected,
  } = useStore()

  const spot    = spotPrices[selectedSymbol] || 0
  const rows    = chain.options[selectedExpiry] || []
  const isFull  = basket.length >= basketSize
  const mobile  = isMobile()
  const gap     = STRIKE_GAP[selectedSymbol] || 50

  const atmRowRef    = useRef(null)
  const tableWrapRef = useRef(null)
  const restTimerRef = useRef(null)
  const prevKeyRef   = useRef('')

  const atmStrike = spot > 0 ? Math.round(spot / gap) * gap : 0

  const scrollToAtm = useCallback(() => {
    if (atmRowRef.current && tableWrapRef.current) {
      const wrap = tableWrapRef.current
      const row  = atmRowRef.current
      wrap.scrollTop = row.offsetTop - wrap.clientHeight / 2 + row.offsetHeight / 2
    }
  }, [])

  useEffect(() => {
    const key = `${selectedSymbol}:${selectedExpiry}`
    if (key !== prevKeyRef.current && rows.length > 0) {
      prevKeyRef.current = key
      setTimeout(scrollToAtm, 120)
    }
  }, [selectedSymbol, selectedExpiry, rows.length, scrollToAtm])

  const atmKey = atmStrike
  useEffect(() => {
    if (atmStrike > 0) setTimeout(scrollToAtm, 80)
  }, [atmKey]) // eslint-disable-line

  const fetchRestChain = useCallback(async () => {
    if (!selectedSymbol || !selectedExpiry) return
    const MON = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                 Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'}
    const toYmd = (exp) => {
      const p = exp.split('-')
      if (p.length === 3 && p[0].length === 2) return `${p[2]}-${MON[p[1]] || '01'}-${p[0].padStart(2,'0')}`
      return exp
    }
    const ymd = toYmd(selectedExpiry)
    try {
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}
      const res = await fetch(`${API}/api/prices/chain/${selectedSymbol}?expiry=${ymd}`, { headers: authHeaders })
      if (!res.ok) return
      const body = await res.json()
      const chainData = body.chain || {}
      if (Object.keys(chainData).length === 0) return
      applyChainSnapshot(selectedSymbol, selectedExpiry, chainData, ymd)
    } catch { /* silent */ }
  }, [selectedSymbol, selectedExpiry, applyChainSnapshot, token])

  // Market hours check (IST)
  function isMarketHours() {
    const now = new Date()
    if (now.getDay() === 0 || now.getDay() === 6) return false
    const ist  = new Date(now.getTime() + 5.5 * 3600 * 1000)
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes()
    return mins >= 540 && mins <= 935
  }

  // REST poll:
  //  - Market OPEN + WS connected → no poll needed (all ticks via WS)
  //  - Market OPEN + WS down → poll every 4s as fallback
  //  - Market CLOSED → fetch once to show last closing prices, then stop
  useEffect(() => {
    if (restTimerRef.current) clearInterval(restTimerRef.current)
    if (!selectedSymbol || !selectedExpiry) return

    if (!isMarketHours()) {
      // Fetch closing prices once — no repeat polling needed
      fetchRestChain()
      return
    }

    if (wsConnected) return   // Market open + WS live — no REST poll needed

    // Market open + WS down — poll as fallback
    fetchRestChain()
    restTimerRef.current = setInterval(fetchRestChain, REST_INTERVAL)
    return () => { if (restTimerRef.current) clearInterval(restTimerRef.current) }
  }, [selectedSymbol, selectedExpiry, wsConnected]) // eslint-disable-line

  const fetchRealExpiries = useCallback(async () => {
    if (!selectedSymbol) return
    try {
      const authHeaders = token ? { Authorization: `Bearer ${token}` } : {}
      const res = await fetch(`${API}/api/prices/expiries/${selectedSymbol}`, { headers: authHeaders })
      if (!res.ok) return
      const body = await res.json()
      const expiries = body.expiries || []
      if (expiries.length > 0) {
        setExpiriesFromBackend(selectedSymbol, expiries)
      }
    } catch (e) {
      console.warn('[EXPIRY] Could not fetch real expiries:', e)
    }
  }, [selectedSymbol, setExpiriesFromBackend, token])

  useEffect(() => {
    fetchRealExpiries()
  }, [selectedSymbol]) // eslint-disable-line

  function add(row, optType, side) {
    if (isFull) { toast.error(`Basket full — max ${basketSize} orders`); return }
    const ltp        = optType === 'CE' ? row.ce_ltp : row.pe_ltp
    const trd_symbol = optType === 'CE' ? (row.ce_token || '') : (row.pe_token || '')
    addToBasket({
      id: Date.now(), symbol: selectedSymbol, strike: row.strike,
      option_type: optType, expiry: selectedExpiry, side,
      lot_count: 1,
      quantity: LOT_SIZES[selectedSymbol] || 75, entry_price: ltp,
      trd_symbol,
    })
    toast.success(`${side} ${selectedSymbol} ${row.strike}${optType} added`, { duration: 1500 })
  }

  function refresh() {
    fetchChainLtps(selectedSymbol, selectedExpiry)
    fetchRestChain()
    toast('Refreshing chain...', { icon: '↻', duration: 1500 })
  }

  async function restartBackend() {
    const ok = window.confirm('Restart the backend service on EC2?\n\nThe app will be unavailable for ~5 seconds.')
    if (!ok) return
    const toastId = toast.loading('Restarting backend…')
    try {
      const res = await fetch(`${API}/api/admin/restart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      toast.success('Backend restarting… reconnecting in 6s', { id: toastId, duration: 4000 })
      setTimeout(() => window.location.reload(), 6000)
    } catch (err) {
      if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
        toast.success('Backend restarting… reconnecting in 6s', { id: toastId, duration: 4000 })
        setTimeout(() => window.location.reload(), 6000)
      } else {
        toast.error(`Restart failed: ${err.message}`, { id: toastId })
      }
    }
  }

  const th = (align = 'right') => ({
    padding: '6px 8px', fontSize: 10, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--text3)', background: '#f1f5f9',
    borderBottom: '2px solid var(--border)',
    textAlign: align, userSelect: 'none',
    position: 'sticky', top: 0, zIndex: 2,
    whiteSpace: 'nowrap',
  })

  const outerStyle = mobile
    ? { width: '100%', background: 'var(--bg-white)' }
    : { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        minHeight: 0, background: 'var(--bg-white)', borderRight: '1px solid var(--border)' }

  const tableWrapStyle = mobile
    ? { overflowX: 'auto', overflowY: 'auto', WebkitOverflowScrolling: 'touch', maxHeight: '70vh' }
    : { flex: 1, overflow: 'auto', minHeight: 0 }

  return (
    <div style={outerStyle}>

      {/* Toolbar */}
      <div style={{
        padding: mobile ? '8px 10px' : '8px 14px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 6, alignItems: 'center',
        flexShrink: 0, background: 'var(--bg-panel)',
        flexWrap: mobile ? 'wrap' : 'nowrap',
      }}>
        <div className="sym-pills" style={{ display: 'flex', gap: 4 }}>
          {['NIFTY', 'BANKNIFTY', 'SENSEX'].map(s => (
            <div key={s} className={`sym-pill ${selectedSymbol === s ? 'active' : ''}`}
              onClick={() => setSymbol(s)}
              style={{ padding: mobile ? '4px 10px' : '5px 14px', fontSize: 11 }}
            >{s}</div>
          ))}
        </div>

        <select className="select" value={selectedExpiry}
          onChange={e => setExpiry(e.target.value)}
          style={{ fontSize: 12, padding: '5px 8px', flex: mobile ? 1 : 'unset' }}>
          {chain.expiries.map(e => <option key={e}>{e}</option>)}
        </select>

        <button onClick={scrollToAtm} className="btn btn-outline btn-sm"
          title="Jump to ATM"
          style={{ fontSize: 11, padding: '4px 8px', flexShrink: 0 }}>
          ◎ ATM
        </button>

        <button onClick={refresh} className="btn btn-outline btn-sm"
          style={{ fontSize: 11, padding: '4px 8px', flexShrink: 0 }}>
          {chainLoading ? '⏳' : '↻'} Refresh
        </button>

        <button
          onClick={restartBackend}
          title="Restart backend service on EC2"
          className="btn btn-outline btn-sm"
          style={{ fontSize: 11, padding: '4px 8px', flexShrink: 0, color: 'var(--red-txt)', borderColor: 'rgba(192,57,43,0.35)' }}>
          ⚙ Restart
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: mobile ? 18 : 20, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
            {spot > 0 ? `₹${spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
          </span>
          {chainLoading && <span style={{ fontSize: 10, color: 'var(--blue)' }}>Loading...</span>}
        </div>
      </div>

      {/* Table */}
      <div style={tableWrapStyle} ref={tableWrapRef}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: mobile ? 340 : 'unset' }}>
          <thead>
            <tr>
              <th style={th('center')}>ACT</th>
              <th style={th('right')}>CE LTP</th>
              <th style={{ ...th('center'), color: 'var(--blue)', fontWeight: 800, minWidth: 80 }}>STRIKE</th>
              <th style={th('left')}>PE LTP</th>
              <th style={th('center')}>ACT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const isAtm      = atmStrike > 0 && row.strike === atmStrike
              const itmCE      = spot > 0 && row.strike < spot
              const itmPE      = spot > 0 && row.strike > spot
              const rowBg      = isAtm ? 'var(--bg-atm)' : (itmCE || itmPE) ? 'var(--bg-panel)' : 'var(--bg-white)'
              const strikeDist = atmStrike > 0 ? Math.abs(row.strike - atmStrike) / gap : 999
              const inWsWindow = strikeDist <= ATM_WINDOW

              return (
                <tr
                  key={row.strike}
                  ref={isAtm ? atmRowRef : null}
                  style={{ background: rowBg, borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#dbeafe'}
                  onMouseLeave={e => e.currentTarget.style.background = rowBg}
                  onTouchStart={e => e.currentTarget.style.background = '#dbeafe'}
                  onTouchEnd={e => e.currentTarget.style.background = rowBg}
                >
                  {/* CE Actions */}
                  <td style={{ width: 72, textAlign: 'center', padding: '4px 4px' }}>
                    <div style={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
                      <button className="act-buy"  onClick={() => add(row, 'CE', 'BUY')}  style={{ padding: '4px 8px', fontSize: 11 }}>B</button>
                      <button className="act-sell" onClick={() => add(row, 'CE', 'SELL')} style={{ padding: '4px 8px', fontSize: 11 }}>S</button>
                    </div>
                  </td>

                  {/* CE LTP */}
                  <td style={{
                    textAlign: 'right', padding: '6px 10px',
                    fontFamily: 'var(--mono)', fontSize: 12,
                    fontWeight: itmCE ? 700 : 400,
                    color: itmCE ? 'var(--text)' : 'var(--text2)',
                  }}>
                    {row.ce_ltp > 0 ? (
                      <span>
                        {row.ce_ltp.toFixed(2)}
                        {inWsWindow && (
                          <span style={{ marginLeft: 3, fontSize: 7, color: 'var(--green)', verticalAlign: 'super' }}>●</span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text3)' }}>—</span>
                    )}
                  </td>

                  {/* STRIKE */}
                  <td style={{
                    textAlign: 'center', padding: '5px 4px',
                    fontWeight: 700, fontSize: isAtm ? 13 : 12,
                    color: isAtm ? 'var(--blue)' : 'var(--text)',
                    background: isAtm ? 'rgba(59,130,246,0.1)' : 'var(--bg-panel)',
                    borderLeft: '1px solid var(--border)',
                    borderRight: '1px solid var(--border)',
                    minWidth: 80,
                    outline: isAtm ? '2px solid var(--blue)' : 'none',
                    outlineOffset: isAtm ? '-2px' : '0',
                  }}>
                    {row.strike.toLocaleString('en-IN')}
                    {isAtm && (
                      <div style={{ fontSize: 8, color: 'var(--blue)', fontWeight: 800, lineHeight: 1, marginTop: 1 }}>
                        ATM
                      </div>
                    )}
                  </td>

                  {/* PE LTP */}
                  <td style={{
                    textAlign: 'left', padding: '6px 10px',
                    fontFamily: 'var(--mono)', fontSize: 12,
                    fontWeight: itmPE ? 700 : 400,
                    color: itmPE ? 'var(--text)' : 'var(--text2)',
                  }}>
                    {row.pe_ltp > 0 ? (
                      <span>
                        {row.pe_ltp.toFixed(2)}
                        {inWsWindow && (
                          <span style={{ marginLeft: 3, fontSize: 7, color: 'var(--green)', verticalAlign: 'super' }}>●</span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text3)' }}>—</span>
                    )}
                  </td>

                  {/* PE Actions */}
                  <td style={{ width: 72, textAlign: 'center', padding: '4px 4px' }}>
                    <div style={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
                      <button className="act-sell" onClick={() => add(row, 'PE', 'SELL')} style={{ padding: '4px 8px', fontSize: 11 }}>S</button>
                      <button className="act-buy"  onClick={() => add(row, 'PE', 'BUY')}  style={{ padding: '4px 8px', fontSize: 11 }}>B</button>
                    </div>
                  </td>
                </tr>
              )
            })}

            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: 40, color: 'var(--text3)', fontSize: 13 }}>
                  {chainLoading ? '⏳ Loading chain...' : '— No strikes loaded —'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Status bar */}
      <div style={{
        padding: '5px 12px', borderTop: '1px solid var(--border)', flexShrink: 0,
        background: isFull ? 'var(--green-dim)' : 'var(--bg-panel)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: isFull ? 'var(--green)' : '#cbd5e1' }} />
        <span style={{ fontSize: 11, color: isFull ? 'var(--green-txt)' : 'var(--text3)', fontWeight: isFull ? 600 : 400 }}>
          {isFull
            ? `✔ Basket ready (${basket.length}/${basketSize})`
            : `${basket.length}/${basketSize} orders added`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>
          {rows.length} strikes &nbsp;·&nbsp; <span style={{ color: 'var(--green)' }}>●</span> WS ±{ATM_WINDOW} &nbsp;·&nbsp; REST {REST_INTERVAL/1000}s
        </span>
      </div>
    </div>
  )
}
