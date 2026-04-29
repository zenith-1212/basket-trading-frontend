import { useEffect, useState } from 'react'
import { Toaster } from 'react-hot-toast'
import { useStore } from './store'
import { usePriceFeed } from './hooks/usePriceFeed'
import {useBasketMonitor} from './hooks/useBasketMonitor'
import Header from './components/Header'
import OptionChain from './components/OptionChain'
import BasketBuilder from './components/BasketBuilder'
import ActiveBaskets from './components/ActiveBaskets'
import LoginPage from './pages/LoginPage'
import HistoryPage from './pages/HistoryPage'
import SettingsPage from './pages/SettingsPage'

const MOBILE_TABS = [
  { id: 'chain',    label: 'Chain',    icon: '📊' },
  { id: 'basket',   label: 'Basket',   icon: '🗂️'  },
  { id: 'active',   label: 'Active',   icon: '⚡'  },
  { id: 'history',  label: 'History',  icon: '📋' },
  { id: 'settings', label: 'Settings', icon: '⚙️'  },
]

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return isMobile
}

function DesktopTerminal() {
  return (
    <div style={{ flex: 1, display: 'flex', gap: 0, overflow: 'hidden', minHeight: 0 }}>
      <OptionChain />
      <BasketBuilder />
      <ActiveBaskets />
    </div>
  )
}

function MobileTerminal() {
  const [mobileTab, setMobileTab] = useState('chain')
  const { activeBaskets, basket } = useStore()

  return (
    <>
      <div className="mobile-panel">
        {mobileTab === 'chain'    && <OptionChain />}
        {mobileTab === 'basket'   && <BasketBuilder />}
        {mobileTab === 'active'   && <ActiveBaskets />}
        {mobileTab === 'history'  && <HistoryPage />}
        {mobileTab === 'settings' && <SettingsPage />}
      </div>

      <nav className="mobile-bottom-nav" style={{
        display: 'flex',
        background: 'var(--bg-header)',
        borderTop: '1px solid rgba(255,255,255,0.1)',
      }}>
        {MOBILE_TABS.map(tab => {
          const isActive = mobileTab === tab.id
          const badge = tab.id === 'basket' ? (basket?.length || 0)
                      : tab.id === 'active' ? (activeBaskets?.length || 0)
                      : 0
          return (
            <button key={tab.id} onClick={() => setMobileTab(tab.id)} style={{
              flex: 1, border: 'none', background: 'transparent',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', padding: '8px 4px', cursor: 'pointer',
              gap: 3, position: 'relative',
              borderTop: isActive ? '2px solid #3b82f6' : '2px solid transparent',
            }}>
              <span style={{ fontSize: 20 }}>{tab.icon}</span>
              <span style={{
                fontSize: 9, fontWeight: isActive ? 700 : 400,
                color: isActive ? '#fff' : 'rgba(255,255,255,0.4)',
              }}>{tab.label}</span>
              {badge > 0 && (
                <span style={{
                  position: 'absolute', top: 4, right: '50%',
                  transform: 'translateX(200%)',
                  background: '#3b82f6', color: '#fff',
                  borderRadius: 8, fontSize: 9, fontWeight: 700,
                  padding: '1px 5px', lineHeight: 1.4,
                  minWidth: 16, textAlign: 'center',
                }}>{badge}</span>
              )}
            </button>
          )
        })}
      </nav>
    </>
  )
}

function AppInner() {
  usePriceFeed()
  useBasketMonitor()
  const { activeTab, initChain, fetchActiveBaskets } = useStore()
  const isMobile = useIsMobile()

  useEffect(() => {
    initChain()
    fetchActiveBaskets()   // no-op now — baskets are in-memory only
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (isMobile) {
    return (
      <>
        <Header />
        <MobileTerminal />
      </>
    )
  }

  return (
    <>
      <Header />
      {activeTab === 'terminal' && <DesktopTerminal />}
      {activeTab === 'history'  && <HistoryPage />}
      {activeTab === 'settings' && <SettingsPage />}
    </>
  )
}

export default function App() {
  const { token } = useStore()
  return (
    <>
      <Toaster position="top-right" toastOptions={{
        style: { background: 'var(--bg-panel)', color: 'var(--text)', border: '1px solid var(--border)', fontSize: 12, fontFamily: 'var(--mono)' },
        duration: 3000,
      }} />
      {token ? <AppInner /> : <LoginPage />}
    </>
  )
}
