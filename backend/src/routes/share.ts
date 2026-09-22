import { Hono } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { actionItems, jobs, type ActionItemRow, type TranscriptPayload } from '../db/schema.js'
import { createDownloadUrl, objectExists } from '../services/storage.js'

// All routes here are PUBLIC (mounted outside the auth-guards jobsRouter).
// A share token IS the authorization. Two kinds of tokens live on the jobs row:
//   - shareToken     -> Internal (full: transcript + audio + summary + actions)
//   - shareTokenMom  -> Stakeholder (Minutes-of-Meeting only; no transcript/audio)
// They are independent so a stakeholder link can never be turned into a full one.

export const shareRouter = new Hono()

shareRouter.get('/', (c) => c.json({ service: 'pinote-share' }))

// --- Stakeholder MoM view (registered before the catch-all :token routes) ----
shareRouter.get('/mom/:token', async (c) => {
  const token = c.req.param('token')
  const [job] = await db.select().from(jobs).where(eq(jobs.shareTokenMom, token)).limit(1)

  if (!job) {
    return c.html(renderMomPage({ title: 'MoM tidak ditemukan - Rekapin', body: notFoundBody(), robots: 'noindex' }), 404)
  }

  const transcript = job.transcript as TranscriptPayload | null
  const meetingTitle = resolveTitle(job)
  const pageTitle = `${meetingTitle} - Minutes of Meeting - Rekapin`

  if (job.status !== 'completed' || !transcript) {
    return c.html(renderMomPage({
      title: pageTitle,
      body: `<h1>${escapeHtml(meetingTitle)}</h1>${notReadyBody(job.status)}`,
      robots: 'noindex',
    }))
  }

  const items = await loadActionItems(job.id)
  const speakerNames = (job.speakerNames ?? {}) as Record<string, string>

  if (wantsJson(c)) {
    return c.json({
      shareKind: 'stakeholder' as const,
      id: job.id,
      filename: job.filename,
      title: job.title ?? null,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      durationSec: job.durationSec,
      language: job.language,
      speakerNames,
      speakerCount: transcript.speakerCount,
      summary: transcript.summary ?? '',
      actionItems: shapeItems(items),
    })
  }

  return c.html(renderMomPage({ title: pageTitle, body: momBody({ job, transcript, items, speakerNames, meetingTitle }), shareUrl: c.req.url }))
})

// --- Internal audio (token-gated; stakeholder tokens have no audio path) -----
shareRouter.get('/:token/audio', async (c) => {
  const token = c.req.param('token')
  const [job] = await db
    .select({ storageKey: jobs.storageKey, mimeType: jobs.mimeType, shareToken: jobs.shareToken })
    .from(jobs)
    .where(eq(jobs.shareToken, token))
    .limit(1)

  if (!job || !job.shareToken) return c.json({ error: 'Audio tidak tersedia' }, 404)
  if (!job.storageKey) return c.json({ error: 'Audio tidak tersedia' }, 404)
  if (!(await objectExists(job.storageKey))) {
    return c.json({ error: 'Rekaman audio sudah tidak ada di server' }, 404)
  }

  const url = await createDownloadUrl(job.storageKey)
  return c.json({ url, mimeType: job.mimeType ?? 'audio/mpeg' })
})

