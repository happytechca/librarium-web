export interface User {
  id: string
  username: string
  email: string
  display_name: string
  is_instance_admin: boolean
}

export interface AuthTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  user: User
}

export interface AdminUser extends User {
  is_active: boolean
  created_at: string
  last_login_at: string | null
}

export interface PagedUsers {
  items: AdminUser[]
  total: number
  page: number
  per_page: number
}

export interface MediaType {
  id: string
  name: string
  display_name: string
  description?: string
  book_count: number
}

export interface ContributorResult {
  id: string
  name: string
}

// MeSeriesResult — GET /api/v1/me/series, aggregated across the caller's libraries.
export interface MeSeriesResult {
  id: string
  name: string
  library_id: string
  library_name: string
}

// MeTagResult — GET /api/v1/me/tags. `ambiguous` is true when another
// accessible library has a tag with the same name; the UI appends the
// library name to disambiguate.
export interface MeTagResult {
  id: string
  name: string
  library_id: string
  library_name: string
  ambiguous: boolean
}

export interface BookContributor {
  contributor_id: string
  name: string
  role: string
  display_order: number
}

export interface Tag {
  id: string
  library_id: string
  name: string
  color: string
  created_at: string
}

export interface Genre {
  id: string
  name: string
  created_at: string
}

export interface Shelf {
  id: string
  library_id: string
  name: string
  description: string
  color: string
  icon: string
  display_order: number
  book_count: number
  tags: Tag[]
  created_at: string
  updated_at: string
}

export interface BookShelfRef {
  id: string
  name: string
}

export interface BookLibraryRef {
  id: string
  name: string
}

export interface Book {
  id: string
  // library_id is the first library holding this book (picked by the API
  // from the library_books junction). Null when the book is floating — i.e.
  // not in any library (e.g. a suggestion-only book). Prefer `libraries`
  // when you need the full set.
  library_id: string | null
  libraries?: BookLibraryRef[]
  title: string
  subtitle: string
  media_type_id: string
  media_type: string
  description: string
  created_at: string
  updated_at: string
  contributors: BookContributor[]
  tags: Tag[]
  genres: Genre[]
  cover_url: string | null
  series: BookSeriesRef[]
  shelves: BookShelfRef[]
  publisher: string
  publish_year: number | null
  /** Primary edition's page count. Sent by the latulip API fork; absent upstream. */
  page_count?: number | null
  language: string
  /**
   * Where this book stands in relation to you: on the shelf, on a wishlist,
   * suggested, or a volume missing from a run you hold part of.
   *
   * Sent by the list. A single-book read always means shelf, because it cannot
   * return a book nobody has.
   */
  ownership?: string
  /**
   * The heading this book falls under for the list's first sort level: an
   * author, a series, a letter, a year, or a time for date added. Sent only
   * when the list is asked for headings; empty means none.
   */
  sort_heading?: string
  user_read_status?: string
  // Caller-scoped, and all three pick the same interaction row, so a user who
  // owns several editions of one work gets a consistent status, rating and
  // progress rather than three answers from three editions. 0 means unrated.
  user_rating?: number
  user_progress_pct?: number
  // active_loan_count is on every book row (drives the "loaned" badge in
  // list views). active_loans is only populated by single-book reads (the
  // GetBook endpoint) for the loan panel.
  active_loan_count?: number
  active_loans?: Loan[]
}

/**
 * One containment link: an omnibus and a volume inside it.
 *
 * Both directions come back in this shape, so the id that matters depends on
 * which end you asked from. Title is always the other book's.
 */
export interface BookContent {
  container_id: string
  contained_id: string
  position: number
  title: string
}

export interface PagedBooks {
  items: Book[]
  total: number
  page: number
  per_page: number
}

export interface EditionFile {
  id: string
  edition_id: string
  file_format: string
  file_name: string
  file_path: string
  root_path: string
  storage_location_id: string | null
  file_size: number | null
  display_order: number
  created_at: string
}

