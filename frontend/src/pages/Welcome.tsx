import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  ArrowRight,
  ArrowLeft,
  MicrophoneStage,
  ListChecks,
  Sparkle,
  WarningCircle,
} from '@phosphor-icons/react'
import { ApiError, api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { BrandMark } from '../components/Brand'
import { ExtensionPill } from '../components/ExtensionPromo'
import { signInWithGoogle } from '../lib/firebase'

type Slide = 'welcome' | 'features' | 'personalize' | 'account'

const SLIDE_ORDER: Slide[] = ['welcome', 'features', 'personalize', 'account']

const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 60 : -60, opacity: 0, scale: 0.98 }),
  center: { x: 0, opacity: 1, scale: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -60 : 60, opacity: 0, scale: 0.98 }),
}

const slideTransition = { type: 'spring' as const, stiffness: 320, damping: 34, mass: 0.9 }

export default function Welcome() {
  const navigate = useNavigate()
  const reduce = useReducedMotion()
  const { refresh } = useAuth()
  const [slide, setSlide] = useState<Slide>('welcome')
  const [dir, setDir] = useState(1)
  const [nickname, setNickname] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [layoutSlide, setLayoutSlide] = useState<Slide>('welcome')

  const go = (next: Slide) => {
    if (next === slide) return
    setDir(SLIDE_ORDER.indexOf(next) > SLIDE_ORDER.indexOf(slide) ? 1 : -1)
    setSlide(next)
  }

  const next = () => {
    const i = SLIDE_ORDER.indexOf(slide)
    if (i < SLIDE_ORDER.indexOf('account')) go(SLIDE_ORDER[i + 1])
  }
  const prev = () => {
    const i = SLIDE_ORDER.indexOf(slide)
    if (i > 0) go(SLIDE_ORDER[i - 1])
  }

  const handleGoogleSignIn = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const idToken = await signInWithGoogle()
      await api.post('/auth/google', { idToken })
      await refresh()
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError) setError(err.message)
      else if (err instanceof Error) setError(err.message)
      else setError('Gagal masuk dengan Google')
    } finally {
      setSubmitting(false)
    }
  }

  const skipToLogin = () => navigate('/login', { replace: true })

  const initials = nickname
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

  const currentIdx = SLIDE_ORDER.indexOf(slide)
  const isAccountLayout = layoutSlide === 'account'

  return (
    <div className="min-h-[100dvh] bg-paper relative overflow-x-hidden overflow-y-auto aurora">
      {/* Decorative grid pattern, fades out under content */}
      <div className="absolute inset-0 grid-pattern opacity-60 pointer-events-none" />

      {/* Top-left brand anchor (persists across slides) */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5 }}
        className="absolute top-6 left-6 md:top-8 md:left-10 flex items-center gap-2.5 z-20"
      >
        <BrandMark size={30} />
        <span className="text-sm font-semibold tracking-tight text-navy">Rekapin</span>
      </motion.div>

      <div className="pointer-events-none absolute inset-x-0 top-6 z-20 hidden justify-center md:top-7 md:flex">
        <div className="pointer-events-auto">
          <ExtensionPill />
        </div>
      </div>

      {/* Skip control */}
      {slide !== 'account' && (
        <button
          onClick={skipToLogin}
          className="absolute top-6 right-6 md:top-8 md:right-10 z-20 text-xs font-medium text-slate-400 hover:text-navy transition-colors"
        >
          Lewati
        </button>
      )}

      <div
        className={`relative z-10 min-h-[100dvh] flex flex-col items-center px-6 ${
          isAccountLayout ? 'justify-start pt-24 pb-24 sm:justify-center sm:py-20' : 'justify-center py-20'
        }`}
      >
        <div className="w-full max-w-md">
          <AnimatePresence mode="wait" custom={dir} initial={false} onExitComplete={() => setLayoutSlide(slide)}>
            <motion.div
              key={slide}
              custom={dir}
              variants={reduce ? undefined : slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={slideTransition}
            >
              {slide === 'welcome' && <WelcomeSlide />}
              {slide === 'features' && <FeaturesSlide />}
              {slide === 'personalize' && (
                <PersonalizeSlide nickname={nickname} setNickname={setNickname} initials={initials} />
              )}
            {slide === 'account' && (
              <AccountSlide
                nickname={nickname}
                error={error}
                submitting={submitting}
                onGoogleSignIn={handleGoogleSignIn}
              />
            )}
            </motion.div>
          </AnimatePresence>

          {/* Progress + nav */}
          <div className="mt-10 flex min-h-10 items-center justify-between">
            <div className="flex items-center gap-1.5">
              {SLIDE_ORDER.map((s, i) => (
                <button
                  key={s}
                  onClick={() => go(s)}
                  className="relative h-1.5 rounded-full transition-all"
                  style={{ width: i === currentIdx ? 28 : 8 }}
                  aria-label={`Slide ${i + 1}`}
                >
                  <span
                    className={`absolute inset-0 rounded-full ${
                      i === currentIdx ? 'bg-brand' : i < currentIdx ? 'bg-brand/40' : 'bg-slate-300'
                    }`}
                  />
                </button>
              ))}
            </div>

            {slide !== 'account' ? (
              <div className="flex items-center gap-2">
                {currentIdx > 0 && (
                  <button onClick={prev} className="btn-ghost !px-3 !py-2 text-xs">
                    <ArrowLeft size={14} weight="bold" />
                    Kembali
                  </button>
                )}
                <button
                  onClick={next}
                  disabled={slide === 'personalize' && !nickname.trim()}
                  className="btn-primary text-xs"
                >
                  Lanjut
                  <ArrowRight size={14} weight="bold" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <footer className="fixed bottom-4 inset-x-0 text-center text-[11px] text-slate-400 z-10 pointer-events-none">
        Rekapin  Contrivention &copy; 2026. by Rekapin, Indonesia.
      </footer>
    </div>
  )
}

function WelcomeSlide() {
  return (
    <div className="text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.85, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20, delay: 0.05 }}
        className="mx-auto mb-8"
      >
        <HeroScene />
      </motion.div>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="eyebrow mb-3"
      >
        Tim Internal Rekapin
      </motion.p>
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.32 }}
        className="text-4xl sm:text-5xl tracking-tightest font-semibold leading-[1.05] text-navy"
      >
        Selamat datang.
        <br />
        <span className="text-brand">Rapat tertulis,</span>
        <br />
        tugas tertuntaskan.
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.42 }}
        className="mt-5 text-[15px] text-ink-muted leading-relaxed max-w-[42ch] mx-auto"
      >
        Setiap rapat jadi sumber kebenaran tim: transkrip, ringkasan, dan tugas
        yang otomatis terbagi semua di satu tempat.
      </motion.p>
    </div>
  )
}