// --- Internal full share (transcript + audio + summary + actions) -----------
shareRouter.get('/:token', async (c) => {
  const token = c.req.param('token')
  const [job] = await db.select().from(jobs).where(eq(jobs.shareToken, token)).limit(1)

  if (!job) {
    return c.html(renderPage({
      title: 'Link bagikan tidak ditemukan - Rekapin',
      heading: 'Link bagikan tidak ditemukan',
      body: '<p>Link ini tidak valid atau sudah tidak tersedia.</p>',
      robots: 'noindex',
      image: null,
      shareUrl: c.req.url,
    }), 404)
  }

  const transcript = job.transcript as TranscriptPayload | null
  const meetingTitle = resolveTitle(job)
  const pageTitle = `${meetingTitle} - Rekapin`

  if (job.status !== 'completed' || !transcript) {
    return c.html(renderPage({
      title: pageTitle,
      heading: meetingTitle,
      body: `<p>Status transkrip: <strong>${escapeHtml(job.status)}</strong>. Transkrip belum tersedia untuk dibaca.</p>`,
      robots: 'noindex',
      image: null,
      shareUrl: c.req.url,
    }))
  }

  const items = await loadActionItems(job.id)
  const speakerNames = (job.speakerNames ?? {}) as Record<string, string>
  const audioAvailable = Boolean(job.storageKey) && (await objectExists(job.storageKey as string))

  if (wantsJson(c)) {
    return c.json({
      shareKind: 'internal' as const,
      id: job.id,
      filename: job.filename,
      title: job.title ?? null,
      mimeType: job.mimeType,
      sizeBytes: job.sizeBytes,
      durationSec: job.durationSec,
      language: job.language,
      status: job.status,
      transcript,
      speakerNames,
      actionItems: shapeItems(items),
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      hasAudio: audioAvailable,
    })
  }

  const summary = transcript.summary?.trim()
  const segments = transcript.segments ?? []
  const hasPolishedTranscript = transcript.polished && transcript.rawSegments !== undefined
  const hasAudio = audioAvailable

  const byOwner = new Map<string, ActionItemRow[]>()
  for (const it of items) {
    const arr = byOwner.get(it.owner) ?? []
    arr.push(it)
    byOwner.set(it.owner, arr)
  }
  const ownerOrder = [...byOwner.keys()]
  const resolveName = (owner: string) => speakerNames[owner] ?? owner

  const actionItemsHtml = ownerOrder.length
    ? `
      <section>
        <h2>Action Items</h2>
        ${ownerOrder
          .map((owner) => {
            const tasks = byOwner.get(owner)!
            return `
            <div class="owner-group">
              <h3>${escapeHtml(resolveName(owner))}</h3>
              <ul>
                ${tasks
                  .map(
                    (t) =>
                      `<li><span class="box">${t.done ? '&#9745;' : '&#9744;'}</span> ${escapeHtml(t.task)}${t.due ? ` <em>(${escapeHtml(t.due)})</em>` : ''}${t.confidence < 0.8 ? ' <span class="hint">(perlu ditinjau)</span>' : ''}</li>`
                  )
                  .join('\n')}
              </ul>
            </div>`
          })
          .join('\n')}
      </section>`
    : ''

  const description = summary ? summary.replace(/\s+/g, ' ').slice(0, 240) : `Transkrip meeting: ${meetingTitle}`

  return c.html(renderPage({
    title: pageTitle,
    heading: meetingTitle,
    description,
    image: null,
    shareUrl: c.req.url,
    body: `
      ${hasAudio ? `
        <section class="audio-section">
          <h2>Rekaman</h2>
          <div class="audio-wrap" id="audioWrap">
            <button type="button" class="audio-play" onclick="window.__loadShareAudio &amp;&amp; window.__loadShareAudio()">&#9654; Putar rekaman</button>
          </div>
        </section>
        <script>
          (function(){
            var wrap=document.getElementById('audioWrap');
            window.__loadShareAudio=function(){
              if(!wrap||wrap.dataset.loaded)return;
              wrap.dataset.loaded='1';
              wrap.textContent='Memuat rekaman\u2026';
              fetch(${JSON.stringify(`/share/${token}/audio`)})
                .then(function(r){return r.json()})
                .then(function(d){
                  if(!d||!d.url){ wrap.innerHTML='<p class="meta">Rekaman tidak tersedia.</p>'; return; }
                  wrap.innerHTML='';
                  var a=document.createElement('audio');
                  a.controls=true;
                  a.preload='metadata';
                  a.style.width='100%';
                  a.src=d.url;
                  wrap.appendChild(a);
                  a.load();
                  var p=a.play();
                  if(p&&p.catch){p.catch(function(){ /* autoplay blocked; user presses play */ });}
                })
                .catch(function(){ wrap.innerHTML='<p class="meta">Rekaman tidak dapat dimuat. Coba segarkan halaman.</p>'; });
            };
          })();
        </script>
      ` : ''}

      ${summary ? `
        <section>
          <h2>Ringkasan</h2>
          ${summary
            .split('\n')
            .filter(Boolean)
            .map((line) => `<p>${escapeHtml(line.replace(/^[-*]\s*/, ''))}</p>`)
            .join('\n')}
        </section>
      ` : ''}

      <section>
        <h2>Metadata Meeting</h2>
        <dl>
          <dt>Judul</dt><dd>${escapeHtml(meetingTitle)}</dd>
          <dt>Durasi</dt><dd>${job.durationSec ? formatDuration(job.durationSec) : 'Tidak tersedia'}</dd>
          <dt>Bahasa</dt><dd>${escapeHtml(job.language)}</dd>
          <dt>Pembicara</dt><dd>${transcript.speakerCount} orang</dd>
          <dt>Tanggal</dt><dd>${job.createdAt.toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' })}</dd>
        </dl>
      </section>

      ${!hasPolishedTranscript ? '<p class="notice">Transkrip masih dalam proses penyempurnaan. Segarkan halaman untuk melihat hasil akhir.</p>' : ''}

      ${actionItemsHtml}

      <section>
        <h2>Transkrip</h2>
        <p class="meta-count">${segments.length} segmen percakapan</p>
        ${segments.map((segment) => `
          <article>
            <p class="meta"><time>${escapeHtml(segment.start)}</time> &ndash; <time>${escapeHtml(segment.end)}</time> &middot; ${escapeHtml(resolveName(segment.speaker))}</p>
            <p>${escapeHtml(segment.text)}</p>
          </article>
        `).join('\n')}
      </section>
    `,
  }))
})

