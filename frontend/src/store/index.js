/**
 * store/index.js — v5.2  (NON-THURSDAY EXPIRY FIX)
 * ===================================================
 * Key fix: getExpiries() was hardcoded to Thursday (weekday 4 in JS).
 * NIFTY sometimes expires on non-Thursday days (special weekly expiries,
 * budget week, election week, etc.) e.g. 24-Mar-2026 = Tuesday.
 *
 * Fix: getExpiries() now generates the next 6 calendar days as candidates
 * and relies on the backend chain_snapshot to correct the expiry.
 * The real expiry list is populated from chain_snapshot.expiry when it arrives.
 *
 * All other v5.0 fixes retained:
 *  - _pendingSnapshot buffer for cold-start price_snapshot
 *  - tokenMap O(1) tick routing
 *  - applyChainSnapshot adds missing strikes from engine data
 *  - fetchChainLtps in-flight guard
 */
import { create } from 'zustand'

export const LOT_SIZES  = { NIFTY:65, BANKNIFTY:30, FINNIFTY:40, SENSEX:20, MIDCPNIFTY:120 }
export const STRIKE_GAP = { NIFTY:50, BANKNIFTY:100, SENSEX:100, FINNIFTY:50, MIDCPNIFTY:25 }

const MON_MAP = {
  Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12',
}
const REV_MON = Object.fromEntries(Object.entries(MON_MAP).map(([k,v]) => [v,k]))

function fromYmd(ymd) {
  if (!ymd) return ymd
  const [yr, mo, dd] = ymd.split('-')
  if (yr.length === 4) return `${dd}-${REV_MON[mo] || mo}-${yr}`
  return ymd
}

function toYmd(exp) {
  if (!exp) return exp
  const parts = exp.split('-')
  if (parts.length === 3 && parts[0].length === 2 && parts[1].length === 3) {
    const [dd, mon, yr] = parts
    return `${yr}-${MON_MAP[mon] || '01'}-${dd.padStart(2,'0')}`
  }
  return exp
}

/**
 * FIX: Generate upcoming expiries without assuming a fixed weekday.
 * Returns the next `count` Thursdays (or Wednesdays for SENSEX) as a
 * STARTING POINT — the real expiry list is corrected by chain_snapshot
 * from the backend which knows the actual expiry dates.
 *
 * For special weeks (budget, election, etc.) the backend will send
 * expiry_ymd with the real date and applyChainSnapshot corrects selectedExpiry.
 */
export function getExpiries(symbol = 'NIFTY', count = 6) {
  const expiries = []
  const months   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  // For SENSEX: Wednesday (JS weekday 3); for others: Thursday (JS weekday 4)
  const primaryDay = symbol === 'SENSEX' ? 3 : 4

  // Start from TODAY (not tomorrow) — today might BE the expiry
  let d = new Date()
  d.setHours(0, 0, 0, 0)

  const checked = new Set()
  let safety = 0

  while (expiries.length < count && safety < 300) {
    safety++
    if (d.getDay() === primaryDay) {
      const str = `${String(d.getDate()).padStart(2,'0')}-${months[d.getMonth()]}-${d.getFullYear()}`
      if (!checked.has(str)) {
        expiries.push(str)
        checked.add(str)
      }
    }
    d.setDate(d.getDate() + 1)
  }
  return expiries
}

function bs_approx(spot, strike, daysToExpiry, isCall) {
  const t          = Math.max(daysToExpiry, 1) / 365
  const iv         = 0.16
  const diff       = spot - strike
  const intrinsic  = isCall ? Math.max(0, diff) : Math.max(0, -diff)
  const timeVal    = spot * iv * Math.sqrt(t) * 0.4
  const distFactor = Math.exp(-Math.abs(diff) / (spot * iv * Math.sqrt(t) * 2 + 1))
  return parseFloat(Math.max(0.1, intrinsic + timeVal * distFactor).toFixed(1))
}

export function generateChain(symbol, spot, depth = 40) {
  const gap     = STRIKE_GAP[symbol] || 50
  const center  = Math.round(spot / gap) * gap
  const strikes = []
  for (let i = -depth; i <= depth; i++) strikes.push(center + i * gap)

  const expiries = getExpiries(symbol, 6)
  const options  = {}
  const today    = new Date()

  for (const exp of expiries) {
    const [dd, mon, yr] = exp.split('-')
    const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11}
    const expDate = new Date(parseInt(yr), months[mon], parseInt(dd))
    const dte     = Math.max(1, Math.round((expDate - today) / 86400000))

    options[exp] = strikes.map(strike => ({
      strike,
      ce_ltp:   bs_approx(spot, strike, dte, true),
      pe_ltp:   bs_approx(spot, strike, dte, false),
      ce_prev:  0, pe_prev: 0,
      ce_token: null, pe_token: null,
      atm:      Math.abs(strike - spot) < gap,
      loading:  false,
    }))
  }
  return { expiries, options }
}

