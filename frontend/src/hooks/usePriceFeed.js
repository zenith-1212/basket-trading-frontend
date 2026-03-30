/**
 * usePriceFeed.js — v5.2  (FIX #5: immediate WS subscribe on basket placement)
 * =========================================================================
 *
 * FIX #2 (v5.1) — Live basket P&L stops updating when switching instruments
 * ──────────────────────────────────────────────────────────────────
 * PROBLEM: When user places a NIFTY basket then switches to SENSEX chain,
 * the frontend sends `set_index SENSEX`. The backend updates its view but
 * the backend tick broadcaster still sends ALL subscribed token prices.
 * The real issue is in the FRONTEND store — `updateLtpByToken` updated only
 * `chain.options[expiry]`, which gets replaced when the user switches chains.
 * So basket orders could no longer find their rows → P&L froze.
 *
 * FIX (two parts — both needed):
 *  Part A (store/index.js): `updateLtpByToken` now ALWAYS writes to
 *    `basketPrices` (a persistent token→ltp map). The basket monitor reads
 *    from there, never from chain.options. This map is never cleared on
 *    instrument switches, so basket P&L stays live regardless of what's viewed.
 *
 *  Part B (here): After any instrument switch, send `set_basket` message to
 *    backend with active basket trd_symbols. This ensures the backend
 *    re-subscribes those tokens to the Dhan feed and they keep ticking.
 *    Also re-send on WS reconnect so subscriptions survive disconnections.
 *
 * FIX #5 (v5.2) — Deep ATM orders outside ±15 WebSocket range get real-time ticks
 * ──────────────────────────────────────────────────────────────────────────────────
 * PROBLEM: When placing a basket at a strike that falls outside the backend's
 * current ±15 ATM window, that token was not subscribed to the Dhan WebSocket.
 * Price updates would only arrive via the 4-second REST fallback, causing:
 *  - Delayed P&L updates (up to 4s lag)
 *  - Inaccurate live basket P&L that doesn't match expected values
 *
 * FIX:
 *  When activeBaskets changes, diff against previous value to find NEWLY placed
 *  baskets. Immediately send `set_basket` with their specific trd_symbols BEFORE
 *  any ATM window shift can exclude them. This ensures:
 *  1. Traded tokens are WebSocket-subscribed the instant the basket is placed
 *  2. P&L starts updating in real-time from the first tick
 *  3. No dependency on REST polling for active position prices
 *
 * All v5.0 fixes retained.
 *
 * ARCHITECTURE:
 *   Browser <--WS--> /ws/prices (backend) <--SSE--> Railway engine <--WS--> Dhan
 *   Browser <-- REST fallback /api/prices/spot (15s) -- backend
 */
import { useEffect, useRef } from 'react'
import { useStore } from '../store'

const _PROD_API = 'https://basket-trading-backend.onrender.com'
const _PROD_WS  = 'wss://basket-trading-backend.onrender.com'
const API_URL = import.meta.env.VITE_API_URL || _PROD_API
const WS_URL  = (import.meta.env.VITE_WS_URL || _PROD_WS) + '/ws/prices'

