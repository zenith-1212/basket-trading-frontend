import { useStore } from '../store'

export default function HistoryPage() {
  const { tradeHistory, paperBalance } = useStore()

  const totalPnl  = tradeHistory.reduce((s, h) => s + h.pnl, 0)
  const wins      = tradeHistory.filter(h => h.pnl > 0).length
  const losses    = tradeHistory.filter(h => h.pnl < 0).length
  const winRate   = tradeHistory.length ? ((wins / tradeHistory.length) * 100).toFixed(1) : '0.0'
  const avgWin    = wins  ? (tradeHistory.filter(h=>h.pnl>0).reduce((s,h)=>s+h.pnl,0)/wins).toFixed(0)  : 0
  const avgLoss   = losses? (tradeHistory.filter(h=>h.pnl<0).reduce((s,h)=>s+h.pnl,0)/losses).toFixed(0): 0

  return (
    <div style={{ flex:1, overflow:'auto', padding:16, display:'flex', flexDirection:'column', gap:12 }}>
      {/* Stats row */}
      <div style={{ display:'flex', gap:10 }}>
        {[
          { label:'TOTAL P&L', value:`₹${totalPnl.toLocaleString('en-IN',{maximumFractionDigits:0})}`, color: totalPnl>=0?'var(--green)':'var(--red)' },
          { label:'WIN RATE',  value:`${winRate}%`,  color:'var(--blue)' },
          { label:'WINS',      value:wins,            color:'var(--green)' },
          { label:'LOSSES',    value:losses,          color:'var(--red)' },
          { label:'AVG WIN',   value:`₹${avgWin}`,   color:'var(--green)' },
          { label:'AVG LOSS',  value:`₹${Math.abs(avgLoss)}`, color:'var(--red)' },
          { label:'PAPER BAL', value:`₹${paperBalance.toLocaleString('en-IN',{maximumFractionDigits:0})}`, color:'var(--amber)' },
        ].map(s => (
          <div key={s.label} className="card" style={{ flex:1, padding:'12px 14px' }}>
            <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:6 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:700, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* History table */}
      <div className="card" style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
        <div className="card-header"><span>Trade History</span></div>
        <div style={{ flex:1, overflow:'auto' }}>
          {tradeHistory.length === 0 ? (
            <div style={{ padding:'48px 0', textAlign:'center', color:'var(--text3)', fontSize:12 }}>
              No trades yet. Execute baskets to see history.
            </div>
          ) : (
            <table className="data-table" style={{ width:'100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign:'left' }}>TIME</th>
                  <th>TYPE</th>
                  <th>LOOP</th>
                  <th>P &amp; L</th>
                  <th>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {tradeHistory.map(h => (
                  <tr key={h.id}>
                    <td style={{ textAlign:'left', color:'var(--text2)' }}>{h.time}</td>
                    <td>
                      <span style={{
                        padding:'2px 8px', borderRadius:3, fontSize:10, fontWeight:700,
                        background: h.type==='TARGET' ? 'var(--green-dim)' : h.type==='SL' ? 'var(--red-dim)' : 'var(--bg4)',
                        color: h.type==='TARGET' ? 'var(--green)' : h.type==='SL' ? 'var(--red)' : 'var(--text2)',
                      }}>{h.type}</span>
                    </td>
                    <td style={{ color:'var(--text2)' }}>Loop {h.loop}</td>
                    <td style={{ color: h.pnl>=0?'var(--green)':'var(--red)', fontWeight:700, fontSize:14 }}>
                      {h.pnl>=0?'+':''}₹{Math.abs(h.pnl).toLocaleString('en-IN',{maximumFractionDigits:0})}
                    </td>
                    <td>
                      <span style={{ fontSize:10, color:'var(--text3)' }}>✓ CLOSED</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
