import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate, Link, useOutletContext } from 'react-router-dom'
import { announceCollectionChanged } from '../../lib/collectionEvents'
import { useAuth, ApiError } from '../../auth/AuthContext'
import { usePermissions } from '../../lib/permissions'
import type { Crumb, LibraryOutletContext } from '../../components/LibraryOutlet'
import type { Book, BookEdition, Copy, CopyLocation, Vocabulary, EditionFile, Loan, MyBook, ReadingSession, BookSeriesRef, ContributorResult, MergedBookResult, MergedFieldResult, StorageLocation, BrowseEntry, ISBNLookupResult } from '../../types'
import { AddEditionModal } from '../../components/AddEditionModal'
import EditBookModal from '../../components/EditBookModal'
import LoanFormModal from '../../components/LoanFormModal'
import BookCover from '../../components/BookCover'
import { useToast } from '../../components/Toast'
import BookContents from '../../components/BookContents'
import BookLists from '../../components/BookLists'
import BookReaders from '../../components/BookReaders'
import BookSeries from '../../components/BookSeries'
import StarRating from '../../components/StarRating'
import { type SavedList } from '../../lib/lists'
import { withBase } from '../../lib/basePath'
import { buildTree, flatten, numberedShelfIds, pathOf, shelfChoices, shelfSpot } from '../../lib/places'
import { authorNames } from '../../lib/mergedLookup'
import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, imageUploadError, tooLargeMessage } from '../../lib/imageUpload'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────