export function usePriceFeed() {
  const wsRef          = useRef(null)
  const connectedRef   = useRef(false)
  const fallbackTimer  = useRef(null)
  const spotTimer      = useRef(null)
  const mountedRef     = useRef(true)

  const {
    updateSpot, setWsConnected,
    updateLtpByToken, applyChainSnapshot, applyPriceSnapshot,
    selectedSymbol, selectedExpiry,
    fetchChainLtps,
    activeBaskets,   // FIX: active (placed) baskets
    basket,          // FIX: staging basket (before execution) — subscribe tokens immediately on add
    token,           // auth token for API requests
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

  // ── Helper: collect all trd_symbols from ALL baskets (active + staging) ─────
  function getBasketTokens() {
    const tokens = []
    // Active (placed) baskets
    for (const b of basketsRef.current) {
      for (const order of b.orders || []) {
        const t = order.trd_symbol || order.ce_token || order.pe_token || ''
        if (t && !tokens.includes(t)) tokens.push(t)
      }
    }
    // Staging basket (orders added but not yet executed)
    for (const order of stagingRef.current || []) {
      const t = order.trd_symbol || ''
      if (t && !tokens.includes(t)) tokens.push(t)
    }
    return tokens
  }

  // ── Helper: send set_basket to keep basket tokens subscribed in backend ──────
  function sendBasketTokens(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const tokens = getBasketTokens()
    if (tokens.length === 0) return
    try {
      ws.send(JSON.stringify({
        type:        'set_basket',
        instruments: tokens.map(t => ({ trd_symbol: t })),
      }))
      console.log(`[WS] set_basket: ${tokens.length} basket tokens re-subscribed`)
    } catch {}
  }

  // Tell backend when user changes index AFTER initial connect
  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws = wsRef.current
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type:   'set_index',
      symbol: selectedSymbol,
      expiry: expiryRef.current,
    }))
    // FIX #2 Part B: re-send basket tokens so backend keeps them subscribed
    // after the instrument switch causes a new ATM window subscription
    sendBasketTokens(ws)
  }, [selectedSymbol]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws = wsRef.current
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({
      type:   'set_expiry',
      expiry: selectedExpiry,
    }))
  }, [selectedExpiry]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── FIX #2: Track previous active baskets to detect newly placed ones ───────
  const prevBasketsRef = useRef([])

  // FIX: when new baskets are added (live trade placed), IMMEDIATELY subscribe
  // those specific traded tokens as highest-priority basket tokens.
  // This fires before the backend's ATM window shift can drop them.
  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws = wsRef.current

    const prev    = prevBasketsRef.current
    const current = basketsRef.current

    // Detect newly added baskets (by id)
    const prevIds = new Set(prev.map(b => b.id))
    const newBaskets = current.filter(b => !prevIds.has(b.id))

    if (newBaskets.length > 0 && ws.readyState === WebSocket.OPEN) {
      // Collect all trd_symbols from the newly placed baskets
      const newTokens = []
      for (const b of newBaskets) {
        for (const order of b.orders || []) {
          const t = order.trd_symbol || ''
          if (t && !newTokens.includes(t)) newTokens.push(t)
        }
      }

      if (newTokens.length > 0) {
        try {
          // Send immediately as basket tokens — highest WS priority
          ws.send(JSON.stringify({
            type:        'set_basket',
            instruments: newTokens.map(t => ({ trd_symbol: t })),
          }))
          console.log(`[WS] NEW BASKET: immediately subscribed ${newTokens.length} tokens:`, newTokens)
        } catch {}
      }
    }

    // Also do a full re-send to keep all basket tokens subscribed
    sendBasketTokens(ws)

    prevBasketsRef.current = current
  }, [activeBaskets]) // eslint-disable-line react-hooks/exhaustive-deps

  // FIX: subscribe/unsubscribe IMMEDIATELY when user adds/removes from staging basket.
  // This is the key to instant P&L — tokens are subscribed the moment the user
  // clicks B/S in the option chain, before they even execute the basket.
  const prevStagingRef = useRef([])
  useEffect(() => {
    if (!connectedRef.current || !wsRef.current) return
    const ws      = wsRef.current
    const prev    = prevStagingRef.current
    const current = basket

    // Find newly added tokens → subscribe them
    const added = current.filter(o => !prev.find(p => p.id === o.id))
    if (added.length > 0 && ws.readyState === WebSocket.OPEN) {
      const newTokens = added.map(o => o.trd_symbol || '').filter(Boolean)
      if (newTokens.length > 0) {
        try {
          ws.send(JSON.stringify({
            type:        'set_basket',
            instruments: newTokens.map(t => ({ trd_symbol: t })),
          }))
          console.log(`[WS] Subscribed staging tokens:`, newTokens)
        } catch {}
      }
    }

    // Find removed tokens → unsubscribe them (only if not in active baskets)
    const removed = prev.filter(o => !current.find(c => c.id === o.id))
    if (removed.length > 0 && ws.readyState === WebSocket.OPEN) {
      const activeTokens = new Set(getBasketTokens())
      const removedTokens = removed
        .map(o => o.trd_symbol || '')
        .filter(t => t && !activeTokens.has(t))
      if (removedTokens.length > 0) {
        try {
          ws.send(JSON.stringify({
            type:        'clear_basket',
            instruments: removedTokens.map(t => ({ trd_symbol: t })),
          }))
          console.log(`[WS] Unsubscribed staging tokens:`, removedTokens)
        } catch {}
      }
    }

    prevStagingRef.current = current
  }, [basket]) // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket lifecycle
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
        console.log('[WS] Connected -> backend -> cloud engine')

        // Send set_index ONCE with expiry included
        socket.send(JSON.stringify({
          type:   'set_index',
          symbol: symbolRef.current,
          expiry: expiryRef.current,
        }))

        // FIX #2 Part B: re-subscribe basket tokens after reconnect
        // Small delay to let the backend process set_index first
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

          if (msg.type !== 'tick') return

          if (msg.symbol && msg.ltp) {
            updateSpot(msg.symbol, msg.ltp)
            if (msg.token) updateLtpByToken(msg.token, msg.ltp)
            return
          }

          if (msg.token && msg.ltp > 0) {
            updateLtpByToken(msg.token, msg.ltp)
          }
        } catch {
          // ignore malformed
        }
      }

      socket.onclose = () => {
        if (!mountedRef.current) return
        connectedRef.current = false
        setWsConnected(false)
        wsRef.current = null
        startFallbackPoll()
        console.log('[WS] Disconnected — reconnecting in 3s...')
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

  // REST fallback chain poll — ONLY when WS is down
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

  // Spot price REST poll — every 15s via BACKEND (not direct to engine)
  useEffect(() => {
    const poll = async () => {
      if (!mountedRef.current) return
      try {
        const authHeaders = tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}
        const res  = await fetch(`${API_URL}/api/prices/spot`, { headers: authHeaders })
        if (!res.ok) return
        const data = await res.json()
        for (const [sym, price] of Object.entries(data)) {
          if (typeof price === 'number' && price > 0) {
            updateSpot(sym, price)
          }
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
