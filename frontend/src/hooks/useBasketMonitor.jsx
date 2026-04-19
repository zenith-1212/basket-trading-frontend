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
const API = () => import.meta.env.VITE_API_URL || 'https://api.baskettrading.in'

export function useBasketMonitor() {
  const {
    activeBaskets,
    basketPrices,
    updateBasketPnl,
    closeBasket,
    adjustBalance,
    addActiveBasket,
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

  // ── Square off: broker first → DB close → UI update → auto-loop re-entry ──
  const squareOffWithBroker = useCallback(async (basket, exitType, pnl) => {
    const orders   = basket.orders || []
    const isPaper  = (basket.mode || '').toUpperCase() === 'PAPER'
    // autoLoop per basket — MANUAL exits never re-enter regardless
    const autoLoop = exitType === 'MANUAL' ? false : (basket.autoLoop ?? false)

    // ── STEP 1: Send exit orders to broker (LIVE mode only) ─────────────────
    if (!isPaper && orders.length > 0) {
      const prices = pricesRef.current

      // Send ORIGINAL side — backend exit_basket reverses it (BUY→SELL, SELL→BUY)
      // DO NOT reverse here — doing so causes double-reversal = wrong direction order
      const exitLegs = orders.map(order => ({
        symbol:      order.symbol,
        strike:      order.strike,
        option_type: order.option_type,
        expiry:      order.expiry,
        side:        order.side,       // original side — backend will reverse
        lot_count:   order.lot_count ?? 1,     // ← lot info for broker engine
        quantity:    order.quantity,           // final qty = lot_count × lot_size
        order_type:  'MKT',
        product:     'MIS',
        trd_symbol:  order.trd_symbol || '',
        ltp:         prices[order.trd_symbol] || order.entry_price || 0,
        price:       prices[order.trd_symbol] || order.entry_price || 0,
      }))

      console.log('[MONITOR] Sending exit orders to broker:', exitLegs)

      try {
        const brokerRes = await fetch(`${API()}/api/orders/exit_basket`, {
          method:  'POST',
          headers: authHeaders(),
          body:    JSON.stringify({
            basket_id: basket.id,
            exit_type: exitType,
            auto_loop: autoLoop,
            orders:    exitLegs,
          }),
        })

        if (!brokerRes.ok) {
          const errText = await brokerRes.text()
          console.error('[MONITOR] Broker exit HTTP error:', brokerRes.status, errText)
          toast.error(`⚠️ Broker exit failed (${brokerRes.status}). Check positions manually!`, { duration: 8000 })
          // Keep closingRef LOCKED — don't retry, user must act manually
          return false
        }

        const brokerData = await brokerRes.json()
        console.log('[MONITOR] Broker exit response:', brokerData)

        const exited = brokerData.exited ?? 0
        const failed = brokerData.failed ?? 0

        if (failed > 0) {
          const failedSymbols = (brokerData.errors || [])
            .map(e => e.leg?.trd_symbol || e.leg?.symbol || '?').join(', ')
          toast.error(`⚠️ ${failed} leg(s) failed to exit: ${failedSymbols}. Check your demat!`, { duration: 10000 })
        }

        if (exited === 0 && failed > 0) {
          toast.error('❌ All exit orders failed! Close positions manually in broker app.', { duration: 12000 })
          return false
        }

        if (exited > 0) {
          const label = exitType === 'TARGET_HIT' ? '✅ Target' : exitType === 'SL_HIT' ? '🛑 Stop-Loss' : '🔲 Manual'
          toast.success(`${label} — ${exited}/${orders.length} leg(s) squared off`, { duration: 5000 })
        }

      } catch (networkErr) {
        console.error('[MONITOR] Network error calling broker exit:', networkErr)
        toast.error('❌ Network error during exit. Verify positions in broker app!', { duration: 10000 })
        return false
      }
    } else if (isPaper) {
      console.log('[MONITOR] PAPER mode — skipping broker exit call')
    }

    // ── STEP 2: Mark basket closed in DB + handle auto-loop re-entry ─────────
    // Backend returns new_basket if auto_loop=true and re-entry was created in DB
    let dbData = null
    try {
      const dbRes = await fetch(`${API()}/api/baskets/${basket.id}/exit`, {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({
          exit_pnl:  pnl,
          exit_type: exitType,
          auto_loop: autoLoop,
        }),
      })
      if (dbRes.ok) {
        dbData = await dbRes.json()
      } else {
        console.warn('[MONITOR] DB exit update failed:', dbRes.status, await dbRes.text())
      }
    } catch (e) {
      console.warn('[MONITOR] DB exit call failed (non-fatal):', e)
    }

    // ── STEP 3: Close old basket in UI ───────────────────────────────────────
    closeBasket(basket.id)
    adjustBalance(pnl)
    delete lastSyncRef.current[basket.id]
    delete lastPnlRef.current[basket.id]

    // ── STEP 4: Auto-loop — place real broker orders + add to UI ────────────
    if (autoLoop && dbData?.re_entered && dbData?.new_basket) {
      const nb       = dbData.new_basket
      const loopNum  = nb.loop_number || (basket.loop || 1) + 1
      const prices   = pricesRef.current
      const srcOrders = nb.orders || basket.orders

      // For LIVE mode: place actual broker orders at current market price
      if (!isPaper && srcOrders.length > 0) {
        try {
          toast(`🔁 Auto-loop ${loopNum}: placing new entry orders...`, { duration: 3000 })

          const entryLegs = srcOrders.map(o => ({
            symbol:      o.symbol,
            strike:      o.strike,
            option_type: o.option_type,
            expiry:      o.expiry,
            side:        o.side,       // original side — re-entering same direction
            lot_count:   o.lot_count ?? 1,    // ← preserve lot size on re-entry
            quantity:    o.quantity,          // final qty = lot_count × lot_size
            order_type:  'MKT',
            product:     'MIS',
            trd_symbol:  o.trd_symbol || '',
            ltp:         prices[o.trd_symbol] || parseFloat(o.entry_price) || 0,
            price:       prices[o.trd_symbol] || parseFloat(o.entry_price) || 0,
          }))

          console.log('[MONITOR] Auto-loop placing new entry orders:', entryLegs)

          const entryRes = await fetch(`${API()}/api/orders/place_basket`, {
            method:  'POST',
            headers: authHeaders(),
            body:    JSON.stringify({ orders: entryLegs }),
          })

          const entryData = entryRes.ok ? await entryRes.json() : null
          console.log('[MONITOR] Auto-loop entry result:', entryData)

          if (!entryRes.ok || !entryData) {
            toast.error(`⚠️ Auto-loop ${loopNum}: broker entry failed — positions not re-entered!`, { duration: 10000 })
          } else if (entryData.failed > 0) {
            toast.error(`⚠️ Auto-loop ${loopNum}: ${entryData.failed} leg(s) failed to enter. Check demat!`, { duration: 10000 })
          } else {
            // Update order IDs in the DB basket with actual broker order IDs
            const updatedOrders = srcOrders.map((o, i) => ({
              ...o,
              entry_price: prices[o.trd_symbol] || parseFloat(o.entry_price) || 0,
              order_id:    entryData.results?.[i]?.order_id || '',
            }))

            // Patch the DB basket's orders with real entry prices + order IDs
            try {
              await fetch(`${API()}/api/baskets/${nb.id}/update_orders`, {
                method:  'POST',
                headers: authHeaders(),
                body:    JSON.stringify({ orders: updatedOrders }),
              })
            } catch (e) {
              console.warn('[MONITOR] Could not patch order IDs (non-fatal):', e)
            }

            const newBasket = {
              id:           nb.id,
              symbol:       basket.symbol,
              orders:       updatedOrders,
              lockedProfit: basket.lockedProfit,
              lockedLoss:   basket.lockedLoss,
              autoLoop:     true,
              pnl:          0,
              status:       'ACTIVE',
              mode:         basket.mode,
              loop:         loopNum,
              entryTime:    new Date().toLocaleTimeString('en-IN'),
            }
            addActiveBasket(newBasket)
            toast.success(`🔁 Auto-loop ${loopNum}: ${entryData.placed} order(s) placed!`, { duration: 5000 })
            console.log('[MONITOR] Auto-loop re-entry live basket added:', newBasket)
          }

        } catch (err) {
          console.error('[MONITOR] Auto-loop entry error:', err)
          toast.error(`⚠️ Auto-loop ${loopNum}: network error placing orders. Check demat!`, { duration: 10000 })
        }

      } else {
        // PAPER mode — no broker call needed, just add to UI
        const newBasket = {
          id:           nb.id,
          symbol:       basket.symbol,
          orders:       srcOrders.map(o => ({
            symbol:      o.symbol,
            strike:      o.strike,
            option_type: o.option_type,
            expiry:      o.expiry,
            side:        o.side,
            lot_count:   o.lot_count ?? 1,   // ← preserve lot size on re-entry
            quantity:    o.quantity,
            entry_price: prices[o.trd_symbol] || parseFloat(o.entry_price) || 0,
            trd_symbol:  o.trd_symbol || '',
            order_id:    '',
          })),
          lockedProfit: basket.lockedProfit,
          lockedLoss:   basket.lockedLoss,
          autoLoop:     true,
          pnl:          0,
          status:       'ACTIVE',
          mode:         basket.mode,
          loop:         loopNum,
          entryTime:    new Date().toLocaleTimeString('en-IN'),
        }
        addActiveBasket(newBasket)
        toast(`🔁 Auto-loop ${loopNum}: paper re-entered`, { duration: 4000 })
      }
    }

    return true

  }, [authHeaders, closeBasket, adjustBalance, addActiveBasket])

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

          squareOffWithBroker(basket, exitType, pnl).then(succeeded => {
            if (!succeeded) {
              // Release lock after 30s on failure so user can retry manually
              setTimeout(() => closingRef.current.delete(basket.id), 30_000)
            }
            // On success: basket removed from state by closeBasket — lock irrelevant
          })
        }
      }
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [updateBasketPnl, syncPnlToDB, squareOffWithBroker])
}
