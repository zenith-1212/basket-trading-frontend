/**
 * usePriceFeed.js — v6.0 (Kotak-only backend)
 * =============================================
 *
 * The wire protocol on /ws/prices is unchanged from v5.x — same client→server
 * messages (set_index / set_expiry / set_basket / clear_basket) and same
 * server→client envelopes (tick / price_snapshot / chain_snapshot).
 *
 * What's gone:
 *   - Render fallback URL (single AWS EC2 host now)
 *   - REST chain-poll fallback inner loop (kept simple — backend always
 *     responds because the feed lives in-process)
 *
 * What's preserved:
 *   - Immediate WS subscribe when basket is staged or executed (so newly
 *     placed positions get real-time ticks before any ATM-window shift)
 *   - Basket monitor resubscribe-after-reload event listener
 *   - Spot REST poll every 15s as a safety net
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../store'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.baskettrading.in'
const WS_URL  = (import.meta.env.VITE_WS_URL || 'wss://api.baskettrading.in') + '/ws/prices'

export function usePriceFeed() {
  const wsRef         = useRef(null)
  const connectedRef  = useRef(false)
  const fallbackTimer = useRef(null)
  const spotTimer     = useRef(null)
  const mountedRef    = useRef(true)

  const {
    updateSpot, setWsConnected,
    updateLtpByToken, applyChainSnapshot, applyPriceSnapshot,
    selectedSymbol, selectedExpiry,
    fetchChainLtps,
    activeBaskets,
    basket,
    token,
  } = useStore()

  const symbolRef  = useRef(selectedSymbol)
  const expiryRef  = useRef(selectedExpiry)
  const basketsRef = useRef(activeBaskets)
  const stagingRef = useRef(basket)
  const tokenRef   = useRef(token)

  useEffect(() => { symbolRef.current  = selectedSymbol }, [selectedSymbol])
  useEffect(() => { expiryRef.current  = selectedExpiry  }, [selectedExpiry])
  useEffect(() => { basketsRef.current = activeBaskets   }, [activeBaskets])
  useEffect(() => { stagingRef.current = basket          }, [basket])
  useEffect(() => { tokenRef.current   = token           }, [token])

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getBasketTokens() {
    const tokens = []
    for (const b of basketsRef.current) {
      for (const order of b.orders || []) {
        const t = order.trd_symbol || order.ce_token || order.pe_token || ''
        if (t && !tokens.includes(t)) tokens.push(t)
      }
    }
    for (const order of stagingRef.current || []) {
      const t = order.trd_symbol || ''
      if (t && !tokens.includes(t)) tokens.push(t)
    }
    return tokens
  }

  function sendBasketTokens(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const tokens = getBasketTokens()
    if (tokens.length === 0) return
    try {
      ws.send(JSON.stringify({
        type:        'set_basket',
        instruments: tokens.map(t => ({ trd_symbol: t })),
      }))
      console.log(`[WS] set_basket → ${tokens.length} basket tokens`)
    } catch {}
  }

  // ── Resubscribe-after-reload event (dispatched by useBasketMonitor) ────────

  useEffect(() => {
    function handleResubscribe(event) {
      const { instruments } = event.detail || {}
      if (!instruments || instruments.length === 0) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setTimeout(() => window.dispatchEvent(
          new CustomEvent('basket-monitor:resubscribe', { detail: event.detail })
        ), 2000)
        return
      }
      try {
        ws.send(JSON.stringify({ type: 'set_basket', instruments }))
        console.log(`[WS] Restored ${instruments.length} basket token(s) after reload`)
      } catch (e) {
        console.warn('[WS] resubscribe failed:', e)
      }
    }
    window.addEventListener('basket-monitor:resubscribe', handleResubscribe)
    return () => window.removeEventListener('basket-monitor:resubscribe', handleResubscribe)
  }, [])

  // ── Send set_index when symbol changes ────────────────────────────────────

  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws = wsRef.current
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type: 'set_index', symbol: selectedSymbol, expiry: expiryRef.current,
    }))
    sendBasketTokens(ws)
  }, [selectedSymbol]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws = wsRef.current
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'set_expiry', expiry: selectedExpiry }))
  }, [selectedExpiry]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Track newly placed baskets → immediate subscribe ──────────────────────

  const prevBasketsRef = useRef([])
  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws = wsRef.current
    const prev    = prevBasketsRef.current
    const current = basketsRef.current

    const prevIds   = new Set(prev.map(b => b.id))
    const newBaskets = current.filter(b => !prevIds.has(b.id))

    if (newBaskets.length > 0 && ws.readyState === WebSocket.OPEN) {
      const newTokens = []
      for (const b of newBaskets) {
        for (const order of b.orders || []) {
          const t = order.trd_symbol || ''
          if (t && !newTokens.includes(t)) newTokens.push(t)
        }
      }
      if (newTokens.length > 0) {
        try {
          ws.send(JSON.stringify({
            type:        'set_basket',
            instruments: newTokens.map(t => ({ trd_symbol: t })),
          }))
          console.log(`[WS] NEW BASKET → ${newTokens.length} tokens`, newTokens)
        } catch {}
      }
    }
    sendBasketTokens(ws)
    prevBasketsRef.current = current
  }, [activeBaskets]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Track staging basket → subscribe on add, unsubscribe on remove ────────

  const prevStagingRef = useRef([])
  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws = wsRef.current
    const prev    = prevStagingRef.current
    const current = basket

    const added = current.filter(o => !prev.find(p => p.id === o.id))
    if (added.length > 0 && ws.readyState === WebSocket.OPEN) {
      const newTokens = added.map(o => o.trd_symbol || '').filter(Boolean)
      if (newTokens.length > 0) {
        try {
          ws.send(JSON.stringify({
            type: 'set_basket',
            instruments: newTokens.map(t => ({ trd_symbol: t })),
          }))
        } catch {}
      }
    }

    const removed = prev.filter(o => !current.find(c => c.id === o.id))
    if (removed.length > 0 && ws.readyState === WebSocket.OPEN) {
      const activeTokens = new Set(getBasketTokens())
      const removedTokens = removed
        .map(o => o.trd_symbol || '')
        .filter(t => t && !activeTokens.has(t))
      if (removedTokens.length > 0) {
        try {
          ws.send(JSON.stringify({
            type: 'clear_basket',
            instruments: removedTokens.map(t => ({ trd_symbol: t })),
          }))
        } catch {}
      }
    }
    prevStagingRef.current = current
  }, [basket]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── WebSocket lifecycle ───────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true

    function connect() {
      if (!mountedRef.current) return
      if (wsRef.current) {
        try { wsRef.current.onclose = null; wsRef.current.close() } catch {}
        wsRef.current = null
      }

      let socket
      try {
        socket = new WebSocket(WS_URL)
        wsRef.current = socket
      } catch {
        setTimeout(connect, 3000)
        return
      }

      socket.onopen = () => {
        if (!mountedRef.current) return
        connectedRef.current = true
        setWsConnected(true)
        stopFallbackPoll()
        console.log('[WS] Connected → backend → Kotak feed')

        socket.send(JSON.stringify({
          type: 'set_index',
          symbol: symbolRef.current,
          expiry: expiryRef.current,
        }))
        setTimeout(() => sendBasketTokens(socket), 500)
      }

      socket.onmessage = (e) => {
        if (!mountedRef.current) return
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'price_snapshot') {
            applyPriceSnapshot(msg.prices, msg.spots)
            return
          }
          if (msg.type === 'chain_snapshot') {
            applyChainSnapshot(msg.symbol, msg.expiry, msg.chain, msg.expiry_ymd)
            return
          }
          // Backend monitor closed a basket (SL/target hit while browser was open)
          if (msg.type === 'basket_closed') {
            const { closeBasket, fetchActiveBaskets } = useStore.getState()
            closeBasket(msg.basket_id)
            // Refresh from DB to pick up any auto-loop re-entry basket
            setTimeout(() => fetchActiveBaskets(), 1500)
            return
          }
          if (msg.type !== 'tick') return

          if (msg.symbol && msg.ltp) {
            updateSpot(msg.symbol, msg.ltp)
            if (msg.token) updateLtpByToken(msg.token, msg.ltp)
            return
          }
          if (msg.token && msg.ltp > 0) {
            updateLtpByToken(msg.token, msg.ltp)
          }
        } catch {}
      }

      socket.onclose = () => {
        if (!mountedRef.current) return
        connectedRef.current = false
        setWsConnected(false)
        wsRef.current = null
        startFallbackPoll()
        console.log('[WS] Disconnected — reconnecting in 3s')
        setTimeout(connect, 3000)
      }

      socket.onerror = () => socket.close()
    }

    connect()

    return () => {
      mountedRef.current = false
      if (wsRef.current) {
        try { wsRef.current.onclose = null; wsRef.current.close() } catch {}
        wsRef.current = null
      }
      stopFallbackPoll()
      stopSpotPoll()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── REST fallback chain poll ─ only when WS is down ───────────────────────

  function startFallbackPoll() {
    stopFallbackPoll()
    fallbackTimer.current = setInterval(() => {
      if (connectedRef.current) { stopFallbackPoll(); return }
      const sym    = symbolRef.current
      const expiry = expiryRef.current
      if (sym && expiry) fetchChainLtps(sym, expiry, true)
    }, 5000)
  }

  function stopFallbackPoll() {
    if (fallbackTimer.current) {
      clearInterval(fallbackTimer.current)
      fallbackTimer.current = null
    }
  }

  // ── Spot REST poll (15s safety net) ───────────────────────────────────────

  useEffect(() => {
    const poll = async () => {
      if (!mountedRef.current) return
      try {
        const headers = tokenRef.current
          ? { Authorization: `Bearer ${tokenRef.current}` } : {}
        const res = await fetch(`${API_URL}/api/prices/spot`, { headers })
        if (!res.ok) return
        const data = await res.json()
        const { spotPrices } = useStore.getState()
        for (const [sym, price] of Object.entries(data)) {
          if (typeof price !== 'number' || price <= 0) continue
          // Sanity check: reject if >10% away from last known good value
          // This prevents stale post-market ticks from corrupting the display
          const prev = spotPrices[sym] || 0
          if (prev > 0 && Math.abs(price - prev) / prev > 0.10) {
            console.warn(`[SPOT] Rejected suspicious ${sym} price: ${price} (prev: ${prev})`)
            continue
          }
          updateSpot(sym, price)
        }
      } catch {}
    }
    poll()
    spotTimer.current = setInterval(poll, 15_000)
    return () => stopSpotPoll()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function stopSpotPoll() {
    if (spotTimer.current) {
      clearInterval(spotTimer.current)
      spotTimer.current = null
    }
  }
}
