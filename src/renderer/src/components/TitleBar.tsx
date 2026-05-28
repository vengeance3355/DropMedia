import { useEffect, useState } from 'react'

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    window.api.isMaximized().then(setMaximized)
    window.api.onWindowMaximized(setMaximized)
  }, [])

  return (
    <div
      className="flex items-center justify-between h-10 px-4 select-none shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-lg bg-gradient-button flex items-center justify-center shadow-lg shadow-purple-500/30">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L4 7v10l8 5 8-5V7L12 2z" fill="white" opacity="0.9"/>
            <path d="M12 8v8M9 13l3 3 3-3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <span className="text-white/90 text-sm font-semibold tracking-wide">DropMedia</span>
      </div>

      {/* Pencere kontrolleri */}
      <div
        className="flex items-center gap-1.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <WindowBtn onClick={() => window.api.minimizeWindow()} title="Küçült">
          <svg width="10" height="2" viewBox="0 0 10 2"><rect width="10" height="1.5" rx="1" fill="currentColor"/></svg>
        </WindowBtn>
        <WindowBtn onClick={() => window.api.maximizeWindow()} title={maximized ? 'Küçült' : 'Büyüt'}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1H9V7M1 3H7V9H1V3Z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round"/></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.3" fill="none"/></svg>
          )}
        </WindowBtn>
        <WindowBtn
          onClick={() => window.api.closeWindow()}
          title="Kapat"
          className="hover:!bg-red-500/80"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </WindowBtn>
      </div>
    </div>
  )
}

function WindowBtn({
  onClick,
  children,
  title,
  className = ''
}: {
  onClick: () => void
  children: React.ReactNode
  title: string
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-7 h-7 rounded-md flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-all duration-150 ${className}`}
    >
      {children}
    </button>
  )
}
