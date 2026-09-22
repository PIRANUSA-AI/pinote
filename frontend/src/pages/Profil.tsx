import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  SignOut,
  ShieldStar,
  Clock,
  Files,
  CurrencyDollar,
  Link as LinkIcon,
  CheckCircle,
  Copy,
  PencilSimple,
  Microphone,
  ListChecks,
  Check,
  ArrowLeft,
  Plus,
  BellRinging,
  X,
  User,
  At,
  Envelope,
} from '@phosphor-icons/react'
import { ApiError, api, type UserStats, type Reminder } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { formatDuration, formatRelativeTime } from '../lib/format'

const USD_TO_IDR = 16_000

interface PlaygroundTask {
  id: string; owner: string; task: string; due: string | null; done: boolean; order: number; createdAt: string
}

export default function Profil() {
  const { user, refresh } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const viewUser = searchParams.get('user')

  const [stats, setStats] = useState<UserStats | null>(null)
  const [taskToken, setTaskToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [displayName, setDisplayName] = useState(user?.displayName ?? user?.username ?? '')
  const [savingName, setSavingName] = useState(false)
  const [userTasks, setUserTasks] = useState<PlaygroundTask[] | null>(null)
  const [knownUsers, setKnownUsers] = useState<string[]>([])
  const [userNotFound, setUserNotFound] = useState(false)

  const [reminders, setReminders] = useState<Reminder[]>([])

  const [aliases, setAliases] = useState<string[]>([])
  const [aliasInput, setAliasInput] = useState('')
  const [savingAliases, setSavingAliases] = useState(false)

  const [ccEmails, setCcEmails] = useState<string[]>([])
  const [ccInput, setCcInput] = useState('')
  const [savingEmails, setSavingEmails] = useState(false)

  const [editingUsername, setEditingUsername] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [savingUsername, setSavingUsername] = useState(false)
  const [usernameChanges, setUsernameChanges] = useState(0)

  useEffect(() => {
    api.get<{ users: Array<{ username: string; displayName: string | null }> }>('/playground/users')
      .then((r) => setKnownUsers(r.users.map((u) => u.username)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (viewUser && viewUser !== user?.username && viewUser !== user?.displayName) {
      if (knownUsers.length > 0) {
        const exists = knownUsers.some((u) => u === viewUser)
        if (!exists) { setUserNotFound(true); setUserTasks([]); return }
        setUserNotFound(false)
      }
      api.get<{ tasks: PlaygroundTask[] }>(`/playground/tasks?owner=${encodeURIComponent(viewUser)}`)
        .then((r) => setUserTasks(r.tasks))
        .catch(() => setUserTasks([]))
    } else {
      setUserTasks(null)
      setUserNotFound(false)
    }
  }, [viewUser, user, knownUsers])

  useEffect(() => {
    if (!viewUser) {
      refresh()
      api.get<UserStats>('/auth/me/stats').then(setStats).catch(() => {})
      api.get<{ reminders: Reminder[] }>('/reminders').then((r) => setReminders(r.reminders)).catch(() => {})
      api.get<{ aliases: string[] }>('/auth/me/aliases').then((r) => setAliases(r.aliases)).catch(() => {})
      api.get<{ primary: string; cc: string[] }>('/auth/me/emails').then((r) => setCcEmails(r.cc)).catch(() => {})
    }
  }, [refresh, viewUser])

  const handleCreateLink = async () => {
    try {
      const res = await api.post<{ taskShareToken: string }>('/auth/me/task-token')
      setTaskToken(res.taskShareToken)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal membuat tautan', 'error')
    }
  }

  const handleCopyLink = async () => {
    if (!taskToken) return
    await navigator.clipboard.writeText(`${window.location.origin}/tasks/${taskToken}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleSaveName = async () => {
    setSavingName(true)
    try {
      await api.patch('/auth/me/display-name', { displayName })
      await refresh()
      setEditingName(false)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Gagal menyimpan', 'error')
    } finally {
      setSavingName(false)
    }
  }

  const handleDismissReminder = async (id: string) => {
    try {
      await api.patch(`/reminders/${id}/dismiss`)
      setReminders((prev) => prev.filter((r) => r.id !== id))
    } catch {
      // ignore
    }
  }

  const handleUsernameChange = async () => {
    if (!newUsername.trim()) return
    setSavingUsername(true)
    try {
      const res = await api.patch<{ username: string; usernameChanges: number }>('/auth/me/username', { username: newUsername.trim() })
      setUsernameChanges(res.usernameChanges)
      setEditingUsername(false)
      await refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Gagal ganti username', 'error')
    } finally {
      setSavingUsername(false)
    }
  }

  const handleAddAlias = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const a = aliasInput.trim().toLowerCase()
    if (!a || aliases.includes(a) || aliases.length >= 15) return
    setAliases([...aliases, a])
    setAliasInput('')
  }

  const handleRemoveAlias = (a: string) => {
    setAliases(aliases.filter((x) => x !== a))
  }

  const handleSaveAliases = async () => {
    setSavingAliases(true)
    try {
      await api.patch('/auth/me/aliases', { aliases })
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Gagal simpan variasi nama', 'error')
    } finally {
      setSavingAliases(false)
    }
  }

  const handleAddCc = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const email = ccInput.trim()
    if (!email || !email.includes('@') || ccEmails.includes(email) || ccEmails.length >= 3) return
    setCcEmails([...ccEmails, email])
    setCcInput('')
  }

  const handleRemoveCc = (email: string) => {
    setCcEmails(ccEmails.filter((e) => e !== email))
  }

  const handleSaveEmails = async () => {
    setSavingEmails(true)
    try {
      await api.patch('/auth/me/emails', { cc: ccEmails })
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Gagal simpan email', 'error')
    } finally {
      setSavingEmails(false)
    }
  }

  if (!user) return null

  const initials = (user.displayName ?? user.username)
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="mx-auto max-w-3xl px-4 md:px-8 pt-8 md:pt-12 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-32">
      {/* Reminder cards */}
      {!viewUser && reminders.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 space-y-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <BellRinging size={16} weight="fill" className="text-amber-600" />
            <p className="text-sm font-semibold text-ink-muted uppercase tracking-wide">Pengingat</p>
          </div>
          {reminders.map((r) => (
            <motion.div
              key={r.id}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              className="card p-4 border-l-4 border-l-amber-400 bg-amber-50/30"
            >
              <div className="flex items-start gap-3">
                <div className="grid place-items-center w-8 h-8 rounded-lg bg-amber-100 text-amber-700 shrink-0">
                  <BellRinging size={15} weight="fill" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink leading-relaxed">
                    {r.message.split(/(@\w+)/g).map((part, i) =>
                      part.startsWith('@') ? (
                        <span key={i} className="inline-flex items-center gap-0.5 text-brand-deep bg-brand-soft font-medium px-1.5 py-0.5 rounded text-[12px] -mx-0.5">
                          {part}
                        </span>
                      ) : (
                        part
                      )
                    )}
                  </p>
                  <p className="text-[11px] text-ink-muted mt-1">
                    Tugas: {r.task}
                  </p>
                </div>
                <button
                  onClick={() => handleDismissReminder(r.id)}
                  className="grid place-items-center w-7 h-7 rounded-md text-slate-400 hover:text-ink hover:bg-slate-100 shrink-0"
                  aria-label="Tutup pengingat"
                >
                  <X size={13} />
                </button>
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* Identity card */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="card-navy p-6 md:p-8 mb-6 relative overflow-hidden"
      >
        <div className="absolute inset-0 grid-pattern opacity-30 pointer-events-none" />
        <div className="relative flex items-center gap-4">
          <div className="grid place-items-center w-16 h-16 rounded-2xl bg-white/15 backdrop-blur text-white font-display font-semibold text-2xl flex-shrink-0">
            {viewUser ? viewUser[0].toUpperCase() : initials}
          </div>
          <div className="min-w-0 flex-1">
            {viewUser ? (
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">@{viewUser}</h1>
                <p className="text-sm text-white/60 mt-0.5">Tugas yang ditugaskan ke {viewUser}</p>
              </div>
            ) : editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Nama tampilan"
                  className="bg-white/15 text-white placeholder-white/50 rounded-lg px-3 py-1.5 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-white/30 max-w-[60%]"
                  maxLength={80}
                  autoFocus
                />
                <button
                  onClick={handleSaveName}
                  disabled={savingName || !displayName.trim()}
                  className="grid place-items-center w-8 h-8 rounded-lg bg-white text-navy disabled:opacity-40"
                >
                  <CheckCircle size={16} weight="fill" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-white truncate">
                  {user.displayName ?? user.username}
                </h1>
                <button
                  onClick={() => setEditingName(true)}
                  className="grid place-items-center w-7 h-7 rounded-md text-white/60 hover:text-white hover:bg-white/10"
                  aria-label="Edit nama tampilan"
                >
                  <PencilSimple size={14} />
                </button>
              </div>
            )}
            {!viewUser && <p className="text-sm text-white/60 mt-0.5">@{user.username}</p>}
            {!viewUser && user.isAdmin && (
              <span className="inline-flex items-center gap-1 mt-2 chip bg-white/15 text-white">
                <ShieldStar size={11} weight="fill" /> Admin
              </span>
            )}
          </div>
        </div>
      </motion.div>

      {!viewUser && (
        <>
          {stats ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6"
            >
              <StatTile
                icon={Microphone}
                label="Total transkrip"
                value={String(stats.totalJobs)}
                valueSize="2xl"
                color="brand"
                badge={stats.totalJobs > 0 ? `${Math.round(stats.latestDurationSec / 60)}m terakhir` : undefined}
              />
              <StatTile
                icon={Clock}
                label="Total durasi"
                value={formatDuration(stats.totalDurationSec)}
                valueSize="2xl"
                color="emerald"
              />
              <StatTile
                icon={CurrencyDollar}
                label="Estimasi biaya"
                value={`Rp${Math.round(stats.estimatedCostUSD * USD_TO_IDR).toLocaleString('id-ID')}`}
                valueSize="xl"
                color="violet"
              />
            </motion.div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="card p-4">
                  <div className="skeleton h-9 w-9 rounded-xl mb-3" />
                  <div className="skeleton h-8 w-24 rounded mb-1" />
                  <div className="skeleton h-3 w-16 rounded" />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Tasks of viewed user */}
      {viewUser && userNotFound && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <div className="flex items-center gap-2.5 mb-3">
            <button onClick={() => navigate(-1)} className="btn-soft text-xs !py-1.5 !px-2.5 gap-1.5">
              <ArrowLeft size={12} /> Kembali
            </button>
          </div>
          <div className="card p-10 text-center">
            <div className="grid place-items-center w-12 h-12 rounded-2xl bg-red-50 border border-red-100 mx-auto mb-3">
              <span className="text-red-500 text-xl font-bold">?</span>
            </div>
            <p className="text-sm font-semibold text-ink mb-1">User tidak ditemukan</p>
            <p className="text-xs text-ink-muted mb-4">@{viewUser} belum terdaftar sebagai anggota tim.</p>
            {user?.isAdmin && (
              <Link to="/admin" className="btn-primary text-xs gap-1.5">
                <Plus size={13} weight="bold" /> Buat user baru
              </Link>
            )}
          </div>
        </motion.div>
      )}
      {viewUser && !userNotFound && userTasks !== null && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <div className="flex items-center gap-2.5 mb-3">
            <button onClick={() => navigate(-1)} className="btn-soft text-xs !py-1.5 !px-2.5 gap-1.5">
              <ArrowLeft size={12} /> Kembali
            </button>
            <p className="text-sm text-ink-muted">Tugas untuk <span className="font-semibold text-navy">@{viewUser}</span></p>
            <span className="text-xs text-ink-muted ml-auto">{userTasks.length} tugas</span>
          </div>
          <div className="card overflow-hidden">
            {userTasks.length === 0 ? (
              <div className="p-8 text-center text-sm text-ink-muted">
                <ListChecks size={28} className="mx-auto text-slate-300 mb-2" weight="duotone" />
                Belum ada tugas untuk @{viewUser}.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {userTasks.map((t) => (
                  <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                    <span className={`mt-0.5 grid place-items-center w-5 h-5 rounded-md border flex-shrink-0 ${
                      t.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300'
                    }`}>
                      {t.done && <Check size={12} weight="bold" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${t.done ? 'line-through text-slate-400' : 'text-ink'}`}>{t.task}</p>
                      {t.due && <span className="text-[11px] text-ink-muted">Tenggat: {t.due}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </motion.div>
      )}

      {!viewUser && (
        <>
          <div className="card p-5 mb-3">
            <div className="flex items-start gap-3">
              <div className="grid place-items-center w-10 h-10 rounded-xl bg-brand-soft text-brand-deep flex-shrink-0">
                <LinkIcon size={18} weight="duotone" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-[15px]">Tautan tugas pribadi</p>
                <p className="text-[13px] text-ink-muted leading-relaxed mt-0.5">
                Bagikan tautan ini agar orang lain bisa lihat semua tugasmu tanpa login.
                </p>
                {taskToken ? (
                  <div className="mt-3 flex items-center gap-2">
                    <code className="flex-1 truncate rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600 font-mono select-all">
                      {window.location.origin}/tasks/{taskToken}
                    </code>
                    <button
                      onClick={handleCopyLink}
                      className={`btn-soft text-xs !py-2 !px-3 flex-shrink-0 ${copied ? '!bg-emerald-50 !text-emerald-600 !border-emerald-200' : ''}`}
                    >
                      {copied ? <CheckCircle size={13} weight="fill" /> : <Copy size={13} />}
                      {copied ? 'Tersalin' : 'Salin'}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleCreateLink}
                    className="btn-soft mt-3 text-xs !py-2 !px-3"
                  >
                    <LinkIcon size={13} />
                    Buat tautan
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Username */}
          <div className="card p-5 mb-3">
            <div className="flex items-start gap-3">
              <div className="grid place-items-center w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex-shrink-0">
                <At size={18} weight="duotone" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-[15px]">Username</p>
                <p className="text-[13px] text-ink-muted mt-0.5">@{user.username}</p>
                {editingUsername ? (
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="text"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      className="input flex-1"
                      placeholder="Username baru"
                      maxLength={64}
                      autoFocus
                    />
                    <button onClick={handleUsernameChange} disabled={savingUsername || !newUsername.trim()} className="btn-primary text-xs !py-2">
                      {savingUsername ? '...' : 'Simpan'}
                    </button>
                    <button onClick={() => setEditingUsername(false)} className="btn-ghost text-xs !py-2">
                      Batal
                    </button>
                  </div>
                ) : (
                  <button onClick={() => { setNewUsername(user.username); setEditingUsername(true) }} className="btn-soft mt-3 text-xs !py-2 !px-3">
                    <PencilSimple size={12} />
                    Ganti username
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Name Aliases */}
          <div className="card p-5 mb-3">
            <div className="flex items-start gap-3">
              <div className="grid place-items-center w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex-shrink-0">
                <User size={18} weight="duotone" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-[15px]">Variasi Nama</p>
                <p className="text-[13px] text-ink-muted leading-relaxed mt-0.5">
                  Biar AI tetap bisa kenali lo meskipun nama lo disebut beda di rapat.
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {aliases.map((a) => (
                    <span key={a} className="inline-flex items-center gap-1.5 chip bg-amber-50 text-amber-700 border border-amber-200 text-xs">
                      {a}
                      <button onClick={() => handleRemoveAlias(a)} className="hover:text-amber-900">&times;</button>
                    </span>
                  ))}
                  {aliases.length < 15 && (
                    <input
                      type="text"
                      value={aliasInput}
                      onChange={(e) => setAliasInput(e.target.value)}
                      onKeyDown={handleAddAlias}
                      placeholder="Tambah variasi..."
                      className="text-xs bg-transparent border-0 outline-none px-1 py-1 w-28 placeholder:text-slate-300"
                    />
                  )}
                </div>
                {aliases.length > 0 && (
                  <button onClick={handleSaveAliases} disabled={savingAliases} className="btn-soft mt-3 text-xs !py-2">
                    {savingAliases ? 'Menyimpan...' : 'Simpan variasi nama'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Email CC */}
          <div className="card p-5 mb-3">
            <div className="flex items-start gap-3">
              <div className="grid place-items-center w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex-shrink-0">
                <Envelope size={18} weight="duotone" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-[15px]">Pengaturan Email</p>
                <p className="text-[13px] text-ink-muted mt-0.5">
                  Tugas akan dikirim ke email utama dan tambahan.
                </p>
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="chip bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs">Utama</span>
                    <span className="text-ink-muted text-xs">{user.email || 'Belum ada email'}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {ccEmails.map((e) => (
                      <span key={e} className="inline-flex items-center gap-1.5 chip bg-slate-100 text-slate-600 text-xs">
                        {e}
                        <button onClick={() => handleRemoveCc(e)} className="hover:text-red-500">&times;</button>
                      </span>
                    ))}
                    {ccEmails.length < 3 && (
                      <input
                        type="email"
                        value={ccInput}
                        onChange={(e) => setCcInput(e.target.value)}
                        onKeyDown={handleAddCc}
                        placeholder="cc@email.com"
                        className="text-xs bg-transparent border-0 outline-none px-1 py-1 w-32 placeholder:text-slate-300"
                      />
                    )}
                  </div>
                </div>
                {ccEmails.length > 0 && (
                  <button onClick={handleSaveEmails} disabled={savingEmails} className="btn-soft mt-3 text-xs !py-2">
                    {savingEmails ? 'Menyimpan...' : 'Simpan email CC'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {stats?.memberSince && (
            <p className="text-xs text-slate-400 px-1 mb-4 tabular">
              Bergabung {formatRelativeTime(stats.memberSince)}
            </p>
          )}

          {user.isAdmin && (
            <Link to="/admin" className="card p-4 mb-3 flex items-center gap-3 hover:bg-paper transition-colors">
              <div className="grid place-items-center w-10 h-10 rounded-xl bg-navy text-white flex-shrink-0">
                <ShieldStar size={18} weight="fill" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-ink">Panel Admin</p>
                <p className="text-xs text-ink-muted">Kelola user, kredit, dan analytics tim.</p>
              </div>
            </Link>
          )}
        </>
      )}
    </div>
  )
}

function StatTile({
  icon: Icon,
  label,
  value,
  valueSize,
  color,
  badge,
}: {
  icon: typeof Microphone
  label: string
  value: string
  valueSize?: 'xl' | '2xl'
  color: 'amber' | 'brand' | 'emerald' | 'violet'
  badge?: string
}) {
  const colors = {
    amber: { bg: 'bg-amber-50', icon: 'text-amber-600', accent: 'bg-amber-100', bar: 'bg-amber-200' },
    brand: { bg: 'bg-brand-soft', icon: 'text-brand-deep', accent: 'bg-brand/10', bar: 'bg-brand/20' },
    emerald: { bg: 'bg-emerald-50', icon: 'text-emerald-600', accent: 'bg-emerald-100', bar: 'bg-emerald-200' },
    violet: { bg: 'bg-violet-50', icon: 'text-violet-600', accent: 'bg-violet-100', bar: 'bg-violet-200' },
  }
  const c = colors[color]
  return (
    <div className={`card p-4 sm:p-5 relative overflow-hidden ${c.bg}/40`}>
      <div className={`absolute top-0 right-0 w-24 h-24 rounded-full -translate-y-1/2 translate-x-1/2 ${c.accent}`} />
      <div className="relative flex items-start justify-between">
        <div className={`grid place-items-center w-10 h-10 rounded-xl ${c.bg} ${c.icon}`}>
          <Icon size={18} weight="duotone" />
        </div>
      </div>
      <p className={`relative mt-4 font-bold text-ink tabular leading-none tracking-tight ${
        valueSize === '2xl' ? 'text-[28px] md:text-[32px]' : 'text-xl md:text-2xl'
      }`}>
        {value}
      </p>
      <p className="relative text-[12px] text-ink-muted font-medium mt-1.5">{label}</p>
      {badge && (
        <span className={`relative inline-block mt-2 text-[10px] font-semibold ${c.icon} ${c.accent} px-2 py-0.5 rounded-full`}>
          {badge}
        </span>
      )}
    </div>
  )
}