export interface BookEdition {
  id: string
  book_id: string
  format: string
  language: string
  edition_name: string
  narrator: string
  narrator_contributor_id: string | null
  narrator_contributor_name: string
  publisher: string
  publish_date: string | null
  // year, month or day: how much of publish_date is real. Older servers omit it.
  publish_date_precision?: 'year' | 'month' | 'day' | null
  isbn_10: string
  isbn_13: string
  description: string
  duration_seconds: number | null
  page_count: number | null
  is_primary: boolean
  // copy_count and acquired_at used to live here. A count could not say which
  // of two copies was signed, lent, or in the office, so each object is its own
  // row now; see Copy below.
  created_at: string
  updated_at: string
  files: EditionFile[]
}

/**
 * One physical object on a shelf.
 *
 * Not a count. A number could say you owned two and nothing else: which one is
 * signed, which is lent to a friend, which is in the office. Each object gets a
 * row, and everything that is true of the object rather than of the work or the
 * printing lives on it.
 */
export interface Copy {
  id: string
  library_id: string
  book_id: string
  /** Null when the printing was never recorded, which is a supported state. */
  edition_id: string | null
  acquired_at: string | null
  acquired_from: string
  /** Minor units plus an ISO 4217 code, so a collection can span currencies. */
  price_minor: number | null
  price_currency: string
  condition: string
  is_signed: boolean
  notes: string
  location_id: string | null
  /** Filled by reads that join it; empty on a bare row. */
  location_name: string
  /** Names the borrower when this copy is out, empty otherwise. */
  on_loan_to: string
  created_at: string
  updated_at: string
}

/** A place in a library where copies physically live. */
export interface CopyLocation {
  id: string
  library_id: string
  name: string
  parent_id: string | null
  copy_count: number
  created_at: string
  /** Set on a bookcase: how many shelves it has, 1 to 50. The places inside are the shelves. */
  shelf_count?: number | null
  /** Whether shelf 1 is at the top or the bottom. Absent means top. */
  shelf_numbering?: 'top_down' | 'bottom_up' | null
}

/**
 * How many people hold one contributor role, over the libraries in scope.
 *
 * From the index rather than the vocabulary: the vocabulary defines every role
 * this server knows, and a collection uses a handful of them. Offering the rest
 * is offering a filter that returns nothing.
 */
export interface RoleCount {
  code: string
  count: number
}

/** One row of a controlled vocabulary. Codes only: a label in the database
 *  cannot be translated, so the name lives in the locale files. */
export interface Vocabulary {
  code: string
  sort_order: number
  is_active: boolean
  applies_to?: string
}

export interface BrowseEntry {
  name: string
  path: string
  is_dir: boolean
  size?: number
  ext?: string
  is_bookable?: boolean
}

export interface StorageLocation {
  id: string
  library_id: string
  name: string
  root_path: string
  media_format: string
  path_template: string
  created_at: string
  updated_at: string
}

export interface ScanResult {
  linked: Array<{ file_path: string; file_size: number; file_ext: string; edition_id: string; book_title: string; isbn: string }>
  unlinked: Array<{ file_path: string; file_size: number }>
  missing_files: Array<{ edition_id: string; book_title: string; format: string; isbn_13: string; isbn_10: string }>
}

export interface UserBookInteraction {
  id: string
  user_id: string
  book_edition_id: string
  read_status: string
  rating: number | null
  notes: string
  review: string
  date_started: string | null
  date_finished: string | null
  is_favorite: boolean
  reread_count: number
  created_at: string
  updated_at: string
}

/**
 * What one person thinks of a work.
 *
 * Keyed to the book rather than to a printing: an opinion is about the story,
 * not about which paperback it was read in, so it does not change when a second
 * edition is added. UserBookInteraction was the per-edition shape and is gone.
 */
export interface MyBook {
  book_id: string
  read_status: string
  rating: number | null
  is_favorite: boolean
  review: string
  notes: string
  wants: boolean
  /**
   * True when the status came from a container the caller has read, an omnibus
   * holding this volume, rather than from anything said about this book. An
   * inherited status carries no rating, because a rating is an opinion about
   * the thing rated and never moves through containment.
   */
  inherited: boolean
}

/** One pass through a work. A reread is another session, not a counter. */
export interface ReadingSession {
  id: string
  book_id: string
  edition_id?: string | null
  started_at?: string | null
  finished_at?: string | null
  status: string
  progress_unit: string
  progress_value?: number | null
  created_at: string
}

export interface Library {
  id: string
  name: string
  description: string
  slug: string
  owner_id: string
  is_public: boolean
  created_at: string
  updated_at: string
}