const _UNDS = ['BANKNIFTY','MIDCPNIFTY','FINNIFTY','SENSEX','NIFTY']

function parseTrdSymbol(trd) {
  const sym = _UNDS.find(u => trd.toUpperCase().startsWith(u))
  if (!sym) return null
  const body = trd.slice(sym.length)
  const ot   = body.slice(-2).toUpperCase()
  if (ot !== 'CE' && ot !== 'PE') return null
  const rest = body.slice(0, -2)

  const mMonth = rest.match(/^(\d{2})([A-Za-z]{3})(\d+)$/)
  if (mMonth) return { sym, strike: parseInt(mMonth[3]), ot }

  const char2  = rest[2], char3 = rest[3]
  const mLen   = (char2 === '1' && ['0','1','2'].includes(char3)) ? 2 : 1
  const mo     = parseInt(rest.slice(2, 2 + mLen))
  const dd     = parseInt(rest.slice(2 + mLen, 2 + mLen + 2))
  const strike = parseInt(rest.slice(2 + mLen + 2))

  if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31 && strike > 0)
    return { sym, strike, ot }
  return null
}

function buildTokenMap(options) {
  const map = {}
  for (const [expiry, rows] of Object.entries(options)) {
    rows.forEach((row, idx) => {
      if (row.ce_token) map[row.ce_token] = { expiry, idx, side: 'ce' }
      if (row.pe_token) map[row.pe_token] = { expiry, idx, side: 'pe' }
    })
  }
  return map
}

const IDX_KEYS = {
  '__IDX_NIFTY':      'NIFTY',
  '__IDX_BANKNIFTY':  'BANKNIFTY',
  '__IDX_SENSEX':     'SENSEX',
  '__IDX_FINNIFTY':   'FINNIFTY',
  '__IDX_MIDCPNIFTY': 'MIDCPNIFTY',
}

let _chainFetchKey = ''