const READ_STATUSES = [
  { value: 'unread', label: 'Unread' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' },
  { value: 'did_not_finish', label: 'Did not finish' },
]

// ─── Reading panel ────────────────────────────────────────────────────────────

/**
 * The caller's reading state for this work.
 *
 * One panel for the book, not one per edition. Reading state used to hang off a
 * printing, so a book with two editions had two answers to "have you read it"
 * and the page asked the reader to pick which paperback they meant. An opinion
 * is about the story.
 *
 * Dates live in reading sessions now, since a reread is another pass rather
 * than a counter. This edits the most recent one, which is what the two date
 * fields always meant; the full history is a later screen.
 */
function ReadingPanel({ bookId }: { bookId: string }) {
  const { callApi } = useAuth()
  const [state, setState] = useState<MyBook | null>(null)
  const [session, setSession] = useState<ReadingSession | null>(null)
  const [form, setForm] = useState({
    read_status: 'unread',
    rating: '',
    notes: '',
    review: '',
    date_started: '',
    date_finished: '',
    is_favorite: false,
  })
  const [isLoading, setIsLoading] = useState(false)
  const [isSaved, setIsSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  /**
   * A date input wants YYYY-MM-DD; the API sends an instant.
   *
   * Normalised through UTC rather than sliced off the front of the string. The
   * API serialises with the server's offset, so a date stored as midnight UTC
   * arrives as `2026-08-01T00:00:00-04:00` and the first ten characters read
   * 2026-07-31. Every date in the form came back a day early.
   */
  const asDate = (v?: string | null) => {
    if (!v) return ''
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [mine, sessions] = await Promise.all([
        callApi<MyBook>(`/api/v1/books/${bookId}/me`).catch(() => null),
        callApi<{ items: ReadingSession[] }>(`/api/v1/books/${bookId}/sessions`).catch(() => null),
      ])
      if (cancelled) return
      // Most recent first, so the first is the pass these fields describe.
      const latest = sessions?.items?.[0] ?? null
      setState(mine)
      setSession(latest)
      setForm({
        read_status: mine?.read_status ?? 'unread',
        rating: mine?.rating != null ? String(mine.rating) : '',
        notes: mine?.notes ?? '',
        review: mine?.review ?? '',
        date_started: asDate(latest?.started_at),
        date_finished: asDate(latest?.finished_at),
        is_favorite: mine?.is_favorite ?? false,
      })
    }
    void load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  /** Writes the dates, creating the first session if there is none yet. */
  const saveDates = async () => {
    const started = form.date_started || null
    const finished = form.date_finished || null
    if (!started && !finished && !session) return null

    if (session) {
      // Sent explicitly, including as null: the API reads an omitted field as
      // "no change", so clearing a date has to say so.
      return callApi<ReadingSession>(`/api/v1/sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ started_at: started, finished_at: finished }),
      })
    }
    return callApi<ReadingSession>(`/api/v1/books/${bookId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        started_at: started,
        finished_at: finished,
        status: finished ? 'finished' : 'reading',
      }),
    })
  }

  const save = async () => {
    setIsLoading(true); setIsSaved(false)
    try {
      // Only the fields this panel owns. The endpoint is a partial update, so
      // anything omitted keeps whatever another device last wrote.
      const rating = form.rating ? Number(form.rating) : null
      const updated = await callApi<MyBook>(`/api/v1/books/${bookId}/me`, {
        method: 'PUT',
        body: JSON.stringify({
          read_status: form.read_status,
          rating,
          clear_rating: rating === null,
          notes: form.notes,
          review: form.review,
          is_favorite: form.is_favorite,
        }),
      })
      const savedSession = await saveDates()
      if (updated) setState(updated)
      if (savedSession) setSession(savedSession)
      setIsSaved(true)
      setError(null)
      announceCollectionChanged()
      setTimeout(() => setIsSaved(false), 2000)
    } catch (e) {
      // Was swallowed once. The server rejected every save through this form
      // for thirteen days and the page said nothing, so it looked like the
      // checkbox simply did not stick. A failed save has to be visible.
      setError(e instanceof ApiError ? e.message : 'Could not save. Try again.')
    } finally { setIsLoading(false) }
  }

  /** Star or unstar. One field, so the body carries one field. */
  const toggleFavourite = async () => {
    const next = !form.is_favorite
    setForm(f => ({ ...f, is_favorite: next }))
    try {
      const updated = await callApi<MyBook>(`/api/v1/books/${bookId}/me`, {
        method: 'PUT',
        body: JSON.stringify({ is_favorite: next }),
      })
      if (updated) setState(updated)
      // The Favourites list and its count live in the rail.
      announceCollectionChanged()
    } catch {
      // Put the star back rather than showing one that did not take.
      setForm(f => ({ ...f, is_favorite: !next }))
    }
  }

  // Whether there is anything to remove. The API answers a book nobody has
  // said anything about with a default row rather than a 404, since 404 would
  // make every unread book look like a broken link, so a non-null response is
  // not evidence that a record exists. Offering Remove on one would be a button
  // whose only outcome is a 404 the page then swallows.
  const hasRecord = Boolean(
    state && !state.inherited && (
      state.read_status !== 'unread' || state.rating != null || state.notes ||
      state.review || state.is_favorite || session
    )
  )

  const inputCls = 'w-full rounded border border-line-strong dark:bg-surface-raised dark:text-white px-2 py-1.5 text-xs focus:border-accent focus:outline-none'

  return (
    <div className="rounded-lg border border-line-subtle">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Every status draws something, including the one that means nothing
              has happened yet. Only read, reading and did-not-finish had a pill,
              so an untouched book left this whole side blank and the row read as
              a control that had failed to load. */}
          {READ_STATUS_PILL[form.read_status] ? (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${READ_STATUS_PILL[form.read_status].cls}`}>
              {READ_STATUS_PILL[form.read_status].icon}
              {READ_STATUS_PILL[form.read_status].label}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-content-subtle ring-1 ring-line">
              Unread
            </span>
          )}
          {state?.inherited && (
            // Worth saying out loud: the status came from an omnibus holding
            // this volume, so nothing was ever recorded about this book itself,
            // and saving here is what makes it explicit.
            <span className="text-xs text-content-subtle" title="Read as part of a collection that contains this book">
              via a collection
            </span>
          )}
        </div>
        {/* Labelled, because a bare star is a guess.
            An unrecorded book draws no status pill, so this row was an empty
            box with one outlined star floating at the right of it and nothing
            to say what it meant. A tooltip does not help: it needs a hover to
            appear and never appears at all on a touch screen. */}
        <button onClick={toggleFavourite}
          aria-pressed={form.is_favorite}
          className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors ${form.is_favorite ? 'text-warning' : 'text-content-subtle hover:text-content-tertiary'}`}
          title={form.is_favorite ? 'Remove from favourites' : 'Add to favourites'}>
          {/* Filled when starred, outlined when not: the state has to read at a
              glance rather than by comparing shades. */}
          <svg className="w-4 h-4" fill={form.is_favorite ? 'currentColor' : 'none'}
            stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
          Favourite
        </button>
      </div>

      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 border-t border-line-subtle text-xs font-medium text-content-muted hover:bg-surface-muted transition-colors"
      >
        <span>My reading</span>
        <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <div>
            <label className="block text-xs text-content-tertiary mb-1">Status</label>
            <select value={form.read_status} onChange={e => setForm(f => ({ ...f, read_status: e.target.value }))} className={inputCls}>
              {READ_STATUSES.map(st => <option key={st.value} value={st.value}>{st.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-content-tertiary mb-1">Rating</label>
            {/* Stars rather than a number box labelled 1-10. The column holds
                ten points, which is five stars of two, so the reader is no
                longer asked to convert in their head against a rail that talks
                about stars. */}
            <StarRating
              value={form.rating === '' ? null : Number(form.rating)}
              onChange={r => setForm(f => ({ ...f, rating: r === null ? '' : String(r) }))}
            />
          </div>
          <div>
            <label className="block text-xs text-content-tertiary mb-1">Date started</label>
            <input type="date" value={form.date_started}
              onChange={e => setForm(f => ({ ...f, date_started: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-content-tertiary mb-1">Date finished</label>
            <input type="date" value={form.date_finished}
              onChange={e => setForm(f => ({ ...f, date_finished: e.target.value }))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs text-content-tertiary mb-1">Notes <span className="text-content-subtle">(private)</span></label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2} placeholder="Personal notes…" className={`${inputCls} resize-none`} />
          </div>
          <div>
            <label className="block text-xs text-content-tertiary mb-1">Review <span className="text-content-subtle">(visible to members)</span></label>
            <textarea value={form.review} onChange={e => setForm(f => ({ ...f, review: e.target.value }))}
              rows={2} placeholder="Share your thoughts…" className={`${inputCls} resize-none`} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              {isSaved && <span className="text-xs text-success">Saved!</span>}
              {error && <span className="text-xs text-danger" role="alert">{error}</span>}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {hasRecord && (
                <button onClick={async () => {
                  if (!confirm('Remove your reading record for this book?')) return
                  await callApi(`/api/v1/books/${bookId}/me`, { method: 'DELETE' }).catch(() => {})
                  // The sessions go too: they are the dates this panel shows,
                  // and leaving them would put a finish date under a status of
                  // unread.
                  if (session) await callApi(`/api/v1/sessions/${session.id}`, { method: 'DELETE' }).catch(() => {})
                  setState(null)
                  setSession(null)
                  setForm({ read_status: 'unread', rating: '', notes: '', review: '', date_started: '', date_finished: '', is_favorite: false })
                  announceCollectionChanged()
                }} className="text-xs text-danger hover:underline">Remove</button>
              )}
              <button onClick={save} disabled={isLoading}
                className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50 transition-colors">
                {isLoading ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Copies ───────────────────────────────────────────────────────────────────

/**
 * The physical objects on the shelf, and the words to describe them.
 *
 * Held once for the whole page rather than per edition: the conditions
 * vocabulary and the library's locations are the same for every copy, and
 * fetching them per card would be one request per printing for one answer.
 */
function useCopies(bookId: string, libraryId: string, onChanged?: (left: Copy[]) => void) {
  const { callApi } = useAuth()
  const { t } = useTranslation()
  const [copies, setCopies] = useState<Copy[]>([])
  const [conditions, setConditions] = useState<Vocabulary[]>([])
  const [locations, setLocations] = useState<CopyLocation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    const [c, v, l] = await Promise.all([
      callApi<{ items: Copy[] }>(`/api/v1/books/${bookId}/copies`).catch(() => null),
      callApi<{ items: Vocabulary[] }>('/api/v1/copy-conditions').catch(() => null),
      callApi<{ items: CopyLocation[] }>(`/api/v1/libraries/${libraryId}/locations`).catch(() => null),
    ])
    return { copies: c?.items ?? [], conditions: v?.items ?? [], locations: l?.items ?? [] }
  }, [callApi, bookId, libraryId])

  const apply = (d: { copies: Copy[]; conditions: Vocabulary[]; locations: CopyLocation[] }) => {
    setCopies(d.copies)
    setConditions(d.conditions)
    setLocations(d.locations)
  }

  // Reads, then writes only if this page is still mounted. Navigating away
  // mid-request would otherwise set state on a component that is gone.
  useEffect(() => {
    let cancelled = false
    void fetchAll().then(d => { if (!cancelled) apply(d) })
    return () => { cancelled = true }
  }, [fetchAll])

  /** Resolves to the copies now held, so a caller can tell the last one went. */
  const reload = useCallback(async () => {
    const d = await fetchAll()
    apply(d)
    return d.copies
  }, [fetchAll])

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await work()
      setError(null)
      onChanged?.(await reload())
    } catch (e) {
      setError(e instanceof ApiError ? e.message : failure)
    } finally { setBusy(false) }
  }

  /** Writes one field. The endpoint is a partial update, so the body names
   *  only what changed and leaves the rest of the copy alone. */
  const patch = (copy: Copy, body: Record<string, unknown>) =>
    run(() => callApi(`/api/v1/copies/${copy.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
        t('copies.save_failed'))

  /** editionId is optional because a copy without one is a supported state: a
   *  book can be on a shelf with nobody having recorded which printing it is. */
  const addCopy = (editionId?: string) =>
    run(() => callApi(`/api/v1/libraries/${libraryId}/copies`, {
      method: 'POST',
      body: JSON.stringify({ book_id: bookId, edition_id: editionId ?? null }),
    }), t('copies.add_failed'))

  const removeCopy = (copy: Copy) => {
    if (!confirm(t('copies.remove_confirm'))) return Promise.resolve()
    return run(() => callApi(`/api/v1/copies/${copy.id}`, { method: 'DELETE' }),
               t('copies.remove_failed'))
  }

  /** Files a copy on a bookcase shelf, making the shelf's place first when
   *  the bookcase only declares it. */
  const fileOnShelf = (copy: Copy, bookcase: CopyLocation, shelf: { name: string; place: CopyLocation | null }) =>
    run(async () => {
      let id = shelf.place?.id
      if (!id) {
        const created = await callApi<CopyLocation>(`/api/v1/libraries/${libraryId}/locations`, {
          method: 'POST',
          body: JSON.stringify({ name: shelf.name, parent_id: bookcase.id }),
        })
        id = created?.id
      }
      if (id) await callApi(`/api/v1/copies/${copy.id}`, { method: 'PATCH', body: JSON.stringify({ location_id: id }) })
    }, t('copies.save_failed'))

  return { copies, conditions, locations, busy, error, patch, addCopy, removeCopy, reload, fileOnShelf }
}

type CopyControls = ReturnType<typeof useCopies>

/** One row per object, with the fields that belong to the object. */
function CopyRows({ copies, controls }: { copies: Copy[]; controls: CopyControls }) {
  const { t } = useTranslation()
  const { conditions, locations, busy, patch, removeCopy, fileOnShelf } = controls
  const prefix = t('shelves_settings.shelf_prefix', { defaultValue: 'Shelf ' })
  // Full paths, since two rooms can each have a "Top shelf". A bookcase's
  // numbered shelves are left out: the shelf menu beside it covers them.
  const placeOptions = useMemo(() => {
    const hidden = numberedShelfIds(locations)
    return flatten(buildTree(locations))
      .filter(n => !hidden.has(n.place.id))
      .map(n => ({ id: n.place.id, label: pathOf(n.place.id, locations).join(' › ') }))
  }, [locations])

  /** Condition codes are a server vocabulary, so the label lives here: a name
   *  stored in the database cannot be translated. An unknown code shows itself
   *  rather than an empty cell, which is what a newly added condition does
   *  until the locale files catch up. */
  const conditionLabel = (code: string) =>
    t(`copies.conditions.${code}`, { defaultValue: code })

  const selectCls = 'rounded border border-line-strong bg-surface dark:bg-surface-raised px-2 py-1 text-xs focus:border-accent focus:outline-none disabled:opacity-50'

  return (
    <div className="space-y-2">
      {copies.map(copy => (
        <div key={copy.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <select value={copy.condition} disabled={busy} className={selectCls}
            onChange={e => patch(copy, { condition: e.target.value })}
            aria-label={t('copies.condition')}>
            {/* The stored value first, even when the vocabulary no longer
                offers it: a retired condition is still what this copy is, and
                dropping it would silently change the row on the next save. */}
            {!conditions.some(c => c.code === copy.condition) && copy.condition && (
              <option value={copy.condition}>{conditionLabel(copy.condition)}</option>
            )}
            {conditions.map(c => (
              <option key={c.code} value={c.code}>{conditionLabel(c.code)}</option>
            ))}
          </select>

          <CopyPlace copy={copy} locations={locations} options={placeOptions} prefix={prefix}
            busy={busy} selectCls={selectCls}
            onPlace={id => patch(copy, { location_id: id })}
            onShelf={(bookcase, shelf) => fileOnShelf(copy, bookcase, shelf)} />

          <label className="flex items-center gap-1.5 text-xs text-content-tertiary">
            <input type="checkbox" checked={copy.is_signed} disabled={busy}
              onChange={e => patch(copy, { is_signed: e.target.checked })}
              className="rounded border-line-strong" />
            {t('copies.signed')}
          </label>

          {copy.on_loan_to && (
            <span className="inline-flex items-center rounded-full bg-warning-surface px-2 py-0.5 text-xs font-medium text-warning-strong ring-1 ring-warning-line">
              {t('copies.lent_to', { name: copy.on_loan_to })}
            </span>
          )}

          <button onClick={() => removeCopy(copy)} disabled={busy}
            className="ml-auto text-xs text-danger hover:underline disabled:opacity-50">
            {t('copies.remove')}
          </button>
        </div>
      ))}
    </div>
  )
}

/** Where a copy sits: a place, and a shelf when the place is a bookcase. */
function CopyPlace({ copy, locations, options, prefix, busy, selectCls, onPlace, onShelf }: {
  copy: Copy
  locations: CopyLocation[]
  options: { id: string; label: string }[]
  prefix: string
  busy: boolean
  selectCls: string
  onPlace: (id: string | null) => void
  onShelf: (bookcase: CopyLocation, shelf: { name: string; place: CopyLocation | null }) => void
}) {
  const { t } = useTranslation()
  const spot = copy.location_id ? shelfSpot(copy.location_id, locations) : null
  const shelves = spot ? shelfChoices(spot.bookcase, locations, prefix) : []

  return (
    <>
      <select value={spot?.bookcase.id ?? copy.location_id ?? ''} disabled={busy} className={selectCls}
        onChange={e => onPlace(e.target.value || null)}
        aria-label={t('copies.location')}>
        <option value="">{t('copies.no_location')}</option>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {spot && shelves.length > 0 && (
        <select value={spot.shelf ?? ''} disabled={busy} className={selectCls}
          onChange={e => {
            const n = Number(e.target.value)
            const shelf = shelves.find(s => s.number === n)
            if (shelf) onShelf(spot.bookcase, shelf)
            else onPlace(spot.bookcase.id)
          }}
          aria-label={t('copies.shelf', { defaultValue: 'Shelf' })}>
          <option value="">{t('copies.no_shelf', { defaultValue: 'No shelf' })}</option>
          {shelves.map(s => <option key={s.number} value={s.number}>{s.name}</option>)}
        </select>
      )}
    </>
  )
}

/** "Add a copy", scoped to whichever printing it sits under. */
function AddCopyButton({ controls, editionId }: { controls: CopyControls; editionId?: string }) {
  const { t } = useTranslation()
  return (
    <button onClick={() => controls.addCopy(editionId)} disabled={controls.busy}
      className="inline-flex items-center gap-1 rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-content-tertiary hover:bg-surface-inset transition-colors disabled:opacity-50">
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
      {t('copies.add')}
    </button>
  )
}

// ─── File browser modal ───────────────────────────────────────────────────────

type BrowseTarget =
  | { kind: 'upload'; format: 'ebook' | 'audiobook'; label: string; rootPath: string }
  | { kind: 'location'; location: StorageLocation }

interface FileBrowserModalProps {
  libraryId: string
  bookId: string
  editionId: string
  editionFormat: string
  onLink: (file: EditionFile) => void
  onClose: () => void
}

function FileBrowserModal({ libraryId, bookId, editionId, editionFormat, onLink, onClose }: FileBrowserModalProps) {
  const { callApi } = useAuth()
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [target, setTarget] = useState<BrowseTarget | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Built-in upload path locations — always present
  const isAudiobook = editionFormat === 'audiobook'
  const uploadTargets: Extract<BrowseTarget, { kind: 'upload' }>[] = isAudiobook
    ? [{ kind: 'upload', format: 'audiobook', label: 'Audiobooks', rootPath: '' }]
    : [{ kind: 'upload', format: 'ebook', label: 'Ebooks', rootPath: '' }]

  useEffect(() => {
    callApi<StorageLocation[]>(`/api/v1/libraries/${libraryId}/storage-locations`)
      .then(locs => setLocations(locs ?? []))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId])

  const browseUpload = useCallback(async (format: 'ebook' | 'audiobook', path: string) => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ format })
      if (path) qs.set('path', path)
      const result = await callApi<{ root_path: string; entries: BrowseEntry[] }>(
        `/api/v1/libraries/${libraryId}/browse-uploads?${qs}`
      )
      setEntries(result?.entries ?? [])
      setCurrentPath(path)
      // Update root_path in target once known
      setTarget(prev =>
        prev?.kind === 'upload' && prev.format === format
          ? { ...prev, rootPath: result?.root_path ?? '' }
          : prev
      )
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to browse directory')
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId])

  const browseLocation = useCallback(async (location: StorageLocation, path: string) => {
    setLoading(true)
    setError(null)
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : ''
      const result = await callApi<BrowseEntry[]>(
        `/api/v1/libraries/${libraryId}/storage-locations/${location.id}/browse${qs}`
      )
      setEntries(result ?? [])
      setCurrentPath(path)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to browse directory')
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId])

  const selectTarget = (t: BrowseTarget) => {
    setTarget(t)
    setCurrentPath('')
    setEntries([])
    if (t.kind === 'upload') browseUpload(t.format, '')
    else browseLocation(t.location, '')
  }

  const navigateInto = (entry: BrowseEntry) => {
    if (!target || !entry.is_dir) return
    if (target.kind === 'upload') browseUpload(target.format, entry.path)
    else browseLocation(target.location, entry.path)
  }

  const navigateUp = () => {
    if (!target) return
    const parent = currentPath.includes('/') ? currentPath.substring(0, currentPath.lastIndexOf('/')) : ''
    if (target.kind === 'upload') browseUpload(target.format, parent)
    else browseLocation(target.location, parent)
  }

  const navigateToSegment = (segPath: string) => {
    if (!target) return
    if (target.kind === 'upload') browseUpload(target.format, segPath)
    else browseLocation(target.location, segPath)
  }

  const navigateToRoot = () => {
    if (!target) return
    if (target.kind === 'upload') browseUpload(target.format, '')
    else browseLocation(target.location, '')
  }

  const handleLink = async (entry: BrowseEntry) => {
    if (!target || entry.is_dir || !entry.is_bookable) return
    setLinking(true)
    try {
      let ef: EditionFile | null = null
      if (target.kind === 'upload') {
        ef = await callApi<EditionFile>(
          `/api/v1/libraries/${libraryId}/books/${bookId}/editions/${editionId}/files/link-upload`,
          { method: 'POST', body: JSON.stringify({ file_path: entry.path }) }
        ) ?? null
      } else {
        ef = await callApi<EditionFile>(
          `/api/v1/libraries/${libraryId}/books/${bookId}/editions/${editionId}/files/link`,
          { method: 'POST', body: JSON.stringify({ storage_location_id: target.location.id, file_path: entry.path }) }
        ) ?? null
      }
      if (ef) onLink(ef)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to link file')
    } finally {
      setLinking(false)
    }
  }

  const targetLabel = target?.kind === 'upload' ? target.label : target?.location.name ?? ''
  const targetRootPath = target?.kind === 'upload' ? target.rootPath : target?.location.root_path ?? ''
  const dirs = entries.filter(e => e.is_dir)
  const files = entries.filter(e => !e.is_dir)

  const sidebarBtnCls = (active: boolean) =>
    `w-full text-left px-2 py-1.5 rounded text-xs font-medium transition-colors truncate ${
      active
        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
    }`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-2xl flex flex-col" style={{ maxHeight: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line flex-shrink-0">
          <h2 className="text-sm font-semibold text-content">Browse server files</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <div className="w-48 flex-shrink-0 border-r border-line overflow-y-auto p-3 space-y-3">
            {/* Built-in upload paths */}
            <div>
              <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-content-subtle">Upload paths</p>
              <div className="space-y-0.5">
                {uploadTargets.map(t => (
                  <button key={t.kind === 'upload' ? t.format : ''} onClick={() => selectTarget(t)}
                    className={sidebarBtnCls(target?.kind === 'upload' && target.format === (t as { format: string }).format)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Configured storage locations */}
            {locations.length > 0 && (
              <div>
                <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-content-subtle">Storage locations</p>
                <div className="space-y-0.5">
                  {locations.map(loc => (
                    <button key={loc.id} onClick={() => selectTarget({ kind: 'location', location: loc })}
                      className={sidebarBtnCls(target?.kind === 'location' && target.location.id === loc.id)}>
                      {loc.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* File browser pane */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Breadcrumb */}
            {target && (
              <div className="flex items-center gap-1 px-4 py-2 border-b border-line text-xs text-content-muted flex-shrink-0 min-w-0">
                <button onClick={navigateToRoot} className="hover:text-content-secondary transition-colors font-medium flex-shrink-0">
                  {targetLabel}
                </button>
                {targetRootPath && (
                  <span className="text-content-faint font-mono truncate flex-shrink min-w-0 hidden sm:block">
                    &nbsp;({targetRootPath})
                  </span>
                )}
                {currentPath.split('/').filter(Boolean).map((seg, i, arr) => {
                  const segPath = arr.slice(0, i + 1).join('/')
                  return (
                    <span key={segPath} className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-content-faint">/</span>
                      <button onClick={() => navigateToSegment(segPath)} className="hover:text-content-secondary transition-colors max-w-[100px] truncate">
                        {seg}
                      </button>
                    </span>
                  )
                })}
              </div>
            )}

            {/* Directory contents */}
            <div className="flex-1 overflow-y-auto p-3">
              {!target && (
                <p className="text-xs text-content-subtle px-2 py-4 text-center">Select a location to browse.</p>
              )}
              {loading && (
                <p className="text-xs text-content-subtle px-2 py-4 text-center">Loading…</p>
              )}
              {error && (
                <p className="text-xs text-danger px-2 py-2">{error}</p>
              )}
              {!loading && target && entries.length === 0 && !error && (
                <p className="text-xs text-content-subtle px-2 py-4 text-center">This directory is empty.</p>
              )}
              {!loading && (
                <div className="space-y-0.5">
                  {currentPath && (
                    <button onClick={navigateUp}
                      className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-content-muted hover:bg-surface-inset transition-colors">
                      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                      ..
                    </button>
                  )}
                  {dirs.map(entry => (
                    <button key={entry.path} onClick={() => navigateInto(entry)}
                      className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-content-secondary hover:bg-surface-inset transition-colors">
                      <svg className="w-3.5 h-3.5 text-amber-400 dark:text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                      </svg>
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ))}
                  {files.map(entry => (
                    <button key={entry.path}
                      onClick={() => entry.is_bookable && handleLink(entry)}
                      disabled={linking || !entry.is_bookable}
                      title={entry.is_bookable ? `Link ${entry.name}` : 'Not a supported book format'}
                      className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs transition-colors group ${
                        entry.is_bookable
                          ? 'text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-700 dark:hover:text-blue-400 disabled:opacity-50 cursor-pointer'
                          : 'text-gray-400 dark:text-gray-600 cursor-default'
                      }`}>
                      <svg className={`w-3.5 h-3.5 flex-shrink-0 transition-colors ${entry.is_bookable ? 'text-gray-400 dark:text-gray-500 group-hover:text-blue-500' : 'text-gray-300 dark:text-gray-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                      <span className="truncate flex-1">{entry.name}</span>
                      {entry.size != null && (
                        <span className="text-content-subtle flex-shrink-0">
                          {(entry.size / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      )}
                      {entry.is_bookable && (
                        <span className="text-accent text-xs opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">Link</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Edition card ─────────────────────────────────────────────────────────────

interface EditionCardProps {
  edition: BookEdition
  libraryId: string
  bookId: string
  onEdit: (edition: BookEdition) => void
  onDeleted: () => void
  /** The objects that are this printing. A copy belongs to an edition, so it
   *  is shown inside one rather than in a list beside them. */
  copies: Copy[]
  copyControls: CopyControls
}

const READ_STATUS_PILL: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  read: {
    label: 'Read',
    cls: 'bg-success-surface text-success-strong ring-success-line ',
    icon: (
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
      </svg>
    ),
  },
  reading: {
    label: 'In Progress',
    cls: 'bg-accent-surface text-accent-strong ring-blue-200 dark:ring-blue-800',
    icon: (
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
  },
  did_not_finish: {
    label: 'Did Not Finish',
    cls: 'bg-warning-surface text-warning-strong ring-amber-200 dark:ring-amber-800',
    icon: (
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
  },
}

const DIGITAL_FORMATS = new Set(['ebook', 'digital', 'audiobook'])

function EditionCard({ edition: initialEdition, libraryId, bookId, onEdit, onDeleted, copies, copyControls }: EditionCardProps) {
  const { can } = usePermissions()
  const canUpdate = can('books:update', libraryId)
  const { callApi, getToken } = useAuth()
  const edition = initialEdition
  const [deleting, setDeleting] = useState(false)
  const [fileUploading, setFileUploading] = useState(false)
  const [fileRemoving, setFileRemoving] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [showBrowser, setShowBrowser] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<EditionFile[]>(initialEdition.files ?? [])
  const isDigital = DIGITAL_FORMATS.has(edition.format)

  const uploadFile = async (file: File) => {
    setFileUploading(true)
    setUploadError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const ef = await callApi<EditionFile>(`/api/v1/libraries/${libraryId}/books/${bookId}/editions/${edition.id}/files`, { method: 'POST', body: form })
      if (ef) setFiles(prev => [...prev, ef])
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : 'Upload failed')
    } finally { setFileUploading(false) }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? [])
    e.target.value = ''
    for (const file of selected) {
      await uploadFile(file)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files)
    for (const file of dropped) {
      await uploadFile(file)
    }
  }

  const handleFileRemove = async (ef: EditionFile) => {
    if (!confirm(`Remove "${ef.file_name || ef.file_format.toUpperCase()}" from this edition?`)) return
    setFileRemoving(true)
    try {
      await callApi(`/api/v1/libraries/${libraryId}/books/${bookId}/editions/${edition.id}/files/${ef.id}`, { method: 'DELETE' })
      setFiles(prev => prev.filter(f => f.id !== ef.id))
    } catch { /* silent */ }
    finally { setFileRemoving(false) }
  }

  const formatBadgeCls = () => {
    if (edition.format === 'ebook' || edition.format === 'digital')
      return 'bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-400 ring-purple-200 dark:ring-purple-800'
    if (edition.format === 'audiobook')
      return 'bg-warning-surface text-warning-strong ring-amber-200 dark:ring-amber-800'
    return 'bg-accent-surface text-accent-strong ring-blue-200 dark:ring-blue-800'
  }

  const handleDelete = async () => {
    if (!confirm('Delete this edition? This also removes any reading records for it.')) return
    setDeleting(true)
    try {
      await callApi(`/api/v1/libraries/${libraryId}/books/${bookId}/editions/${edition.id}`, { method: 'DELETE' })
      onDeleted()
    } catch {
      setDeleting(false)
    }
  }

  const metaItems: Array<{ label: string; value: React.ReactNode } | null> = [
    edition.publisher        ? { label: 'Publisher',  value: edition.publisher } : null,
    edition.language         ? { label: 'Language',   value: edition.language.toUpperCase() } : null,
    edition.publish_date     ? { label: 'Published',  value: edition.publish_date } : null,
    edition.isbn_13          ? { label: 'ISBN-13',    value: <span className="font-mono">{edition.isbn_13}</span> } : null,
    edition.isbn_10          ? { label: 'ISBN-10',    value: <span className="font-mono">{edition.isbn_10}</span> } : null,
    edition.page_count != null    ? { label: 'Pages',    value: `${edition.page_count}` } : null,
    edition.duration_seconds != null ? { label: 'Duration', value: `${Math.round(edition.duration_seconds / 3600 * 10) / 10} hrs` } : null,
    edition.narrator         ? { label: 'Narrator',   value: edition.narrator } : null,
    // Copies + Acquired moved to per-library display — follow-up work under M2M.
  ].filter(Boolean)

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 bg-surface-muted">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${formatBadgeCls()}`}>
            {edition.format}
          </span>
          {edition.is_primary && (
            <span className="inline-flex items-center rounded-full bg-success-surface px-2 py-0.5 text-xs font-medium text-success-strong ring-1 ring-success-line">
              Primary
            </span>
          )}
          {edition.edition_name && <span className="text-sm font-medium text-content">{edition.edition_name}</span>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {canUpdate && (<>
            <button onClick={() => onEdit(edition)}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-surface-strong transition-colors"
              title="Edit edition">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button onClick={handleDelete} disabled={deleting}
              className="p-1.5 rounded-md text-gray-400 hover:text-danger hover:bg-surface-strong transition-colors disabled:opacity-50"
              title="Delete edition">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </>)}
        </div>
      </div>

      {/* Metadata grid */}
      {metaItems.length > 0 && (
        <dl className="px-4 py-3 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2.5">
          {(metaItems as Array<{ label: string; value: React.ReactNode }>).map(item => (
            <div key={item.label}>
              <dt className="text-xs text-content-subtle">{item.label}</dt>
              <dd className="text-sm text-content-secondary mt-0.5">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* File attachments — digital editions only */}
      {isDigital && (
        <>
          <div
            className={`border-t transition-colors ${
              isDragging
                ? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-100 dark:border-gray-800'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Existing files list */}
            {files.map(ef => (
              <div key={ef.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <div className="min-w-0">
                    <span className="text-xs text-content-tertiary">
                      {ef.file_name || ef.file_format.toUpperCase()}
                      {ef.file_size != null && <span className="ml-1 text-content-subtle">({(ef.file_size / (1024 * 1024)).toFixed(1)} MB)</span>}
                    </span>
                    {ef.file_path && (
                      <p className="text-xs text-content-subtle font-mono truncate">
                        {ef.root_path ? <><span className="text-content-faint">{ef.root_path}/</span>{ef.file_path}</> : ef.file_path}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={async () => {
                      const token = await getToken()
                      const res = await fetch(withBase(`/api/v1/libraries/${libraryId}/books/${bookId}/editions/${edition.id}/files/${ef.id}`), {
                        headers: token ? { Authorization: `Bearer ${token}` } : {},
                      })
                      if (!res.ok) return
                      const blob = await res.blob()
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = ef.file_name || `${ef.id}.${ef.file_format}`
                      a.click()
                      URL.revokeObjectURL(url)
                    }}
                    className="px-2 py-1 rounded text-xs font-medium text-accent hover:bg-accent-surface transition-colors"
                  >
                    Download
                  </button>
                  <button
                    onClick={() => handleFileRemove(ef)}
                    disabled={fileRemoving}
                    className="px-2 py-1 rounded text-xs font-medium text-danger hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            {/* Add file row */}
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className={`text-xs truncate ${uploadError ? 'text-red-500 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>
                {uploadError ?? (isDragging ? 'Drop to upload' : files.length === 0 ? 'No files attached' : 'Drop to add another file')}
              </span>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={fileUploading}
                  className="px-2 py-1 rounded text-xs font-medium text-content-tertiary hover:bg-surface-inset transition-colors disabled:opacity-50"
                >
                  {fileUploading ? 'Uploading…' : 'Upload'}
                </button>
                <button
                  onClick={() => setShowBrowser(true)}
                  disabled={fileUploading}
                  className="px-2 py-1 rounded text-xs font-medium text-content-tertiary hover:bg-surface-inset transition-colors disabled:opacity-50"
                  title="Browse server files"
                >
                  Browse
                </button>
                <input ref={fileInputRef} type="file" className="hidden" multiple
                  accept=".epub,.pdf,.mobi,.azw3,.cbz,.cbr,.mp3,.m4a,.m4b,.aax,.ogg,.flac,.opus"
                  onChange={handleFileUpload} />
              </div>
            </div>
          </div>
          {showBrowser && (
            <FileBrowserModal
              libraryId={libraryId}
              bookId={bookId}
              editionId={edition.id}
              editionFormat={edition.format}
              onLink={ef => {
                setFiles(prev => [...prev, ef])
                setShowBrowser(false)
              }}
              onClose={() => setShowBrowser(false)}
            />
          )}
        </>
      )}

      {/* The objects that are this printing.
          Copies used to sit in a section of their own beside the editions,
          which read as two parallel things when one is a property of the
          other: an edition is how a book was published, a copy is the one on
          your shelf. */}
      <div className="border-t border-line-subtle px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-content-muted">
            {copies.length > 0 ? `Copies (${copies.length})` : 'Copies'}
          </p>
          <AddCopyButton controls={copyControls} editionId={edition.id} />
        </div>
        {copies.length === 0 ? (
          <p className="text-sm text-content-subtle">
            None recorded. Adding one says you have this printing on a shelf.
          </p>
        ) : (
          <CopyRows copies={copies} controls={copyControls} />
        )}
      </div>
    </div>
  )
}

// ─── Merged metadata modal ────────────────────────────────────────────────────

interface MergedMetadataModalProps {
  book: Book
  editions: BookEdition[]
  libraryId: string
  bookId: string
  onClose: () => void
  onApplied: () => void
}

// A by-title search result may have no ISBN at all (common for older/small-press
// editions — exactly the case ISFDB is strongest at). When one is picked and
// there's no ISBN to re-resolve through the merged-lookup endpoint, build a
// single-source "merged" result directly from it so the same field-diff/apply
// UI still works — just without cross-provider alternatives.
function toMergedFromSingle(r: ISBNLookupResult): MergedBookResult {
  const field = (value: string): MergedFieldResult | undefined =>
    value ? { value, source: r.provider, source_display: r.provider_display, alternatives: [] } : undefined
  return {
    title: field(r.title),
    subtitle: field(r.subtitle),
    authors: r.authors?.length ? { value: r.authors.join(', '), source: r.provider, source_display: r.provider_display, alternatives: [] } : undefined,
    description: field(r.description),
    publisher: field(r.publisher),
    publish_date: field(r.publish_date),
    language: field(r.language),
    isbn_10: field(r.isbn_10),
    isbn_13: field(r.isbn_13),
    page_count: r.page_count != null ? { value: String(r.page_count), source: r.provider, source_display: r.provider_display, alternatives: [] } : undefined,
    categories: r.categories,
    covers: r.cover_url ? [{ source: r.provider, source_display: r.provider_display, cover_url: r.cover_url }] : [],
  }
}

function MergedMetadataModal({ book, editions, libraryId, bookId, onClose, onApplied }: MergedMetadataModalProps) {
  const { callApi } = useAuth()
  const primaryEdition = editions.find(e => e.is_primary) ?? editions[0] ?? null
  const [mode, setMode] = useState<'isbn' | 'search'>('isbn')
  const [isbnInput, setIsbnInput] = useState(primaryEdition?.isbn_13 || primaryEdition?.isbn_10 || '')
  const [merged, setMerged] = useState<MergedBookResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ─── By-title search mode — lets the user resolve ambiguity manually,
  // unlike the batch enrichment job which only ever acts on an exact ISBN ───
  const [searchInput, setSearchInput] = useState(book.title)
  const [searchResults, setSearchResults] = useState<ISBNLookupResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // For each field key, the chosen alternative source (undefined = use primary)
  const [altChoice, setAltChoice] = useState<Record<string, string>>({})
  // Which field keys are selected to apply
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  // Selected cover index (-1 = don't apply)
  const [selectedCoverIdx, setSelectedCoverIdx] = useState(-1)

  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  const getEffectiveValue = (key: string, field: MergedFieldResult | undefined): string => {
    if (!field) return ''
    const chosen = altChoice[key]
    if (chosen) return field.alternatives?.find(a => a.source === chosen)?.value ?? field.value
    return field.value
  }

  const fieldDefs = (m: MergedBookResult) => [
    { key: 'title',        label: 'Title',       currentValue: book.title,                                          field: m.title },
    { key: 'subtitle',     label: 'Subtitle',    currentValue: book.subtitle,                                       field: m.subtitle },
    { key: 'authors',      label: 'Authors',     currentValue: book.contributors.map(c => c.name).join(', '),       field: m.authors },
    { key: 'description',  label: 'Description', currentValue: book.description,                                    field: m.description, multiline: true },
    { key: 'publisher',    label: 'Publisher',   currentValue: primaryEdition?.publisher ?? '',                     field: m.publisher },
    { key: 'publish_date', label: 'Pub. date',   currentValue: primaryEdition?.publish_date ?? '',                  field: m.publish_date },
    { key: 'language',     label: 'Language',    currentValue: primaryEdition?.language ?? '',                      field: m.language },
    { key: 'isbn_10',      label: 'ISBN-10',     currentValue: primaryEdition?.isbn_10 ?? '',                       field: m.isbn_10, mono: true },
    { key: 'isbn_13',      label: 'ISBN-13',     currentValue: primaryEdition?.isbn_13 ?? '',                       field: m.isbn_13, mono: true },
    { key: 'page_count',   label: 'Page count',  currentValue: primaryEdition?.page_count != null ? String(primaryEdition.page_count) : '', field: m.page_count },
  ].filter(fd => !!fd.field)

  // Shared by both the ISBN and by-title paths once a MergedBookResult is in
  // hand — pre-selects fields that actually differ from the book's current
  // values, same as before.
  const applyMergedResult = (result: MergedBookResult) => {
    setAltChoice({})
    setMerged(result)
    const defs = fieldDefs(result)
    setEnabled(new Set(defs.filter(fd => fd.field!.value !== fd.currentValue).map(fd => fd.key)))
    setSelectedCoverIdx(!book.cover_url && (result.covers?.length ?? 0) > 0 ? 0 : -1)
  }

  const doSearch = async (isbn: string) => {
    const q = isbn.trim()
    if (!q) return
    setLoading(true); setError(null); setMerged(null)
    try {
      const result = await callApi<MergedBookResult>(`/api/v1/lookup/isbn/${encodeURIComponent(q)}/merged`)
      if (!result) { setError('No results found.'); return }
      applyMergedResult(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Lookup failed')
    } finally {
      setLoading(false)
    }
  }

  // Declared after doSearch so the effect closes over the real function
  // rather than reaching above its declaration. Runs once on open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isbnInput) doSearch(isbnInput) }, [])

  // Switching tabs clears any diff view from the other tab (e.g. the
  // auto-run ISBN search on mount) so a stale result can't linger and look
  // like it belongs to the tab you just switched to.
  const switchMode = (m: 'isbn' | 'search') => {
    setMode(m)
    setMerged(null)
    setError(null)
  }

  const doBookSearch = async (query: string) => {
    const q = query.trim()
    if (!q) return
    // Clear any diff view left over from the auto-run ISBN search on mount
    // (or a previous pick) — otherwise the results list below stays hidden
    // behind `!merged` and a title search silently appears to do nothing.
    setMerged(null)
    setSearchLoading(true); setSearchError(null); setSearchResults([])
    try {
      const results = await callApi<ISBNLookupResult[]>(`/api/v1/lookup/books?q=${encodeURIComponent(q)}`)
      setSearchResults(results ?? [])
      if (!results || results.length === 0) setSearchError('No results found.')
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Unable to retrieve results — please try again later.')
    } finally {
      setSearchLoading(false)
    }
  }

  // Picking a search result resolves ambiguity manually — the whole point of
  // this tab. When it has an ISBN, re-resolve through the merged-lookup
  // endpoint to pull in any other providers' data for that same edition too;
  // when it doesn't (common for older ISFDB editions), use its data directly.
  // Deliberately never re-resolves through /lookup/isbn/{isbn}/merged, even
  // when the picked result has an ISBN. A single ISBN can span several
  // distinct ISFDB printings (same book, different publisher/year/cover —
  // Panther reused one ISBN for 1969/1973/1977 reprints of Camp
  // Concentration), and that endpoint has no way to know which one the user
  // meant — it returns whichever ISFDB happens to pick first, which silently
  // swapped in a different edition's data here during testing. Trusting only
  // the exact record the user clicked is the whole point of this tab.
  const selectSearchResult = (r: ISBNLookupResult) => {
    setError(null)
    applyMergedResult(toMergedFromSingle(r))
  }

  const resolveContributors = async (names: string[]) => {
    const out: Array<{ contributor_id: string; role: string; display_order: number }> = []
    for (const name of names) {
      try {
        const matches = await callApi<ContributorResult[]>(`/api/v1/contributors?q=${encodeURIComponent(name)}`)
        const exact = (matches ?? []).find(c => c.name.toLowerCase() === name.toLowerCase())
        if (exact) {
          out.push({ contributor_id: exact.id, role: 'author', display_order: out.length })
        } else {
          const c = await callApi<ContributorResult>('/api/v1/contributors', { method: 'POST', body: JSON.stringify({ name }) })
          if (c) out.push({ contributor_id: c.id, role: 'author', display_order: out.length })
        }
      } catch { /* skip */ }
    }
    return out.filter((c, i, arr) => arr.findIndex(x => x.contributor_id === c.contributor_id && x.role === c.role) === i)
  }

  const handleApply = async () => {
    if (!merged) return
    setApplying(true); setApplyError(null)
    try {
      const pick = (key: string, current: string) =>
        enabled.has(key) ? (getEffectiveValue(key, merged[key as keyof MergedBookResult] as MergedFieldResult | undefined) || current) : current

      let contribs = book.contributors.map((c, i) => ({ contributor_id: c.contributor_id, role: c.role, display_order: i }))
      if (enabled.has('authors') && merged.authors) {
        const chosen = altChoice.authors
        contribs = await resolveContributors(authorNames(
          (chosen && merged.authors.alternatives?.find(a => a.source === chosen)) || merged.authors))
      }

      await callApi(`/api/v1/libraries/${libraryId}/books/${bookId}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: pick('title', book.title),
          subtitle: pick('subtitle', book.subtitle),
          description: pick('description', book.description),
          media_type_id: book.media_type_id,
          contributors: contribs,
          tag_ids: book.tags.map(t => t.id),
          genre_ids: (book.genres ?? []).map(g => g.id),
        }),
      })

      if (primaryEdition) {
        const edKeys = ['publisher', 'publish_date', 'language', 'isbn_10', 'isbn_13', 'page_count']
        if (edKeys.some(k => enabled.has(k))) {
          await callApi(`/api/v1/libraries/${libraryId}/books/${bookId}/editions/${primaryEdition.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              format: primaryEdition.format, edition_name: primaryEdition.edition_name,
              narrator: primaryEdition.narrator, is_primary: primaryEdition.is_primary,
              duration_seconds: primaryEdition.duration_seconds,
              description: primaryEdition.description,
              language: pick('language', primaryEdition.language ?? ''),
              publisher: pick('publisher', primaryEdition.publisher ?? ''),
              publish_date: pick('publish_date', primaryEdition.publish_date ?? ''),
              isbn_10: pick('isbn_10', primaryEdition.isbn_10 ?? ''),
              isbn_13: pick('isbn_13', primaryEdition.isbn_13 ?? ''),
              page_count: enabled.has('page_count') && merged.page_count
                ? (parseInt(getEffectiveValue('page_count', merged.page_count)) || primaryEdition.page_count)
                : primaryEdition.page_count,
            }),
          })
        }
      }

      if (selectedCoverIdx >= 0 && merged.covers?.[selectedCoverIdx]) {
        try {
          await callApi(`/api/v1/libraries/${libraryId}/books/${bookId}/cover/fetch`, {
            method: 'POST', body: JSON.stringify({ url: merged.covers[selectedCoverIdx].cover_url }),
          })
        } catch { /* non-fatal */ }
      }

      onApplied(); onClose()
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : 'Failed to apply')
    } finally {
      setApplying(false)
    }
  }

  const defs = merged ? fieldDefs(merged) : []
  const selectedCount = defs.filter(fd => enabled.has(fd.key)).length + (selectedCoverIdx >= 0 ? 1 : 0)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-16 px-4">
      <div className="w-full max-w-xl rounded-xl bg-surface shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 className="text-base font-semibold text-content">Refresh metadata</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-content-tertiary text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* ISBN vs by-title tabs — by-title exists so ambiguous/no-ISBN
              editions (the batch enrichment job only ever acts on an exact
              ISBN) can still be resolved, with a person picking the result. */}
          <div className="flex rounded-lg bg-surface-inset p-1">
            <button type="button" onClick={() => switchMode('isbn')}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'isbn' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              By ISBN
            </button>
            <button type="button" onClick={() => switchMode('search')}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${mode === 'search' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              By Title
            </button>
          </div>

          {mode === 'isbn' ? (
            <div className="flex gap-2">
              <input type="text" value={isbnInput} onChange={e => setIsbnInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch(isbnInput)}
                placeholder="ISBN-10 or ISBN-13…"
                className="flex-1 rounded-lg border border-line-strong dark:bg-gray-800 dark:text-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <button onClick={() => doSearch(isbnInput)} disabled={loading || !isbnInput.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {loading ? '…' : 'Search'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && doBookSearch(searchInput)}
                  placeholder="Search by title, author, or keyword…"
                  className="flex-1 rounded-lg border border-line-strong dark:bg-gray-800 dark:text-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                <button onClick={() => doBookSearch(searchInput)} disabled={searchLoading || !searchInput.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {searchLoading ? '…' : 'Search'}
                </button>
              </div>
              {searchError && <p className="text-sm text-danger">{searchError}</p>}
              {searchLoading && <p className="text-sm text-content-subtle">Searching providers…</p>}
              {!merged && searchResults.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
                    {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} — pick the edition you own
                  </p>
                  <div className="max-h-72 overflow-y-auto space-y-2">
                    {searchResults.map((r, i) => (
                      <button key={i} type="button" onClick={() => selectSearchResult(r)}
                        className="w-full text-left rounded-xl border border-line bg-surface-muted p-3 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-accent-surface transition-colors">
                        <div className="flex gap-3">
                          {r.cover_url ? (
                            <img src={r.cover_url} alt="" referrerPolicy="no-referrer" className="w-10 h-14 object-cover rounded flex-shrink-0 bg-surface-strong" />
                          ) : (
                            <div className="w-10 h-14 rounded flex-shrink-0 bg-surface-strong" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm text-content truncate">{r.title}</p>
                            {r.subtitle && <p className="text-xs text-content-muted truncate">{r.subtitle}</p>}
                            {r.authors?.length > 0 && <p className="text-xs text-content-tertiary mt-0.5 truncate">{r.authors.join(', ')}</p>}
                            <div className="flex items-center gap-2 mt-1">
                              {r.publisher && <span className="text-xs text-content-subtle truncate">{r.publisher}</span>}
                              {r.publisher && r.publish_date && <span className="text-content-faint">·</span>}
                              {r.publish_date && <span className="text-xs text-content-subtle">{r.publish_date.slice(0, 4)}</span>}
                              <span className="text-content-faint">·</span>
                              <span className="text-xs text-content-subtle">{r.provider_display}</span>
                              {!r.isbn_13 && !r.isbn_10 && <span className="text-xs text-amber-600 dark:text-amber-500">no ISBN</span>}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'isbn' && error && <p className="text-sm text-danger">{error}</p>}
          {mode === 'isbn' && loading && <p className="text-sm text-content-subtle">Searching providers…</p>}

          {merged && (
            <>
              {/* Field rows */}
              <div className="rounded-xl border border-line overflow-hidden">
                <div className="divide-y divide-line-subtle">
                  {defs.map(fd => {
                    const effectiveValue = getEffectiveValue(fd.key, fd.field)
                    const isSame = effectiveValue === fd.currentValue
                    const isOn = enabled.has(fd.key)
                    const hasAlts = (fd.field?.alternatives?.length ?? 0) > 0
                    const sourceDisplay = altChoice[fd.key]
                      ? fd.field!.alternatives.find(a => a.source === altChoice[fd.key])?.source_display ?? fd.field!.source_display
                      : fd.field!.source_display

                    return (
                      <div key={fd.key} className={`flex items-start gap-3 px-4 py-3 ${isSame ? 'opacity-50' : ''}`}>
                        <input type="checkbox" checked={isOn && !isSame} disabled={isSame}
                          onChange={() => { if (!isSame) setEnabled(prev => { const s = new Set(prev); if (isOn) s.delete(fd.key); else s.add(fd.key); return s }) }}
                          className="mt-0.5 rounded border-line-strong text-blue-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-wider text-content-subtle">{fd.label}</p>
                          {isSame ? (
                            <p className={`mt-0.5 text-sm text-content-muted ${fd.multiline ? 'line-clamp-2' : 'truncate'}`}>
                              {effectiveValue || '(empty)'}
                            </p>
                          ) : (
                            <>
                              <p className={`mt-0.5 text-sm text-content-subtle ${fd.multiline ? 'line-clamp-1' : 'truncate'} ${fd.currentValue ? 'line-through' : 'italic'}`}>
                                {fd.currentValue || '(empty)'}
                              </p>
                              <p className={`text-sm text-accent mt-0.5 ${fd.multiline ? 'line-clamp-2' : 'truncate'} ${fd.mono ? 'font-mono text-xs' : ''}`}>
                                {effectiveValue}
                              </p>
                            </>
                          )}
                        </div>
                        <div className="flex-shrink-0 flex flex-col items-end gap-1">
                          {isSame ? (
                            <span className="text-xs text-content-faint">same</span>
                          ) : hasAlts ? (
                            <select
                              value={altChoice[fd.key] ?? ''}
                              onChange={e => setAltChoice(prev => ({ ...prev, [fd.key]: e.target.value }))}
                              className="text-xs rounded border border-line bg-surface-raised text-content-tertiary px-1.5 py-0.5 focus:outline-none focus:border-blue-400"
                            >
                              <option value="">{fd.field!.source_display}</option>
                              {fd.field!.alternatives.map(alt => (
                                <option key={alt.source} value={alt.source}>{alt.source_display}</option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-xs text-content-subtle">{sourceDisplay}</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Covers */}
              {(merged.covers?.length ?? 0) > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-content-subtle mb-2">Cover</p>
                  <div className="flex gap-3 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setSelectedCoverIdx(-1)}
                      className={`rounded-lg border-2 px-3 py-2 text-xs font-medium transition-colors ${selectedCoverIdx === -1 ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'}`}
                    >
                      Keep current
                    </button>
                    {merged.covers!.map((cover, idx) => (
                      <button key={cover.source} type="button" onClick={() => setSelectedCoverIdx(idx)}
                        className={`flex flex-col items-center gap-1 rounded-lg border-2 p-1.5 transition-colors ${selectedCoverIdx === idx ? 'border-blue-500' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'}`}>
                        <img src={cover.cover_url} alt="" referrerPolicy="no-referrer" className="h-16 w-11 object-cover rounded" />
                        <span className="text-xs text-content-muted">{cover.source_display}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {applyError && (
                <p className="text-sm text-danger">{applyError}</p>
              )}

              <div className="flex justify-end">
                <button onClick={handleApply} disabled={applying || selectedCount === 0}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {applying ? 'Applying…' : selectedCount > 0 ? `Apply ${selectedCount} change${selectedCount !== 1 ? 's' : ''}` : 'Nothing selected'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="pt-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-content-muted">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BookPage() {
  const { libraryId, bookId } = useParams<{ libraryId: string; bookId: string }>()
  const navigate = useNavigate()
  const { callApi } = useAuth()
  const { setExtraCrumbs } = useOutletContext<LibraryOutletContext>()
  const { t } = useTranslation()
  const toast = useToast()
  // Controls a viewer can't use are left out rather than left to fail.
  const { can } = usePermissions()
  const canUpdate = can('books:update', libraryId)
  const canLend = can('loans:create', libraryId)

  const [book, setBook] = useState<Book | null>(null)
  const [editions, setEditions] = useState<BookEdition[]>([])
  // The lists this book is on, private ones included. The shelf read only ever
  // returned lists shared with a library, so a list made anywhere else was
  // invisible on the page for the book that is on it.
  const [bookLists, setBookLists] = useState<SavedList[]>([])
  const [seriesRefs, setSeriesRefs] = useState<BookSeriesRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showMetaSearch, setShowMetaSearch] = useState(false)
  const [showEditBook, setShowEditBook] = useState(false)
  const [showLend, setShowLend] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Loan[] | null>(null)
  const [editionModal, setEditionModal] = useState<'add' | BookEdition | null>(null)
  const [coverUploading, setCoverUploading] = useState(false)
  const coverInputRef = useRef<HTMLInputElement>(null)

  // With no copy left here the book is no longer in this library, so it has
  // left Books too and its page is an empty shell. Back to the list then, with
  // a word so the jump doesn't read as something going wrong.
  const heldHere = (copies: Copy[]) => copies.some(c => c.library_id === libraryId)
  const backToBooks = () => {
    announceCollectionChanged()
    if (book) toast.show(t('copies.book_gone', { title: book.title }))
    navigate('/books', { replace: true })
  }

  // One fetch for the whole page: the conditions vocabulary and the library's
  // locations are the same for every printing, so asking per card would be one
  // request per edition for one answer.
  const copyControls = useCopies(bookId ?? '', libraryId ?? '', left => { if (!heldHere(left)) backToBooks() })
  const unattributedCopies = copyControls.copies.filter(c => !c.edition_id)

  const load = useCallback(async () => {
    if (!libraryId || !bookId) return
    setError(null)
    try {
      const b = await callApi<Book>(`/api/v1/libraries/${libraryId}/books/${bookId}`)
      if (!b) { navigate(`/libraries/${libraryId}/books`, { replace: true }); return }
      setBook(b)

      const [eds, lsts, srs] = await Promise.all([
        callApi<BookEdition[]>(`/api/v1/libraries/${libraryId}/books/${bookId}/editions`),
        callApi<{ items: SavedList[] }>(`/api/v1/books/${bookId}/lists`),
        callApi<BookSeriesRef[]>(`/api/v1/libraries/${libraryId}/books/${bookId}/series`),
      ])
      setEditions(eds ?? [])
      setBookLists(lsts?.items ?? [])
      setSeriesRefs(srs ?? [])
      return eds ?? []
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate(`/libraries/${libraryId}`, { replace: true })
        return
      }
      setError(err instanceof ApiError ? err.message : 'Failed to load book')
    }
  }, [callApi, libraryId, bookId, navigate])

  useEffect(() => { load() }, [load])

  // Copies of a deleted edition stay, filed under no edition, so they are read
  // again too. Nothing left of either means the book has nothing here.
  const editionDeleted = async () => {
    const [eds, left] = await Promise.all([load(), copyControls.reload()])
    if (eds?.length === 0 && !heldHere(left)) backToBooks()
  }

  useEffect(() => {
    if (book) setExtraCrumbs([
      { label: 'Books', to: `/libraries/${libraryId}/books` } as Crumb,
      { label: book.title },
    ])
    return () => setExtraCrumbs([])
  }, [book, setExtraCrumbs])

  // Eager-load loan history alongside the book so we can hide the
  // section entirely on books that have never been lent. Cheap one-shot
  // GET; the trade-off vs lazy-loading on disclosure-open is that we
  // don't render an empty "Loan history" header on books with none.
  // Lives above the early `error` return so hook order stays stable.
  const loadHistory = useCallback(async () => {
    if (!libraryId || !bookId) return
    const list = await callApi<Loan[]>(
      `/api/v1/libraries/${libraryId}/loans?include_returned=true&book_id=${bookId}`,
    ).catch(() => null)
    setHistory(list ?? [])
  }, [callApi, libraryId, bookId])

  useEffect(() => { loadHistory() }, [loadHistory])

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-lg bg-danger-surface border border-danger-line px-4 py-3 text-sm text-danger-strong">
          {error}
        </div>
      </div>
    )
  }

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset input so re-selecting the same file still fires onChange
    e.target.value = ''
    if (file.size > MAX_IMAGE_BYTES) {
      toast.show(tooLargeMessage(t), { variant: 'error' })
      return
    }
    setCoverUploading(true)
    try {
      const form = new FormData()
      form.append('cover', file)
      await callApi(`/api/v1/libraries/${libraryId}/books/${bookId}/cover`, {
        method: 'PUT',
        body: form,
      })
      load()
    } catch (err) {
      toast.show(imageUploadError(err, t), { variant: 'error' })
    } finally { setCoverUploading(false) }
  }

  const handleMarkReturned = async (loan: Loan) => {
    const today = new Date().toISOString().slice(0, 10)
    await callApi(`/api/v1/libraries/${libraryId}/loans/${loan.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        loaned_to: loan.loaned_to,
        due_date: loan.due_date,
        returned_at: today,
        notes: loan.notes,
      }),
    }).catch(() => {})
    load()
    // Refresh history so the just-returned loan shows up there too.
    loadHistory()
  }

  const handleCoverDelete = async () => {
    if (!confirm('Remove cover image?')) return
    setCoverUploading(true)
    try {
      await callApi(`/api/v1/libraries/${libraryId}/books/${bookId}/cover`, { method: 'DELETE' })
      load()
    } finally { setCoverUploading(false) }
  }

  if (!book) {
    return <div className="p-8 text-sm text-content-subtle">Loading…</div>
  }

  return (
    // Stacks on a phone. Side by side, a fixed 12rem cover plus the page
    // padding left about 150px for the details, which wrapped the title
    // mid-name. The cover keeps a sensible size rather than going full width,
    // and only sticks once there is a column for it to stick beside.
    <div className="p-4 sm:p-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:gap-8 sm:items-start">

        {/* ── Left sidebar ── */}
        <div className="w-40 flex-shrink-0 space-y-5 sm:sticky sm:top-8 sm:w-48">

          {/* Cover with hover overlay */}
          <div className={`relative group ${canUpdate ? 'cursor-pointer' : ''}`}
            onClick={() => canUpdate && !coverUploading && coverInputRef.current?.click()}>
            <BookCover title={book.title} coverUrl={book.cover_url} className="w-full" />
            <input ref={coverInputRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={handleCoverUpload} />
            {canUpdate && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
              <button type="button" disabled={coverUploading}
                onClick={e => { e.stopPropagation(); coverInputRef.current?.click() }}
                className="rounded-md bg-white/90 px-3 py-1.5 text-xs font-medium text-gray-900 hover:bg-white disabled:opacity-50 transition-colors">
                {coverUploading ? 'Uploading…' : book.cover_url ? 'Change cover' : 'Add cover'}
              </button>
              {book.cover_url && !coverUploading && (
                <button type="button"
                  onClick={e => { e.stopPropagation(); handleCoverDelete() }}
                  className="rounded-md bg-white/90 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-white transition-colors">
                  Remove
                </button>
              )}
            </div>}
          </div>


          {/* Reading state sits with the book, not with a printing. It used to
              live inside each edition card, so a book with two editions asked
              which paperback you meant before it would let you say you had read
              the story. */}
          <ReadingPanel bookId={book.id} />
          {/* Media type + tags */}
          <div className="flex flex-wrap gap-1.5">
            <span className="inline-flex items-center rounded-full bg-surface-inset px-2.5 py-0.5 text-xs font-medium text-content-tertiary">
              {book.media_type}
            </span>
            {book.tags.map(tag => (
              <span key={tag.id}
                className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
                style={{ backgroundColor: tag.color || '#6b7280' }}>
                {tag.name}
              </span>
            ))}
          </div>
          {/* Genres */}
          {book.genres?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {book.genres.map(genre => (
                <span key={genre.id}
                  className="inline-flex items-center rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-content-tertiary">
                  {genre.name}
                </span>
              ))}
            </div>
          )}

          {/* Contributors */}
          {book.contributors.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-content-subtle mb-2">
                {book.contributors.length === 1 && book.contributors[0].role === 'author' ? 'Author' : 'Contributors'}
              </p>
              <div className="space-y-2">
                {book.contributors.map(c => (
                  <Link key={c.contributor_id} to={`/libraries/${libraryId}/contributors/${c.contributor_id}`} className="block group/contrib">
                    <p className="text-sm font-medium text-content group-hover/contrib:text-accent transition-colors">{c.name}</p>
                    <p className="text-xs text-content-muted capitalize">{c.role}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* There was a "primary edition quick-ref" here: publisher, published,
              language, ISBN and pages, read off whichever edition is primary.
              It restated the primary edition's own panel a few hundred pixels
              to the right, on the same screen without scrolling, so it saved
              nobody a trip. Worse on a book with several: publisher and page
              count are per-edition under FRBR, and printed here with no edition
              named, Dune's four editions became one unqualified "Chilton, 618
              pages" beside a list showing three different publishers. The
              editions list already says all of it, attributed to the edition it
              belongs to and badged for which one is primary. */}
        </div>

        {/* ── Right main column ── */}
        <div className="flex-1 min-w-0">

          {/* Subtitle and actions.
              The title was here too, as a second h1 forty-five pixels under the
              one the sticky header already renders, so the page opened by
              saying "Dune 1" twice — and two h1s meant a screen reader had to
              pick which was the page heading. The header's is sticky, so it is
              the one that survives scrolling and the one worth keeping; the
              subtitle stays because nothing else shows it. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {book.subtitle && (
                <p className="text-base text-content-muted">{book.subtitle}</p>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
{canLend && (
                <button onClick={() => setShowLend(true)} title="Lend this book"
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-surface-inset transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                  </svg>
                </button>
              )}
              {canUpdate && (<>
                <button onClick={() => setShowEditBook(true)} title="Edit book"
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-surface-inset transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button onClick={() => setShowMetaSearch(true)} title="Refresh metadata"
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-surface-inset transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
              </>)}
            </div>
          </div>

          {/* Active loans — surfaces loans where this book is currently
              lent out so the user doesn't have to navigate to /loans. The
              schema allows multi-active loans (when the user owns more than
              one copy), so we render every active row. */}
          {book.active_loans && book.active_loans.length > 0 && (
            <Section title={book.active_loans.length === 1 ? 'Currently lent' : `Currently lent (${book.active_loans.length})`}>
              <div className="space-y-2">
                {book.active_loans.map(loan => {
                  const today = new Date().toISOString().slice(0, 10)
                  const overdue = !!loan.due_date && loan.due_date < today
                  return (
                    <div key={loan.id}
                      className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-warning-surface flex items-center justify-center">
                          <svg className="w-4 h-4 text-amber-500 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                          </svg>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-content truncate">
                            Lent to {loan.loaned_to}
                          </p>
                          <p className="text-xs text-content-muted">
                            <span>Loaned {loan.loaned_at}</span>
                            {loan.due_date && (
                              <span className={overdue ? 'ml-2 text-danger font-medium' : 'ml-2'}>
                                · Due {loan.due_date}{overdue && ' (overdue)'}
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                      <button onClick={() => handleMarkReturned(loan)}
                        className="rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-content-secondary hover:bg-surface-muted transition-colors whitespace-nowrap flex-shrink-0">
                        Mark returned
                      </button>
                    </div>
                  )
                })}
              </div>
            </Section>
          )}

          {/* Loan history — disclosure pattern, collapsed by default.
              The whole section hides on books with no recorded loans;
              we eager-fetch above so we know whether to render at all. */}
          {history && history.length > 0 && (
            <div className="pt-6">
              <button onClick={() => setHistoryOpen(o => !o)}
                className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-content-muted hover:text-content-secondary transition-colors">
                <svg className={`w-3.5 h-3.5 transition-transform ${historyOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Loan history
                <span className="text-xs font-normal normal-case tracking-normal text-content-subtle">
                  ({history.length})
                </span>
              </button>
              {historyOpen && (
                <div className="mt-3 rounded-xl border border-line bg-surface overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-muted border-b border-line">
                      <tr>
                        {['Loaned to', 'Loaned', 'Due', 'Returned'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-content-muted">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line-subtle">
                      {history.map(loan => (
                        <tr key={loan.id}>
                          <td className="px-4 py-2.5 text-content-secondary">{loan.loaned_to}</td>
                          <td className="px-4 py-2.5 text-xs text-content-muted">{loan.loaned_at}</td>
                          <td className="px-4 py-2.5 text-xs text-content-muted">{loan.due_date ?? <span className="text-content-faint">—</span>}</td>
                          <td className="px-4 py-2.5 text-xs text-content-muted">{loan.returned_at ?? <span className="text-warning">Active</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Description */}
          {book.description && (
            <Section title="Description">
              <p className="text-sm text-content-secondary whitespace-pre-wrap leading-relaxed">
                {book.description}
              </p>
            </Section>
          )}

          {/* Always rendered, in a series or not. Hiding it when the book was
              in none meant the only way to put it in one was the per-library
              page, which is what librarium-web#85 calls a different part of the
              app. */}
          <Section title="Series">
            <BookSeries
              bookId={bookId ?? ''}
              libraryId={libraryId ?? ''}
              refs={seriesRefs}
              onChanged={() => void load()}
            />
          </Section>

          {/* Always rendered, whether or not anything is recorded. The table
              has been empty since it shipped because there was no surface to
              write a row from, so an empty-hides rule would keep it that way. */}
          <Section title="Contains">
            <BookContents bookId={bookId ?? ''} libraryId={libraryId ?? ''} />
          </Section>

          {/* Always rendered, pills or not. Hiding it when the book was on
              nothing meant the first list could never be added from here. */}
          <Section title="On lists">
            <BookLists bookId={bookId ?? ''} lists={bookLists} onChanged={() => void load()} />
          </Section>

          {/* What everyone else thought. The component owns its heading and
              renders nothing at all when there is nobody else, so a one-person
              library never meets an empty section. */}
          <BookReaders bookId={bookId ?? ''} />

          {/* Editions */}
          <Section
            title={`Editions${editions.length > 0 ? ` (${editions.length})` : ''}`}
            action={canUpdate && (
                <button onClick={() => setEditionModal('add')}
                  className="inline-flex items-center gap-1 rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-content-tertiary hover:bg-surface-inset transition-colors">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add edition
                </button>
            )
            }
          >
            {editions.length === 0 ? (
              <p className="text-sm text-content-subtle">No editions recorded yet.</p>
            ) : (
              <div className="space-y-3">
                {editions.map(e => (
                  <EditionCard key={e.id} edition={e} libraryId={libraryId!} bookId={bookId!}
                    onEdit={setEditionModal}
                    onDeleted={() => void editionDeleted()}
                    copies={copyControls.copies.filter(c => c.edition_id === e.id)}
                    copyControls={copyControls}
                  />
                ))}
              </div>
            )}
          </Section>

          {/* Copies whose printing was never recorded.
              A supported state rather than a gap: a book can be on a shelf
              with nobody having said which edition it is, and nesting copies
              strictly under editions would leave these with nowhere to go. */}
          {unattributedCopies.length > 0 && (
            <Section
              title={`Copies with no edition (${unattributedCopies.length})`}
              action={<AddCopyButton controls={copyControls} />}
            >
              <p className="mb-2 text-sm text-content-subtle">
                These are on a shelf, but nobody has recorded which printing.
                Editing one and choosing an edition files it above.
              </p>
              <CopyRows copies={unattributedCopies} controls={copyControls} />
            </Section>
          )}
        </div>
      </div>

      {showEditBook && book && (
        <EditBookModal
          libraryId={libraryId!}
          book={book}
          onClose={() => setShowEditBook(false)}
          onSaved={updated => { setBook(updated); setShowEditBook(false) }}
        />
      )}

      {showLend && book && (
        <LoanFormModal
          libraryId={libraryId!}
          prefillBook={{ id: book.id, title: book.title }}
          onClose={() => setShowLend(false)}
          onSaved={() => {
            setShowLend(false)
            // Refresh the book (active_loans) and the history list so the
            // new loan shows in both the "Currently lent" panel and the
            // history disclosure without a manual page reload.
            load()
            loadHistory()
          }}
        />
      )}

      {showMetaSearch && (
        <MergedMetadataModal
          book={book}
          editions={editions}
          libraryId={libraryId!}
          bookId={bookId!}
          onClose={() => setShowMetaSearch(false)}
          onApplied={load}
        />
      )}

      {editionModal !== null && (
        <AddEditionModal
          libraryId={libraryId!}
          bookId={bookId!}
          edition={editionModal === 'add' ? null : editionModal}
          contributors={book.contributors}
          onClose={() => setEditionModal(null)}
          onSaved={() => { setEditionModal(null); load() }}
        />
      )}
    </div>
  )
}
