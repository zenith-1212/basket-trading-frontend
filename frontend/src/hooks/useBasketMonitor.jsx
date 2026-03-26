/**
 * useBasketMonitor.jsx — v5.1
 * ============================
 * Monitors all active baskets for live P&L using basketPrices (token→ltp map).
 * Runs on a tight interval so P&L stays fresh even when chain view changes.
 *
 * Responsibilities:
 *  1. Compute per-basket P&L from basketPrices every 500ms
 *  2. Call updateBasketPnl(id, pnl) to push results into store
 *  3. Auto-close basket when target profit or stop-loss is hit
 *  4. Adjust paper balance on auto-close
 *
 * P&L formula (per order):
 *   BUY  leg: (current_ltp - entry_price) * quantity
 *   SELL leg: (entry_price - current_ltp) * quantity
 *   Total basket P&L = sum of all order P&Ls
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

const POLL_MS = 500

export function useBasketMonitor() {
  const {
    activeBaskets,
    basketPrices,
    updateBasketPnl,
    closeBasket,
    adjustBalance,
  } = useStore()

  // Keep refs so the interval always sees latest values without re-creating it
  const basketsRef = useRef(activeBaskets)
  const pricesRef  = useRef(basketPrices)
  const closingRef = useRef(new Set())   // IDs currently being auto-closed (debounce)
  const lastPnlRef = useRef({})          // id → last dispatched pnl (skip unchanged)

  useEffect(() => { basketsRef.current = activeBaskets }, [activeBaskets])
  useEffect(() => { pricesRef.current  = basketPrices  }, [basketPrices])

  useEffect(() => {
    const timer = setInterval(() => {
      const baskets = basketsRef.current
      const prices  = pricesRef.current

      for (const basket of baskets) {
        if (closingRef.current.has(basket.id)) continue

        const orders = basket.orders || []
        if (orders.length === 0) continue

        // ── Compute total basket P&L ───────────────────────────────────────────
        let totalPnl = 0
        let allPriced = true

        for (const order of orders) {
          const token = order.trd_symbol || ''
          const ltp   = prices[token]

          if (!ltp || ltp <= 0) {
            allPriced = false
            continue   // skip unpriced legs but don't bail entirely
          }

          const entry = order.entry_price || 0
          const qty   = order.quantity    || 0
          const legPnl = order.side === 'BUY'
            ? (ltp - entry) * qty
            : (entry - ltp) * qty

          totalPnl += legPnl
        }

        // Round to 2dp for display stability; skip store update if unchanged
        const pnl = Math.round(totalPnl * 100) / 100
        if (pnl !== lastPnlRef.current[basket.id]) {
          lastPnlRef.current[basket.id] = pnl
          updateBasketPnl(basket.id, pnl)
        }

        // ── Auto-exit on target / stop-loss ──────────────────────────────────
        if (!allPriced) continue   // only trigger exits when all legs are priced

        const target = basket.lockedProfit ?? Infinity
        const sl     = basket.lockedLoss   ?? Infinity

        const hitTarget = target > 0 && pnl >=  target
        const hitSL     = sl     > 0 && pnl <= -sl

        if (hitTarget || hitSL) {
          closingRef.current.add(basket.id)

          const reason = hitTarget
            ? `Target hit ₹${target.toLocaleString()}`
            : `Stop-loss hit ₹${sl.toLocaleString()}`
          toast(reason, { duration: 4000 })

          // Settle paper balance with realised P&L
          adjustBalance(pnl)
          closeBasket(basket.id)

          // Clean up closing guard after basket is removed
          setTimeout(() => closingRef.current.delete(basket.id), 2000)
        }
      }
    }, POLL_MS)

    return () => clearInterval(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
