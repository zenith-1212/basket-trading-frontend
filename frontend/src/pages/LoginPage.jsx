import { useState } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

export default function LoginPage() {
  const [email, setEmail]   = useState('')
  const [pass, setPass]     = useState('')
  const [isSignup, setMode] = useState(false)
  const [loading, setLoad]  = useState(false)
  const { setToken, setUser } = useStore()

  const API = import.meta.env.VITE_API_URL || 'https://basket-trading-backend.onrender.com'

  async function submit(e) {
    e.preventDefault()
    setLoad(true)
    try {
      const endpoint = isSignup ? '/api/auth/signup' : '/api/auth/login'
      const res = await fetch(API + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Auth failed')
      setToken(data.access_token)
      setUser({ email, id: data.user?.id })
      toast.success(isSignup ? 'Account created!' : 'Logged in!')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoad(false)
    }
  }

  // Allow skipping auth for demo/paper trading
  function skipLogin() {
    setToken('demo-paper-token')
    setUser({ email: 'demo@paper.trade', id: 'demo' })
    toast('Paper trading mode — no real orders', { icon: '📄' })
  }

  return (
    <div style={{
      flex:1, display:'flex', alignItems:'center', justifyContent:'center',
      background: 'radial-gradient(ellipse at 50% 40%, rgba(0,230,118,0.04) 0%, transparent 70%)',
      padding:24,
    }}>
      <div style={{ width:'100%', maxWidth:360 }}>
        {/* Logo */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{
            width:56, height:56, background:'var(--green-dim)', border:'1px solid var(--green)',
            borderRadius:12, display:'inline-flex', alignItems:'center', justifyContent:'center',
            fontSize:24, fontWeight:800, color:'var(--green)', fontFamily:'var(--sans)',
            marginBottom:14, boxShadow:'0 0 32px rgba(0,230,118,0.15)',
          }}>B</div>
          <div style={{ fontSize:20, fontWeight:800, fontFamily:'var(--sans)', color:'var(--text)', letterSpacing:'0.02em' }}>
            BASKET LOOP TRADER
          </div>
          <div style={{ fontSize:10, color:'var(--text3)', marginTop:4, letterSpacing:'0.1em' }}>
            HYBRID · DHAN DATA · KOTAK NEO
          </div>
        </div>

        {/* Form card */}
        <div className="card" style={{ padding:24 }}>
          <div style={{ display:'flex', gap:4, marginBottom:20, background:'var(--bg3)', padding:3, borderRadius:6 }}>
            {[['login','LOGIN'],['signup','SIGN UP']].map(([m, label]) => (
              <button key={m} onClick={() => setMode(m==='signup')} style={{
                flex:1, padding:'6px 0', borderRadius:4, border:'none', cursor:'pointer',
                fontFamily:'var(--mono)', fontSize:11, fontWeight:700, letterSpacing:'0.06em',
                background: (m==='signup')===isSignup ? 'var(--bg2)' : 'transparent',
                color: (m==='signup')===isSignup ? 'var(--text)' : 'var(--text3)',
                transition:'all 0.15s',
              }}>{label}</button>
            ))}
          </div>

          <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div>
              <div style={{ fontSize:10, color:'var(--text3)', marginBottom:4, letterSpacing:'0.06em' }}>EMAIL</div>
              <input className="input" type="email" placeholder="trader@example.com"
                value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div>
              <div style={{ fontSize:10, color:'var(--text3)', marginBottom:4, letterSpacing:'0.06em' }}>PASSWORD</div>
              <input className="input" type="password" placeholder="••••••••"
                value={pass} onChange={e => setPass(e.target.value)} required minLength={6} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={loading}
              style={{ justifyContent:'center', marginTop:4, fontSize:12, padding:'9px 0' }}>
              {loading ? '...' : (isSignup ? 'CREATE ACCOUNT' : 'LOGIN')}
            </button>
          </form>

          <div style={{ margin:'16px 0', textAlign:'center', position:'relative' }}>
            <div style={{ height:1, background:'var(--border)' }}/>
            <span style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
              background:'var(--bg2)', padding:'0 10px', fontSize:10, color:'var(--text3)' }}>OR</span>
          </div>

          <button className="btn btn-ghost" onClick={skipLogin}
            style={{ width:'100%', justifyContent:'center', fontSize:11 }}>
            ▶ CONTINUE AS PAPER TRADER (no login)
          </button>
        </div>

        <div style={{ textAlign:'center', marginTop:16, fontSize:10, color:'var(--text3)', lineHeight:1.6 }}>
          Paper trading is 100% free and requires no API keys.<br/>
          Connect Dhan + Kotak in Settings for live data &amp; real orders.
        </div>
      </div>
    </div>
  )
}
