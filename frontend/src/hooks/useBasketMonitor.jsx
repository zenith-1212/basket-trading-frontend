/**
 * useBasketMonitor.jsx — v7.0  (Square-Off Fix Edition)
 * ========================================================
 *
 * ROOT CAUSE OF ISSUE 2 (Basket square-off not working in demat):
 * ---------------------------------------------------------------
 * The old v6.0 `exitBasketWithBackend()` only called:
 *   POST /api/baskets/{id}/exit        ← updates DB status (CANCELLED/SL_HIT/etc.)
 *
 * It did NOT call:
 *
 * So the UI showed "trade closed" but the broker position was still open.
 * Manual exit worked because the UI triggered the broker call directly.
 *
 * FIXES IN v7.0:
 */

import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

const POLL_MS    = 500
const DB_SYNC_MS = 30_000

// Reads VITE_API_URL at runtime, falls back to the deployed backend
const API = () => import.meta.env.VITE_API_URL || 'https://api.baskettrading.in'

export function useBasketMonitor() {
  const {
    activeBaskets,
    basketPrices,
    updateBasketPnl,
    token,
  } = useStore()

  const basketsRef  = useRef(activeBaskets)
  const pricesRef   = useRef(basketPrices)
  const tokenRef    = useRef(token)
  const lastPnlRef  = useRef({})
  const lastSyncRef = useRef({})

  useEffect(() => { basketsRef.current = activeBaskets }, [activeBaskets])
  useEffect(() => { pricesRef.current  = basketPrices  }, [basketPrices])
  useEffect(() => { tokenRef.current   = token         }, [token])

  // ── Auth header helper ─────────────────────────────────────────────────────
  const authHeaders = useCallback(() => ({
    'Content-Type': 'application/json',
    ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
  }), [])

  // ── Persist P&L to DB (throttled, non-blocking) ────────────────────────────
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

  // squareOffWithBroker REMOVED — backend basket_monitor.py handles all SL/target exits.
  // Frontend only displays PnL. Backend broadcasts basket_closed via WebSocket on exit.

  // ── Re-subscribe restored baskets after page reload ────────────────────────
  useEffect(() => {
    const restoredBaskets = basketsRef.current.filter(b => b._fromDB)
    if (restoredBaskets.length === 0) return

    const instruments = []
    restoredBaskets.forEach(b => {
      b.orders.forEach(o => {
        if (o.trd_symbol) {
          instruments.push({ trd_symbol: o.trd_symbol, SecurityId: o.trd_symbol })
        }
      })
    })

    if (instruments.length === 0) return

    window.dispatchEvent(new CustomEvent('basket-monitor:resubscribe', {
      detail: { instruments }
    }))
  }, [])

  // ── Main P&L computation loop ──────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const baskets = basketsRef.current
      const prices  = pricesRef.current

      for (const basket of baskets) {
        const orders = basket.orders || []
        if (orders.length === 0) continue

        let totalPnl = 0
        let allPriced = true

        for (const order of orders) {
          const trdKey = order.trd_symbol || ''
          const ltp    = prices[trdKey]

          if (!ltp || ltp <= 0) { allPriced = false; continue }

          const entry  = order.entry_price || 0
          const qty    = order.quantity    || 0
          const legPnl = order.side?.toUpperCase() === 'BUY'
            ? (ltp - entry) * qty
            : (entry - ltp) * qty

          totalPnl += legPnl
        }

        const pnl = Math.round(totalPnl * 100) / 100

        if (pnl !== lastPnlRef.current[basket.id]) {
          lastPnlRef.current[basket.id] = pnl
          updateBasketPnl(basket.id, pnl)
          syncPnlToDB(basket.id, pnl)
        }

        // NOTE: SL/target exit is handled ENTIRELY by backend basket_monitor.py
        // Frontend only displays PnL — never triggers exits automatically.
        // Backend broadcasts basket_closed via WebSocket when SL/target hits.
        // This prevents double-exit race conditions.
      }
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [updateBasketPnl, syncPnlToDB])
}