export interface Series {
  id: string
  library_id: string
  name: string
  description: string
  total_count: number | null
  is_complete: boolean // backward compat: API returns status === 'completed'
  status: string
  original_language: string
  publication_year: number | null
  demographic: string
  genres: string[]
  url: string
  external_id: string
  external_source: string
  last_release_date: string | null
  next_release_date: string | null
  book_count: number
  arc_count: number
  // Caller-relative reading state — number of books in the series whose
  // effective user_read_status is 'read' / 'reading'. Both 0 when not authed
  // or no progress recorded. UI gates display behind show_read_badges.
  /**
   * What the run is worth, averaged from the volumes anyone has rated.
   *
   * Null when nothing in it is rated, which is a different thing from a rating
   * of nought. rated_books says how many volumes it came from, because a 4
   * from one volume of twenty and a 4 from all twenty are not the same claim.
   */
  rating?: number | null
  rated_books?: number
  /** The caller's own average over the run, null when they have rated none. */
  my_rating?: number | null
  read_count: number
  reading_count: number
  preview_books: SeriesPreviewBook[]
  tags: Tag[]
  created_at: string
  updated_at: string
}

export interface SeriesPreviewBook {
  book_id: string
  title: string
  cover_url: string | null
  /**
   * Whether the library actually has this volume.
   *
   * The strip is the whole run, missing volumes included, so without this a
   * volume nobody owns draws exactly like one on the shelf. Optional because a
   * server older than the field sends nothing, and "unknown" has to mean held
   * rather than greying a shelf full of books somebody owns.
   */
  held?: boolean
}

// ── Cross-library index surfaces ────────────────────────────────────────────
// GET /api/v1/me/authors/index and GET /api/v1/me/series/index. Both are
// unpaged: the A-Z bar has to know which letters have anything behind them,
// which means the client holds the whole set anyway.

export interface AuthorSpine {
  book_id: string
  title: string
  cover_url: string | null
}

export interface AuthorLibraryRef {
  id: string
  name: string
}

export interface AuthorIndexEntry {
  id: string
  name: string
  sort_name: string
  photo_url: string | null
  /** Letter the index files this author under, from sort_name, folded for
   *  accents. '#' for anything that does not resolve to a letter. */
  letter: string
  book_count: number
  read_count: number
  spines: AuthorSpine[]
  libraries: AuthorLibraryRef[]
}

export interface SeriesArc {
  id: string
  series_id: string
  name: string
  description: string
  position: number
  // Optional volume bounds — used by the UI to slot ghost rows (missing
  // volumes the user doesn't own) into the right arc even when no owned
  // book in the arc is available as a neighbour anchor.
  vol_start: number | null
  vol_end: number | null
  book_count: number
  created_at: string
  updated_at: string
}

// AI-generated proposals for series metadata or arcs. Pending proposals are
// rendered in a review panel on the series detail page; the user accepts or
// rejects per-field or per-arc before any structured data is written.
export interface AIMetadataProposal {
  id: string
  library_id: string
  run_id: string | null
  target_type: string
  target_id: string
  kind: 'series_metadata' | 'series_arcs'
  payload: SeriesMetadataPayload | SeriesArcsPayload
  status: 'pending' | 'accepted' | 'rejected' | 'partially_accepted'
  created_at: string
  applied_at: string | null
  applied_by: string | null
}

export interface SeriesMetadataPayload {
  status?: string | null
  total_count?: number | null
  demographic?: string | null
  genres: string[]
  description?: string | null
}

export interface SeriesArcsPayload {
  arcs: ProposedArc[]
}

export interface ProposedArc {
  name: string
  position: number
  vol_start?: number | null
  vol_end?: number | null
}

export interface SeriesVolume {
  id: string
  series_id: string
  position: number
  title: string
  release_date: string | null
  cover_url: string
  external_id: string
  created_at: string
  updated_at: string
}

