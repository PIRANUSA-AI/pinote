import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ArrowSquareOut, Plus } from '@phosphor-icons/react'

const DISMISSED_KEY = 'rekapin-install-dismissed'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function isMobileDevice() {
  const ua = navigator.userAgent
  if (/android|iphone|ipad|ipod/i.test(ua)) return true
  return /macintosh/i.test(ua) && navigator.maxTouchPoints > 1
}

function isInStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in window.navigator && (window.navigator as { standalone?: boolean }).standalone === true)
}

export function InstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIOS, setShowIOS] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!isMobileDevice()) return
    if (isInStandaloneMode()) return
    if (localStorage.getItem(DISMISSED_KEY)) return

    if (isIOS()) {
      setShowIOS(true)
      setVisible(true)
      return
    }

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setVisible(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const dismiss = () => {
    setVisible(false)
    localStorage.setItem(DISMISSED_KEY, '1')
  }

  const install = async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') setVisible(false)
    setDeferredPrompt(null)
  }

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -40 }}
          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          className="fixed top-0 inset-x-0 z-50 px-4 pt-3 pb-2 md:top-4 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-auto"
        >
          <div className="flex items-center gap-3 rounded-2xl bg-navy text-white shadow-xl px-4 py-3 md:min-w-[320px]">
            <img src="/icon-512.svg" alt="" className="w-9 h-9 rounded-xl flex-shrink-0" />
            <div className="flex-1 min-w-0">
              {showIOS ? (
                <>
                  <p className="text-sm font-semibold">Tambahkan ke Layar Utama</p>
                  <p className="text-xs text-white/60 flex items-center gap-1 mt-0.5">
                    Tap <ArrowSquareOut size={11} className="inline" /> lalu "Add to Home Screen"
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold">Install Rekapin</p>
                  <p className="text-xs text-white/60 mt-0.5">Akses lebih cepat dari layar utama</p>
                </>
              )}
            </div>
            {!showIOS && (
              <button
                onClick={install}
                className="flex items-center gap-1.5 bg-white text-navy rounded-full px-3 py-1.5 text-xs font-semibold flex-shrink-0 hover:bg-slate-100 transition-colors"
              >
                <Plus size={12} weight="bold" />
                Install
              </button>
            )}
            <button
              onClick={dismiss}
              className="w-7 h-7 grid place-items-center rounded-full bg-white/10 hover:bg-white/20 flex-shrink-0 transition-colors"
            >
              <X size={13} weight="bold" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
