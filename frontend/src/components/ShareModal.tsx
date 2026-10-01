import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Buildings, Check, Copy, LinkBreak, UserPlus, UsersThree, X } from '@phosphor-icons/react'
import { api, type ShareKind } from '../lib/api'
import { useToast } from './Toast'
import { PeoplePicker, loadPeople, personName } from './PeoplePicker'

interface Props {
  open: boolean
  onClose: () => void
  jobId: string
  filename: string
  initialInternal: string | null | undefined
  initialStakeholder: string | null | undefined
  onTokensChange: (next: { shareToken: string | null; shareTokenMom: string | null }) => void
  memberIds: string[]
  onMembersChange: (ids: string[]) => void
}

export function ShareModal({ open, onClose, jobId, filename, initialInternal, initialStakeholder, onTokensChange, memberIds, onMembersChange }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [names, setNames] = useState<string[]>([])

  useEffect(() => {
    if (!open || memberIds.length === 0) {
      setNames([])
      return
    }
    loadPeople()
      .then((people) => setNames(people.filter((p) => memberIds.includes(p.id)).map(personName)))
      .catch(() => setNames([]))
  }, [open, memberIds])

  const saveMembers = async (ids: string[]) => {
    const res = await api.put<{ memberIds: string[] }>(`/jobs/${jobId}/members`, { userIds: ids })
    onMembersChange(res.memberIds)
  }

  return (
    <>
    <PeoplePicker
      open={pickerOpen}
      title="Bagikan ke anggota tim"
      subtitle={filename}
      initial={memberIds}
      onSave={saveMembers}
      onClose={() => setPickerOpen(false)}
    />
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] grid place-items-center p-4">
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
            className="relative bg-paper rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200/70">
              <div className="min-w-0">
                <h2 className="font-semibold text-navy text-[15px]">Bagikan transkrip</h2>
                <p className="text-xs text-ink-muted truncate mt-0.5">{filename}</p>
              </div>
              <button onClick={onClose} className="grid place-items-center w-8 h-8 rounded-md text-slate-400 hover:bg-slate-100 flex-shrink-0">
                <X size={16} weight="bold" />
              </button>
            </div>

            <div className="p-4 space-y-3 max-h-[70dvh] overflow-y-auto">
              <div className="rounded-xl border border-slate-200/80 p-4">
                <div className="flex items-start gap-3">
                  <div className="grid place-items-center w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex-shrink-0">
                    <UserPlus size={20} weight="duotone" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-navy text-sm">Anggota tim</span>
                    <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                      Pilih siapa saja yang boleh membuka rapat ini di akun Pinote mereka. Tidak ada yang dibagikan otomatis.
                    </p>
                    {names.length > 0 && (
                      <p className="text-xs text-navy mt-2 leading-relaxed">{names.join(', ')}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setPickerOpen(true)}
                  className="btn-ghost !text-xs !py-1.5 w-full mt-3 border border-slate-200 hover:border-navy/30"
                >
                  {memberIds.length > 0 ? `Atur anggota (${memberIds.length})` : 'Pilih anggota'}
                </button>
              </div>
              <ShareOption
                kind="internal"
                jobId={jobId}
                initialToken={initialInternal}
                onTokenChange={(token) => onTokensChange({ shareToken: token, shareTokenMom: initialStakeholder ?? null })}
                icon={<UsersThree size={20} weight="duotone" />}
                title="Internal"
                tagline="Akses penuh"
                description="Transkrip lengkap, rekaman audio, ringkasan, dan action items. Cocok untuk tim internal."
                ctaLabel="Buat link Internal"
              />
              <ShareOption
                kind="stakeholder"
                jobId={jobId}
                initialToken={initialStakeholder}
                onTokenChange={(token) => onTokensChange({ shareToken: initialInternal ?? null, shareTokenMom: token })}
                icon={<Buildings size={20} weight="duotone" />}
                title="Stakeholder"
                tagline="Minutes of Meeting"
                description="Hanya MoM — ringkasan rapat dan tindak lanjut dalam format profesional. Tanpa transkrip & tanpa rekaman."
                ctaLabel="Buat link MoM"
              />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
    </>
  )
}

interface OptionProps {
  kind: ShareKind
  jobId: string
  initialToken: string | null | undefined
  onTokenChange: (token: string | null) => void
  icon: React.ReactNode
  title: string
  tagline: string
  description: string
  ctaLabel: string
}

function ShareOption({ kind, jobId, initialToken, onTokenChange, icon, title, tagline, description, ctaLabel }: OptionProps) {
  const [token, setToken] = useState<string | null>(initialToken ?? null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const { toast } = useToast()

  useEffect(() => { setToken(initialToken ?? null) }, [initialToken])

  const linkPath = kind === 'internal' ? `/share/${token}` : `/share/mom/${token}`
  const fullUrl = token ? `${window.location.origin}${linkPath}` : ''

  const create = async () => {
    setLoading(true)
    try {
      const data = await api.post<{ shareToken: string }>(`/jobs/${jobId}/share`, { kind })
      setToken(data.shareToken)
      onTokenChange(data.shareToken)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal membuat link', 'error')
    } finally {
      setLoading(false)
    }
  }

  const revoke = async () => {
    setLoading(true)
    try {
      await api.delete(`/jobs/${jobId}/share?kind=${kind}`)
      setToken(null)
      onTokenChange(null)
      toast('Link dicabut', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal mencabut link', 'error')
    } finally {
      setLoading(false)
    }
  }

  const copy = async () => {
    if (!fullUrl) return
    try {
      await navigator.clipboard.writeText(fullUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast('Gagal menyalin link', 'error')
    }
  }

  const share = async () => {
    if (!fullUrl) return
    if (navigator.share) {
      try { await navigator.share({ title, text: `Minutes of Meeting - Pinote`, url: fullUrl }) } catch { /* aborted */ }
    } else {
      copy()
    }
  }

  return (
    <div className="rounded-xl border border-slate-200/80 p-4">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-navy text-sm">{title}</span>
            <span className="text-[10px] uppercase tracking-wide font-semibold text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded">{tagline}</span>
          </div>
          <p className="text-xs text-ink-muted mt-1 leading-relaxed">{description}</p>
        </div>
      </div>

      <div className="mt-3">
        {token ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 bg-slate-100 rounded-lg pl-3 pr-1 py-1.5">
              <span className="text-xs text-ink-muted truncate flex-1 font-mono">{fullUrl}</span>
              <button onClick={copy} className="grid place-items-center w-7 h-7 rounded-md text-slate-500 hover:bg-white hover:text-navy flex-shrink-0" title="Salin">
                {copied ? <Check size={14} weight="bold" className="text-green-600" /> : <Copy size={14} />}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={share} disabled={loading} className="btn-primary !text-xs !py-1.5 !px-3 flex-1 disabled:opacity-40">
                {copied ? 'Tersalin!' : 'Bagikan'}
              </button>
              <button onClick={revoke} disabled={loading} className="btn-ghost !text-xs !py-1.5 !px-3 text-red-600 hover:bg-red-50 disabled:opacity-40" title="Cabut link">
                <LinkBreak size={14} />
              </button>
            </div>
          </div>
        ) : (
          <button onClick={create} disabled={loading} className="btn-ghost !text-xs !py-1.5 w-full border border-slate-200 hover:border-navy/30 disabled:opacity-40">
            {loading ? 'Memproses...' : ctaLabel}
          </button>
        )}
      </div>
    </div>
  )
}
