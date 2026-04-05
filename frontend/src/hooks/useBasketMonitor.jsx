/**
 * useBasketMonitor.jsx — v6.0  (Trade Persistence Edition)
 * ==========================================================
 * New in v6.0:
 *  1. On mount, re-subscribes to WS price feed for any basket restored from DB
 *     (baskets with _fromDB flag) so live P&L resumes after page refresh.
 *  2. Persists P&L to DB every 30 seconds via POST /api/baskets/{id}/update_pnl.
 *  3. Auto-exit calls POST /api/baskets/{id}/exit with exit_type so history
 *     is recorded server-side (previously only lived in frontend memory).
 *  4. closeBasket() only called after successful backend exit (or force-close).
 *
 * Retained from v5.1:
 *  - 500ms P&L computation loop
 *  - closingRef debounce to prevent double-exit
 *  - lastPnlRef to skip unchanged store updates
 */
import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

const POLL_MS     = 500
const DB_SYNC_MS  = 30_000   // persist P&L to DB every 30 seconds
const API = () => import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'

export function useBasketMonitor() {
  const {
    activeBaskets,
    basketPrices,
    updateBasketPnl,
    closeBasket,
    adjustBalance,
    token,
  } = useStore()

  const basketsRef  = useRef(activeBaskets)
  const pricesRef   = useRef(basketPrices)
  const tokenRef    = useRef(token)
  const closingRef  = useRef(new Set())
  const lastPnlRef  = useRef({})
  const lastSyncRef = useRef({})     // id → last DB sync timestamp

  useEffect(() => { basketsRef.current = activeBaskets }, [activeBaskets])
  useEffect(() => { pricesRef.current  = basketPrices  }, [basketPrices])
  useEffect(() => { tokenRef.current   = token         }, [token])

  // ── Auth header helper ────────────────────────────────────────────────────
  const authHeaders = useCallback(() => ({
    'Content-Type':  'application/json',
    ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
  }), [])

  // ── Persist P&L to DB (non-blocking, best-effort) ────────────────────────
  const syncPnlToDB = useCallback(async (basketId, pnl) => {
    const now = Date.now()
    if ((now - (lastSyncRef.current[basketId] || 0)) < DB_SYNC_MS) return
    lastSyncRef.current[basketId] = now
    try {
      await fetch(`${API()}/api/baskets/${basketId}/update_pnl`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ current_pnl: pnl }),
      })
    } catch (e) {
      console.warn('[MONITOR] P&L sync failed:', e)
    }
  }, [authHeaders])

  // ── Call backend exit then remove from store ──────────────────────────────
  const exitBasketWithBackend = useCallback(async (basket, exitType, pnl) => {
    try {
      await fetch(`${API()}/api/baskets/${basket.id}/exit`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ exit_pnl: pnl, exit_type: exitType }),
      })
    } catch (e) {
      console.warn('[MONITOR] Backend exit failed (closing UI anyway):', e)
    }
    closeBasket(basket.id)
    adjustBalance(pnl)
    delete lastSyncRef.current[basket.id]
    delete lastPnlRef.current[basket.id]
  }, [authHeaders, closeBasket, adjustBalance])

  // ── Re-subscribe restored baskets to WS price feed ───────────────────────
  useEffect(() => {
    const restoredBaskets = basketsRef.current.filter(b => b._fromDB)
    if (restoredBaskets.length === 0) return

    // Collect all trd_symbols from restored baskets
    const instruments = []
    restoredBaskets.forEach(b => {
      b.orders.forEach(o => {
        if (o.trd_symbol) {
          instruments.push({
            trd_symbol: o.trd_symbol,
            SecurityId: o.trd_symbol,
          })
        }
      })
    })

    if (instruments.length === 0) return

    // Send set_basket message to WS — the existing usePriceFeed hook owns the socket,
    // so we dispatch a custom event that usePriceFeed listens to.
    window.dispatchEvent(new CustomEvent('basket-monitor:resubscribe', {
      detail: { instruments }
    }))
  }, []) // run once after mount (baskets already loaded by fetchActiveBaskets)

  // ── Main P&L computation loop ─────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const baskets = basketsRef.current
      const prices  = pricesRef.current

      for (const basket of baskets) {
        if (closingRef.current.has(basket.id)) continue

        const orders = basket.orders || []
        if (orders.length === 0) continue

        let totalPnl = 0
        let allPriced = true

        for (const order of orders) {
          const token = order.trd_symbol || ''
          const ltp   = prices[token]

          if (!ltp || ltp <= 0) { allPriced = false; continue }

          const entry  = order.entry_price || 0
          const qty    = order.quantity    || 0
          const legPnl = order.side === 'BUY'
            ? (ltp - entry) * qty
            : (entry - ltp) * qty

          totalPnl += legPnl
        }

        const pnl = Math.round(totalPnl * 100) / 100

        // Update store only when P&L changes
        if (pnl !== lastPnlRef.current[basket.id]) {
          lastPnlRef.current[basket.id] = pnl
          updateBasketPnl(basket.id, pnl)
          // Persist to DB throttled to DB_SYNC_MS
          syncPnlToDB(basket.id, pnl)
        }

        // Auto-exit — only when all legs priced
        if (!allPriced) continue

        const target   = basket.lockedProfit ?? Infinity
        const sl       = basket.lockedLoss   ?? Infinity
        const hitTarget = target > 0 && pnl >=  target
        const hitSL     = sl     > 0 && pnl <= -sl

        if (hitTarget || hitSL) {
          closingRef.current.add(basket.id)
          const exitType = hitTarget ? 'TARGET_HIT' : 'SL_HIT'
          const reason   = hitTarget
            ? `🎯 Target hit ₹${target.toLocaleString()}`
            : `🔴 Stop-loss hit ₹${sl.toLocaleString()}`

          toast(reason, { duration: 4000 })

          exitBasketWithBackend(basket, exitType, pnl).finally(() => {
            setTimeout(() => closingRef.current.delete(basket.id), 2000)
          })
        }
      }
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [updateBasketPnl, syncPnlToDB, exitBasketWithBackend])
}