// --- helpers -----------------------------------------------------------------

function wantsJson(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const accept = c.req.header('Accept') ?? ''
  // Browser navigation always advertises text/html first. XHR/fetch from the SPA
  // sends */* (or application/json), which we treat as a JSON request.
  return !accept.includes('text/html')
}

function resolveTitle(job: typeof jobs.$inferSelect): string {
  return job.title?.trim() || job.filename.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ')
}

async function loadActionItems(jobId: string): Promise<ActionItemRow[]> {
  try {
    return await db
      .select()
      .from(actionItems)
      .where(and(eq(actionItems.jobId, jobId)))
      .orderBy(asc(actionItems.order), asc(actionItems.createdAt))
  } catch (err) {
    console.warn(`share render: failed to load action items for ${jobId}:`, err)
    return []
  }
}

function shapeItems(items: ActionItemRow[]) {
  return items
    .map((it) => ({
      id: it.id,
      owner: it.owner,
      task: it.task,
      due: it.due,
      confidence: it.confidence,
      done: it.done,
      order: it.order,
    }))
    .sort((a, b) => a.order - b.order)
}

function notFoundBody(): string {
  return `<h1>Minutes of Meeting tidak ditemukan</h1><p>Link ini tidak valid atau sudah tidak tersedia.</p>`
}

function notReadyBody(status: string): string {
  return `<p>Status: <strong>${escapeHtml(status)}</strong>. Dokumen belum tersedia.</p>`
}

// --- MoM (stakeholder) HTML --------------------------------------------------

