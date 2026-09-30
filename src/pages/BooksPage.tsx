// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 FireBall1725
//
// Books: one surface across every library the caller can read, with library as
// a filter rather than a folder you navigate into.
//
// Deliberately a new page rather than surgery on LibraryPage, which is 6,000+
// lines. The old per-library route keeps working until the redesign's later
// tranches replace it.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { COLLECTION_CHANGED, announceCollectionChanged } from '../lib/collectionEvents'
import { formatStars, starsOf } from '../lib/rating'
import { Stars } from '../components/StarRating'
import { useAuth } from '../auth/AuthContext'
import PageHeader from '../components/PageHeader'
import { PromptDialog, type PromptExtras } from '../components/Dialog'
import { TAG_COLORS } from '../lib/tagColours'
import AddBooksDialog from '../components/addBooks/AddBooksDialog'
import FacetRail from '../components/FacetRail'
import SidePanel from '../components/SidePanel'
import FilterSearch from '../components/FilterSearch'
import BookBulkBar from '../components/BookBulkBar'
import LibraryPickerDialog from '../components/LibraryPickerDialog'
import BookCover, { BookCoverThumb } from '../components/BookCover'
import { usePageTitle } from '../hooks/usePageTitle'
import { useContributorNames } from '../hooks/useContributorNames'
import type { TFunction } from 'i18next'
import { type IconName } from '../lib/icons'
import { LIST_ICONS } from '../lib/listIcons'
import ViewChip from '../components/ViewChip'
import SortMenu from '../components/SortMenu'
import { effectiveSort, headingKey, headingText, headingsLabel } from '../lib/bookSort'
import type { Book, GroupedEntry, Library, MediaType, PagedGroupedBooks, SeriesGroupEntry } from '../types'
import {
  DEFAULT_PAGE_SIZE,
  FACET_ORDER,
  PAGE_SIZES,
  OWNERSHIP_ANY,
  clearAll,
  isDefaultOwnership,
  pageWindow,
  readState,
  selectionCount,
  toApiQuery,
  toggle,
  writeState,
  type BookFacets,
  type BrowseState,
  type FacetKey,
} from '../lib/bookBrowse'
import {
  announceListsChanged,
  createSmartList,
  deleteList,
  fetchLists,
  isDirty as viewIsDirty,
  listIcon,
  listQuery,
  adoptedList,
  matchList,
  updateList,
  DEFAULT_LIST_KEY,
  type SavedList,
  type ListLayout,
} from '../lib/lists'

/**
 * Colour a whole series alike, so twenty volumes read as one run on the shelf.
 * Falls back to the title for a standalone book.
 */
const coverSeed = (book: Book) => book.series?.[0]?.series_name || book.title

/**
 * Read state as a chip, because it is a value the reader scans for rather than
 * prose they read. Reading shows the percentage instead of the word: at that
 * point "how far in" is the useful part, and the colour already says reading.
 */
function StatusChip({ book, t }: { book: Book; t: TFunction }) {
  // The API sends '' for a book the caller has never interacted with, while the
  // facet rail counts those same books as unread. Treating the two as one keeps
  // the chip agreeing with the count: 140 unread in the rail should not sit
  // beside a list where most rows are blank.
  const status = book.user_read_status || 'unread'

  const pct = Math.round(book.user_progress_pct ?? 0)
  // Tone modifiers come from the reference chip: good, on, warn, or the plain
  // outline for unread.
  const tone =
    status === 'read' ? 'good'
    : status === 'reading' ? 'on'
    : status === 'did_not_finish' ? 'warn'
    : ''

  const label = status === 'reading' && pct > 0
    ? `${pct}%`
    : t(`read_status.${status}`, { defaultValue: status })

  return <span className={`lb-chip flex-none ${tone}`}>{label}</span>
}

/**
 * Fixed-width so the titles beside it stay on one left edge down the list; a
 * rating that sized itself would make every row start somewhere different. The
 * width and the narrow-screen hiding both come from `.lb-rowitem .stars`, which
 * is why the shared widget is wrapped rather than used on its own.
 */
function RowStars({ rating }: { rating: number }) {
  if (!rating) return <span className="stars" aria-hidden="true" />
  return (
    <span className="stars">
      <Stars rating={rating} />
    </span>
  )
}

/** Books held by more than one library need the reader to say which they mean. */
const heldByMany = (book: Book) => (book.libraries ?? []).length > 1

/**
 * Marks a book that several libraries hold.
 *
 * On the row before the click rather than only in the dialog after it, so the
 * picker is expected instead of arriving as an interruption. Two offset squares
 * read as "more than one of these" at 12px, where a count would not.
 */
function MultiLibraryBadge({ book, t }: { book: Book; t: TFunction }) {
  if (!heldByMany(book)) return null
  const names = (book.libraries ?? []).map(l => l.name).join(', ')
  return (
    <span
      className="lb-chip flex-none px-1 py-0 text-[9px] leading-[14px]"
      title={t('books.in_libraries', {
        count: book.libraries?.length ?? 0, names,
        defaultValue: `In ${book.libraries?.length} libraries: ${names}`,
      })}
      aria-hidden="true"
    >
      ▣▣
    </span>
  )
}

/**
 * What a collapsed series says about itself.
 *
 * Two facts, and which is primary depends on the filter. With nothing narrowing
 * the list, "14 of 22 · 5 read" describes the run the way the Series page does.
 * Once a filter is on and it matches fewer books than the reader owns, the
 * matching count leads, because a group reporting 14 while the reader filtered
 * to "reading" would be describing the shelf rather than the filter.
 */
function seriesSummary(g: SeriesGroupEntry, t: TFunction): string {
  const held = g.total_count
    ? t('series.owned_of', { owned: g.owned, total: g.total_count, defaultValue: `${g.owned} of ${g.total_count}` })
    : t('series.owned', { count: g.owned, defaultValue: `${g.owned} volumes` })
  const read = t('series.read_count', { count: g.read, defaultValue: `${g.read} read` })

  if (g.matched < g.owned) {
    return `${t('series.matching', { count: g.matched, defaultValue: `${g.matched} matching` })} · ${held}`
  }
  return `${held} · ${read}`
}

/**
 * The tick that puts a whole run in the selection.
 *
 * Selecting a group means selecting the books it stands for, so a bulk edit
 * reaches all thirty-four volumes without the reader opening the series first.
 * Indeterminate when only some of them are already in, which happens after
 * ticking individual volumes and then collapsing.
 */
function SeriesSelectBox({ entry, allPicked, somePicked, onToggle, t }: {
  entry: SeriesGroupEntry
  allPicked: boolean
  somePicked: boolean
  onToggle: (entry: SeriesGroupEntry) => void
  t: TFunction
}) {
  return (
    <input
      type="checkbox"
      className="lb-rowacts h-3.5 w-3.5 flex-none cursor-pointer accent-[var(--color-accent)]"
      checked={allPicked}
      ref={el => { if (el) el.indeterminate = somePicked && !allPicked }}
      onChange={() => onToggle(entry)}
      aria-label={t('books.select_series', {
        name: entry.series_name,
        defaultValue: `Select every volume of ${entry.series_name}`,
      })}
    />
  )
}

