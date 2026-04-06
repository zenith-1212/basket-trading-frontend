import { useState } from 'react'
import { useStore } from '../store'
import toast from 'react-hot-toast'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [pass, setPass]         = useState('')
  const [loading, setLoad]      = useState(false)
  const { setToken, setUser }   = useStore()

  const API = import.meta.env.VITE_API_URL || 'https://api.baskettrading.in'

  async function submit(e) {
    e.preventDefault()
    setLoad(true)
    try {
      const res = await fetch(API + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: pass }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Login failed')
      setToken(data.access_token)
      setUser({ username, id: data.user?.id })
      toast.success('Logged in successfully')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoad(false)
    }
  }

  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at 50% 40%, rgba(0,230,118,0.04) 0%, transparent 70%)',
      padding: 24, minHeight: '100vh',
    }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 56, height: 56, background: 'var(--green-dim)', border: '1px solid var(--green)',
            borderRadius: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--sans)',
            marginBottom: 14, boxShadow: '0 0 32px rgba(0,230,118,0.15)',
          }}>B</div>
          <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'var(--sans)', color: 'var(--text)', letterSpacing: '0.02em' }}>
            BASKET LOOP TRADER
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4, letterSpacing: '0.1em' }}>
            HYBRID · DHAN DATA · KOTAK NEO
          </div>
        </div>

        {/* Form card */}
        <div className="card" style={{ padding: 24 }}>
          <div style={{ marginBottom: 20, textAlign: 'center' }}>
            <span style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
              color: 'var(--text3)', fontFamily: 'var(--mono)',
            }}>ADMIN LOGIN</span>
          </div>

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4, letterSpacing: '0.06em' }}>USERNAME</div>
              <input
                className="input"
                type="text"
                placeholder="admin"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4, letterSpacing: '0.06em' }}>PASSWORD</div>
              <input
                className="input"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                value={pass}
                onChange={e => setPass(e.target.value)}
                required
                minLength={6}
              />
            </div>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={loading}
              style={{ justifyContent: 'center', marginTop: 4, fontSize: 12, padding: '10px 0' }}
            >
              {loading ? 'LOGGING IN...' : 'LOGIN →'}
            </button>
          </form>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 10, color: 'var(--text3)', lineHeight: 1.6 }}>
          Private trading terminal. Unauthorized access is prohibited.
        </div>
      </div>
    </div>
  )
}
