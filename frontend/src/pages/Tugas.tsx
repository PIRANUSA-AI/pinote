import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Check, WarningCircle, ListChecks, BellRinging } from '@phosphor-icons/react'
import { ApiError, api, type MyTasksResponse, type AdminTasksResponse, type TaskGroupItem } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { LoadingScreen } from '../components/LoadingScreen'
import { DueBadge } from '../components/DueBadge'
import { formatRelativeTime } from '../lib/format'

const CONFIDENCE_THRESHOLD = 0.55
const REMIND_COOLDOWN_MS = 60 * 60 * 1000

export default function Tugas() {
  const { user } = useAuth()
  const isAdmin = user?.isAdmin ?? false

  const [data, setData] = useState<MyTasksResponse | AdminTasksResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hideDone, setHideDone] = useState(false)
  const [remindingId, setRemindingId] = useState<string | null>(null)
  const [remindMsg, setRemindMsg] = useState<{ id: string; message: string } | null>(null)
  const [rateLimited, setRateLimited] = useState<string | null>(null)

  const load = () => {
    setError(null)
    const url = isAdmin ? '/auth/me/tasks?admin=1' : '/auth/me/tasks'
    api
      .get<MyTasksResponse | AdminTasksResponse>(url)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Gagal memuat tugas'))
  }

  useEffect(load, [isAdmin])

  const toggle = async (item: TaskGroupItem, nextDone: boolean) => {
    if (!data || 'isAdminView' in data) return
    setData({
      ...data,
      openCount: data.openCount + (nextDone ? -1 : 1),
      groups: data.groups.map((g) => ({
        ...g,
        items: g.items.map((it) => (it.id === item.id ? { ...it, done: nextDone } : it)),
      })),
    })
    try {
      await api.patch('/auth/me/tasks', { itemId: item.id, done: nextDone })
    } catch {
      load()
    }
  }

  const handleRemind = async (item: TaskGroupItem) => {
    setRemindingId(item.id)
    setRemindMsg(null)
    setRateLimited(null)
    try {
      const res = await api.post<{ id: string; message: string }>(`/reminders/tasks/${item.id}`)
      setRemindMsg({ id: res.id, message: res.message })
      setTimeout(() => setRemindMsg(null), 4000)
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setRateLimited(item.id)
        setTimeout(() => setRateLimited(null), 3000)
      } else {
        const msg = err instanceof ApiError ? err.message : 'Gagal kirim pengingat'
        setError(msg)
      }
    } finally {
      setRemindingId(null)
    }
  }

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 md:px-8 pt-10">
        <p className="text-sm text-red-600">{error}</p>
        <button onClick={load} className="btn-ghost mt-4">Coba lagi</button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 md:px-8 pt-8 md:pt-12 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-32">
        <header className="mb-6 md:mb-8">
          <div className="skeleton h-3 w-20 rounded mb-2" />
          <div className="skeleton h-9 w-48 rounded-lg mb-2" />
          <div className="skeleton h-4 w-36 rounded" />
        </header>
        {[0, 1, 2].map((i) => (
          <div key={i} className="card p-5 mb-3">
            <div className="skeleton h-5 w-1/2 rounded-lg mb-4" />
            <div className="space-y-3">
              <div className="skeleton h-4 w-full rounded" />
              <div className="skeleton h-4 w-3/4 rounded" />
              <div className="skeleton h-4 w-2/3 rounded" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if ('isAdminView' in data && data.isAdminView) {
    const adminData = data as AdminTasksResponse
    const visibleGroups = adminData.groups
      .map((g) => ({ ...g, items: hideDone ? g.items.filter((i) => !i.done) : g.items }))
      .filter((g) => g.items.length > 0)

    return (
      <div className="mx-auto max-w-3xl px-4 md:px-8 pt-8 md:pt-12 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-32">
        <header className="flex items-start justify-between gap-4 mb-6 md:mb-8">
          <div className="min-w-0">
            <p className="eyebrow mb-2">Semua tugas tim</p>
            <h1 className="text-3xl md:text-4xl tracking-tightest font-semibold text-navy">
              Admin View
            </h1>
            <p className="mt-1.5 text-sm text-ink-muted tabular">
              {adminData.totalCount} tugas · {adminData.groups.length} orang
            </p>
          </div>
        </header>

        {remindMsg && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-2.5 text-xs text-emerald-700"
          >
            <BellRinging size={14} weight="fill" className="mt-0.5 shrink-0" />
            <span>{remindMsg.message}</span>
          </motion.div>
        )}

        <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none mb-6">
          <input
            type="checkbox"
            checked={hideDone}
            onChange={(e) => setHideDone(e.target.checked)}
            className="rounded border-slate-300 text-brand focus:ring-brand/20"
          />
          Sembunyikan yang sudah selesai
        </label>

        <div className="space-y-5">
          {visibleGroups.length === 0 ? (
            <div className="card p-12 text-center">
              <ListChecks weight="duotone" size={40} className="mx-auto text-slate-300" />
              <p className="mt-3 text-sm text-ink-muted">Belum ada tugas.</p>
            </div>
          ) : (
            visibleGroups.map((g) => (
              <motion.section
                key={g.owner}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="card p-4 sm:p-5"
              >
                <h2 className="font-semibold text-[15px] text-navy mb-3">{g.owner}</h2>
                <ul className="divide-y divide-slate-100">
                  {g.items.map((it) => (
                    <li key={it.id} className="flex items-start gap-3 py-2.5">
                      <span className={`mt-0.5 grid place-items-center w-5 h-5 rounded-md border flex-shrink-0 ${
                        it.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300'
                      }`}>
                        {it.done && <Check size={12} weight="bold" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm leading-relaxed ${it.done ? 'line-through text-slate-400' : 'text-ink'}`}>
                          {it.task}
                        </p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <DueBadge due={it.due} dueOn={it.dueOn} done={it.done} />
                          {it.confidence < CONFIDENCE_THRESHOLD && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                              <WarningCircle size={10} weight="fill" />
                              Perlu ditinjau
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {rateLimited === it.id && (
                          <span className="text-[10px] text-amber-600 whitespace-nowrap">Tunggu 1 jam</span>
                        )}
                        <button
                          onClick={() => handleRemind(it)}
                          disabled={remindingId === it.id || rateLimited === it.id}
                          className="btn-soft text-[11px] !py-1.5 !px-2.5 gap-1"
                        >
                          {remindingId === it.id ? (
                            <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <BellRinging size={11} weight="bold" />
                          )}
                          Ingatkan
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </motion.section>
            ))
          )}
        </div>
      </div>
    )
  }

  const userData = data as MyTasksResponse
  const visibleGroups = userData.groups
    .map((g) => ({ ...g, items: hideDone ? g.items.filter((i) => !i.done) : g.items }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="mx-auto max-w-3xl px-4 md:px-8 pt-8 md:pt-12 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-32">
      <header className="flex items-start justify-between gap-4 mb-6 md:mb-8">
        <div className="min-w-0">
          <p className="eyebrow mb-2">Tugas saya</p>
          <h1 className="text-3xl md:text-4xl tracking-tightest font-semibold text-navy">
            {userData.user.displayName}
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted tabular">
            {userData.openCount} tugas terbuka · {userData.totalCount} total
          </p>
        </div>
      </header>

      <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none mb-6">
        <input
          type="checkbox"
          checked={hideDone}
          onChange={(e) => setHideDone(e.target.checked)}
          className="rounded border-slate-300 text-brand focus:ring-brand/20"
        />
        Sembunyikan tugas yang sudah selesai
      </label>

      <div className="space-y-5">
        {visibleGroups.length === 0 ? (
          <div className="card p-12 text-center">
            <Check weight="duotone" size={40} className="mx-auto text-emerald-500" />
            <p className="mt-3 text-sm text-ink-muted">
              {userData.totalCount === 0 ? 'Belum ada tugas untuk kamu.' : 'Semua tugas sudah selesai. Mantap!'}
            </p>
          </div>
        ) : (
          visibleGroups.map((g) => (
            <motion.section
              key={g.jobId}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="card p-4 sm:p-5"
            >
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <Link
                  to={`/job/${g.jobId}`}
                  className="font-semibold truncate text-[15px] text-navy hover:text-brand transition-colors"
                >
                  {g.title ?? g.filename}
                </Link>
                <span className="text-[11px] text-slate-400 flex-shrink-0 tabular">
                  {formatRelativeTime(g.completedAt ?? g.createdAt)}
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {g.items.map((it) => (
                  <li key={it.id} className="flex items-start gap-3 py-2.5">
                    <button
                      onClick={() => toggle(it, !it.done)}
                      className={`mt-0.5 grid place-items-center w-5 h-5 rounded-md border flex-shrink-0 transition ${
                        it.done
                          ? 'bg-brand border-brand text-white'
                          : 'border-slate-300 text-transparent hover:border-brand'
                      }`}
                      aria-label={it.done ? 'Tandai belum selesai' : 'Tandai selesai'}
                    >
                      <Check size={12} weight="bold" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm leading-relaxed ${
                          it.done ? 'line-through text-slate-400' : 'text-ink'
                        }`}
                      >
                        {it.task}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <DueBadge due={it.due} dueOn={it.dueOn} done={it.done} />
                        {it.confidence < CONFIDENCE_THRESHOLD && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                            <WarningCircle size={10} weight="fill" />
                            Perlu ditinjau
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </motion.section>
          ))
        )}
      </div>
    </div>
  )
}