/**
 * The tick that puts a book in the selection.
 *
 * .lb-rowacts is the reference stylesheet's answer to a control inside a row
 * whose whole surface is a link: it raises the control above the stretched
 * anchor so the click lands here rather than navigating.
 */
function SelectBox({ book, picked, onToggle, t }: {
  book: Book
  picked: Map<string, Book>
  onToggle: (book: Book) => void
  t: TFunction
}) {
  return (
    <input
      type="checkbox"
      className="lb-rowacts h-3.5 w-3.5 flex-none cursor-pointer accent-[var(--color-accent)]"
      checked={picked.has(book.id)}
      onChange={() => onToggle(book)}
      aria-label={t('books.select_one', { title: book.title, defaultValue: `Select ${book.title}` })}
    />
  )
}

/**
 * What a filter chip says.
 *
 * Facet values arrive as raw data — a library id, a read-status enum, a bare
 * rating — so the label comes from the counts block where the server already
 * paired each value with its display name. Falling back to the value itself
 * means a chip is never blank, only occasionally ugly.
 */
function chipLabel(key: FacetKey, value: string, facets: BookFacets | null, t: TFunction): string {
  if (key === 'ownership') return t(`ownership.${value}`, { defaultValue: value })
  if (key === 'read_status') return t(`read_status.${value}`, { defaultValue: value })
  if (key === 'rating' || key === 'my_rating') {
    return t('facets.stars', {
      count: starsOf(Number(value)), stars: formatStars(Number(value)),
      defaultValue: `${formatStars(Number(value))} stars`,
    })
  }
  // Favourite is a boolean, so its facet value is the string "true". Falling
  // through to the label the server sent put a chip reading TRUE beside the
  // results, which says nothing about what was filtered.
  if (key === 'favourite') return t('facets.favourited', { defaultValue: 'Favourited' })
  return facets?.[key]?.find(v => v.value === value)?.label ?? value
}

/** A bare id, which is never something to show a reader. */
const looksLikeAnID = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/**
 * chipLabel, plus the views the reader can see.
 *
 * A view's chip is keyed by id, and the facet block only lists values something
 * matched, so an empty view had no entry to read a name from and the chip
 * rendered a raw UUID.
 */
function chipLabelWithViews(
  key: FacetKey, value: string, facets: BookFacets | null, views: SavedList[], t: TFunction,
): string {
  if (key === 'shelf') {
    const named = views.find(v => v.id === value)
    if (named) return named.name
  }
  const label = chipLabel(key, value, facets, t)
  // Never a raw id. An id-keyed facet reads its name out of the facet block,
  // and the block only carries values something matched, so a filter matching
  // nothing had nothing to read and fell through to the UUID. The dimension's
  // own name says more than forty hex digits ever will.
  if (looksLikeAnID(label)) {
    return t(`facets.${key}`, { defaultValue: key })
  }
  return label
}

/** Book detail still lives under a library, so link via the first one holding it. */
const bookHref = (book: Book) =>
  book.library_id ? `/libraries/${book.library_id}/books/${book.id}` : `/books/${book.id}`

interface PagedBooks {
  items: Book[]
  total: number
  page: number
  per_page: number
}

