import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Check,
  Copy,
  PencilSimple,
  Plus,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import type { ActionItem, ActionItemChange } from '../lib/api'
import { api } from '../lib/api'
import { speakerStyle } from '../lib/format'
import { useToast } from '../components/Toast'
import { DueBadge } from './DueBadge'

interface Props {
  jobId: string
  actionItems: ActionItem[]
  speakerNames: Record<string, string>
  readOnly?: boolean
  onChange?: (next: ActionItem[]) => void
  onSpeakerRename?: (speaker: string, name: string) => void
}

const CONFIDENCE_THRESHOLD = 0.55

export function ActionItemsPanel({
  jobId,
  actionItems,
  speakerNames,
  readOnly,
  onChange,
  onSpeakerRename,
}: Props) {
  const [copiedOwner, setCopiedOwner] = useState<string | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [addingForOwner, setAddingForOwner] = useState<string | null>(null)
  const [newTaskText, setNewTaskText] = useState('')
  const [renamingOwner, setRenamingOwner] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const { toast } = useToast()

  const resolveName = (owner: string) => speakerNames[owner] ?? owner

  // Group by owner; preserve first-appearance order across the sorted items.
  const groups = useMemo(() => {
    const map = new Map<string, ActionItem[]>()
    for (const it of [...actionItems].sort((a, b) => a.order - b.order)) {
      const arr = map.get(it.owner) ?? []
      arr.push(it)
      map.set(it.owner, arr)
    }
    return [...map.entries()]
  }, [actionItems])

  if (actionItems.length === 0) return null

  const patch = async (changes: ActionItemChange[]) => {
    if (readOnly) return
    try {
      const res = await api.patch<{ actionItems: ActionItem[] }>(
        `/jobs/${jobId}/action-items`,
        changes
      )
      onChange?.(res.actionItems)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal menyimpan perubahan', 'error')
    }
  }

  const toggle = (item: ActionItem) => {
    // Optimistic local update via onChange fallback
    patch([{ id: item.id, done: !item.done }])
  }

  const saveEdit = (item: ActionItem) => {
    const text = draftText.trim()
    if (!text) {
      setEditingId(null)
      return
    }
    patch([{ id: item.id, task: text }])
    setEditingId(null)
  }

  const remove = (item: ActionItem) => {
    patch([{ id: item.id, _delete: true }])
  }

  const addTask = (owner: string) => {
    const text = newTaskText.trim()
    if (!text) {
      setAddingForOwner(null)
      return
    }
    patch([{ owner, task: text, confidence: 1 }])
    setNewTaskText('')
    setAddingForOwner(null)
  }

  const copyOwner = async (owner: string, items: ActionItem[]) => {
    const name = resolveName(owner)
    const lines = items
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((it) => `- [${it.done ? 'x' : ' '}] ${it.task}${it.due ? ` (${it.due})` : ''}`)
      .join('\n')
    await navigator.clipboard.writeText(`${name}\n${lines}`)
    setCopiedOwner(owner)
    setTimeout(() => setCopiedOwner(null), 1500)
  }

  const copyAll = async () => {
    const blocks = groups.map(([owner, items]) => {
      const lines = items
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((it) => `- [${it.done ? 'x' : ' '}] ${it.task}${it.due ? ` (${it.due})` : ''}`)
        .join('\n')
      return `${resolveName(owner)}\n${lines}`
    })
    await navigator.clipboard.writeText(blocks.join('\n\n'))
    setCopiedAll(true)
    setTimeout(() => setCopiedAll(false), 1500)
  }

  const submitRename = (owner: string) => {
    const name = renameValue.trim()
    setRenamingOwner(null)
    if (!name || name === resolveName(owner)) return
    api
      .post<{ speakerNames: Record<string, string> }>(`/jobs/${jobId}/speakers`, {
        speaker: owner,
        name,
      })
      .then((res) => onSpeakerRename?.(owner, name))
      .catch((err) => toast(err instanceof Error ? err.message : 'Gagal mengganti nama', 'error'))
  }

  return (
    <div className="card p-5 sm:p-7">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <h3 className="eyebrow">Action Items</h3>
          <span className="text-[11px] text-slate-400 tabular">
            {actionItems.length} tugas · {groups.length} orang
          </span>
        </div>
        {!readOnly && (
          <button
            onClick={copyAll}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-navy px-2.5 py-1.5 rounded-lg hover:bg-slate-100"
            title="Salin semua sebagai checklist"
          >
            {copiedAll ? <Check size={14} weight="bold" /> : <Copy size={14} />}
            Salin semua
          </button>
        )}
      </div>

      <div className="space-y-3">
        {groups.map(([owner, items]) => {
          const style = speakerStyle(owner)
          const done = items.filter((i) => i.done).length
          const isRenaming = renamingOwner === owner
          return (
            <motion.div
              key={owner}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`rounded-2xl border-2 ${style.accent} overflow-hidden`}
            >
              <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full ${style.dot} flex-shrink-0`} />
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => submitRename(owner)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(owner)
                        if (e.key === 'Escape') setRenamingOwner(null)
                      }}
                      className="text-sm font-semibold bg-white border border-slate-200 rounded-md px-2 py-0.5 min-w-0 focus:outline-none focus:ring-2 focus:ring-offset-0"
                    />
                  ) : (
                    <button
                      onClick={() => !readOnly && onSpeakerRename && (
                        setRenamingOwner(owner), setRenameValue(resolveName(owner))
                      )}
                      className="group inline-flex items-center gap-1.5 text-sm font-semibold text-navy min-w-0"
                      title={readOnly ? undefined : 'Klik untuk ganti nama'}
                    >
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium ${style.chip}`}>
                        {owner}
                      </span>
                      {resolveName(owner) !== owner && (
                        <span className="truncate">{resolveName(owner)}</span>
                      )}
                      {!readOnly && (
                        <PencilSimple
                          size={12}
                          className="text-slate-300 group-hover:text-ink-muted"
                        />
                      )}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-semibold tabular px-2 py-0.5 rounded-full ${style.text} bg-white/70`}
                    title={`${items.length} tugas untuk orang ini`}
                  >
                    {items.length} tugas
                    {done > 0 && <span className="text-slate-400 font-normal">· {done} selesai</span>}
                  </span>
                  <button
                    onClick={() => copyOwner(owner, items)}
                    className="grid place-items-center w-7 h-7 rounded-lg text-slate-400 hover:text-navy hover:bg-white/70"
                    title="Salin checklist orang ini"
                  >
                    {copiedOwner === owner ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                  </button>
                </div>
              </div>

              <ul className="px-2 pb-2 space-y-0.5">
                <AnimatePresence initial={false}>
                  {items.map((item) => {
                    const lowConf = item.confidence < CONFIDENCE_THRESHOLD
                    const isEditing = editingId === item.id
                    return (
                      <motion.li
                        key={item.id}
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: lowConf ? 0.65 : 1 }}
                        exit={{ opacity: 0, height: 0 }}
                        className="group flex items-start gap-2.5 px-2 py-2 rounded-xl hover:bg-white/70"
                      >
                        <button
                          onClick={() => toggle(item)}
                          disabled={readOnly}
                          className={`mt-0.5 w-5 h-5 rounded-md border-2 flex-shrink-0 grid place-items-center transition-colors ${
                            item.done
                              ? `${style.dot} border-transparent`
                              : 'border-slate-300 bg-white hover:border-brand'
                          } ${readOnly ? 'cursor-default' : 'cursor-pointer'}`}
                        >
                          {item.done && <Check size={12} weight="bold" className="text-white" />}
                        </button>

                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <input
                              autoFocus
                              value={draftText}
                              onChange={(e) => setDraftText(e.target.value)}
                              onBlur={() => saveEdit(item)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEdit(item)
                                if (e.key === 'Escape') setEditingId(null)
                              }}
                              className="w-full text-[14px] bg-white border border-slate-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2"
                            />
                          ) : (
                            <div className="flex items-start gap-1.5 flex-wrap">
                              <span
                                className={`text-[14px] leading-relaxed text-navy ${
                                  item.done ? 'line-through text-slate-400' : ''
                                }`}
                              >
                                {item.task}
                              </span>
                              <DueBadge due={item.due} dueOn={item.dueOn} done={item.done} />
                              {lowConf && (
                                <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">
                                  <WarningCircle size={10} weight="fill" />
                                  Perlu ditinjau
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {!readOnly && (
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                            <button
                              onClick={() => {
                                setEditingId(item.id)
                                setDraftText(item.task)
                              }}
                              className="grid place-items-center w-7 h-7 rounded-lg text-slate-400 hover:text-navy hover:bg-slate-100"
                              title="Edit"
                            >
                              <PencilSimple size={13} />
                            </button>
                            <button
                              onClick={() => remove(item)}
                              className="grid place-items-center w-7 h-7 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
                              title="Hapus"
                            >
                              <Trash size={13} />
                            </button>
                          </div>
                        )}
                      </motion.li>
                    )
                  })}
                </AnimatePresence>

                {addingForOwner === owner && (
                  <li className="flex items-center gap-2.5 px-2 py-2">
                    <span className={`mt-0.5 w-5 h-5 rounded-md border-2 border-slate-300 bg-white flex-shrink-0`} />
                    <input
                      autoFocus
                      value={newTaskText}
                      onChange={(e) => setNewTaskText(e.target.value)}
                      onBlur={() => addTask(owner)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addTask(owner)
                        if (e.key === 'Escape') setAddingForOwner(null)
                      }}
                      placeholder="Tulis tugas baru…"
                      className="flex-1 text-[14px] bg-white border border-slate-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2"
                    />
                  </li>
                )}
              </ul>

              {!readOnly && (
                <button
                  onClick={() => {
                    setAddingForOwner(owner)
                    setNewTaskText('')
                  }}
                  className="flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-navy px-4 py-2 w-full text-left"
                >
                  <Plus size={12} weight="bold" />
                  Tambah tugas
                </button>
              )}
            </motion.div>
          )
        })}
      </div>

      {actionItems.some((i) => i.confidence < CONFIDENCE_THRESHOLD) && (
        <p className="mt-4 text-[11px] text-slate-400 flex items-center gap-1.5">
          <X size={11} />
          Item berlabel "Perlu ditinjau" diekstrak AI dengan keyakinan rendah — verifikasi sebelum diambil tindakan.
        </p>
      )}
    </div>
  )
}