function momBody(args: {
  job: typeof jobs.$inferSelect
  transcript: TranscriptPayload
  items: ActionItemRow[]
  speakerNames: Record<string, string>
  meetingTitle: string
}): string {
  const { job, transcript, items, speakerNames, meetingTitle } = args
  const summary = transcript.summary?.trim() ?? ''
  const summaryLines = summary.split('\n').map((l) => l.trim()).filter(Boolean)
  const resolveName = (owner: string) => speakerNames[owner] ?? owner

  // Attendees: resolved speaker names, de-duped, sorted.
  const speakerLabels = Array.from(
    { length: transcript.speakerCount },
    (_, i) => `Speaker ${i + 1}`
  )
  const attendees = Array.from(
    new Set(speakerLabels.map((s) => speakerNames[s] ?? s).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b))

  const dateStr = job.createdAt.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const summaryHtml = summaryLines.length
    ? `<section><h2>Ringkasan Pembahasan</h2><ul>${summaryLines
        .map((l) => `<li>${escapeHtml(l.replace(/^[-*]\s*/, ''))}</li>`)
        .join('\n')}</ul></section>`
    : '<p class="meta">Tidak ada ringkasan.</p>'

  const actionsHtml = items.length
    ? `<section>
        <h2>Tindakan &amp; Tindak Lanjut</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Tindakan</th><th>Penanggung Jawab</th><th>Tenggat</th><th>Status</th></tr></thead>
            <tbody>
              ${items
                .map(
                  (it, i) => `<tr>
                    <td class="num">${i + 1}</td>
                    <td>${escapeHtml(it.task)}</td>
                    <td>${escapeHtml(resolveName(it.owner))}</td>
                    <td>${it.due ? escapeHtml(it.due) : '&mdash;'}</td>
                    <td>${it.done ? '<span class="badge done">Selesai</span>' : '<span class="badge open">Terbuka</span>'}</td>
                  </tr>`
                )
                .join('\n')}
            </tbody>
          </table>
        </div>
      </section>`
    : '<section><h2>Tindakan &amp; Tindak Lanjut</h2><p class="meta">Tidak ada tindakan tercatat.</p></section>'

  return `
    <header class="mom-doc">
      <div class="mom-eyebrow">Minutes of Meeting</div>
      <h1>${escapeHtml(meetingTitle)}</h1>
    </header>

    <section class="mom-meta">
      <div><span class="label">Tanggal</span><span>${escapeHtml(dateStr)}</span></div>
      <div><span class="label">Durasi</span><span>${job.durationSec ? escapeHtml(formatDuration(job.durationSec)) : '&mdash;'}</span></div>
      <div><span class="label">Bahasa</span><span>${escapeHtml(job.language)}</span></div>
      <div><span class="label">Pembicara</span><span>${transcript.speakerCount} orang</span></div>
      ${attendees.length ? `<div class="full"><span class="label">Hadiririn</span><span>${attendees.map(escapeHtml).join(', ')}</span></div>` : ''}
    </section>

    ${summaryHtml}

    ${actionsHtml}

    <footer class="mom-footer">
      <p>Dokumen ini dibuat otomatis dari rekaman rapat menggunakan Rekapin. Hanya berisi ringkasan dan tindak lanjut &mdash; bukan transkrip penuh.</p>
      <p class="meta">Disiapkan ${escapeHtml(dateStr)} &middot; Dipublikasikan via Rekapin</p>
    </footer>
  `
}

function renderMomPage(args: { title: string; body: string; robots?: string; shareUrl?: string }): string {
  const url = args.shareUrl ?? ''
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="${escapeHtml(args.robots ?? 'index,follow')}" />
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:title" content="Minutes of Meeting - Rekapin" />
    <meta property="og:site_name" content="Rekapin" />
    <meta name="twitter:card" content="summary" />
    <title>${escapeHtml(args.title)}</title>
    <style>${MOM_STYLES}</style>
  </head>
  <body>
    <header class="topbar"><div class="topbar-inner"><span class="brand">Rekapin</span><small>Minutes of Meeting</small></div></header>
    <main class="mom">
      ${args.body}
    </main>
  </body>
</html>`
}

// --- Internal full-share HTML ------------------------------------------------

function renderPage(args: {
  title: string
  heading: string
  body: string
  description?: string
  robots?: string
  image: string | null
  shareUrl?: string
}): string {
  const description = args.description ?? 'Rekapin public transcript'
  const url = args.shareUrl ?? ''
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="${escapeHtml(args.robots ?? 'index,follow')}" />

    <!-- Open Graph -->
    <meta property="og:type" content="article" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:title" content="${escapeHtml(args.heading)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:site_name" content="Rekapin" />
    ${args.image ? `<meta property="og:image" content="${escapeHtml(args.image)}" />` : ''}

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(args.heading)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />

    <title>${escapeHtml(args.title)}</title>

    <!-- JSON-LD for AI agents / search engines -->
    <script type="application/ld+json">
    ${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      name: args.heading,
      description,
      about: 'Meeting transcript',
      inLanguage: 'id',
      dateCreated: new Date().toISOString().split('T')[0],
    })}
    </script>

    <style>${SHARE_STYLES}</style>
  </head>
  <body>
    <header>
      <div>
        <span>Rekapin</span>
        <small>Public Transcript</small>
      </div>
    </header>
    <main>
      <h1>${escapeHtml(args.heading)}</h1>
      ${args.body}
    </main>
  </body>
</html>`
}