export default function BooksPage() {
  const { t, i18n } = useTranslation()
  const lang = i18n.resolvedLanguage ?? i18n.language
  const { callApi } = useAuth()
  usePageTitle('Books')

  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const state = useMemo<BrowseState>(() => readState(params), [params])

  // The book whose library the reader is being asked to choose.
  //
  // Book detail still lives under a library, and most of what it shows is the
  // same whichever one you enter through, but shelves, loans, storage
  // locations and the tag vocabulary are not. Following the legacy library_id
  // would pick whichever library sorts first and hide the rest without saying
  // so, which is what this dialog exists to stop.
  const [pickFor, setPickFor] = useState<Book | null>(null)

  const askWhichLibrary = useCallback((e: React.MouseEvent, book: Book) => {
    if ((book.libraries ?? []).length < 2) return
    // Let a modified click through: opening in a new tab is a deliberate act
    // and a dialog cannot serve it.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    setPickFor(book)
  }, [])

  // Page size is a preference rather than part of the shared link, so it is
  // read from storage instead of the URL.
  const [perPage, setPerPage] = useState<number>(() => {
    const raw = Number(localStorage.getItem('librarium:books_per_page'))
    return PAGE_SIZES.includes(raw) ? raw : DEFAULT_PAGE_SIZE
  })

  // Views are a saved filter plus a layout. The layout lives here rather than in
  // the URL for the same reason page size does: it is how you like to read a
  // list, not part of what the link selects.
  //
  // The override is keyed on the filter it was made against. A view is reachable
  // from the sidebar, which only navigates, so the layout has to follow from the
  // filter rather than from having gone through openView; without the key, the
  // toggle you flipped on one view would follow you onto the next one.
  // Server-backed, not localStorage. Views used to live in this browser, which
  // meant one saved on a laptop did not exist on a phone; worse, after the rail
  // moved to /me/lists a view saved here went somewhere the rail never looked.
  const [views, setViews] = useState<SavedList[]>([])

  const reloadLists = useCallback(async () => {
    setViews(await fetchLists(callApi).catch(() => []))
  }, [callApi])

  useEffect(() => {
    let cancelled = false
    void fetchLists(callApi)
      .then(l => { if (!cancelled) setViews(l) })
      .catch(() => { /* The page works unfiltered without them. */ })
    return () => { cancelled = true }
  }, [callApi])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  /** The list the filter arrived from, kept while the filter is edited. */
  const [adopted, setAdopted] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [adding, setAdding] = useState(false)
  // The filter rail as a panel, on the narrow shell where the rail is hidden.
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Fetched only when the modal opens. Books is a read surface; making every
  // visit pay for the media types and libraries an add would need is a cost
  // most visits never use.
  const [addData, setAddData] = useState<{ libraries: Library[]; mediaTypes: MediaType[] } | null>(null)
  useEffect(() => {
    if (!adding || addData) return
    let cancelled = false
    Promise.all([
      callApi<Library[]>('/api/v1/libraries'),
      callApi<MediaType[]>('/api/v1/media-types'),
    ])
      .then(([libraries, mediaTypes]) => {
        if (!cancelled) setAddData({ libraries: libraries ?? [], mediaTypes: mediaTypes ?? [] })
      })
      .catch(() => { if (!cancelled) setAddData({ libraries: [], mediaTypes: [] }) })
    return () => { cancelled = true }
  }, [adding, addData, callApi])
  const [layoutOverride, setLayoutOverride] = useState<{ viewId: string | null; layout: ListLayout } | null>(null)

  // Entries, not books, even when grouping is off.
  //
  // An ungrouped book becomes a one-book entry, so the rows and tiles below
  // render one shape instead of two near-identical ones that drift.
  const [entries, setEntries] = useState<GroupedEntry[]>([])
  const [total, setTotal] = useState(0)
  // How many books the entries stand for. Equal to total when ungrouped; the
  // grouped list has to show both or the rail looks wrong beside it.
  const [bookTotal, setBookTotal] = useState(0)
  const [facets, setFacets] = useState<BookFacets | null>(null)
  const [error, setError] = useState<string | null>(null)

  // `loading` is derived, not a flag. It is true whenever what is on screen was
  // fetched for a different filter than the current one, so it cannot desync
  // from the data the way a separate boolean can, and nothing has to set state
  // synchronously inside the effect to raise it.
  // Books the reader has ticked, held as whole records rather than ids.
  //
  // A bulk edit is a PUT that replaces the record, so it needs every field of
  // every selected book. Keeping only ids would mean the selection stopped
  // working the moment the reader paged away from where they ticked it, which
  // is exactly when a selection spanning pages is worth having.
  // Selection is a mode you enter, not a column that sits on every row.
  //
  // A checkbox on all 279 rows says "this page is for editing" to someone who
  // came to read. Behind a button, the ordinary case is clean and the editing
  // case is one click away.
  const [selecting, setSelecting] = useState(false)

  const [picked, setPicked] = useState<Map<string, Book>>(() => new Map())
  const selected = useMemo(() => [...picked.values()], [picked])

  const togglePick = useCallback((book: Book) => {
    setPicked(prev => {
      const next = new Map(prev)
      if (next.has(book.id)) next.delete(book.id)
      else next.set(book.id, book)
      return next
    })
  }, [])

  const clearPicked = useCallback(() => setPicked(new Map()), [])

  const stopSelecting = useCallback(() => {
    setSelecting(false)
    setPicked(new Map())
  }, [])

  /**
   * Books this entry stands for, fetched when a collapsed group is ticked.
   *
   * A bulk edit is a PUT that replaces the record, so a selection has to hold
   * whole books; a group only carries its id and a count. Fetching through the
   * same series filter the drill-in uses means the ticked group selects exactly
   * the books opening it would have shown.
   */
  const booksForSeries = useCallback(async (seriesIds: string[]) => {
    if (seriesIds.length === 0) return []
    const query = toApiQuery({ ...state, series: seriesIds.join(','), page: 1 }, 500)
    const page = await callApi<PagedBooks>(`/api/v1/me/books?${query}`)
    return page.items ?? []
  }, [callApi, state])

  /**
   * Whether a collapsed group is fully, partly, or not selected.
   *
   * Derived from the selection rather than tracked separately: a selected book
   * carries its series refs, so counting the picked books that belong to this
   * series answers it without a second source of truth to keep in sync.
   */
  const seriesPickState = useCallback((g: SeriesGroupEntry): 'none' | 'some' | 'all' => {
    let n = 0
    for (const b of picked.values()) {
      if (b.series?.some(x => x.series_id === g.series_id)) n++
    }
    if (n === 0) return 'none'
    return n >= g.matched ? 'all' : 'some'
  }, [picked])

  const toggleSeriesPick = useCallback(async (g: SeriesGroupEntry) => {
    const books = await booksForSeries([g.series_id])
    setPicked(prev => {
      const next = new Map(prev)
      // Ticking is all-or-nothing per group: if every book is already in, the
      // click takes them out.
      if (books.length > 0 && books.every(b => next.has(b.id))) {
        books.forEach(b => next.delete(b.id))
      } else {
        books.forEach(b => next.set(b.id, b))
      }
      return next
    })
  }, [booksForSeries])

  // The books on this page that can be selected. In grouped mode a series
  // entry is not a book, and selection is not offered at all, so this is empty
  // and the bulk bar never appears.
  const books = useMemo(
    () => entries.flatMap(e => (e.kind === 'book' ? [e.book] : [])),
    [entries]
  )

  /** Series entries on this page, which stand for books not yet loaded. */
  const pageSeries = useMemo(
    () => entries.flatMap(e => (e.kind === 'series' ? [e] : [])),
    [entries]
  )

  // "Select page", not "select all": the reader can see this page, and a
  // control that silently ticked 4,000 books across 80 pages would be acted on
  // before anyone realised what it had taken in.
  // A page of collapsed groups stands for more books than are loaded, so "all
  // picked" cannot be decided from what is on screen. Counting the books a
  // group stands for against the selection is close enough to drive the
  // indeterminate state without fetching every group up front.
  const pageBookCount = books.length + pageSeries.reduce((n, g) => n + g.matched, 0)
  const pageAllPicked = pageBookCount > 0 && picked.size >= pageBookCount &&
    books.every(b => picked.has(b.id))
  const pageSomePicked = picked.size > 0

  const togglePage = useCallback(async () => {
    if (pageAllPicked) { setPicked(new Map()); return }
    // One request for every series on the page rather than one per group.
    const fromGroups = await booksForSeries(pageSeries.map(g => g.series_id))
    setPicked(prev => {
      const next = new Map(prev)
      books.forEach(b => next.set(b.id, b))
      fromGroups.forEach(b => next.set(b.id, b))
      return next
    })
  }, [books, pageSeries, pageAllPicked, booksForSeries])

  // What the last bulk action did. Held until the next one rather than timed
  // out: "14 changed, 2 failed" is the only place the failures are reported.
  const [bulkNotice, setBulkNotice] = useState<string | null>(null)

  // A write does not change the filter, so nothing in the URL tells the fetch
  // to run again. This does.
  const [reloadNonce, setReloadNonce] = useState(0)

  // Books added anywhere show up here without a reload: this page's own Add,
  // the USB scanner's dialog (opened by the shell, not by this page), an Undo.
  // Re-running the current query rather than pushing the new book into the
  // list by hand: it may not match the filter on screen, and a book that
  // appears where it does not belong is worse than one that needs a moment.
  useEffect(() => {
    const again = () => setReloadNonce(n => n + 1)
    window.addEventListener(COLLECTION_CHANGED, again)
    return () => window.removeEventListener(COLLECTION_CHANGED, again)
  }, [])

  const fetchKey = `${params.toString()}|${perPage}|${reloadNonce}|${lang}`
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const loading = loadedKey !== fetchKey

  // Text input is local so typing stays responsive; the URL updates on a pause.
  //
  // When the URL query changes from outside (back button, a cleared filter) the
  // draft has to follow. Adjusting during render rather than in an effect is
  // React's documented pattern for this and avoids a second render pass.
  const [draftQuery, setDraftQuery] = useState(state.query)
  const [syncedQuery, setSyncedQuery] = useState(state.query)
  if (state.query !== syncedQuery) {
    setSyncedQuery(state.query)
    setDraftQuery(state.query)
  }

  // A selection survives paging, because that is the point of holding whole
  // records. It does not survive a changed filter: the books that were ticked
  // are no longer the ones on screen, and acting on them afterwards would edit
  // a set the reader can no longer see.
  const filterKey = useMemo(() => {
    const p = new URLSearchParams(params)
    p.delete('page')
    return p.toString()
  }, [params])
  const [syncedFilter, setSyncedFilter] = useState(filterKey)
  if (filterKey !== syncedFilter) {
    setSyncedFilter(filterKey)
    if (picked.size) setPicked(new Map())
    setBulkNotice(null)
  }

  /**
   * Open a collapsed group.
   *
   * Drills into the series on this same surface rather than navigating to the
   * per-library series page: the filters, the rail and the layout all stay put,
   * and grouping is what collapsed the run in the first place, so expanding it
   * belongs here. Grouping switches off, since a series inside itself is one
   * entry holding the whole page.
   */
  const openSeries = useCallback((g: SeriesGroupEntry) => {
    setParams(writeState({ ...state, series: g.series_id, grouped: false, page: 1 }), { replace: false })
  }, [state, setParams])

  const apply = useCallback((next: BrowseState) => {
    setParams(writeState(next), { replace: true })
  }, [setParams])

  // Emptying the box clears the search. Text is otherwise committed on Enter
  // rather than as it is typed: the box now offers suggestions, and searching
  // for each half-typed name reflowed the page under the dropdown and, when a
  // list was open, reported it modified against a filter nobody had chosen yet.
  useEffect(() => {
    if (draftQuery === '' && state.query !== '') apply({ ...state, query: '', page: 1 })
  }, [draftQuery, state, apply])

  // Results and counts are two requests but one logical fetch. A stale-response
  // guard keeps a slow earlier request from overwriting a newer one.
  const requestSeq = useRef(0)
  useEffect(() => {
    const seq = ++requestSeq.current

    const list = state.grouped
      ? callApi<PagedGroupedBooks>(`/api/v1/me/books/grouped?${toApiQuery(state, perPage, false, lang)}`)
          .then(p => ({
            items: p.items ?? [],
            total: p.total ?? 0,
            bookTotal: p.book_total ?? 0,
          }))
      : callApi<PagedBooks>(`/api/v1/me/books?${toApiQuery(state, perPage, false, lang)}`)
          .then(p => ({
            items: (p.items ?? []).map(book => ({ kind: 'book', book, sort_heading: book.sort_heading }) as GroupedEntry),
            total: p.total ?? 0,
            bookTotal: p.total ?? 0,
          }))

    Promise.all([
      list,
      callApi<{ data: BookFacets }>(`/api/v1/me/books/facets?${toApiQuery(state, perPage, true)}`),
    ])
      .then(([page, f]) => {
        if (seq !== requestSeq.current) return
        setEntries(page.items)
        setTotal(page.total)
        setBookTotal(page.bookTotal)
        setFacets(f.data)
        setError(null)
        setLoadedKey(fetchKey)
      })
      .catch((e: unknown) => {
        if (seq !== requestSeq.current) return
        setError(e instanceof Error ? e.message : String(e))
        // Mark it settled so the view stops claiming to load; the error is what
        // the reader sees instead of results.
        setLoadedKey(fetchKey)
      })
  }, [callApi, state, perPage, fetchKey, lang])

  const pages = Math.max(1, Math.ceil(total / perPage))

  // Every book the caller could see under the non-ownership filters. The
  // ownership counts are computed with the ownership selection excluded, so
  // they already span the whole scope and summing them is the total.
  const scopeTotal = facets
    ? facets.ownership.reduce((n, v) => n + v.count, 0)
    : null

  // Chips for what is actually applied. Ownership at its default is not a
  // choice the reader made, so it gets no chip to remove.
  // all, so matching on the filter is the only thing that covers every route in.
  const paramsNow = params.toString()
  const activeChips = FACET_ORDER.flatMap(key =>
    (key === 'ownership' &&
      (isDefaultOwnership(state.selection[key]) || state.selection[key].includes(OWNERSHIP_ANY))
      ? []
      : state.selection[key]
    ).map(value => ({
      key,
      value,
      label: chipLabelWithViews(key, value, facets, views, t),
    }))
  )
  // The drilled-into series' name, read off the books on screen rather than
  // fetched: every one of them is in it. Undefined only when the series holds
  // nothing, which is the one case with no row to read it from.
  const seriesLabel = useMemo(() => {
    if (!state.series) return null
    for (const e of entries) {
      if (e.kind !== 'book') continue
      const hit = e.book.series?.find(x => x.series_id === state.series)
      if (hit) return hit.series_name
    }
    return null
  }, [entries, state.series])

  // Contributors filter like a facet but are not one, so they are counted and
  // chipped alongside rather than inside the selection.
  const contributorNames = useContributorNames(state.contributors)
  const activeFilters = selectionCount(state.selection) + state.contributors.length

  const dropContributor = (id: string) =>
    apply({ ...state, contributors: state.contributors.filter(c => c !== id), page: 1 })

  // A view is "open" either because it was clicked, or because the filter on
  // screen describes it. The second case is not a nicety: the sidebar links only
  // navigate, and a bookmarked URL or the back button arrive with no click at
  // Falls back to the Default view rather than to nothing. Books is always
  // showing *something*, and that something is the Default unless a real view
  // was opened or the filter happens to describe one. Without the fallback,
  // editing the Default drops the bar the moment the filter changes — which is
  // precisely when "Save changes" needs to be on screen, since saving is how
  // you set what Books opens on.
  /**
   * Which list is open, and it has to survive the filter being edited.
   *
   * Arriving from the rail sets no id: the page worked out which list it was on
   * by matching the filter. So the first keystroke broke the match, the page
   * fell back to the default, and Save changes pointed at the wrong list. The
   * one thing you cannot do with a list is edit it.
   *
   * An exact match adopts the list; from then on it stays open while the filter
   * drifts, which is what makes the edit saveable. Opening a different one
   * matches again and takes over.
   */
  const matchedNow = matchList(views, paramsNow)

  // Only a real navigation changes which list is open. Editing a list's filter
  // can drift it into looking like another one: clear the search on Bleach and
  // what is left is the Default's empty filter, so matching alone jumped to the
  // Default and Bleach could not be edited at all. The two cases are identical
  // in the URL, so the history action is what tells them apart. The rail links
  // push; apply() replaces.
  const editedInPlace = useNavigationType() === 'REPLACE'
  const adoptedNow = adoptedList(matchedNow, adopted, editedInPlace)

  // Adjusted during render rather than in an effect: React re-runs this
  // component before touching the DOM, so the list is already adopted by the
  // time anything is drawn and there is no frame showing the wrong one. The
  // value is computed above rather than read back from state, so this render
  // uses it too.
  if (adoptedNow !== adopted) setAdopted(adoptedNow)
  // Navigating to a different list drops a pinned one, or Revert would leave
  // the old list open while the rail said otherwise.
  if (!editedInPlace && matchedNow && activeViewId && activeViewId !== matchedNow.id) {
    setActiveViewId(null)
  }

  const activeView =
    views.find(v => v.id === activeViewId) ??
    views.find(v => v.id === adoptedNow) ??
    matchedNow ??
    views.find(v => v.builtin_key === DEFAULT_LIST_KEY) ??
    null

  // Layout belongs to the view, so it follows from whichever view is open
  // rather than being a separate toggle the reader has to reset on every
  // switch. An override is remembered against the view it was made on, which
  // means flipping to rows inside one view survives editing that view's filter
  // but does not leak onto the next one.
  const layout: ListLayout =
    layoutOverride && layoutOverride.viewId === (activeView?.id ?? null)
      ? layoutOverride.layout
      : activeView?.layout ?? 'list'
  const dirty = activeView ? viewIsDirty(activeView, paramsNow, layout) : false
  const isDefaultView = activeView?.builtin_key === DEFAULT_LIST_KEY

  // The sort in effect: the reader's, or title A to Z, or reading order inside
  // one series. Headings follow its first level.
  const sortNow = effectiveSort(state.sort, !!state.series)
  const autoSort = state.sort.length === 0 && !!state.series
  const leadField = sortNow[0].field

  // Where each heading starts: the heading's text at the first entry under it,
  // null everywhere else. The server says which author or series an entry was
  // sorted under; a date added becomes a day in the reader's own time zone.
  const headingStarts = useMemo(() => {
    if (!state.headings) return []
    let last: string | null = null
    return entries.map(e => {
      const key = headingKey(leadField, e.sort_heading)
      if (key === last) return null
      last = key
      return headingText(leadField, e.sort_heading, t, lang)
    })
  }, [entries, state.headings, leadField, t, lang])

  const chooseLayout = (next: ListLayout) =>
    setLayoutOverride({ viewId: activeView?.id ?? null, layout: next })

  const openView = (v: SavedList) => {
    setActiveViewId(v.id)
    setLayoutOverride(null)
    setParams(new URLSearchParams(listQuery(v)), { replace: true })
  }

  const saveCurrentAs = async (name: string, icon?: IconName, extras?: PromptExtras) => {
    setNaming(false)
    const created = await createSmartList(callApi, name, paramsNow, icon, 'books', layout, extras?.color)
      .catch(() => null)
    await reloadLists()
    if (created) setActiveViewId(created.id)
    announceListsChanged()
  }

  /**
   * Rename the view on screen and change its icon.
   *
   * renameView has existed since views did and nothing ever called it: there
   * was no way to rename a view at all, let alone re-badge one. The same dialog
   * does both, because from the reader's side it is one edit.
   */
  const [renaming, setRenaming] = useState(false)
  const applyRename = async (name: string, icon?: IconName, extras?: PromptExtras) => {
    setRenaming(false)
    if (!activeView) return
    await updateList(callApi, activeView.id, { name, icon, color: extras?.color ?? '' }).catch(() => {})
    await reloadLists()
    announceListsChanged()
  }

  /** Close the view and go back to an unfiltered Books. */
  const leaveView = useCallback(() => {
    // Forget the adopted list too, or leaving would land back on it.
    setAdopted(null)
    setActiveViewId(null)
    setLayoutOverride(null)
    setParams(new URLSearchParams(), { replace: true })
  }, [setParams])

  const commitView = async () => {
    if (!activeView) return
    await updateList(callApi, activeView.id, { query: paramsNow, layout })
      .catch(() => {})
    await reloadLists()
    announceListsChanged()
    // The layout is part of the view now, so the override has nothing left to
    // override; leaving it would keep the bar reading "modified" after a save.
    setLayoutOverride(null)
  }

  const removeView = async (id: string) => {
    await deleteList(callApi, id).catch(() => {})
    await reloadLists()
    announceListsChanged()
    if (activeViewId === id) setActiveViewId(null)
    if (adopted === id) setAdopted(null)
    setLayoutOverride(null)
  }

  const changePageSize = (next: number) => {
    // Keep the reader next to what they were looking at instead of dumping them
    // on page 1: item 101 stays item 101, only its page number moves.
    const firstItem = (state.page - 1) * perPage
    localStorage.setItem('librarium:books_per_page', String(next))
    setPerPage(next)
    apply({ ...state, page: Math.floor(firstItem / next) + 1 })
  }

  const from = total === 0 ? 0 : (state.page - 1) * perPage + 1
  const to = Math.min(state.page * perPage, total)

  return (
    <>
      <PageHeader
        title={t('books.title', { defaultValue: 'Books' })}
        description={t('books.description', {
          defaultValue: 'Everything across the libraries you can read.',
        })}
      />

      <div className="books-page">
        {/* Search on the left, the page's own actions on the right, one line.
            They used to sit in the row below with the view chip, the count and
            a chip per filter, which is a row that grows: every filter ticked
            and every unsaved change pushed the buttons onto a second line and
            then a third. Nothing here depends on which view is open, so
            nothing here belongs in that row. */}
        <div className="books-toolbar flex flex-wrap items-center gap-2">
        {/* Search and, on a phone, the Filter button that stands in for the
            rail: one line, so the books start right under it. */}
        <div className="books-searchrow flex items-center gap-2">
        <FilterSearch
          className="min-w-0 flex-1"
          value={draftQuery}
          onChange={setDraftQuery}
          onCommitText={text => { setDraftQuery(text); apply({ ...state, query: text, page: 1 }) }}
          facets={facets}
          lists={views}
          selection={state.selection}
          onToggleFacet={(key, value) => apply(toggle(state, key, value))}
          onPickRating={values => apply({
            ...state,
            selection: { ...state.selection, rating: values },
            page: 1,
          })}
          onPickContributor={id => {
            if (state.contributors.includes(id)) return
            apply({ ...state, contributors: [...state.contributors, id], page: 1 })
          }}
        />
          <button type="button" onClick={() => setFiltersOpen(true)}
            className={`books-filter-btn items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              activeFilters > 0
                ? 'border-accent bg-accent text-white'
                : 'border-line-strong text-content-secondary hover:bg-surface-inset'
            }`}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            {t('books.filter', { defaultValue: 'Filter' })}
            {activeFilters > 0 && <span className="tabular-nums">· {activeFilters}</span>}
          </button>
        </div>

          <span className="books-spacer flex-1" />
          {/* The page's own actions. On a phone they share one line that
              scrolls sideways instead of wrapping into three. */}
          <div className="books-actions flex items-center gap-2">
          <Link to={`/inventory${params.get('lib') ? `?lib=${params.get('lib')}` : ''}`} className="lb-btn ghost sm">
            {t('inventory.title', { defaultValue: 'Inventory' })}
          </Link>
          <button type="button" onClick={() => setAdding(true)}
            className="books-add-btn lb-btn sm">
            {t('books.add', { defaultValue: 'Add book' })}
          </button>

          <button type="button"
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            aria-pressed={selecting}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              selecting
                ? 'border-accent bg-accent text-white'
                : 'border-line-strong text-content-secondary hover:bg-surface-inset'
            }`}>
            {selecting
              ? t('books.done_selecting', { defaultValue: 'Done' })
              : t('books.select', { defaultValue: 'Select' })}
          </button>

          {/* Not in the layout toggle beside it: layout is how the same
              rows are drawn, grouping changes what a row is. Hidden while
              drilled into a series, where there is nothing left to
              collapse. */}
          {!state.series && (
            <button type="button"
              onClick={() => apply({ ...state, grouped: !state.grouped, page: 1 })}
              aria-pressed={state.grouped}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                state.grouped
                  ? 'border-accent bg-accent text-white'
                  : 'border-line-strong text-content-secondary hover:bg-surface-inset'
              }`}>
              {t('books.group_series', { defaultValue: 'Group series' })}
            </button>
          )}

          {/* Beside Group series and named apart from it: that one changes what
              a row is, this one only puts a heading over each author, series,
              letter or year, whichever the sort starts with. Off unless asked
              for, so a sorted list is just a list. */}
          <button type="button"
            onClick={() => apply({ ...state, headings: !state.headings })}
            aria-pressed={state.headings}
            title={state.headings
              ? t('sort.headings_on_hint', { defaultValue: 'Headings on. Click to list the books without them.' })
              : t('sort.headings_off_hint', { defaultValue: 'Put a heading over each group the sort makes' })}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              state.headings
                ? 'border-accent bg-accent text-white'
                : 'border-line-strong text-content-secondary hover:bg-surface-inset'
            }`}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 3h7M2 9.5h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M4 5.8h10M4 12.3h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".6" />
            </svg>
            {headingsLabel(leadField, t)}
          </button>

          <div className="flex overflow-hidden rounded-md border border-line-strong">
            {(['list', 'grid'] as ListLayout[]).map(opt => (
              <button key={opt} type="button" onClick={() => chooseLayout(opt)}
                aria-pressed={layout === opt}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  layout === opt ? 'bg-accent text-white' : 'text-content-secondary hover:bg-surface-inset'
                }`}>
                {t(`views.layout_${opt}`, { defaultValue: opt === 'list' ? 'Rows' : 'Grid' })}
              </button>
            ))}
          </div>
          </div>
        </div>

        <SidePanel
          open={filtersOpen}
          title={t('books.filter', { defaultValue: 'Filter' })}
          width="narrow"
          onClose={() => setFiltersOpen(false)}
          footer={<>
            <span />
            <button type="button" className="lb-btn sm" onClick={() => setFiltersOpen(false)}>
              {t('books.show_results', { defaultValue: 'Show results' })}
            </button>
          </>}
        >
          <FacetRail
            facets={facets}
            selection={state.selection}
            loading={loading}
            onToggle={(key: FacetKey, value: string) => apply(toggle(state, key, value))}
            onClear={() => apply(clearAll(state))}
          />
        </SidePanel>

        {/* Add book as a round + in the corner, on a phone only. Hidden while
            selecting, when the bottom of the screen belongs to the bulk bar. */}
        {!selecting && (
          <button type="button" className="books-fab" onClick={() => setAdding(true)}
            aria-label={t('books.add', { defaultValue: 'Add book' })}
            title={t('books.add', { defaultValue: 'Add book' })}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </button>
        )}

        <div className="grid grid-cols-1 gap-7 lg:grid-cols-[13rem_1fr]">
          <aside className="books-rail">
            <FacetRail
              facets={facets}
              selection={state.selection}
              loading={loading}
              onToggle={(key: FacetKey, value: string) => apply(toggle(state, key, value))}
              onClear={() => apply(clearAll(state))}
            />
          </aside>

          {/* min-w-0: a grid item is otherwise as wide as its longest
              unbreakable title, which pushed the page sideways on a phone. */}
          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-content-muted">
              {/* The open view, as a chip in the row that already carries the
                  count and every filter. It used to be a full-width tinted
                  banner above all this, which shouted at a state that usually
                  needs nothing done about it — the rail already highlights
                  which view is open. Modified is the case that deserves
                  attention, and that is the only case that now colours. */}
              {/* A clean Default is named but not offered as a chip.
                  Its × cleared the filters to reach the state it was already
                  in, so the control did nothing — but the name still says
                  which view you are looking at, and the ⋯ beside it keeps
                  Rename reachable. As a chip it read as something to dismiss;
                  as quiet text it reads as a label, which is what it is.

                  Any other view, and the Default once modified, gets the chip:
                  then there is something to leave, and × does it. */}
              {activeView && (
                <span className="flex items-center gap-1.5">
                                    <ViewChip
                    view={activeView}
                    dirty={dirty}
                    isDefault={isDefaultView}
                    defaultHint={t('views.default_hint', {
                      defaultValue: 'what Books opens on',
                    })}
                    onLeave={leaveView}
                    onRename={() => setRenaming(true)}
                    onSaveAsNew={() => setNaming(true)}
                    onDelete={() => removeView(activeView.id)}
                  />
                </span>
              )}
              <span className="tabular-nums">
                {loading && !entries.length
                  ? t('common.loading', { defaultValue: 'Loading…' })
                  : state.grouped
                    // Before the scope comparison, not after it. "105 of 370
                    // records" reads as 105 books, and 105 is entries.
                    ? t('books.entry_count', {
                        entries: total, books: bookTotal,
                        defaultValue: `${total} entries · ${bookTotal} books`,
                      })
                  : scopeTotal !== null && scopeTotal !== total
                    // "of N records" is what makes a filtered shelf legible:
                    // 41 books alone reads as a small library rather than as a
                    // slice of a larger one.
                    ? t('books.of_records', {
                        shown: total, total: scopeTotal,
                        defaultValue: `${total} of ${scopeTotal} records`,
                      })
                    : t('books.count', {
                          total,
                          defaultValue: `${total} books`,
                        })}
              </span>

              {/* The sort sits with the count and the filters: all three
                  describe the list in front of you. Changing it marks the view
                  modified, and Save changes beside it keeps it. */}
              <SortMenu
                value={state.sort}
                effective={sortNow}
                auto={autoSort}
                onChange={levels => apply({ ...state, sort: levels, page: 1 })}
              />

              {/* Every applied filter as a chip that removes itself. The rail
                  can do this too, but it is a long way from the results and
                  the reader has to remember which of seven groups they used. */}
              {/* Only once there is a page to select. Offering "select all" on
                  an empty result reads as a broken control. */}
              {entries.length > 0 && selecting && (
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-content-tertiary hover:text-content-secondary">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    checked={pageAllPicked}
                    // Some picked but not all: the box says "clicking me
                    // selects the rest", which is what indeterminate means.
                    ref={el => { if (el) el.indeterminate = pageSomePicked && !pageAllPicked }}
                    onChange={() => void togglePage()}
                  />
                  {t('books.select_page', { defaultValue: 'Select page' })}
                </label>
              )}

              {/* The way back out. Drilling in is a filter like any other, so
                  it gets a chip that removes itself; without one the only way
                  back is the browser's back button. */}
              {state.series && (
                <button type="button" className="lb-chip on"
                  onClick={() => apply({ ...state, series: '', grouped: true, page: 1 })}
                  title={t('books.leave_series', { defaultValue: 'Back to all books' })}>
                  {seriesLabel ?? t('books.one_series', { defaultValue: 'One series' })} ×
                </button>
              )}

              {state.contributors.map(id => (
                <button
                  key={`contributor:${id}`}
                  type="button"
                  onClick={() => dropContributor(id)}
                  className="lb-chip on"
                  title={t('facets.remove', { defaultValue: 'Remove filter' })}
                >
                  {/* Named once the lookup lands. Until then the chip still has
                      to be here and still has to be removable, so it says what
                      it is rather than sitting blank. */}
                  {contributorNames[id] ?? t('search.author', { defaultValue: 'Author' })} ×
                </button>
              ))}

              {activeChips.map(chip => (
                <button
                  key={`${chip.key}:${chip.value}`}
                  type="button"
                  onClick={() => apply(toggle(state, chip.key, chip.value))}
                  className="lb-chip on"
                  title={t('facets.remove', { defaultValue: 'Remove filter' })}
                >
                  {chip.label} ×
                </button>
              ))}

              <span className="flex-1" />

              {/* Unsaved changes to an open view. The only view state worth a
                  button in the reader's way, which is why it is the only one
                  that gets one. */}
              {activeView && dirty && (
                <>
                  <button type="button" onClick={commitView}
                    className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:brightness-110">
                    {t('views.save_changes', { defaultValue: 'Save changes' })}
                  </button>
                  <button type="button" onClick={() => openView(activeView)}
                    className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-content-secondary hover:bg-surface-inset">
                    {t('views.revert', { defaultValue: 'Revert' })}
                  </button>
                </>
              )}

              {/* Offered only when there is something worth naming. */}
              {!activeView && (activeFilters > 0 || state.query) && (
                <button type="button"
                  onClick={() => setNaming(true)}
                  className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:brightness-110">
                  {t('views.save', { defaultValue: 'Save as a view' })}
                </button>
              )}

            </div>

            {selected.length > 0 && (
              <BookBulkBar
                selected={selected}
                onClear={clearPicked}
                onDone={(result, label) => {
                  setBulkNotice(
                    result.failed === 0
                      ? t('bulk.done', {
                          label, count: result.ok,
                          defaultValue: `${label}: ${result.ok} books`,
                        })
                      : t('bulk.done_partial', {
                          label, ok: result.ok, failed: result.failed,
                          defaultValue: `${label}: ${result.ok} done, ${result.failed} failed`,
                        })
                  )
                  clearPicked()
                  // Reloads this list (the listener above) and the rail, whose
                  // counts live in the shell, which has no idea a write
                  // happened here. Without it the sidebar kept saying
                  // "Signed copies 10" beside a facet reading 11.
                  announceCollectionChanged()
                }}
              />
            )}

            {bulkNotice && (
              <div className="mb-4 rounded-lg border border-line bg-surface-inset px-3 py-2 text-sm text-content-secondary">
                {bulkNotice}
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-danger-line bg-danger-surface px-4 py-3 text-sm text-danger-strong">
                {error}
              </div>
            )}

            {!error && !loading && entries.length === 0 && (
              <div className="py-16 text-center">
                <p className="font-display text-2xl text-content-secondary">
                  {t('books.empty_title', { defaultValue: 'Nothing matches' })}
                </p>
                <p className="font-read mt-1 text-content-muted">
                  {activeFilters > 0
                    ? t('books.empty_filtered', { defaultValue: 'Loosen a filter, or clear them all.' })
                    : t('books.empty_shelf', { defaultValue: 'No books in your libraries yet.' })}
                </p>
              </div>
            )}

            {entries.length > 0 && layout === 'list' && (
              <ul>
                {entries.map((entry, i) => (
                  <Fragment key={entry.kind === 'series' ? `s:${entry.series_id}` : entry.book.id}>
                  {headingStarts[i] && (
                    <li className="lb-display border-b border-line-strong pb-1 pt-5 text-[19px] leading-tight text-content first:pt-0">
                      {headingStarts[i]}
                    </li>
                  )}
                  {entry.kind === 'series' ? (
                  <li key={`s:${entry.series_id}`}>
                    <div className="lb-rowitem">
                      <button type="button" className="absolute inset-0"
                        aria-label={entry.series_name}
                        onClick={() => openSeries(entry)} />
                      {selecting && (
                        <SeriesSelectBox
                          entry={entry}
                          allPicked={seriesPickState(entry) === 'all'}
                          somePicked={seriesPickState(entry) === 'some'}
                          onToggle={g => void toggleSeriesPick(g)}
                          t={t}
                        />
                      )}
                      <span className="books-row-cover flex-none">
                        <BookCoverThumb
                          title={entry.series_name}
                          coverUrl={entry.cover_url}
                          seed={entry.series_name}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="books-row-title lb-display block truncate text-[16.5px] leading-tight text-content">
                          {entry.series_name}
                        </span>
                        <span className="block truncate text-[11px] text-content-tertiary">
                          {seriesSummary(entry, t)}
                        </span>
                      </span>
                      {/* Says what the row is before you click it: a run, not a
                          book that happens to have a count. */}
                      <span className="lb-chip flex-none">
                        {t('series.volumes', { count: entry.matched, defaultValue: `${entry.matched} volumes` })}
                      </span>
                    </div>
                  </li>
                ) : (
                  <li key={entry.book.id}>
                    {/* .lb-rowitem carries the row's gap, padding and separator
                        from the reference stylesheet, so this markup describes
                        what is in the row and nothing about how it looks.
                        The row is a div rather than a link so the checkbox is
                        not inside the anchor; the link is stretched over the
                        row instead, and the checkbox sits above it. That is
                        what .lb-rowitem's position:relative is for. */}
                    <div className="lb-rowitem">
                      <Link to={bookHref(entry.book)} className="absolute inset-0"
                        aria-label={entry.book.title}
                        onClick={e => askWhichLibrary(e, entry.book)} />
                      {selecting && (
                        <SelectBox book={entry.book} picked={picked} onToggle={togglePick} t={t} />
                      )}
                      <span className="books-row-cover flex-none">
                        <BookCoverThumb
                          title={entry.book.title}
                          coverUrl={entry.book.cover_url}
                          readStatus={entry.book.user_read_status}
                          ownership={entry.book.ownership}
                          seed={coverSeed(entry.book)}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="books-row-title lb-display block truncate text-[16.5px] leading-tight text-content">
                          {entry.book.title}
                        </span>
                        <span className="books-row-meta block truncate text-[11px] text-content-tertiary">
                          {[
                            entry.book.contributors?.[0]?.name,
                            entry.book.publish_year || null,
                            entry.book.media_type,
                          ].filter(Boolean).join(' · ')}
                        </span>
                        {/* Phone rows (latulip): author on its own line, then
                            pages, year and the read status, stacked under the
                            title the way a shelf app lays a book out. */}
                        <span className="books-row-author truncate text-content-secondary">
                          {entry.book.contributors?.[0]?.name}
                        </span>
                        <span className="books-row-details items-center gap-2 text-content-tertiary">
                          {entry.book.page_count ? (
                            <span className="flex-none">{t('books.pages', { pages: entry.book.page_count, defaultValue: `${entry.book.page_count} p.` })}</span>
                          ) : null}
                          {entry.book.page_count && entry.book.publish_year ? <span aria-hidden="true">·</span> : null}
                          {entry.book.publish_year ? <span className="flex-none">{entry.book.publish_year}</span> : null}
                          <StatusChip book={entry.book} t={t} />
                          <RowStars rating={entry.book.user_rating ?? 0} />
                        </span>
                      </span>
                      <span className="books-row-side">
                        <MultiLibraryBadge book={entry.book} t={t} />
                        <StatusChip book={entry.book} t={t} />
                        <RowStars rating={entry.book.user_rating ?? 0} />
                      </span>
                    </div>
                  </li>
                  )}
                  </Fragment>
                ))}
              </ul>
            )}

            {entries.length > 0 && layout === 'grid' && (
              <ul className="books-grid grid items-start">
                {entries.map((entry, i) => (
                  <Fragment key={entry.kind === 'series' ? `s:${entry.series_id}` : entry.book.id}>
                  {headingStarts[i] && (
                    <li className="lb-display col-span-full border-b border-line pb-1 pt-3 text-[21px] leading-tight text-content first:pt-0">
                      {headingStarts[i]}
                    </li>
                  )}
                  {entry.kind === 'series' ? (
                  <li key={`s:${entry.series_id}`} className="relative">
                    {selecting && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-surface/85 p-0.5 backdrop-blur-sm">
                        <SeriesSelectBox
                          entry={entry}
                          allPicked={seriesPickState(entry) === 'all'}
                          somePicked={seriesPickState(entry) === 'some'}
                          onToggle={g => void toggleSeriesPick(g)}
                          t={t}
                        />
                      </span>
                    )}
                    {/* Offset panels behind the cover, so a run reads as a run
                        at tile size without a label. */}
                    <button type="button" className="group block w-full text-left"
                      onClick={() => openSeries(entry)}>
                      <span className="relative block">
                        <span aria-hidden="true"
                          className="absolute inset-y-2 -right-1.5 w-full rounded-[3px] border border-line bg-surface-inset" />
                        <span aria-hidden="true"
                          className="absolute inset-y-1 -right-0.5 w-full rounded-[3px] border border-line bg-surface-strong" />
                        <BookCover
                          title={entry.series_name}
                          coverUrl={entry.cover_url}
                          seed={entry.series_name}
                          className="relative w-full"
                        />
                        {/* Its own ground, not the plain outline chip: over a
                            cover the outline had almost no contrast. */}
                        <span className="absolute bottom-1.5 left-1.5 rounded bg-surface/85 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-content backdrop-blur-sm">
                          {entry.matched}
                        </span>
                      </span>
                      <span className="mt-2 block truncate text-[12.5px] font-semibold text-content group-hover:text-accent">
                        {entry.series_name}
                      </span>
                      <span className="block truncate text-[11px] text-content-muted">
                        {seriesSummary(entry, t)}
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={entry.book.id} className="relative">
                    {/* Over the cover rather than beside the title: the tile
                        has no spare row, and the corner is the one part of a
                        cover that carries nothing. */}
                    {selecting && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-surface/85 p-0.5 backdrop-blur-sm">
                        <SelectBox book={entry.book} picked={picked} onToggle={togglePick} t={t} />
                      </span>
                    )}
                    {heldByMany(entry.book) && (
                      <span className="absolute right-1.5 top-1.5 rounded bg-surface/85 p-0.5 backdrop-blur-sm">
                        <MultiLibraryBadge book={entry.book} t={t} />
                      </span>
                    )}
                    <Link to={bookHref(entry.book)} className="group block"
                      onClick={e => askWhichLibrary(e, entry.book)}>
                      <BookCover
                        title={entry.book.title}
                        coverUrl={entry.book.cover_url}
                        readStatus={entry.book.user_read_status}
                        ownership={entry.book.ownership}
                        seed={coverSeed(entry.book)}
                        className="w-full"
                      />
                      <span className="mt-2 block truncate text-[12.5px] font-semibold text-content group-hover:text-accent">
                        {entry.book.title}
                      </span>
                      <span className="block truncate text-[11px] text-content-muted">
                        {entry.book.contributors?.[0]?.name ?? '—'}
                      </span>
                      {/* Progress only where it means something. A bar under
                          every cover reads as a loading state for the page. */}
                      {entry.book.user_read_status === 'reading' && (entry.book.user_progress_pct ?? 0) > 0 && (
                        <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-surface-strong">
                          <span className="block h-full bg-accent"
                            style={{ width: `${Math.min(100, entry.book.user_progress_pct ?? 0)}%` }} />
                        </span>
                      )}
                    </Link>
                  </li>
                  )}
                  </Fragment>
                ))}
              </ul>
            )}

            {total > 0 && (
              <>
                <nav className="mt-7 flex flex-wrap items-center justify-center gap-1.5" aria-label="Pagination">
                  <button
                    type="button"
                    disabled={state.page <= 1}
                    onClick={() => apply({ ...state, page: state.page - 1 })}
                    className="h-8 min-w-8 rounded-md border border-line-strong px-2 text-sm text-content-secondary disabled:opacity-30 enabled:hover:bg-surface-inset"
                  >
                    ‹
                  </button>
                  {pageWindow(state.page, pages).map((n, i) =>
                    n === null ? (
                      <span key={`gap-${i}`} className="px-1 text-content-muted">…</span>
                    ) : (
                      <button
                        key={n}
                        type="button"
                        aria-current={n === state.page ? 'page' : undefined}
                        onClick={() => apply({ ...state, page: n })}
                        className={`h-8 min-w-8 rounded-md border px-2 text-sm tabular-nums transition-colors ${
                          n === state.page
                            ? 'border-transparent bg-accent font-semibold text-white'
                            : 'border-line-strong text-content-secondary hover:bg-surface-inset'
                        }`}
                      >
                        {n}
                      </button>
                    )
                  )}
                  <button
                    type="button"
                    disabled={state.page >= pages}
                    onClick={() => apply({ ...state, page: state.page + 1 })}
                    className="h-8 min-w-8 rounded-md border border-line-strong px-2 text-sm text-content-secondary disabled:opacity-30 enabled:hover:bg-surface-inset"
                  >
                    ›
                  </button>
                </nav>

                <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-content-muted">
                  <span className="tabular-nums">
                    {t('books.range', {
                      from, to, total,
                      defaultValue: `${from} to ${to} of ${total}`,
                    })}
                  </span>
                  <label className="flex items-center gap-1.5">
                    {t('books.per_page', { defaultValue: 'Show' })}
                    <select
                      value={perPage}
                      onChange={e => changePageSize(Number(e.target.value))}
                      className="rounded border border-line-strong bg-surface px-1.5 py-0.5 text-xs text-content"
                    >
                      {PAGE_SIZES.map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {adding && addData && (
        <AddBooksDialog
          libraries={addData.libraries}
          mediaTypes={addData.mediaTypes}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            // Reloads this list (the listener above) as well as the rail.
            announceCollectionChanged()
          }}
        />
      )}

      <PromptDialog
        open={naming}
        title={t('views.save_as_view', { defaultValue: 'Save as a view' })}
        description={t('views.new_description', {
          defaultValue: 'Saves the filter you have on Books right now. You can change it later.',
        })}
        label={t('views.name_label', { defaultValue: 'Name' })}
        placeholder={t('views.name_placeholder', { defaultValue: 'Signed first editions' })}
        icons={LIST_ICONS}
        initialIcon="newview"
        iconLabel={t('common.icon', { defaultValue: 'Icon' })}
        colors={TAG_COLORS}
        colorLabel={t('common.colour', { defaultValue: 'Colour' })}
        onCancel={() => setNaming(false)}
        onSubmit={saveCurrentAs}
      />

      <PromptDialog
        open={renaming}
        title={t('views.rename', { defaultValue: 'Rename' })}
        label={t('views.name_label', { defaultValue: 'Name' })}
        initialValue={activeView?.name ?? ''}
        icons={LIST_ICONS}
        initialIcon={activeView ? listIcon(activeView) : undefined}
        iconLabel={t('common.icon', { defaultValue: 'Icon' })}
        initialColor={activeView?.color ?? ''}
        colors={TAG_COLORS}
        colorLabel={t('common.colour', { defaultValue: 'Colour' })}
        onCancel={() => setRenaming(false)}
        onSubmit={applyRename}
      />

      <LibraryPickerDialog
        open={pickFor !== null}
        libraries={pickFor?.libraries ?? []}
        description={t('library_picker.book_description', {
          title: pickFor?.title ?? '',
          defaultValue: 'Shelves, loans and tags differ per library. The rest of the book is the same either way.',
        })}
        onCancel={() => setPickFor(null)}
        onPick={libraryId => {
          const book = pickFor
          setPickFor(null)
          if (book) navigate(`/libraries/${libraryId}/books/${book.id}`)
        }}
      />
    </>
  )
}
