import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, MagnifyingGlass, X } from '@phosphor-icons/react'
import { api, type Person } from '../lib/api'
import { useToast } from './Toast'

let peopleRequest: Promise<Person[]> | null = null

export function loadPeople(): Promise<Person[]> {
  if (!peopleRequest) {
    peopleRequest = api
      .get<{ people: Person[] }>('/jobs/people')
      .then((r) => r.people)
      .catch((err) => {
        peopleRequest = null
        throw err
      })
  }
  return peopleRequest
}

export function personName(person: Person): string {
  return person.displayName || person.username
}

interface Props {
  open: boolean
  title: string
  subtitle?: string
  initial: string[]
  onSave: (ids: string[]) => Promise<void>
  onClose: () => void
}

export function PeoplePicker({ open, title, subtitle, initial, onSave, onClose }: Props) {
  const [people, setPeople] = useState<Person[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set(initial))
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    if (!open) return
    setSelected(new Set(initial))
    setQuery('')
    loadPeople()
      .then(setPeople)
      .catch((err) => toast(err instanceof Error ? err.message : 'Gagal memuat daftar user', 'error'))
  }, [open])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = people ?? []
    if (!q) return list
    return list.filter((p) => personName(p).toLowerCase().includes(q) || p.username.toLowerCase().includes(q))
  }, [people, query])

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      await onSave([...selected])
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal menyimpan', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] grid place-items-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            className="relative bg-paper rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[80dvh]"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200/70">
              <div className="min-w-0">
                <h2 className="font-semibold text-navy text-[15px]">{title}</h2>
                {subtitle && <p className="text-xs text-ink-muted truncate mt-0.5">{subtitle}</p>}
              </div>
              <button onClick={onClose} className="grid place-items-center w-8 h-8 rounded-md text-slate-400 hover:bg-slate-100 flex-shrink-0">
                <X size={16} weight="bold" />
              </button>
            </div>

            <div className="px-4 pt-3">
              <label className="flex items-center gap-2 bg-slate-100 rounded-lg px-3 py-2">
                <MagnifyingGlass size={14} className="text-slate-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Cari nama atau username"
                  className="flex-1 bg-transparent text-sm focus:outline-none"
                />
              </label>
            </div>

            <ul className="flex-1 overflow-y-auto px-2 py-2">
              {people === null ? (
                <li className="px-3 py-6 text-center text-xs text-ink-muted">Memuat daftar user...</li>
              ) : visible.length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-ink-muted">Tidak ada user yang cocok</li>
              ) : (
                visible.map((person) => {
                  const on = selected.has(person.id)
                  return (
                    <li key={person.id}>
                      <button
                        onClick={() => toggle(person.id)}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-100 text-left"
                      >
                        <span
                          className={`w-5 h-5 rounded-md border-2 grid place-items-center flex-shrink-0 ${
                            on ? 'bg-brand border-transparent' : 'border-slate-300 bg-white'
                          }`}
                        >
                          {on && <Check size={12} weight="bold" className="text-white" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-navy truncate">{personName(person)}</span>
                          <span className="block text-[11px] text-ink-muted truncate">@{person.username}</span>
                        </span>
                      </button>
                    </li>
                  )
                })
              )}
            </ul>

            <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-200/70">
              <span className="text-xs text-ink-muted tabular">{selected.size} dipilih</span>
              <div className="flex items-center gap-2">
                {selected.size > 0 && (
                  <button onClick={() => setSelected(new Set())} className="btn-ghost !text-xs !py-1.5 !px-3">
                    Kosongkan
                  </button>
                )}
                <button onClick={save} disabled={saving || people === null} className="btn-primary !text-xs !py-1.5 !px-4 disabled:opacity-40">
                  {saving ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