const SHARE_STYLES = `
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #F8FAFC; color: #0F172A; line-height: 1.7; -webkit-font-smoothing: antialiased; }
  @media (prefers-color-scheme: dark) {
    body { background: #0F172A; color: #E2E8F0; }
    header { background: #1E1B4B; }
    .owner-group { background: #1E293B; border-color: #334155; }
    .owner-group h3 { color: #A5B4FC; }
    article { border-color: #334155; }
    .meta, .meta-count, dt { color: #94A3B8; }
    header div small { color: #94A3B8; }
    .notice { background: #422006; border-color: #92400E; color: #FBBF24; }
    .audio-section audio { filter: invert(0.9) hue-rotate(180deg); }
  }
  main { max-width: 880px; margin: 0 auto; padding: 32px 20px 80px; }
  header { border-bottom: 1px solid #E2E8F0; background: #0F172A; color: #fff; }
  header div { max-width: 880px; margin: 0 auto; padding: 16px 20px; display: flex; align-items: baseline; gap: 12px; font-weight: 700; letter-spacing: 0.03em; }
  header div small { font-weight: 400; color: #94A3B8; letter-spacing: 0; }
  h1 { font-size: clamp(26px, 3.5vw, 40px); line-height: 1.15; margin: 0 0 20px; color: inherit; }
  h2 { margin-top: 40px; padding-top: 20px; border-top: 1px solid; border-color: #E2E8F0; font-size: 18px; font-weight: 600; color: inherit; }
  @media (prefers-color-scheme: dark) { h2 { border-color: #334155; } }
  p { margin: 0 0 12px; }
  dl { display: grid; grid-template-columns: 140px 1fr; gap: 6px 16px; font-size: 14px; }
  dt { color: #64748B; }
  dd { margin: 0; }
  article { padding: 16px 0; border-bottom: 1px solid #E2E8F0; }
  @media (prefers-color-scheme: dark) { article { border-color: #334155; } }
  article:last-of-type { border-bottom: 0; }
  .meta { color: #64748B; font-size: 13px; margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
  .meta time { font-variant-numeric: tabular-nums; }
  .meta-count { color: #64748B; font-size: 13px; margin-bottom: 0; }
  .owner-group { margin: 12px 0; padding: 16px 20px; background: #fff; border: 1px solid #E2E8F0; border-radius: 12px; }
  @media (prefers-color-scheme: dark) { .owner-group { background: #1E293B; border-color: #334155; } }
  .owner-group h3 { margin: 0 0 10px; font-size: 15px; color: #4F46E5; }
  .owner-group ul { list-style: none; padding: 0; margin: 0; }
  .owner-group li { display: flex; gap: 8px; padding: 6px 0; font-size: 14px; line-height: 1.5; }
  .owner-group li + li { border-top: 1px solid #F1F5F9; }
  @media (prefers-color-scheme: dark) { .owner-group li + li { border-color: #334155; } }
  .owner-group .box { flex-shrink: 0; font-size: 14px; color: #64748B; }
  .owner-group em { color: #64748B; font-style: normal; font-size: 12px; }
  .owner-group .hint { color: #D97706; font-size: 12px; }
  .notice { padding: 12px 16px; background: #FEF3C7; border: 1px solid #F59E0B; border-radius: 8px; font-size: 14px; color: #92400E; margin: 20px 0; }
  a { color: #4F46E5; text-decoration: underline; text-underline-offset: 2px; }
  @media (prefers-color-scheme: dark) { a { color: #A5B4FC; } }
  .audio-section audio { width: 100%; margin-top: 4px; }
  .audio-wrap { margin-top: 4px; }
  .audio-play { appearance: none; border: 1px solid #4F46E5; background: #EEF2FF; color: #4338CA; padding: 10px 18px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .audio-play:hover { background: #E0E7FF; }
  @media (prefers-color-scheme: dark) {
    .audio-play { background: #1E1B4B; border-color: #4F46E5; color: #C7D2FE; }
    .audio-play:hover { background: #312E81; }
  }
`