export interface SeriesEntry {
  position: number
  /**
   * The last volume a container covers, for an omnibus or a bind-up. Null on
   * an ordinary book, which occupies one position rather than a span.
   *
   * Derived by the server from what the book contains, so it agrees with the
   * contained rows by construction.
   */
  position_end?: number | null
  book_id: string
  arc_id: string | null
  title: string
  subtitle: string
  media_type: string
  cover_url: string | null
  /**
   * Whether the library actually has this volume.
   *
   * A series lists the whole run, promoted gaps included, so without this a
   * volume nobody owns draws exactly like one on the shelf. Optional because a
   * server older than the field sends nothing, and "unknown" has to mean held
   * rather than greying a run somebody owns outright.
   */
  held?: boolean
  user_read_status: string
  contributors: BookContributor[]
}

export interface SeriesMatchCandidate {
  book_id: string
  title: string
  subtitle: string
  position: number
  other_series: BookSeriesRef[]
}

export interface SeriesSuggestionBook {
  book_id: string
  title: string
  subtitle: string
  position: number
  cover_url: string | null
}

export interface SeriesSuggestion {
  proposed_name: string
  books: SeriesSuggestionBook[]
}

export interface Loan {
  id: string
  library_id: string
  book_id: string
  book_title: string
  /** Only on the cross-library list, which has to say which library a row is in. */
  library_name?: string
  loaned_to: string
  loaned_at: string
  due_date: string | null
  returned_at: string | null
  notes: string
  created_at: string
  updated_at: string
}

export interface BookSeriesRef {
  series_id: string
  series_name: string
  position: number
}

export interface MergedFieldOption {
  value: string
  source: string
  source_display: string
  // Every provider that gave this value. Older servers omit it.
  sources?: string[]
  // The list behind a joined value; authors only, newer servers only.
  values?: string[]
}

// Why a field's value was pre-selected. Older servers omit it.
export type MergeReason = 'agreed' | 'only' | 'longest' | 'most_detail' | 'first'

export interface MergedFieldResult {
  value: string
  source: string
  source_display: string
  reason?: MergeReason
  sources?: string[]
  // The list behind a joined value; authors only, newer servers only.
  // Splitting value on commas breaks "King, Jr.", so read this first.
  values?: string[]
  alternatives: MergedFieldOption[]
}

export interface CoverOption {
  source: string
  source_display: string
  cover_url: string
  // Pixel size read from the image header; absent when unknown.
  width?: number
  height?: number
}

// What one provider did during a lookup.
export interface LookupProviderStatus {
  name: string
  display_name: string
  status: 'answered' | 'no_record' | 'error' | 'missed'
  millis: number
}

export interface MergedBookResult {
  title?: MergedFieldResult
  subtitle?: MergedFieldResult
  authors?: MergedFieldResult
  description?: MergedFieldResult
  publisher?: MergedFieldResult
  publish_date?: MergedFieldResult
  language?: MergedFieldResult
  isbn_10?: MergedFieldResult
  isbn_13?: MergedFieldResult
  page_count?: MergedFieldResult
  categories?: string[]
  covers?: CoverOption[]
  // 'largest' once cover sizes are known, else 'first'.
  cover_reason?: 'largest' | 'first'
  providers?: LookupProviderStatus[]
  // The ISBN a UPC lookup was answered by, worked out from the add-on.
  from_isbn?: string
  // Other books the same add-on could be, when the publisher has more than
  // one ISBN prefix and several resolved.
  other_isbns?: { isbn: string; title: string }[]
}

export interface ISBNLookupResult {
  provider: string
  provider_display: string
  title: string
  subtitle: string
  authors: string[]
  publisher: string
  publish_date: string
  isbn_10: string
  isbn_13: string
  description: string
  cover_url: string
  language: string
  page_count: number | null
  categories?: string[]
}

export interface ProviderConfigField {
  key: string
  label: string
  type: string // "password" | "text" | "url"
  required: boolean
  placeholder?: string
  help_text?: string
}

export interface ProviderStatus {
  name: string
  display_name: string
  description: string
  requires_key: boolean
  capabilities: string[]
  help_text?: string
  help_url?: string
  enabled: boolean
  has_api_key: boolean
  config?: Record<string, string>
  // Optional — providers whose config is more than a single API key (e.g. a
  // self-hosted mirror needing a base URL) declare this; the settings page
  // falls back to the legacy single-API-key form when it's absent.
  config_fields?: ProviderConfigField[]
  // On the admin Lookups list rather than only in the catalogue. Older
  // servers omit it; treat enabled as listed there.
  listed?: boolean
  // Catalogue details; all optional so older servers still type-check.
  kind?: 'data' | 'buy'
  region?: string
  languages?: string[]
  sends?: string
  contributed_by?: string
  docs_url?: string
}