function HeroScene() {
  const BARS = [
    { h: [22, 58, 30, 70, 18], dur: 1.8 },
    { h: [40, 18, 64, 26, 52], dur: 2.1 },
    { h: [60, 90, 36, 78, 44], dur: 1.6 },
    { h: [80, 100, 50, 92, 70], dur: 1.9 },
    { h: [54, 76, 30, 88, 60], dur: 2.0 },
    { h: [36, 22, 70, 40, 64], dur: 1.7 },
    { h: [22, 48, 28, 58, 20], dur: 2.2 },
    { h: [14, 32, 20, 40, 16], dur: 1.95 },
  ]

  return (
    <svg width="280" height="180" viewBox="0 0 280 180" fill="none" className="mx-auto">
      <defs>
        <linearGradient id="waveGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1E1B4B">
            <animate attributeName="stop-color" values="#1E1B4B;#4F46E5;#818CF8;#4F46E5;#1E1B4B" dur="8s" repeatCount="indefinite" />
          </stop>
          <stop offset="50%" stopColor="#6366F1">
            <animate attributeName="stop-color" values="#6366F1;#818CF8;#A78BFA;#6366F1;#818CF8" dur="8s" repeatCount="indefinite" />
          </stop>
          <stop offset="100%" stopColor="#A78BFA">
            <animate attributeName="stop-color" values="#A78BFA;#818CF8;#6366F1;#A78BFA;#818CF8" dur="8s" repeatCount="indefinite" />
          </stop>
        </linearGradient>
        <linearGradient id="waveGlow" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#818CF8" stopOpacity="0.35" />
          <stop offset="1" stopColor="#818CF8" stopOpacity="0" />
        </linearGradient>
      </defs>

      <ellipse cx="140" cy="30" rx="120" ry="30" fill="url(#waveGlow)" />

      {BARS.map((bar, i) => {
        const x = 60 + i * 20
        const heights = [...bar.h, bar.h[0]]
        const positions = heights.map((v) => 90 - v / 2)

        return (
          <rect
            key={i}
            x={x}
            y={positions[0]}
            width={9}
            height={heights[0]}
            rx={4.5}
            fill="url(#waveGrad)"
          >
            <animate
              attributeName="height"
              values={heights.join(';')}
              dur={`${bar.dur}s`}
              begin={`${i * 0.07}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="y"
              values={positions.join(';')}
              dur={`${bar.dur}s`}
              begin={`${i * 0.07}s`}
              repeatCount="indefinite"
            />
          </rect>
        )
      })}
    </svg>
  )
}

const FEATURES = [
  {
    icon: MicrophoneStage,
    title: 'Transkrip otomatis',
    body: 'Upload audio rapat atau rekam langsung dari Google Meet, Zoom, dan WhatsApp. Transkrip rapi lengkap dengan label pembicara.',
  },
  {
    icon: Sparkle,
    title: 'Ringkasan & tugas',
    body: 'AI mengekstrak ringkasan rapat dan action items per orang siap di-delegasikan.',
  },
  {
    icon: ListChecks,
    title: 'Tugas tertuntaskan',
    body: 'Tiap anggota tim punya link pribadi: semua tugasnya lintas rapat, bisa diceklis.',
  },
]

function FeaturesSlide() {
  return (
    <div>
      <motion.p
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="eyebrow mb-3"
      >
        Apa yang Rekapin lakuin
      </motion.p>
      <motion.h2
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06 }}
        className="text-3xl sm:text-4xl tracking-tightest font-semibold leading-tight text-navy"
      >
        Rapat jadi dokumentasi.
        <br />
        Dokumentasi jadi tindakan.
      </motion.h2>

      <div className="mt-8 space-y-3">
        {FEATURES.map((f, i) => {
          const Icon = f.icon
          return (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + i * 0.1, type: 'spring', stiffness: 240, damping: 22 }}
              className="card p-4 flex items-start gap-3.5"
            >
              <div className="grid place-items-center w-10 h-10 rounded-xl bg-brand-soft text-brand-deep flex-shrink-0">
                <Icon size={20} weight="duotone" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-ink text-[15px]">{f.title}</p>
                <p className="text-[13px] text-ink-muted leading-relaxed mt-0.5">{f.body}</p>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

function PersonalizeSlide({
  nickname,
  setNickname,
  initials,
}: {
  nickname: string
  setNickname: (v: string) => void
  initials: string
}) {
  return (
    <div className="text-center">
      <motion.p
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="eyebrow mb-3"
      >
        Personalisasi
      </motion.p>
      <motion.h2
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06 }}
        className="text-3xl sm:text-4xl tracking-tightest font-semibold leading-tight text-navy"
      >
        Siapa nama panggilanmu?
      </motion.h2>
      <p className="mt-3 text-sm text-ink-muted">
        Kami pakai ini untuk menyapa dan menyesuaikan pengalamanmu.
      </p>

      <div className="mt-8 mb-8">
        <PersonalBadge initials={initials || '?'} name={nickname} />
      </div>

      <input
        type="text"
        value={nickname}
        onChange={(e) => setNickname(e.target.value)}
        autoFocus
        placeholder="Contoh: Dinda"
        className="input text-center !text-lg !py-4 max-w-xs mx-auto"
        maxLength={60}
      />
    </div>
  )
}

function PersonalBadge({
  initials,
  name,
  className = 'mx-auto',
}: {
  initials: string
  name: string
  className?: string
}) {
  return (
    <svg width="160" height="160" viewBox="0 0 160 160" fill="none" className={className}>
      <defs>
        <linearGradient id="badgeBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1E1B4B" />
          <stop offset="1" stopColor="#4F46E5" />
        </linearGradient>
      </defs>
      <motion.circle
        cx="80"
        cy="80"
        r="74"
        fill="none"
        stroke="#6366F1"
        strokeWidth="1.5"
        strokeDasharray="3 7"
        initial={{ rotate: 0 }}
        animate={{ rotate: 360 }}
        transition={{ duration: 24, ease: 'linear', repeat: Infinity }}
        style={{ transformOrigin: '80px 80px' }}
        opacity="0.5"
      />
      <motion.path
        d="M 30 80 A 50 50 0 0 1 80 30"
        fill="none"
        stroke="#818CF8"
        strokeWidth="3"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, ease: 'easeInOut' }}
      />
      <motion.rect
        x="30"
        y="30"
        width="100"
        height="100"
        rx="30"
        fill="url(#badgeBg)"
        initial={{ scale: 0.85 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 18 }}
        style={{ transformOrigin: '80px 80px' }}
      />
      <rect x="30" y="30" width="100" height="100" rx="30" fill="none" stroke="#FFFFFF" strokeOpacity="0.12" />
      <motion.text
        key={initials}
        x="80"
        y="80"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Geist Sans, sans-serif"
        fontWeight="700"
        fontSize={initials.length > 1 ? 44 : 56}
        fill="#FFFFFF"
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 280, damping: 18 }}
        style={{ transformOrigin: '80px 80px' }}
      >
        {initials || '?'}
      </motion.text>
      <motion.text
        key={name}
        x="80"
        y="146"
        textAnchor="middle"
        fontFamily="Geist Sans, sans-serif"
        fontWeight="500"
        fontSize="10"
        fill="#475569"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.15 }}
      >
        {name ? name.toUpperCase() : ''}
      </motion.text>
    </svg>
  )
}

function AccountSlide({
  nickname,
  error,
  submitting,
  onGoogleSignIn,
}: {
  nickname: string
  error: string | null
  submitting: boolean
  onGoogleSignIn: () => void
}) {
  return (
    <div className="text-center">
      <motion.h2
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="mx-auto max-w-sm text-balance text-2xl sm:text-3xl tracking-tightest font-semibold leading-tight text-navy"
      >
        {nickname ? `Halo, ${nickname}` : 'Masuk ke Rekapin'}
      </motion.h2>
      <p className="mt-2 text-[13px] text-ink-muted">
        Pastikan login dengan @piranusa.com atau @contrivent.com
      </p>

      <div className="mt-8">
        <button
          onClick={onGoogleSignIn}
          disabled={submitting}
          className="btn-ghost w-full justify-center gap-3 py-3 border border-slate-200 hover:bg-slate-50 max-w-xs mx-auto"
        >
          {submitting ? (
            <span className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
              <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
              <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
              <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
            </svg>
          )}
          {submitting ? 'Memproses...' : 'Masuk dengan Google'}
        </button>
      </div>

      {error && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 flex items-center gap-2 rounded-xl bg-red-50 border border-red-100 px-3 py-2.5 text-xs text-red-700 max-w-xs mx-auto"
        >
          <WarningCircle size={14} weight="fill" />
          {error}
        </motion.div>
      )}
    </div>
  )
}