export const useStore = create((set, get) => ({

  user:     null,
  token:    localStorage.getItem('token') || null,
  setUser:  (user)  => set({ user }),
  setToken: (token) => { localStorage.setItem('token', token || ''); set({ token }) },
  logout:   ()      => { localStorage.removeItem('token'); set({ user: null, token: null }) },

  isLive:  false,
  setLive: async (v) => {
    set({ isLive: v })
    if (v) {
      try {
        const API   = import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'
        const token = get().token
        const headers = { 'Content-Type': 'application/json' }
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res  = await fetch(API + '/api/orders/balance', { headers })
        if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`)
        const data = await res.json()
        if (data.balance !== undefined) set({ liveBalance: data.balance })
      } catch(e) { console.warn('[BALANCE]', e) }
    } else {
      set({ liveBalance: 0 })
    }
  },

  spotPrices:       { NIFTY: 0, BANKNIFTY: 0, SENSEX: 0 },
  priceChanges:     { NIFTY: 0, BANKNIFTY: 0, SENSEX: 0 },
  wsConnected:      false,
  _pendingSnapshot: null,

  updateSpot: (sym, price) => {
    if (!price || price <= 0) return
    const s    = get()
    const prev = s.spotPrices[sym] || 0
    set({
      priceChanges: { ...s.priceChanges, [sym]: prev > 0 ? parseFloat((price - prev).toFixed(2)) : 0 },
      spotPrices:   { ...s.spotPrices,   [sym]: price },
    })
    // Only regenerate chain if:
    // 1. This is the selected symbol
    // 2. Chain has NO real data yet (all ltps are 0 — BS placeholder only)
    if (sym === get().selectedSymbol) {
      const gap     = STRIKE_GAP[sym] || 50
      const curRows = get().chain.options[get().selectedExpiry] || []
      const hasReal = curRows.some(r => r.ce_ltp > 0 || r.pe_ltp > 0)
      // Only regen if chain is completely empty (no rows at all)
      if (curRows.length === 0) {
        const newChain = generateChain(sym, price)
        const expiry   = get().selectedExpiry || newChain.expiries[0] || ''
        const tokenMap = buildTokenMap(newChain.options)
        set({ chain: newChain, selectedExpiry: expiry, tokenMap })
      }
      // Never overwrite real prices — real chain comes via applyChainSnapshot
    }
  },

  setWsConnected: (v) => set({ wsConnected: v }),

  selectedSymbol: 'NIFTY',
  selectedExpiry: '',
  chain:          { expiries: [], options: {} },
  chainLoading:   false,
  tokenMap:       {},

  setSymbol: (sym) => {
    const spot     = get().spotPrices[sym] || 0
    const safeSpot = spot > 0 ? spot : { NIFTY: 23000, BANKNIFTY: 53000, SENSEX: 74000 }[sym] || 23000
    const chain    = generateChain(sym, safeSpot)
    const tokenMap = buildTokenMap(chain.options)
    set({ selectedSymbol: sym, selectedExpiry: chain.expiries[0] || '', chain, chainLoading: false, tokenMap })
  },

  setExpiry: (exp) => {
    set({ selectedExpiry: exp })
  },

  initChain: () => {
    const sym      = get().selectedSymbol
    const spot     = get().spotPrices[sym] || 0
    const safeSpot = spot > 0 ? spot : { NIFTY: 23000, BANKNIFTY: 53000, SENSEX: 74000 }[sym] || 23000
    const chain    = generateChain(sym, safeSpot)
    const tokenMap = buildTokenMap(chain.options)
    set({ chain, selectedExpiry: chain.expiries[0] || '', tokenMap })
  },

  // Apply chain_snapshot — this is the source of truth for real expiries
  applyChainSnapshot: (symbol, expiry, chainData, expiry_ymd) => {
    if (!symbol || !expiry || !chainData) return

    const ltpMap = {}
    for (const [trd, ltp] of Object.entries(chainData)) {
      const parsed = parseTrdSymbol(trd)
      if (!parsed || !ltp || ltp <= 0) continue
      const { strike, ot } = parsed
      if (!ltpMap[strike]) ltpMap[strike] = {}
      if (ot === 'CE') { ltpMap[strike].ce = ltp; ltpMap[strike].ce_token = trd }
      else             { ltpMap[strike].pe = ltp; ltpMap[strike].pe_token = trd }
    }

    if (Object.keys(ltpMap).length === 0) {
      console.warn('[SNAPSHOT] No strikes parsed from chain data')
      set({ chainLoading: false })
      return
    }

    set(s => {
      // FIX: The backend sends the REAL expiry (e.g. "24-Mar-2026").
      // If our chain doesn't have it yet, add it.
      let targetExpiry = expiry
      const chain = { ...s.chain, options: { ...s.chain.options } }

      // Add the real expiry to our expiry list if missing
      if (!chain.options[targetExpiry]) {
        const spot = s.spotPrices[symbol] || 23000
        const gap  = STRIKE_GAP[symbol] || 50
        const allStrikes = Object.keys(ltpMap).map(Number).sort((a,b) => a-b)

        // Build rows from engine data
        chain.options[targetExpiry] = allStrikes.map(strike => ({
          strike,
          ce_ltp: 0, pe_ltp: 0, ce_prev: 0, pe_prev: 0,
          ce_token: null, pe_token: null,
          atm: Math.abs(strike - spot) < gap,
          loading: false,
        }))

      // Add to expiry list, keeping it sorted by real date
        if (!chain.expiries.includes(targetExpiry)) {
          const allExp = [...chain.expiries.filter(e => e !== targetExpiry), targetExpiry]
          // Sort by actual date value
          allExp.sort((a, b) => {
            const toMs = (e) => {
              const p = e.split('-')
              if (p.length === 3 && p[0].length === 2) {
                const MON = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11}
                return new Date(parseInt(p[2]), MON[p[1]] || 0, parseInt(p[0])).getTime()
              }
              return 0
            }
            return toMs(a) - toMs(b)
          })
          chain.expiries = allExp
        }
      }

      // Build/extend rows from engine data — add any new strikes not yet in chain
      const existingStrikes = new Set((chain.options[targetExpiry] || []).map(r => r.strike))
      const allStrikes = [...new Set([
        ...(chain.options[targetExpiry] || []).map(r => r.strike),
        ...Object.keys(ltpMap).map(Number),
      ])].sort((a, b) => a - b)

      // Rebuild rows including new strikes from engine
      const spot2 = s.spotPrices[symbol] || 23000
      const gap2  = STRIKE_GAP[symbol] || 50
      chain.options[targetExpiry] = allStrikes.map(strike => {
        const existing = (chain.options[targetExpiry] || []).find(r => r.strike === strike)
        const e = ltpMap[strike] || {}
        return {
          strike,
          ce_ltp:   e.ce  > 0 ? parseFloat(e.ce.toFixed(1))  : (existing?.ce_ltp  || 0),
          pe_ltp:   e.pe  > 0 ? parseFloat(e.pe.toFixed(1))  : (existing?.pe_ltp  || 0),
          ce_prev:  existing?.ce_prev || 0,
          pe_prev:  existing?.pe_prev || 0,
          ce_token: e.ce_token || existing?.ce_token || null,
          pe_token: e.pe_token || existing?.pe_token || null,
          atm:      Math.abs(strike - spot2) < gap2,
          loading:  false,
        }
      })

      const tokenMap = buildTokenMap(chain.options)
      console.log(`[SNAPSHOT] ${Object.keys(ltpMap).length} strikes applied (${symbol} ${targetExpiry})`)

      const newState = {
        chain,
        chainLoading: false,
        tokenMap,
        // FIX: update selectedExpiry to the REAL expiry from engine
        selectedExpiry: targetExpiry,
      }

      // Apply pending snapshot prices
      const pending = s._pendingSnapshot
      if (pending && Object.keys(tokenMap).length > 0) {
        for (const [token, ltp] of Object.entries(pending)) {
          if (!ltp || ltp <= 0) continue
          const loc = tokenMap[token]
          if (!loc) continue
          const { expiry: e, idx, side } = loc
          const erows = chain.options[e]
          if (!erows) continue
          const row    = erows[idx]
          if (!row) continue
          const newRow = { ...row }
          if (side === 'ce') { newRow.ce_prev = row.ce_ltp; newRow.ce_ltp = ltp }
          else               { newRow.pe_prev = row.pe_ltp; newRow.pe_ltp = ltp }
          chain.options[e] = [...erows]; chain.options[e][idx] = newRow
        }
        newState._pendingSnapshot = null
      }

      return newState
    })
  },

  applyPriceSnapshot: (prices, spots) => {
    if (spots) {
      const s = get()
      const newSpots = { ...s.spotPrices }
      for (const [sym, ltp] of Object.entries(spots)) {
        if (ltp > 0) newSpots[sym] = ltp
      }
      set({ spotPrices: newSpots })
    }

    if (!prices || Object.keys(prices).length === 0) return

    // FIX #2: always merge into basketPrices regardless of tokenMap state
    set(s => ({ basketPrices: { ...s.basketPrices, ...Object.fromEntries(
      Object.entries(prices).filter(([,v]) => v > 0)
    ) } }))

    const tokenMap = get().tokenMap
    if (Object.keys(tokenMap).length === 0) {
      set({ _pendingSnapshot: prices })
      return
    }

    set(state => {
      const chain = { ...state.chain, options: { ...state.chain.options } }
      let changed = false
      for (const [token, ltp] of Object.entries(prices)) {
        if (!ltp || ltp <= 0) continue
        const loc = tokenMap[token]
        if (!loc) continue
        const { expiry, idx, side } = loc
        const rows = chain.options[expiry]
        if (!rows) continue
        const row    = rows[idx]
        if (!row) continue
        const newRow = { ...row }
        if (side === 'ce') { newRow.ce_prev = row.ce_ltp; newRow.ce_ltp = ltp }
        else               { newRow.pe_prev = row.pe_ltp; newRow.pe_ltp = ltp }
        chain.options[expiry] = [...rows]
        chain.options[expiry][idx] = newRow
        changed = true
      }
      return changed ? { chain } : state
    })
  },

  fetchChainLtps: async (symbol, expiry, silent = false) => {
    if (!symbol || !expiry) return
    const key = `${symbol}:${expiry}`
    if (_chainFetchKey === key) return
    _chainFetchKey = key

    if (!silent) set({ chainLoading: true })

    const API = import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'
    const ymd = toYmd(expiry)

    // Try the requested expiry first, then scan every day for next 14 days
    // (NIFTY/BANKNIFTY can expire on any weekday for special weeks)
    const candidates = [ymd]
    const probe = new Date()
    probe.setHours(0, 0, 0, 0)
    for (let i = 0; i < 45; i++) {
      const yr = probe.getFullYear()
      const mo = String(probe.getMonth() + 1).padStart(2,'0')
      const dd = String(probe.getDate()).padStart(2,'0')
      const c  = `${yr}-${mo}-${dd}`
      if (c !== ymd && !candidates.includes(c)) candidates.push(c)
      probe.setDate(probe.getDate() + 1)
    }

    for (const tryExpiry of candidates) {
      try {
        const token = get().token
        const headers = token ? { Authorization: `Bearer ${token}` } : {}
        const res = await fetch(`${API}/api/prices/chain/${symbol}?expiry=${tryExpiry}`, { headers })
        if (!res.ok) continue
        const body      = await res.json()
        const chainData = body.chain || {}
        if (Object.keys(chainData).length === 0) continue

        const displayExpiry = fromYmd(tryExpiry)
        get().applyChainSnapshot(symbol, displayExpiry, chainData, tryExpiry)
        console.log(`[CHAIN REST] ${Object.keys(chainData).length} tokens  ${symbol}/${tryExpiry}`)
        _chainFetchKey = ''
        return
      } catch (e) {
        console.warn('[CHAIN REST] Fetch error:', e)
      }
    }

    console.warn('[CHAIN REST] All expiries empty for', symbol)
    set({ chainLoading: false })
    _chainFetchKey = ''
  },

  // FIX #2: basketPrices holds token→ltp for ALL subscribed tokens.
  // This map is NEVER cleared when the user switches instruments, so the
  // basket monitor always has live prices regardless of what's being viewed.
  basketPrices: {},

  updateLtpByToken: (token, ltp) => {
    if (!token || !ltp || ltp <= 0) return
    if (IDX_KEYS[token]) {
      get().updateSpot(IDX_KEYS[token], ltp)
      return
    }

    // FIX #2: Always update basketPrices for every option tick.
    // This runs even when the token is NOT in the current chain view,
    // keeping basket P&L live across instrument switches.
    set(s => ({ basketPrices: { ...s.basketPrices, [token]: ltp } }))

    const loc = get().tokenMap[token]
    if (!loc) return   // token not in current chain view — basketPrices already updated above
    const { expiry, idx, side } = loc
    set(s => {
      const rows = s.chain.options[expiry]
      if (!rows) return s
      const row = rows[idx]
      if (!row) return s
      const newRow = { ...row }
      if (side === 'ce') { newRow.ce_prev = row.ce_ltp; newRow.ce_ltp = ltp }
      else               { newRow.pe_prev = row.pe_ltp; newRow.pe_ltp = ltp }
      const newRows = [...rows]; newRows[idx] = newRow
      return { chain: { ...s.chain, options: { ...s.chain.options, [expiry]: newRows } } }
    })
  },

  basket:           [],
  basketSize:       4,
  setBasketSize:    (n)     => set({ basketSize: n }),
  addToBasket:      (order) => set(s => s.basket.length >= s.basketSize ? s : { basket: [...s.basket, order] }),
  removeFromBasket: (idx)   => set(s => ({ basket: s.basket.filter((_,i) => i !== idx) })),
  clearBasket:      ()      => set({ basket: [] }),

  lockedProfit:    3000,
  lockedLoss:      1500,
  autoLoop:        true,
  setLockedProfit: (v) => set({ lockedProfit: v }),
  setLockedLoss:   (v) => set({ lockedLoss: v }),
  setAutoLoop:     (v) => set({ autoLoop: v }),

  activeBaskets:   [],
  addActiveBasket:      (b)           => set(s => ({ activeBaskets: [...s.activeBaskets, b] })),
  updateBasketPnl:      (id, pnl)     => set(s => ({ activeBaskets: s.activeBaskets.map(b => b.id === id ? { ...b, pnl } : b) })),
  updateBasketTargets:  (id, profit, loss) => set(s => ({ activeBaskets: s.activeBaskets.map(b => b.id === id ? { ...b, lockedProfit: profit, lockedLoss: loss } : b) })),
  closeBasket:          (id)          => set(s => ({ activeBaskets: s.activeBaskets.filter(b => b.id !== id) })),

  tradeHistory: [],
  addHistory:   (h) => set(s => ({ tradeHistory: [h, ...s.tradeHistory].slice(0,100) })),

  paperBalance:   1000000,
  liveBalance:    0,
  setLiveBalance: (v)   => set({ liveBalance: v }),
  adjustBalance:  (pnl) => set(s => ({ paperBalance: s.paperBalance + pnl })),

  activeTab: 'terminal',
  setTab:    (t) => set({ activeTab: t }),
}))
