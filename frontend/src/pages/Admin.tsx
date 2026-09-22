import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Plus,
  Trash,
  Key,
  ShieldStar,
  User as UserIcon,
  CheckCircle,
  Clipboard,
  Link as LinkIcon,
  ChartLineUp,
  Files,
  Clock,
  CheckSquare,
  Users as UsersIcon,
  WarningCircle,
  ListChecks,
  CurrencyDollar,
} from '@phosphor-icons/react'
import { ApiError, api, type ManagedUser } from '../lib/api'
import { formatRelativeTime, formatDuration } from '../lib/format'
import { useAuth } from '../hooks/useAuth'
import { LineChart, BarChart, DonutProgress } from '../components/charts'
import { useToast } from '../components/Toast'

interface Overview {
  users: number
  admins: number
  jobs: number
  completedJobs: number
  failedJobs: number
  completionRate: number
  totalDurationSec: number
  actionItems: number
  actionItemsDone: number
  actionItemsCompletionRate: number
}
interface TrendPoint { date: string; count: number; duration: number }
interface TopUser {
  id?: string
  username: string
  displayName: string | null
  jobsCompleted: number
  totalDuration: number
}
interface Failure {
  id: string
  filename: string
  error_message: string | null
  created_at: string
  username: string
}

interface CostData {
  totalDurationSec: number; totalJobs: number; estimatedCostUSD: number; range: string
}

const COST_RANGE_OPTIONS = [
  { key: 'day', label: 'Hari' },
  { key: 'week', label: 'Minggu' },
  { key: 'month', label: 'Bulan' },
  { key: 'year', label: 'Tahun' },
  { key: 'all', label: 'Semua' },
] as const

const TREND_DAYS_OPTIONS = [
  { key: 7, label: '7 hari' },
  { key: 30, label: '30 hari' },
  { key: 90, label: '90 hari' },
  { key: 365, label: '1 tahun' },
] as const