export interface SeriesLookupResult {
  provider: string
  provider_display: string
  name: string
  description: string
  total_count: number | null
  is_complete: boolean
  cover_url: string
  external_id: string
  status: string
  original_language: string
  publication_year: number | null
  demographic: string
  genres: string[]
  url: string
  external_source: string
}

export interface LibraryContributor {
  id: string
  name: string
  sort_name: string
  is_corporate: boolean
  photo_url: string | null
  book_count: number
  nationality: string
  born_date: string | null
  updated_at: string
}

export interface PagedContributors {
  items: LibraryContributor[]
  total: number
  page: number
  per_page: number
}

export interface ContributorWork {
  id: string
  contributor_id: string
  title: string
  isbn_13: string
  isbn_10: string
  publish_year: number | null
  cover_url: string
  source: string
  created_at: string
  in_library: boolean
  library_book_id: string | null
}

export interface ContributorDetail {
  id: string
  name: string
  sort_name: string
  is_corporate: boolean
  bio: string
  born_date: string | null
  died_date: string | null
  nationality: string
  external_ids: Record<string, string>
  photo_url: string | null
  book_count: number
  created_at: string
  updated_at: string
  works: ContributorWork[]
  books: Book[]
}

export interface DashboardBook {
  book_id: string
  library_id: string
  library_name: string
  title: string
  cover_url: string | null
  authors: string
  read_status: string
  updated_at?: string
}

// Kept for backwards compat — same shape
export type CurrentlyReadingBook = DashboardBook

export interface FinishedBook {
  book_id: string
  library_id: string
  library_name: string
  title: string
  authors: string
  cover_url: string | null
  finished_at: string
  rating: number | null
  is_favorite: boolean
}

export interface ContinueSeriesItem {
  series_id: string
  series_name: string
  position: number
  last_read_position: number
  book_id: string
  library_id: string
  library_name: string
  title: string
  authors: string
  cover_url: string | null
  read_status: string
}

export interface MonthlyReadBucket {
  month: string // "YYYY-MM"
  count: number
}

export interface DashboardStats {
  total_books: number
  books_read: number
  books_reading: number
  books_added_this_year: number
  books_read_this_year: number
  favorites_count: number
  monthly_reads: MonthlyReadBucket[]
}

export interface ExternalContributorCandidate {
  provider: string
  external_id: string
  name: string
  photo_url: string
}

export interface ExternalContributorData {
  provider: string
  external_id: string
  name: string
  bio: string
  born_date: string | null
  died_date: string | null
  nationality: string
  photo_url: string
  works: Array<{
    title: string
    isbn_13: string
    isbn_10: string
    publish_year: number | null
    cover_url: string
  }>
}

export interface LibraryMember {
  user_id: string
  username: string
  display_name: string
  email: string
  role_id: string
  role: string
  joined_at: string
  invited_by?: string
  tags: Tag[]
}

// ─── AI ──────────────────────────────────────────────────────────────────────

export interface AIConfigField {
  key: string
  label: string
  type: string // "password" | "text" | "url" | "model"
  required: boolean
  placeholder?: string
  help_text?: string
  options?: string[]
}

export interface AIProviderStatus {
  name: string
  display_name: string
  description: string
  help_text?: string
  help_url?: string
  config_fields: AIConfigField[]
  enabled: boolean
  active: boolean
  has_api_key: boolean
  config?: Record<string, string>
}

export interface AIPermissions {
  reading_history: boolean
  ratings: boolean
  favourites: boolean
  full_library: boolean
  taste_profile: boolean
}

export interface UserAIPrefs {
  opt_in: boolean
}

export interface SuggestionView {
  id: string
  type: string // "buy" | "read_next"
  book_id?: string
  book_edition_id?: string
  library_id?: string
  title: string
  author?: string
  isbn?: string
  cover_url?: string
  reasoning?: string
  status: string // "new" | "dismissed" | "interested" | "added_to_library"
  created_at: string
}

