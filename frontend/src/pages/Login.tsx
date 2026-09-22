import { useEffect, useState } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, DownloadSimple } from '@phosphor-icons/react'
import { useAuth } from '../hooks/useAuth'
import { ApiError, api } from '../lib/api'
import { BrandMark } from '../components/Brand'
import { signInWithGoogle } from '../lib/firebase'

export default function Login() {
  const { user, loading, refresh } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'

  useEffect(() => {
    if (!loading && user) navigate(from, { replace: true })
  }, [user, loading, navigate, from])

  const handleGoogleSignIn = async () => {
    setError(null)
    setGoogleLoading(true)
    try {
      const idToken = await signInWithGoogle()
      await api.post('/auth/google', { idToken })
      await refresh()
      navigate(from, { replace: true })
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else if (err instanceof Error) setError(err.message)
      else setError('Gagal masuk dengan Google')
    } finally {
      setGoogleLoading(false)
    }
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-6 py-12 bg-paper aurora relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        className="relative w-full max-w-sm"
      >
        <div className="flex flex-col items-center mb-9">
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 16, delay: 0.1 }}
          >
            <BrandMark size={56} />
          </motion.div>
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-deep">
            Rekapin by Contrivent
          </p>
          <h1 className="mt-2 text-center text-3xl md:text-4xl tracking-tightest leading-[1.05] font-semibold text-navy">
            Masuk
          </h1>
          <p className="mt-2.5 text-center text-[13px] text-ink-muted leading-relaxed">
            Hanya untuk @piranusa.com atau @contrivent.com
          </p>
        </div>

        <button
          onClick={handleGoogleSignIn}
          disabled={googleLoading}
          className="btn-ghost w-full justify-center gap-3 py-3 border border-slate-200 hover:bg-slate-50"
        >
          {googleLoading ? (
            <span className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
              <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
              <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
              <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
            </svg>
          )}
          {googleLoading ? 'Memproses...' : 'Masuk dengan Google'}
        </button>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-5 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error}
          </motion.div>
        )}

        <Link
          to="/welcome"
          className="mt-5 mx-auto flex items-center justify-center gap-1.5 text-xs font-medium text-slate-400 hover:text-navy transition-colors w-fit"
        >
          <ArrowLeft size={12} weight="bold" />
          Lihat perkenalan Rekapin
        </Link>

        <Link
          to="/extension"
          className="mt-3 mx-auto flex items-center justify-center gap-1.5 text-xs font-medium text-brand-deep hover:text-navy transition-colors w-fit"
        >
          <DownloadSimple size={12} weight="bold" />
          Unduh extension Chrome dan catatan rilis
        </Link>
      </motion.div>
    </div>
  )
}
