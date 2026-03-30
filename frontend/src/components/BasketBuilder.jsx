import { useState } from 'react'
import { useStore, LOT_SIZES } from '../store'
import toast from 'react-hot-toast'

const isMobile = () => window.innerWidth < 768
const API = () => import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'

export default function BasketBuilder() {
  const {
    basket, basketSize, setBasketSize, removeFromBasket, clearBasket,
    lockedProfit, lockedLoss, autoLoop, setLockedProfit, setLockedLoss, setAutoLoop,
    addActiveBasket, isLive, selectedSymbol, token,
    liveBalance, setLiveBalance,
  } = useStore()

  const [placing, setPlacing] = useState(false)
  const isEmpty    = basket.length === 0
  const isFull     = basket.length >= basketSize
  const totalValue = basket.reduce((s, o) => s + o.entry_price * o.quantity, 0)
  const mobile     = isMobile()

  async function execute() {
    if (isEmpty)         { toast.error('Add orders to basket first'); return }
    if (lockedProfit <= 0) { toast.error('Set target profit > 0'); return }
    if (lockedLoss   <= 0) { toast.error('Set stop loss > 0'); return }

    if (isLive) {
      const ok = window.confirm(
        `⚠️ LIVE MODE — ${basket.length} REAL order(s) will be placed on Kotak Neo!\n\n` +
        basket.map(o => `${o.side} ${o.symbol} ${o.strike} ${o.option_type} × ${o.quantity}`).join('\n') +
        `\n\nConfirm?`
      )
      if (!ok) return

      // ── Place orders via backend ──────────────────────────────────────────
      setPlacing(true)
      toast.loading('Placing orders on Kotak Neo...', { id: 'exec' })

      try {
        const res  = await fetch(`${API()}/api/orders/place_basket`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            orders: basket.map(o => ({
              symbol:      o.symbol,
              strike:      o.strike,
              option_type: o.option_type,
              expiry:      o.expiry,
              side:        o.side,
              quantity:    o.quantity,
              order_type:  'MKT',
              product:     'MIS',
              trd_symbol:  o.trd_symbol || o.ce_token || o.pe_token || '',
            })),
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.detail || 'Order placement failed')
        }

        if (data.failed > 0) {
          toast.error(
            `${data.placed} placed, ${data.failed} failed:\n` +
            data.errors.map(e => e.error).join('\n'),
            { id: 'exec', duration: 6000 }
          )
        } else {
          toast.success(
            `✅ ${data.placed} order(s) placed on Kotak Neo!`,
            { id: 'exec' }
          )
        }

        // Add to active baskets with real order IDs
        // IMPORTANT: store trd_symbol from backend result (scrip-search corrected)
        // so that WS set_basket subscription uses the EXACT symbol the exchange knows
        addActiveBasket({
          id:           Date.now().toString(),
          symbol:       selectedSymbol,
          orders:       basket.map((o, i) => ({
            ...o,
            order_id:   data.results[i]?.order_id       || '',
            trd_symbol: data.results[i]?.trading_symbol || o.trd_symbol || '',
          })),
          lockedProfit, lockedLoss, autoLoop,
          pnl:          0,
          status:       'ACTIVE',
          loop:         1,
          entryTime:    new Date().toLocaleTimeString('en-IN'),
          mode:         'LIVE',
        })
        clearBasket()

        // Refresh live balance after placing
        fetchLiveBalance()

      } catch (err) {
        toast.error(`Order failed: ${err.message}`, { id: 'exec', duration: 6000 })
      } finally {
        setPlacing(false)
      }

    } else {
      // ── Paper mode — no API call needed ──────────────────────────────────
      addActiveBasket({
        id:          Date.now().toString(),
        symbol:      selectedSymbol,
        orders:      basket.map(o => ({ ...o })),
        lockedProfit, lockedLoss, autoLoop,
        pnl:         0, status: 'ACTIVE', loop: 1,
        entryTime:   new Date().toLocaleTimeString('en-IN'),
        mode:        'PAPER',
      })
      clearBasket()
      toast.success('Basket executed in PAPER mode')
    }
  }

  async function fetchLiveBalance() {
    try {
      const res  = await fetch(`${API()}/api/orders/balance`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = await res.json()
      if (data.balance !== undefined && setLiveBalance) {
        setLiveBalance(data.balance)
        toast.success(`Balance: ₹${data.balance.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, { duration: 3000 })
      }
    } catch (e) {
      console.warn('[BALANCE] Could not fetch live balance:', e)
    }
  }

  // On mobile: full width, no overflow:hidden
  const outerStyle = mobile
    ? { width: '100%', background: 'var(--bg-white)' }
    : { width: 290, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-white)', borderRight: '1px solid var(--border)' }

  return (
    <div style={outerStyle}>

      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Basket Builder</div>
          {/* Live balance pill */}
          {isLive && liveBalance > 0 && (
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--green-txt)', background: 'var(--green-dim)', padding: '2px 8px', borderRadius: 10 }}>
              ₹{liveBalance.toLocaleString('en-IN', { maximumFractionDigits: 0 })} available
            </div>
          )}
          {isLive && liveBalance === 0 && (
            <button onClick={fetchLiveBalance} style={{
              fontSize: 9, padding: '2px 8px', borderRadius: 10, border: '1px solid var(--border2)',
              background: '#fff', color: 'var(--blue)', cursor: 'pointer', touchAction: 'manipulation',
            }}>↻ Load Balance</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          <span style={{ fontSize: 10, color: 'var(--text3)', alignSelf: 'center', marginRight: 2 }}>SIZE</span>
          {[2, 4, 6, 8, 10, 12].map(s => (
            <button key={s} onClick={() => setBasketSize(s)} style={{
              flex: 1, padding: '4px 0', borderRadius: 4, border: '1px solid',
              borderColor: basketSize === s ? 'var(--blue)' : 'var(--border)',
              background:  basketSize === s ? 'var(--blue-dim)' : '#fff',
              color:       basketSize === s ? 'var(--blue)' : 'var(--text2)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', touchAction: 'manipulation',
            }}>{s}</button>
          ))}
        </div>
      </div>

      {/* Orders list */}
      <div style={mobile
        ? { padding: '6px' }
        : { flex: 1, overflow: 'auto', minHeight: 0 }
      }>
        {isEmpty ? (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text3)' }}>
            <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.2 }}>⬡</div>
            <div style={{ fontSize: 11, lineHeight: 1.7 }}>Click B (Buy) or S (Sell)<br />in the option chain<br />to add orders</div>
          </div>
        ) : (
          <div style={{ padding: mobile ? 0 : '6px' }}>
            {basket.map((order, i) => (
              <div key={order.id} className="anim-in" style={{
                marginBottom: 5, padding: '10px 12px', borderRadius: 8,
                background: 'var(--bg-panel)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <span className={`badge ${order.side === 'BUY' ? 'badge-green' : 'badge-red'}`}>{order.side}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {order.symbol} {order.strike} {order.option_type}
                    </span>
                  </div>
                  <button onClick={() => removeFromBasket(i)} style={{
                    background: 'none', border: 'none', color: 'var(--text3)',
                    cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '2px 6px',
                    touchAction: 'manipulation',
                  }}>×</button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)' }}>
                  <span style={{ fontFamily: 'var(--mono)' }}>₹{order.entry_price.toFixed(1)} × {order.quantity}</span>
                  <span style={{ color: 'var(--text3)' }}>{order.expiry}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Total */}
      {!isEmpty && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', flexShrink: 0, background: 'var(--bg-panel)' }}>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Total Premium</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
            ₹{totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </span>
        </div>
      )}

      {/* Config: Target / SL / AutoLoop */}
      <div style={{ padding: '12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--green-txt)', fontWeight: 600, marginBottom: 4 }}>TARGET ₹</div>
            <input type="number" className="input" value={lockedProfit}
              onChange={e => setLockedProfit(Number(e.target.value))}
              style={{ fontSize: 16, fontFamily: 'var(--mono)', padding: '8px', borderColor: 'rgba(0,135,90,0.4)' }} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--red-txt)', fontWeight: 600, marginBottom: 4 }}>STOP LOSS ₹</div>
            <input type="number" className="input" value={lockedLoss}
              onChange={e => setLockedLoss(Number(e.target.value))}
              style={{ fontSize: 16, fontFamily: 'var(--mono)', padding: '8px', borderColor: 'rgba(192,57,43,0.4)' }} />
          </div>
        </div>
        <div onClick={() => setAutoLoop(!autoLoop)} className="toggle-wrap">
          <div className={`toggle ${autoLoop ? 'on' : ''}`} />
          <span style={{ fontSize: 12, color: autoLoop ? 'var(--green-txt)' : 'var(--text2)', fontWeight: autoLoop ? 600 : 400 }}>
            Auto-Loop {autoLoop ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </div>

      {/* Execute buttons */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
        <button className="btn btn-outline btn-sm" onClick={clearBasket} disabled={isEmpty || placing}
          style={{ fontSize: 12, touchAction: 'manipulation' }}>Clear</button>
        <button
          onClick={execute}
          disabled={isEmpty || placing}
          style={{
            flex: 1, padding: mobile ? '12px 0' : '10px 0',
            border: 'none', borderRadius: 6,
            cursor: (isEmpty || placing) ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--sans)', fontSize: mobile ? 14 : 12,
            fontWeight: 700, letterSpacing: '0.02em',
            background: (isEmpty || placing) ? 'var(--border)' : isLive ? 'var(--green)' : 'var(--blue)',
            color: (isEmpty || placing) ? 'var(--text3)' : '#fff',
            transition: 'all 0.15s', touchAction: 'manipulation',
          }}
        >
          {placing            ? '⏳ Placing orders...'
           : isEmpty          ? 'Add Orders First'
           : isLive           ? `▶ Execute Live (${basket.length} legs)`
                              : `▶ Execute Paper (${basket.length} legs)`}
        </button>
      </div>
    </div>
  )
}