export default function Admin() {
  const { user: self } = useAuth()
  const { toast } = useToast()
  const [users, setUsers] = useState<ManagedUser[] | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [trendDays, setTrendDays] = useState(30)
  const [topUsers, setTopUsers] = useState<TopUser[] | null>(null)
  const [failures, setFailures] = useState<Failure[] | null>(null)
  const [costData, setCostData] = useState<CostData | null>(null)
  const [costRange, setCostRange] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [makeAdmin, setMakeAdmin] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const USD_TO_IDR = 16000

  const loadAll = async () => {
    try {
      const [u, o, t, top, f, c] = await Promise.all([
        api.get<{ users: ManagedUser[] }>('/users'),
        api.get<Overview>('/users/stats/overview'),
        api.get<{ points: TrendPoint[] }>(`/users/stats/jobs-trend?days=${trendDays}`),
        api.get<{ users: TopUser[] }>('/users/stats/top-users?limit=6'),
        api.get<{ failures: Failure[] }>('/users/stats/recent-failures?limit=5'),
        api.get<CostData>(`/users/stats/cost-overview?range=${costRange}`),
      ])
      setUsers(u.users)
      setOverview(o)
      setTrend(t.points)
      setTopUsers(top.users)
      setFailures(f.failures)
      setCostData(c)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data admin')
    }
  }

  useEffect(() => {
    void loadAll()
  }, [trendDays, costRange])

  const flashSuccess = (msg: string) => {
    setFlash(msg)
    setTimeout(() => setFlash(null), 2500)
  }

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      await api.post('/users', {
        username: newUsername.trim(),
        password: newPassword,
        isAdmin: makeAdmin,
        displayName: newDisplayName.trim() || undefined,
      })
      setNewUsername('')
      setNewPassword('')
      setNewDisplayName('')
      setMakeAdmin(false)
      await loadAll()
      flashSuccess(`User "${newUsername}" dibuat`)
    } catch (err) {
      if (err instanceof ApiError) setCreateError(err.message)
      else setCreateError('Gagal membuat user')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (u: ManagedUser) => {
    if (u.id === self?.id) {
      toast('Tidak bisa hapus akun sendiri', 'error')
      return
    }
    if (!confirm(`Hapus user "${u.username}"? Semua transkripnya juga akan terhapus.`)) return
    try {
      await api.delete(`/users/${u.id}`)
      await loadAll()
      flashSuccess(`User "${u.username}" dihapus`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal menghapus', 'error')
    }
  }

  const handleResetPassword = async (u: ManagedUser) => {
    const np = prompt(`Password baru untuk "${u.username}":`)
    if (!np || np.length < 8) {
      if (np !== null) toast('Password minimal 8 karakter', 'error')
      return
    }
    try {
      await api.patch(`/users/${u.id}/password`, { newPassword: np })
      flashSuccess(`Password "${u.username}" direset`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal reset password', 'error')
    }
  }

  const handleCopyTaskLink = async (u: ManagedUser) => {
    try {
      if (!u.taskShareToken) {
        const res = await api.post<{ taskPath: string }>(`/users/${u.id}/task-token`)
        await loadAll()
        await navigator.clipboard.writeText(`${window.location.origin}${res.taskPath}`)
      } else {
        await navigator.clipboard.writeText(`${window.location.origin}/tasks/${u.taskShareToken}`)
      }
      flashSuccess(`Link tugas "${u.username}" disalin`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal membuat link tugas', 'error')
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 md:px-8 pt-8 md:pt-12 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-32">
      <header className="mb-8">
        <p className="eyebrow mb-2">Admin</p>
        <h1 className="text-3xl md:text-4xl tracking-tightest font-semibold text-navy">
          Dashboard Tim
        </h1>
        <p className="mt-2 text-sm text-ink-muted max-w-md leading-relaxed">
          Kelola user, monitor penggunaan, dan pastikan tim tertuntaskan.
        </p>
        <Link
          to="/admin/playground"
          className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-brand-deep hover:text-brand bg-brand-soft px-3 py-2 rounded-lg transition-colors"
        >
          <ListChecks size={14} weight="bold" />
          Playground Tugas
        </Link>
      </header>

      {flash && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 flex items-center gap-2 rounded-xl bg-navy text-white px-4 py-2.5 text-sm"
        >
          <CheckCircle weight="fill" size={16} />
          {flash}
        </motion.div>
      )}

      {error && <p className="text-sm text-red-600 mb-6">{error}</p>}

      {/* Analytics overview */}
      {overview && (
        <section className="mb-8" aria-label="Analytics">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="grid place-items-center w-8 h-8 rounded-lg bg-navy text-white">
                <ChartLineUp size={15} weight="fill" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-navy">Ringkasan tim</h2>
                <p className="text-[11px] text-ink-muted">30 hari terakhir</p>
              </div>
            </div>
            <p className="text-[11px] text-ink-muted tabular">
              <span className="text-navy font-semibold">{overview.completionRate}%</span> sukses
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard icon={UsersIcon} label="Anggota" value={String(overview.users)} sub={`${overview.admins} admin`} color="navy" />
            <StatCard icon={Files} label="Total transkrip" value={String(overview.jobs)} sub={`${overview.completedJobs} selesai`} color="brand" />
            <StatCard icon={Clock} label="Total durasi" value={formatDuration(overview.totalDurationSec)} color="emerald" />
            <StatCard icon={CheckSquare} label="Action items" value={String(overview.actionItems)} sub={`${overview.actionItemsDone} selesai`} color="violet" />
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            {/* Jobs trend line */}
            <div className="card p-5 md:col-span-2">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  Transkrip per hari
                </p>
                <div className="flex items-center gap-1">
                  {TREND_DAYS_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setTrendDays(opt.key)}
                      className={`text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${
                        trendDays === opt.key
                          ? 'bg-navy text-white'
                          : 'text-ink-muted hover:bg-slate-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-2xl font-semibold text-navy tabular mb-3">
                {trend ? trend.reduce((a, b) => a + b.count, 0) : '—'}
                <span className="text-sm text-ink-muted font-normal ml-2">rapat</span>
              </p>
              {trend && <LineChart points={trend} label="Tren transkrip" />}
            </div>

            {/* Completion donut */}
            <div className="card p-5 flex flex-col items-center justify-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3 self-start">
                Action items selesai
              </p>
              <DonutProgress
                value={overview.actionItemsCompletionRate}
                label="selesai"
                color="#6366F1"
              />
              <p className="text-[11px] text-ink-muted mt-3 tabular text-center">
                {overview.actionItemsDone} dari {overview.actionItems} tugas
              </p>
            </div>
          </div>

          {/* Cost overview */}
          {costData && (
            <div className="mt-3">
              <div className="card p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="grid place-items-center w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600">
                      <CurrencyDollar size={13} weight="fill" />
                    </div>
                    <p className="text-xs font-semibold text-navy">Estimasi biaya</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {COST_RANGE_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() => setCostRange(opt.key)}
                        className={`text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${
                          costRange === opt.key
                            ? 'bg-emerald-600 text-white'
                            : 'text-ink-muted hover:bg-slate-100'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <div>
                    <p className="text-[11px] text-ink-muted font-medium">Total biaya</p>
                    <p className="text-xl sm:text-2xl font-bold text-navy tabular mt-0.5">
                      Rp{Math.round(costData.estimatedCostUSD * USD_TO_IDR).toLocaleString('id-ID')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-ink-muted font-medium">Total transkrip</p>
                    <p className="text-xl sm:text-2xl font-bold text-navy tabular mt-0.5">
                      {costData.totalJobs}
                      <span className="text-sm font-normal text-ink-muted ml-1">file</span>
                    </p>
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <p className="text-[11px] text-ink-muted font-medium">Total durasi</p>
                    <p className="text-xl sm:text-2xl font-bold text-navy tabular mt-0.5">
                      {formatDuration(costData.totalDurationSec)}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Top users + recent failures */}
          <div className="grid md:grid-cols-2 gap-3 mt-3">
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="grid place-items-center w-7 h-7 rounded-lg bg-amber-50 text-amber-700">
                  <ChartLineUp size={13} weight="fill" />
                </div>
                <p className="text-xs font-semibold text-navy">Pengguna paling aktif</p>
              </div>
              {topUsers && (
                <BarChart
                  items={topUsers.map((u) => ({
                    label: u.displayName ?? u.username,
                    value: u.jobsCompleted,
                    sub: `· ${formatDuration(u.totalDuration)}`,
                  }))}
                  label="Top user"
                />
              )}
            </div>

            <div className="card p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="grid place-items-center w-7 h-7 rounded-lg bg-red-50 text-red-600">
                  <WarningCircle size={13} weight="fill" />
                </div>
                <p className="text-xs font-semibold text-navy">Kegagalan terbaru</p>
              </div>
              {failures && failures.length === 0 ? (
                <div className="flex flex-col items-center py-6 text-center">
                  <div className="grid place-items-center w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-500 mb-2">
                    <CheckCircle size={20} weight="fill" />
                  </div>
                  <p className="text-sm font-medium text-emerald-700">Semua lancar</p>
                  <p className="text-xs text-ink-muted mt-0.5">Tidak ada job gagal dalam 7 hari terakhir.</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {failures?.slice(0, 5).map((f) => (
                    <li key={f.id} className="flex items-start gap-2.5 p-2 -mx-2 rounded-lg hover:bg-red-50/40 transition-colors">
                      <span className="grid place-items-center w-7 h-7 rounded-lg bg-red-50 text-red-600 flex-shrink-0 mt-0.5">
                        <WarningCircle size={13} weight="fill" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-ink truncate">{f.filename}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[11px] text-ink-muted">@{f.username}</span>
                          <span className="text-slate-300">·</span>
                          <span className="text-[11px] text-ink-muted">{formatRelativeTime(f.created_at)}</span>
                        </div>
                        {f.error_message && (
                          <p className="text-[11px] text-red-600/70 mt-0.5 line-clamp-1">{f.error_message}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Create user */}
      <section className="card p-5 sm:p-7 mb-8">
        <h2 className="text-sm font-semibold mb-4 flex items-center gap-2 text-navy">
          <Plus weight="bold" size={16} /> Tambah anggota
        </h2>
        <form onSubmit={handleCreate} className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label">Username</label>
            <input
              type="text"
              required
              autoCapitalize="none"
              spellCheck={false}
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="input"
              placeholder="contoh: rangga"
            />
          </div>
          <div>
            <label className="label">Nama tampilan</label>
            <input
              type="text"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              className="input"
              placeholder="contoh: Rangga D."
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input"
              placeholder="min. 8 karakter"
            />
          </div>
          <div className="self-end">
            <button
              type="submit"
              disabled={creating || !newUsername || !newPassword}
              className="btn-primary w-full"
            >
              {creating ? 'Membuat…' : 'Tambah'}
            </button>
          </div>
          <label className="sm:col-span-2 lg:col-span-4 flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={makeAdmin}
              onChange={(e) => setMakeAdmin(e.target.checked)}
              className="rounded border-slate-300 text-brand focus:ring-brand/20"
            />
            Jadikan admin (bisa kelola user lain)
          </label>
          {createError && <p className="sm:col-span-2 lg:col-span-4 text-sm text-red-600">{createError}</p>}
        </form>
      </section>

      {/* User list */}
      <section>
        <h2 className="text-sm font-semibold mb-3 px-1 text-navy">Semua anggota</h2>
        {users === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-16 rounded-2xl" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <p className="text-sm text-ink-muted px-1">Belum ada user.</p>
        ) : (
          <ul className="divide-y divide-slate-200/80 border-t border-b border-slate-200/80 bg-surface rounded-xl overflow-hidden">
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-4 py-3 sm:py-4 px-3 sm:px-5 hover:bg-paper transition-colors group">
                <div
                  className={`grid place-items-center w-11 h-11 rounded-xl flex-shrink-0 ${
                    u.isAdmin ? 'bg-navy text-white shadow-sm' : 'bg-brand-soft border border-brand/20 text-brand-deep'
                  }`}
                >
                  {u.isAdmin ? <ShieldStar weight="fill" size={19} /> : <UserIcon size={19} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-[15px] text-ink truncate">
                      {u.displayName ?? u.username}
                    </p>
                    {u.id === self?.id && (
                      <span className="text-[10px] font-medium text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">kamu</span>
                    )}
                    {u.isAdmin && (
                      <span className="text-[10px] font-semibold text-navy bg-navy/10 px-1.5 py-0.5 rounded">admin</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-xs text-ink-muted">@{u.username}</p>
                    <span className="text-slate-300">·</span>
                    <p className="text-xs text-ink-muted">dibuat {formatRelativeTime(u.createdAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 sm:gap-1">
                  <button
                    onClick={() => handleCopyTaskLink(u)}
                    className="grid place-items-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg hover:bg-brand-soft hover:text-brand-deep text-slate-400 transition-colors"
                    title="Salin link tugas"
                  >
                    {u.taskShareToken ? <LinkIcon size={15} /> : <Clipboard size={15} />}
                  </button>
                  <button
                    onClick={() => handleResetPassword(u)}
                    className="grid place-items-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors"
                    title="Reset password"
                  >
                    <Key size={15} />
                  </button>
                  <button
                    onClick={() => handleDelete(u)}
                    disabled={u.id === self?.id}
                    className="grid place-items-center w-8 h-8 sm:w-9 sm:h-9 rounded-lg hover:bg-red-50 hover:text-red-600 text-slate-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Hapus user"
                  >
                    <Trash size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: typeof Clock
  label: string
  value: string
  sub?: string
  color: 'navy' | 'brand' | 'emerald' | 'violet'
}) {
  const colors = {
    navy: { icon: 'bg-navy text-white', accent: 'bg-navy/5', bar: 'bg-navy/15' },
    brand: { icon: 'bg-brand-soft text-brand-deep', accent: 'bg-brand/5', bar: 'bg-brand/15' },
    emerald: { icon: 'bg-emerald-50 text-emerald-600', accent: 'bg-emerald-50', bar: 'bg-emerald-200' },
    violet: { icon: 'bg-violet-50 text-violet-600', accent: 'bg-violet-50', bar: 'bg-violet-200' },
  }
  const c = colors[color]
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`card p-4 sm:p-5 relative overflow-hidden ${c.accent}/40`}
    >
      <div className={`absolute top-0 right-0 w-32 h-32 rounded-full -translate-y-1/2 translate-x-1/3 ${c.accent}`} />
      <div className={`relative grid place-items-center w-10 h-10 rounded-xl ${c.icon} mb-3`}>
        <Icon size={18} weight="duotone" />
      </div>
      <p className="relative text-[28px] sm:text-[32px] font-bold text-navy tabular leading-none tracking-tight">
        {value}
      </p>
      <p className="relative text-xs text-ink-muted font-semibold mt-2">
        {label}
      </p>
      {sub && (
        <p className="relative text-[11px] text-ink-muted/70 mt-0.5 font-medium flex items-center gap-1">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.bar}`} />
          {sub}
        </p>
      )}
    </motion.div>
  )
}
