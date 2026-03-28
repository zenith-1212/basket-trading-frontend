/**
 * ActiveBaskets.jsx — v2.0
 * =========================
 * FIX #3: "Edit Order" button — allows modifying limit price / SL on active orders.
 * FIX #4: Exit now calls POST /api/orders/exit_basket to square off in demat.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import toast from 'react-hot-toast'

const isMobile = () => window.innerWidth < 768
const API = () => import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'

function PnlBar({ pnl, target, sl }) {
  const range   = target + sl
  const clamped = Math.max(-sl, Math.min(target, pnl))
  const pct     = ((clamped + sl) / range) * 100
  const isPos   = pnl >= 0
  const color   = isPos ? 'var(--green)' : 'var(--red)'

  return (
    <div className="pnl-track">
      <div style={{ position: 'absolute', left: 0, width: `${(sl / range) * 100}%`, height: '100%', background: 'rgba(192,57,43,0.12)', borderRadius: '3px 0 0 3px' }} />
      <div style={{ position: 'absolute', right: 0, width: `${(target / range) * 100}%`, height: '100%', background: 'rgba(0,135,90,0.12)', borderRadius: '0 3px 3px 0' }} />
      <div style={{ position: 'absolute', left: `${(sl / range) * 100}%`, width: 1, height: '100%', background: 'var(--border2)' }} />
      <div className="pnl-cursor" style={{ left: `${pct}%`, background: color, borderColor: '#fff' }} />
    </div>
  )
}

// ── FIX #3: Edit Order Modal (limit price + SL trigger) ──────────────────────
function EditOrderModal({ order, token, onClose, onSave }) {
  const [newPrice,  setNewPrice]  = useState(order.entry_price || 0)
  const [slTrigger, setSlTrigger] = useState(0)
  const [saving,    setSaving]    = useState(false)

  async function save() {
    if (!order.order_id) {
      toast.error('No order ID — cannot modify (paper mode?)')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`${API()}/api/orders/modify`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body:    JSON.stringify({
          order_id:       order.order_id,
          new_price:      parseFloat(newPrice)  || null,
          trigger_price:  parseFloat(slTrigger) || null,
          order_type:     slTrigger > 0 ? 'SL' : 'LMT',
          trading_symbol: order.trd_symbol || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Modify failed')
      toast.success(`Order ${order.order_id} modified ✓`)
      onSave({ ...order, entry_price: parseFloat(newPrice) || order.entry_price })
      onClose()
    } catch (err) {
      toast.error(`Modify failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-white)', borderRadius: 12, padding: 20, width: 300,
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)', border: '1px solid var(--border)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>
          Edit Order — {order.symbol} {order.strike} {order.option_type}
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600, marginBottom: 4 }}>
            NEW LIMIT PRICE ₹
          </div>
          <input
            type="number" step="0.05"
            className="input" value={newPrice}
            onChange={e => setNewPrice(e.target.value)}
            style={{ fontSize: 16, fontFamily: 'var(--mono)', padding: '8px', width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: 'var(--red-txt)', fontWeight: 600, marginBottom: 4 }}>
            SL TRIGGER PRICE ₹ (0 = no SL)
          </div>
          <input
            type="number" step="0.05"
            className="input" value={slTrigger}
            onChange={e => setSlTrigger(e.target.value)}
            style={{ fontSize: 16, fontFamily: 'var(--mono)', padding: '8px', width: '100%',
                     borderColor: 'rgba(192,57,43,0.4)' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline btn-sm" onClick={onClose}
            style={{ flex: 1, justifyContent: 'center' }}>
            Cancel
          </button>
          <button
            className="btn" onClick={save} disabled={saving}
            style={{ flex: 2, justifyContent: 'center', background: 'var(--blue)', color: '#fff',
                     border: 'none', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer',
                     padding: '9px 0', fontSize: 13, fontWeight: 700 }}>
            {saving ? 'Modifying...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Edit Basket Targets Modal (profit ₹ + SL ₹ for a live basket) ─────────────
function EditTargetsModal({ basket, onClose, onSave }) {
  const [profit, setProfit] = useState(String(basket.lockedProfit || 0))
  const [loss,   setLoss]   = useState(String(basket.lockedLoss   || 0))

  function save() {
    const p = parseFloat(profit)
    const l = parseFloat(loss)
    if (isNaN(p) || p <= 0) { toast.error('Enter a valid profit target > 0'); return }
    if (isNaN(l) || l <= 0) { toast.error('Enter a valid stop-loss > 0');     return }
    onSave(p, l)
    toast.success(`Targets updated — TGT ₹${p.toLocaleString()} / SL ₹${l.toLocaleString()}`)
    onClose()
  }

  function handleKey(e) {
    if (e.key === 'Enter') save()
    if (e.key === 'Escape') onClose()
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, padding: '16px',
    }} onClick={onClose}>
      {/* Centered card — not a bottom-sheet, so mobile keyboard cannot push it off-screen */}
      <div style={{
        background: 'var(--bg-white)', borderRadius: 14,
        padding: '20px 18px 20px', width: '100%', maxWidth: 400,
        boxShadow: '0 8px 40px rgba(0,0,0,0.22)', border: '1px solid var(--border)',
      }} onClick={e => e.stopPropagation()}>

        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3 }}>
          Edit Basket Targets
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 18 }}>
          Changes take effect immediately on this basket.
        </div>

        {/* Target Profit */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: 'var(--green-txt)', fontWeight: 700, marginBottom: 6, letterSpacing: '0.05em' }}>
            TARGET PROFIT
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 0,
            border: '1.5px solid rgba(0,135,90,0.5)', borderRadius: 8, overflow: 'hidden',
            background: 'var(--bg-panel)',
          }}>
            <span style={{
              padding: '10px 10px 10px 14px', fontSize: 17, fontWeight: 800,
              color: 'var(--green-txt)', background: 'transparent', userSelect: 'none',
              lineHeight: 1,
            }}>₹</span>
            <input
              type="number" min="1" step="50"
              inputMode="numeric"
              value={profit}
              onChange={e => setProfit(e.target.value)}
              onKeyDown={handleKey}
              style={{
                flex: 1, fontSize: 20, fontFamily: 'var(--mono)', fontWeight: 700,
                padding: '10px 12px 10px 0', border: 'none', outline: 'none',
                background: 'transparent', color: 'var(--green-txt)', width: '100%',
              }}
            />
          </div>
        </div>

        {/* Stop Loss */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: 'var(--red-txt)', fontWeight: 700, marginBottom: 6, letterSpacing: '0.05em' }}>
            STOP LOSS
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 0,
            border: '1.5px solid rgba(192,57,43,0.5)', borderRadius: 8, overflow: 'hidden',
            background: 'var(--bg-panel)',
          }}>
            <span style={{
              padding: '10px 10px 10px 14px', fontSize: 17, fontWeight: 800,
              color: 'var(--red-txt)', background: 'transparent', userSelect: 'none',
              lineHeight: 1,
            }}>₹</span>
            <input
              type="number" min="1" step="50"
              inputMode="numeric"
              value={loss}
              onChange={e => setLoss(e.target.value)}
              onKeyDown={handleKey}
              style={{
                flex: 1, fontSize: 20, fontFamily: 'var(--mono)', fontWeight: 700,
                padding: '10px 12px 10px 0', border: 'none', outline: 'none',
                background: 'transparent', color: 'var(--red-txt)', width: '100%',
              }}
            />
          </div>
        </div>

        {/* Preview bar */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 11, marginBottom: 18,
          padding: '7px 12px', borderRadius: 7, background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
        }}>
          <span style={{ color: 'var(--red-txt)', fontWeight: 700 }}>SL ₹{(parseFloat(loss)||0).toLocaleString()}</span>
          <span style={{ color: 'var(--text3)', fontSize: 10 }}>← basket range →</span>
          <span style={{ color: 'var(--green-txt)', fontWeight: 700 }}>TGT ₹{(parseFloat(profit)||0).toLocaleString()}</span>
        </div>

        {/* Buttons — always at the bottom, full width */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '12px 0', fontSize: 13, fontWeight: 600,
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderRadius: 8, cursor: 'pointer', color: 'var(--text2)',
            }}>
            Cancel
          </button>
          <button
            onClick={save}
            style={{
              flex: 2, padding: '12px 0', fontSize: 14, fontWeight: 800,
              background: 'var(--green)', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer',
              letterSpacing: '0.01em',
            }}>
            ✓ Update Targets
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Basket Card ───────────────────────────────────────────────────────────────
function BasketCard({ basket, index }) {
  const { closeBasket, adjustBalance, addHistory, isLive, token, updateBasketTargets } = useStore()
  const [exiting,      setExiting]      = useState(false)
  const [editOrder,    setEditOrder]    = useState(null)   // FIX #3
  const [editTargets,  setEditTargets]  = useState(false)  // FIX: profit ₹ edit

  const pnl   = basket.pnl || 0
  const isPos = pnl >= 0
  const color = isPos ? 'var(--green-txt)' : 'var(--red-txt)'
  const bgPnl = isPos ? 'var(--green-dim)' : 'var(--red-dim)'

  // ── FIX #4: Exit places REAL opposite orders in demat ─────────────────────
  async function exit() {
    if (isLive) {
      const ok = window.confirm(
        `Exit basket #${index + 1}?\n\nThis will place SELL/BUY orders on Kotak to square off:\n` +
        basket.orders.map(o => `${o.side === 'BUY' ? 'SELL' : 'BUY'} ${o.symbol} ${o.strike} ${o.option_type} × ${o.quantity}`).join('\n')
      )
      if (!ok) return

      setExiting(true)
      toast.loading('Squaring off on Kotak Neo...', { id: 'exit' })

      try {
        const res = await fetch(`${API()}/api/orders/exit_basket`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            basket_id: basket.id,
            orders: basket.orders.map(o => ({
              symbol:      o.symbol,
              strike:      o.strike,
              option_type: o.option_type,
              expiry:      o.expiry,
              side:        o.side,
              quantity:    o.quantity,
              order_type:  'MKT',
              product:     o.product || 'MIS',
              trd_symbol:  o.trd_symbol || '',
              order_id:    o.order_id  || '',
            })),
          }),
        })

        const data = await res.json()

        if (!res.ok) throw new Error(data.detail || 'Exit failed')

        if (data.failed > 0) {
          const forceClose = window.confirm(
            `${data.exited} legs exited, ${data.failed} failed:\n` +
            data.errors.map(e => e.error).join('\n') +
            '\n\nForce-close in UI anyway?'
          )
          if (!forceClose) { setExiting(false); return }
          toast.error(`Partial exit: ${data.failed} legs failed`, { id: 'exit' })
        } else {
          toast.success(`✅ ${data.exited} leg(s) squared off on Kotak`, { id: 'exit' })
        }

      } catch (err) {
        const forceClose = window.confirm(
          `Exit API error: ${err.message}\n\nForce-close in UI anyway? (positions may still be open in demat)`
        )
        if (!forceClose) { setExiting(false); return }
        toast.error(`Exit error: ${err.message}`, { id: 'exit' })
      } finally {
        setExiting(false)
      }
    }

    // Close in UI (paper mode always lands here; live mode after API success)
    closeBasket(basket.id)
    if (!isLive) adjustBalance(pnl)
    addHistory({
      id: Date.now(), time: new Date().toLocaleTimeString('en-IN'),
      type: 'MANUAL', pnl, loop: basket.loop,
    })
    toast(`Basket #${index + 1} exited · ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)}`,
          { icon: pnl >= 0 ? '✅' : '🔴' })
  }

  return (
    <div className="anim-in" style={{
      margin: '6px 8px', borderRadius: 10,
      border: '1px solid var(--border)', background: 'var(--bg-white)',
      overflow: 'hidden', boxShadow: 'var(--shadow)',
    }}>
      {/* FIX #3: Edit modal */}
      {editOrder && (
        <EditOrderModal
          order={editOrder}
          token={token}
          onClose={() => setEditOrder(null)}
          onSave={() => setEditOrder(null)}
        />
      )}

      {/* FIX: Edit basket profit/SL targets modal */}
      {editTargets && (
        <EditTargetsModal
          basket={basket}
          onClose={() => setEditTargets(false)}
          onSave={(profit, loss) => {
            updateBasketTargets(basket.id, profit, loss)
          }}
        />
      )}

      {/* Card header */}
      <div style={{ padding: '8px 12px', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>#{index + 1}</span>
          <span className="badge badge-blue">Loop {basket.loop}</span>
          {basket.autoLoop && <span style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 600 }}>⟳ AUTO</span>}
        </div>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>{basket.entryTime}</span>
          <span className={`badge ${basket.mode === 'LIVE' ? 'badge-green' : 'badge-amber'}`}>{basket.mode}</span>
        </div>
      </div>

      <div style={{ padding: '10px 12px' }}>
        {/* P&L */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: bgPnl }}>
          <span style={{ fontSize: 11, color, fontWeight: 600 }}>P & L</span>
          <span style={{ fontSize: 26, fontWeight: 800, color, fontFamily: 'var(--mono)', letterSpacing: '-0.02em' }}>
            {isPos ? '+' : ''}₹{Math.abs(pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </span>
        </div>

        <PnlBar pnl={pnl} target={basket.lockedProfit} sl={basket.lockedLoss} />

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', marginBottom: 10, marginTop: 4, alignItems: 'center' }}>
          <span style={{ color: 'var(--red-txt)', fontWeight: 600 }}>SL ₹{basket.lockedLoss.toLocaleString()}</span>
          <button
            onClick={() => setEditTargets(true)}
            title="Edit profit target & stop-loss"
            style={{
              background: 'none', border: '1px solid var(--border)',
              borderRadius: 4, padding: '1px 7px', fontSize: 9,
              color: 'var(--blue)', cursor: 'pointer', fontWeight: 700,
              letterSpacing: '0.03em',
            }}>
            ✎ Edit Targets
          </button>
          <span style={{ color: 'var(--green-txt)', fontWeight: 600 }}>TGT ₹{basket.lockedProfit.toLocaleString()}</span>
        </div>

        {/* Orders — FIX #3: each row has an Edit button (live mode only) */}
        <div style={{ marginBottom: 10 }}>
          {basket.orders.map((o, i) => (
            <div key={i} style={{
              display: 'flex', gap: 6, fontSize: 12, alignItems: 'center',
              padding: '5px 0',
              borderBottom: i < basket.orders.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <span className={`badge ${o.side === 'BUY' ? 'badge-green' : 'badge-red'}`} style={{ fontSize: 9 }}>{o.side}</span>
              <span style={{ fontWeight: 600, flex: 1 }}>{o.symbol} {o.strike} {o.option_type}</span>
              <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>₹{o.entry_price.toFixed(1)}</span>
              {/* FIX #3: Edit button (live mode with order_id only) */}
              {basket.mode === 'LIVE' && o.order_id && (
                <button
                  onClick={() => setEditOrder(o)}
                  style={{
                    background: 'var(--bg-panel)', border: '1px solid var(--border)',
                    borderRadius: 4, padding: '2px 6px', fontSize: 9,
                    color: 'var(--blue)', cursor: 'pointer', fontWeight: 600,
                  }}>
                  Edit
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={exit}
          disabled={exiting}
          className="btn btn-danger"
          style={{ width: '100%', justifyContent: 'center', fontSize: 13, padding: '10px', touchAction: 'manipulation', opacity: exiting ? 0.6 : 1 }}>
          {exiting ? '⏳ Squaring off...' : 'Exit Basket'}
        </button>
      </div>
    </div>
  )
}

export default function ActiveBaskets() {
  const { activeBaskets, tradeHistory } = useStore()
  const mobile = isMobile()

  const outerStyle = mobile
    ? { width: '100%', background: 'var(--bg-panel)' }
    : { width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-panel)' }

  return (
    <div style={outerStyle}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-white)', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Active Baskets</span>
        <span className="badge badge-blue">{activeBaskets.length} running</span>
      </div>

      <div style={mobile ? {} : { flex: 1, overflow: 'auto', minHeight: 0 }}>
        {activeBaskets.length === 0 ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text3)' }}>
            <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.15 }}>◎</div>
            <div style={{ fontSize: 12, lineHeight: 1.8 }}>No active baskets.<br />Build and execute a basket.</div>
          </div>
        ) : (
          activeBaskets.map((b, i) => <BasketCard key={b.id} basket={b} index={i} />)
        )}
      </div>

      {tradeHistory.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0, background: 'var(--bg-white)' }}>
          <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
            Recent Exits
          </div>
          {tradeHistory.slice(0, 6).map(h => (
            <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 12px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)', fontSize: 10 }}>{h.time}</span>
              <span className={`badge ${h.type === 'TARGET' ? 'badge-green' : h.type === 'SL' ? 'badge-red' : 'badge-grey'}`} style={{ fontSize: 9 }}>{h.type}</span>
              <span style={{ color: h.pnl >= 0 ? 'var(--green-txt)' : 'var(--red-txt)', fontWeight: 700, fontFamily: 'var(--mono)' }}>
                {h.pnl >= 0 ? '+' : ''}₹{Math.abs(h.pnl).toFixed(0)}
              </span>
              <span style={{ fontSize: 9, color: 'var(--text3)' }}>L{h.loop}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
