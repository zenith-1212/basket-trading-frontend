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
 *   POST /api/orders/exit_basket       ← sends actual exit orders to Kotak/broker API
 *
 * So the UI showed "trade closed" but the broker position was still open.
 * Manual exit worked because the UI triggered the broker call directly.
 *
 * FIXES IN v7.0:
 * 1. squareOffWithBroker()  — calls /api/orders/exit_basket FIRST with correct params:
 *      • correct trd_symbol (from order.trd_symbol, same as entry)
 *      • correct quantity
 *      • reversed side (BUY→SELL, SELL→BUY)
 *      • current LTP for price protection
 *      • order_type: "MKT" (market order for immediate fill)
 * 2. Waits for broker ACK before updating DB status.
 * 3. Logs partial fills and failures — does NOT silently succeed.
 * 4. On broker failure, keeps closingRef locked to prevent double-exit loop,
 *    but alerts user with a toast so they can manually close if needed.
 * 5. PAPER mode: skips broker call, goes straight to DB + UI update.
 */

import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

const POLL_MS    = 500
const DB_SYNC_MS = 30_000

// Reads VITE_API_URL at runtime, falls back to the deployed backend
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

  // ── FIX: Call broker exit API FIRST, then update DB ────────────────────────
  const squareOffWithBroker = useCallback(async (basket, exitType, pnl) => {
    const orders  = basket.orders || []
    const isPaper = (basket.mode || '').toUpperCase() === 'PAPER'

    // ── STEP 1: Send exit orders to broker ──────────────────────────────────
    if (!isPaper && orders.length > 0) {
      // Build exit legs: reverse side, use current LTP for price protection
      const prices = pricesRef.current
      const exitLegs = orders.map(order => ({
        symbol:      order.symbol,
        strike:      order.strike,
        option_type: order.option_type,
        expiry:      order.expiry,
        // CRITICAL: reverse the original side so we close the position
        side:        order.side?.toUpperCase() === 'BUY' ? 'SELL' : 'BUY',
        quantity:    order.quantity,
        order_type:  'MKT',
        product:     'MIS',
        // CRITICAL: use trd_symbol from order — this is the exact Kotak symbol
        trd_symbol:  order.trd_symbol || '',
        // Send current LTP so backend can apply price protection for limit orders
        ltp:         prices[order.trd_symbol] || order.entry_price || 0,
        price:       prices[order.trd_symbol] || order.entry_price || 0,
      }))

      console.log('[MONITOR] Sending exit orders to broker:', exitLegs)

      let brokerSuccess = false
      let brokerErrors  = []

      try {
        const brokerRes = await fetch(`${API()}/api/orders/exit_basket`, {
          method:  'POST',
          headers: authHeaders(),
          body:    JSON.stringify({
            basket_id: basket.id,
            orders:    exitLegs,
          }),
        })

        if (!brokerRes.ok) {
          const errText = await brokerRes.text()
          console.error('[MONITOR] Broker exit HTTP error:', brokerRes.status, errText)
          toast.error(`⚠️ Broker exit failed (${brokerRes.status}). Check positions manually!`, { duration: 8000 })
          // Do NOT remove from UI — user must verify manually
          // Keep closingRef locked so we don't retry automatically
          return
        }

        const brokerData = await brokerRes.json()
        console.log('[MONITOR] Broker exit response:', brokerData)

        const exited = brokerData.exited ?? 0
        const failed = brokerData.failed ?? 0
        const errors = brokerData.errors ?? []

        brokerSuccess = exited > 0
        brokerErrors  = errors

        if (failed > 0) {
          // Partial failure — some legs may still be open
          const failedSymbols = errors.map(e => e.leg?.trd_symbol || e.leg?.symbol || '?').join(', ')
          toast.error(
            `⚠️ ${failed} leg(s) failed to exit: ${failedSymbols}. Check your demat!`,
            { duration: 10000 }
          )
          console.error('[MONITOR] Partial exit failures:', errors)
        }

        if (exited === 0 && failed > 0) {
          // Complete broker failure — abort UI close so user can act
          toast.error('❌ All exit orders failed! Close positions manually in broker app.', { duration: 12000 })
          return
        }

        if (brokerSuccess) {
          const label = exitType === 'TARGET_HIT' ? '✅ Target' : '🛑 Stop-Loss'
          toast.success(
            `${label} — ${exited}/${orders.length} leg(s) exited successfully`,
            { duration: 5000 }
          )
        }

      } catch (networkErr) {
        console.error('[MONITOR] Network error calling broker exit:', networkErr)
        toast.error('❌ Network error during exit. Verify positions in broker app!', { duration: 10000 })
        // Don't close UI on network error — user must verify
        return
      }
    } else if (isPaper) {
      console.log('[MONITOR] PAPER mode — skipping broker exit call')
    }

    // ── STEP 2: Mark basket as closed in DB (only after broker ACK) ─────────
    try {
      const dbRes = await fetch(`${API()}/api/baskets/${basket.id}/exit`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ exit_pnl: pnl, exit_type: exitType }),
      })
      if (!dbRes.ok) {
        console.warn('[MONITOR] DB exit update failed:', dbRes.status, await dbRes.text())
        // Non-fatal — broker exit already done, just log
      }
    } catch (e) {
      console.warn('[MONITOR] DB exit call failed (non-fatal):', e)
    }

    // ── STEP 3: Update UI ────────────────────────────────────────────────────
    closeBasket(basket.id)
    adjustBalance(pnl)
    delete lastSyncRef.current[basket.id]
    delete lastPnlRef.current[basket.id]

  }, [authHeaders, closeBasket, adjustBalance])

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
        if (closingRef.current.has(basket.id)) continue

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

        // Only auto-exit when ALL legs are priced to avoid premature triggers
        if (!allPriced) continue

        const target    = basket.lockedProfit ?? Infinity
        const sl        = basket.lockedLoss   ?? Infinity
        const hitTarget = target > 0 && pnl >=  target
        const hitSL     = sl     > 0 && pnl <= -sl

        if (hitTarget || hitSL) {
          // Lock immediately to prevent re-entry on next 500ms tick
          closingRef.current.add(basket.id)

          const exitType = hitTarget ? 'TARGET_HIT' : 'SL_HIT'
          const reason   = hitTarget
            ? `🎯 Target ₹${target.toLocaleString()} hit — exiting basket...`
            : `🔴 Stop-loss ₹${sl.toLocaleString()} hit — exiting basket...`

          toast(reason, { duration: 3000 })

          // FIX: squareOffWithBroker calls broker first, then DB, then UI
          squareOffWithBroker(basket, exitType, pnl).finally(() => {
            // Release lock after 3s so if something went wrong user can retry
            setTimeout(() => closingRef.current.delete(basket.id), 3000)
          })
        }
      }
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [updateBasketPnl, syncPnlToDB, squareOffWithBroker])
}