const MOM_STYLES = `
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #F8FAFC; color: #0F172A; line-height: 1.65; -webkit-font-smoothing: antialiased; }
  @media (prefers-color-scheme: dark) {
    body { background: #0B1220; color: #E2E8F0; }
    .topbar { background: #0F172A; border-color: #1E293B; }
    .mom { background: #111C2E; border-color: #1E293B; box-shadow: 0 1px 0 #1E293B; }
    .mom-eyebrow { color: #A5B4FC; }
    .mom-meta { background: #0F172A; border-color: #1E293B; }
    .mom-meta .label { color: #94A3B8; }
    table th { background: #0F172A; color: #CBD5E1; }
    table td, table th { border-color: #1E293B; }
    tr:nth-child(even) td { background: #0E1726; }
    .badge.done { background: #064E3B; color: #6EE7B7; }
    .badge.open { background: #1E293B; color: #CBD5E1; }
    .mom-footer .meta { color: #94A3B8; }
  }
  .topbar { border-bottom: 1px solid #E2E8F0; background: #fff; }
  .topbar-inner { max-width: 880px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: baseline; gap: 10px; }
  .topbar .brand { font-weight: 700; letter-spacing: 0.03em; }
  .topbar small { color: #94A3B8; }
  .mom { max-width: 880px; margin: 28px auto; padding: 40px 44px; background: #fff; border: 1px solid #E2E8F0; border-radius: 16px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  @media (max-width: 640px) { .mom { margin: 0; border-radius: 0; border-left: 0; border-right: 0; padding: 28px 20px; } }
  .mom-eyebrow { text-transform: uppercase; letter-spacing: 0.12em; font-size: 12px; font-weight: 700; color: #4F46E5; }
  .mom-doc h1 { font-size: clamp(24px, 3vw, 32px); line-height: 1.2; margin: 8px 0 0; }
  .mom-meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: #E2E8F0; border: 1px solid #E2E8F0; border-radius: 12px; overflow: hidden; margin: 28px 0; }
  @media (max-width: 560px) { .mom-meta { grid-template-columns: 1fr; } }
  .mom-meta > div { background: #F8FAFC; padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
  .mom-meta .full { grid-column: 1 / -1; }
  .mom-meta .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #64748B; font-weight: 600; }
  h2 { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #334155; margin: 32px 0 12px; }
  @media (prefers-color-scheme: dark) { h2 { color: #CBD5E1; } }
  ul { padding-left: 20px; margin: 0; }
  li { margin: 4px 0; }
  .table-wrap { overflow-x: auto; border: 1px solid #E2E8F0; border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  table th, table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #E2E8F0; vertical-align: top; }
  table th { background: #F8FAFC; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #475569; }
  table tr:last-child td { border-bottom: 0; }
  td.num { color: #94A3B8; width: 32px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.done { background: #ECFDF5; color: #047857; }
  .badge.open { background: #F1F5F9; color: #475569; }
  .meta { color: #64748B; font-size: 13px; }
  .mom-footer { margin-top: 36px; padding-top: 20px; border-top: 1px solid #E2E8F0; color: #64748B; font-size: 13px; }
  @media (prefers-color-scheme: dark) { .mom-footer { border-color: #1E293B; color: #94A3B8; } }
  .mom-footer p { margin: 0 0 6px; }
`

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}j ${m}m ${s}d`
  if (m > 0) return `${m}m ${s}d`
  return `${s}d`
}