export interface SuggestionRunView {
  id: string
  user_id?: string // only set on admin-scoped responses
  triggered_by: string // scheduler | admin | user
  provider_type: string
  model_id?: string
  status: string // running | completed | failed
  error?: string
  tokens_in: number
  tokens_out: number
  estimated_cost_usd: number
  started_at: string
  finished_at?: string
  suggestion_count?: number
  steering?: SuggestionSteeringView | null
}

// Steering payload sent with POST /me/suggestions/run. All fields optional;
// at least one must be non-empty for the server to accept it.
export interface SuggestionSteeringInput {
  author_ids?: string[]
  series_ids?: string[]
  genre_ids?: string[]
  tag_ids?: string[]
  notes?: string
}

// SuggestionSteeringView is the hydrated form returned on run reads: IDs
// resolved to display names so the banner can render without extra fetches.
export interface SuggestionSteeringView {
  authors?: Array<{ id: string; name: string }>
  series?: Array<{ id: string; name: string }>
  genres?: Array<{ id: string; name: string }>
  tags?: Array<{ id: string; name: string; library_id: string }>
  notes?: string
}

// SuggestionRunEvent is one observable step in a pipeline run. `content`
// shape depends on `type`; the UI renders raw JSON for unknown types.
export interface SuggestionRunEvent {
  seq: number
  type: string
  content: Record<string, unknown>
  created_at: string
}

export interface SuggestionRunDetail {
  run: SuggestionRunView
  events: SuggestionRunEvent[]
}

export interface JobSummary {
  id: string
  display_name: string
  description: string
  kind: string
  enabled: boolean
}

// QuotaView is returned by GET /me/suggestions/quota. `available === false`
// gates Run Now + sidebar visibility; `unavailable_reason` is one of
// `job_disabled` / `no_provider` / `not_opted_in` when unavailable.
export interface SuggestionQuotaView {
  used: number
  limit: number
  resets_at?: string
  unlimited: boolean
  available: boolean
  unavailable_reason: string | null
}

export interface AISuggestionsJobConfig {
  enabled: boolean
  interval_minutes: number
  max_buy_per_user: number
  max_read_next_per_user: number
  include_taste_profile: boolean
  user_run_rate_limit_per_day: number
  max_tokens_initial: number
  max_tokens_backfill: number
}

// TasteProfile is the JSON shape stored per-user. All fields optional —
// empty categories simply aren't sent to the AI. Chip-style categories
// (genres, themes, formats) use `love` / `avoid` lists rather than per-item
// maps so the model prompt is compact and human-readable.
export interface TasteProfile {
  genres?: { love?: string[]; avoid?: string[]; favourite?: string[] }
  themes?: { love?: string[]; avoid?: string[] }
  formats?: { love?: string[]; avoid?: string[] }
  era?: string
  favourite_authors?: string[]
  hard_nos?: string
}

/**
 * One entry in the grouped Books list: a series shown as a unit, or a single
 * book that belongs to none.
 *
 * `matched` is how many of the series' books match the current filter, and
 * `owned` how many the caller holds in total. They differ whenever a filter is
 * on, which is exactly when the reader needs both numbers to make sense of what
 * they are looking at.
 */
export interface SeriesGroupEntry {
  kind: 'series'
  series_id: string
  series_name: string
  matched: number
  owned: number
  read: number
  total_count: number | null
  cover_url: string | null
  /** Present when the list was asked for headings. See Book.sort_heading. */
  sort_heading?: string
}

export interface BookGroupEntry {
  kind: 'book'
  book: Book
  /** Present when the list was asked for headings. See Book.sort_heading. */
  sort_heading?: string
}

export type GroupedEntry = SeriesGroupEntry | BookGroupEntry

export interface PagedGroupedBooks {
  items: GroupedEntry[]
  /** Entries on this page's terms: groups plus standalone books. */
  total: number
  /** Books those entries stand for. The facet rail counts these, not entries. */
  book_total: number
  page: number
  per_page: number
}

/**
 * What one member has recorded about a book, as shown to the others.
 *
 * No notes field, deliberately: the server does not select them, because the
 * form that writes them calls them private.
 */
export interface BookReader {
  user_id: string
  display_name: string
  username: string
  read_status: string
  rating?: number
  is_favorite: boolean
  review: string
  started_at?: string
  finished_at?: string
  updated_at: string
}
