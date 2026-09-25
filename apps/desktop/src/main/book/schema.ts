/**
 * The shop's book — schema, as an ordered list of migrations.
 *
 * Migrations are append-only and never edited once shipped. A migration that has
 * run on the owner's Mac is history; changing it here would mean two machines
 * with the same `user_version` and different tables, which is the failure mode
 * that makes a support call unanswerable.
 *
 * Every amount is an integer in paise and every quantity an integer in
 * thousandths — see `money.ts` for why. SQLite has no decimal type, and storing
 * money as REAL is how a ledger drifts.
 *
 * Ids are text UUIDs rather than autoincrement integers, so a record can be
 * created before it is stored, referenced across a backup/restore, and merged
 * from a second machine later without a renumbering pass.
 */

export interface Migration {
  readonly version: number;
  /** What it does, in the terms the plan uses. Shown in the migration log. */
  readonly summary: string;
  readonly sql: string;
}

/**
 * v1 — the receivables core.
 *
 * Deliberately not everything in the object model. The point of having a
 * migration runner is that the schema may grow safely, and exercising that path
 * early on real data is worth more than guessing every column now.
 *
 * *That growth did not go where this note first predicted.* It said Quotation
 * and Job would be v2; v2 turned out to be `glossary_hidden` and v3 the Bench's
 * arguments, because those were the screens that got built. The prediction is
 * corrected rather than deleted — a plan that was wrong about its own next step
 * is worth knowing about.
 *
 * What v1 must carry is the wedge: who owes money, on what bill, less what they
 * have paid, and which photograph of which piece of paper each of those facts
 * came from.
 */
const V1: Migration = {
  version: 1,
  summary: "Parties, documents, invoices, payments, and the search index",
  sql: `
-- A customer or a supplier. "Party" because that is the word used in the trade.
CREATE TABLE party (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'customer'
                 CHECK (kind IN ('customer', 'supplier', 'both')),
  phone        TEXT,
  email        TEXT,
  -- 15 characters when present. Its 1st-2nd characters are the state code,
  -- which is what decides CGST+SGST against IGST.
  gstin        TEXT,
  state_code   TEXT,
  address      TEXT,
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- Archived rather than deleted. A party with history is never removed,
  -- because deleting one would orphan bills that are evidence.
  archived_at  INTEGER
);
CREATE INDEX party_name_idx ON party (name);

-- The photograph or PDF a record was read from. Every number in this book can
-- be traced back to the piece of paper it came off.
CREATE TABLE document (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('photo', 'pdf', 'scan', 'other')),
  -- Relative to the document store, never absolute: the store moves when the
  -- book is restored onto a different Mac, and an absolute path would not.
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  captured_at  INTEGER NOT NULL,
  ocr_text     TEXT,
  ocr_at       INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX document_sha_idx ON document (sha256);

-- A bill raised. Totals are stored, but they are always recomputed from the
-- line items on write — never taken from what a model read off a photograph.
CREATE TABLE invoice (
  id               TEXT PRIMARY KEY,
  -- His own bill number, which is often handwritten and not always unique.
  -- Not a key, and not validated, because the book must accept what the paper
  -- actually says rather than what a tidy system would prefer.
  number           TEXT,
  party_id         TEXT NOT NULL REFERENCES party (id),
  issued_on        INTEGER NOT NULL,
  due_on           INTEGER,
  subtotal_paise   INTEGER NOT NULL DEFAULT 0,
  tax_paise        INTEGER NOT NULL DEFAULT 0,
  total_paise      INTEGER NOT NULL DEFAULT 0,
  place_of_supply  TEXT,
  document_id      TEXT REFERENCES document (id),
  -- NULL means a person entered this by hand and it is trusted. A number means
  -- it was extracted, and below the threshold it cannot reach the money table.
  confidence       REAL,
  status           TEXT NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  notes            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX invoice_party_idx ON invoice (party_id, issued_on);
CREATE INDEX invoice_issued_idx ON invoice (issued_on);

CREATE TABLE invoice_item (
  id              TEXT PRIMARY KEY,
  invoice_id      TEXT NOT NULL REFERENCES invoice (id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  description     TEXT NOT NULL,
  hsn_sac         TEXT,
  quantity_milli  INTEGER NOT NULL DEFAULT 1000,
  unit            TEXT,
  rate_paise      INTEGER NOT NULL DEFAULT 0,
  amount_paise    INTEGER NOT NULL DEFAULT 0,
  -- Basis points: 18% is 1800.
  tax_rate_bp     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invoice_item_invoice_idx ON invoice_item (invoice_id, position);

-- Money received. Not necessarily against one bill: a party pays ₹50,000
-- toward three, which is why allocation is its own table.
CREATE TABLE payment (
  id            TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES party (id),
  received_on   INTEGER NOT NULL,
  amount_paise  INTEGER NOT NULL,
  method        TEXT CHECK (method IN ('cash', 'upi', 'bank', 'cheque', 'other')),
  reference     TEXT,
  notes         TEXT,
  document_id   TEXT REFERENCES document (id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX payment_party_idx ON payment (party_id, received_on);

-- Which bill a payment paid, and how much of it. A payment may be partly
-- unallocated — money on account — and that is a real state, not an error.
CREATE TABLE payment_allocation (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL REFERENCES payment (id) ON DELETE CASCADE,
  invoice_id    TEXT NOT NULL REFERENCES invoice (id) ON DELETE CASCADE,
  amount_paise  INTEGER NOT NULL
);
CREATE INDEX allocation_payment_idx ON payment_allocation (payment_id);
CREATE INDEX allocation_invoice_idx ON payment_allocation (invoice_id);

-- One search index over everything a person would type into a box. Contentless
-- FTS5 would be smaller, but it cannot return a snippet, and a search result
-- that cannot show why it matched is a search result nobody trusts.
CREATE VIRTUAL TABLE search USING fts5 (
  kind UNINDEXED,
  ref_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`
};

/**
 * v2 — what the owner has hidden from the glossary.
 *
 * The glossary itself is derived from the book at read time and has no table:
 * a stored vocabulary is a second copy that can disagree with the records it
 * came from, and it would keep teaching a customer's old name after a rename.
 *
 * A *decision*, though, cannot be derived. "Do not show me this word again" is
 * not a fact about the business and there is nothing in the book to recompute it
 * from, so it is the one part that is stored — and stored as a key rather than a
 * row of the term, so hiding one costs nothing and forgetting how it was worded
 * is fine.
 *
 * This is also the first migration to run on data that already exists on
 * somebody's Mac, which is the point of having a runner at all.
 */
const V2: Migration = {
  version: 2,
  summary: "Terms the owner has hidden from the glossary",
  sql: `
CREATE TABLE glossary_hidden (
  key        TEXT PRIMARY KEY,
  hidden_at  INTEGER NOT NULL
);
`
};

/**
 * v3 — the arguments the Bench has held.
 *
 * In the book rather than in its own file because it is business history: what
 * this Mac asked, which engines answered, and which of them was shown wrong. It
 * belongs beside the bills for the same reason the bills belong together —
 * one backup, one restore, one place to delete from.
 *
 * The **turns are deliberately absent.** They are the owner's business
 * discussed at length, and a table quietly accumulating the full text of every
 * argument would be the most sensitive thing on this Mac. Counting is enough to
 * route with (D-083).
 */
const V3: Migration = {
  version: 3,
  summary: "Arguments the Bench has held, for routing evidence",
  sql: `
CREATE TABLE bench_argument (
  id                TEXT PRIMARY KEY,
  at                INTEGER NOT NULL,
  -- Trimmed to 300 characters by the writer. A routing finding needs to know
  -- what kind of question it was about, not the whole of somebody's prompt.
  question          TEXT NOT NULL,
  proposer_engine   TEXT NOT NULL,
  adversary_engine  TEXT NOT NULL,
  outcome           TEXT NOT NULL,
  -- Which seat gave way, or NULL when neither did. This is the column the
  -- whole table exists for: an engine that concedes has been shown wrong by
  -- another engine, on this owner's own work.
  conceded          TEXT CHECK (conceded IN ('proposer', 'adversary')),
  approx_tokens     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bench_argument_at_idx ON bench_argument (at DESC);
`
};

/**
 * v4 — the Case: work that finishes, and the room it was done in.
 *
 * The app had ten destinations and nothing to point at (D-093). A Case is the
 * missing atom — it opens with a question, accrues a crew and a transcript, and
 * **closes with a verdict.** If a thing has no end it is not a Case, which is the
 * rule that keeps this table from becoming a junk drawer.
 *
 * ## It points at records; it never contains them
 *
 * `case_link` holds a reference and nothing else. A Case about a late invoice
 * does not copy the invoice — outstanding stays derived on read (D-058), and a
 * closed Case leaves every record exactly as it found it. Duplicating a figure
 * into a second table is how two numbers that must agree begin to disagree.
 *
 * ## Storing the turns, when D-083 refused to
 *
 * The Bench deliberately keeps its arguments' *shape* and not their text: "a
 * table quietly accumulating the full text of every argument would be the most
 * sensitive thing on this Mac." That reasoning was right and it is not being
 * reversed by inattention here, so the difference has to be stated.
 *
 * A Bench argument stores turns for **analysis** — and counting was enough to
 * route with, so the text was not worth its risk. A Case stores turns because
 * **the transcript is the work itself**: resuming a Case is replaying it, and
 * that is the exact failure this whole design exists to fix — a session closed by
 * mistake and a night's work gone. A Case with no transcript is not a smaller
 * Case, it is not a Case.
 *
 * What that buys is a debt, paid in four places rather than waved at:
 *
 * 1. The owner **named** this Case, so it is not an ambient recording.
 * 2. It appears on the *what it has seen* screen as its own category, with its
 *    own off switch, **and that screen shipped before this table did** (D-065).
 * 3. It is erasable by Case — one `DELETE`, cascading — which is the scope DPDP
 *    (10.3) previously had to invent for itself.
 * 4. It **closes.** An abandoned Case closes itself at thirty days, so the table
 *    is bounded by work that ended rather than by how long the app was installed.
 *
 * ## Turn kinds, and why a summary can never impersonate a turn
 *
 * `kind` is the discriminator the crew's own room design arrived at. A
 * `compacted` turn is one the local model wrote to stand in for several old ones,
 * and it carries `compacted_from` so a reader can always ask what it replaced.
 * `finding` and `receipt` turns are **held out of the compactor's input entirely**
 * and re-inserted afterwards: an LLM cannot be structurally forced to preserve an
 * identifier it was merely asked to keep, so the safe design never hands it one.
 * A receipt that has been summarised is not a receipt, and this product's whole
 * claim is a receipt for everything it touched.
 */
const V4: Migration = {
  version: 4,
  summary: "Cases — work that finishes, the room it happened in, and what it points at",
  sql: `
CREATE TABLE work_case (
  id          TEXT PRIMARY KEY,
  -- What a person would call it in a sentence. Shown in the list.
  title       TEXT NOT NULL,
  -- The question it opened with, in the owner's own words.
  question    TEXT NOT NULL,
  opened_at   INTEGER NOT NULL,
  -- NULL means open. There is no separate status column, because two columns
  -- that must agree about whether something is finished eventually will not.
  closed_at   INTEGER,
  -- Why it ended. 'abandoned' is written by the thirty-day sweep and is honest
  -- history; an open Case nobody will finish is the thing worth avoiding.
  closed_as   TEXT CHECK (closed_as IN ('settled', 'abandoned', 'dropped')),
  -- The verdict, which is what makes it a Case rather than a conversation.
  verdict     TEXT,
  CHECK ((closed_at IS NULL) = (closed_as IS NULL))
);
CREATE INDEX work_case_open_idx ON work_case (closed_at, opened_at DESC);

CREATE TABLE case_turn (
  id             TEXT PRIMARY KEY,
  case_id        TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
  -- Position in the room. Unique per Case, so replay is deterministic and two
  -- seats appending near each other cannot silently interleave into one order
  -- on this machine and a different one after a restore.
  seq            INTEGER NOT NULL,
  -- Who spoke: a seat label, or 'owner'. Never a credential, never an account.
  seat           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('verbatim', 'finding', 'receipt', 'compacted')),
  body           TEXT NOT NULL,
  at             INTEGER NOT NULL,
  -- JSON array of the turn ids a compacted turn stands in for; NULL otherwise.
  -- A reader can always ask what a summary replaced, which is the difference
  -- between compaction and quietly losing the record.
  compacted_from TEXT,
  UNIQUE (case_id, seq),
  CHECK ((kind = 'compacted') = (compacted_from IS NOT NULL))
);
CREATE INDEX case_turn_room_idx ON case_turn (case_id, seq);

CREATE TABLE case_link (
  case_id  TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('party', 'invoice', 'payment', 'document')),
  ref_id   TEXT NOT NULL,
  PRIMARY KEY (case_id, kind, ref_id)
);
CREATE INDEX case_link_ref_idx ON case_link (kind, ref_id);
`
};

/** Output edits never overwrite a reviewed version or escape Case erasure. */
const V5: Migration = {
  version: 5,
  summary: "Versioned workroom outputs and explicit owner acceptance",
  sql: `
CREATE TABLE case_artifact_version (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_turn_id TEXT REFERENCES case_turn (id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  UNIQUE (case_id, revision)
);
CREATE INDEX case_artifact_room_idx ON case_artifact_version (case_id, revision DESC);
`
};

/** Export history remains available after a workroom closes, and disappears
 * with the workroom. A pending record is uncertainty, never proof of a file. */
const V6: Migration = {
  version: 6,
  summary: "Durable receipts for exact workroom output exports",
  sql: `
CREATE TABLE case_artifact_export (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES case_artifact_version (id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('docx', 'md')),
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'written', 'failed')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  accepted_at INTEGER
);
CREATE INDEX case_artifact_export_room_idx ON case_artifact_export (case_id, created_at DESC);
`
};

/**
 * Every migration, in order.
 *
 * The runner applies each one whose version is above the database's current
 * `user_version`, inside a transaction, after taking a backup.
 */
/**
 * v7 — the loop the product actually sells (D-111).
 *
 * V1's note predicted Quotation and Job would be v2, then recorded that v2 went
 * to `glossary_hidden` and v3 to the Bench "because those were the screens that
 * got built". Six versions later the Book still had no enquiry and no
 * quotation: it modelled receivables, which the owner cut on 12 September, and
 * not the enquiry-to-quotation loop, which is the whole shipped promise.
 *
 * The correction is not a new object model. It is the two nouns the six steps
 * of D-111 already name, and the one column — `quotation.state` — that lets a
 * quotation close. Without a close the product drafts and forgets, and the
 * pricing intelligence the position depends on can never accumulate.
 */
const V7: Migration = {
  version: 7,
  summary: "Enquiries, quotations, and the outcome that closes them",
  sql: `
-- Something a person asked for a price on. It arrives from a channel and is
-- kept exactly as it came: \`raw_text\` is evidence, never rewritten by a model.
-- A party is optional because an enquiry usually arrives before its sender is
-- anybody in the book yet.
CREATE TABLE enquiry (
  id            TEXT PRIMARY KEY,
  party_id      TEXT REFERENCES party (id),
  channel       TEXT NOT NULL
                  CHECK (channel IN ('indiamart','whatsapp','telegram','email','phone','walk_in')),
  -- The sender's own identifier where the channel has one, so the same
  -- IndiaMART enquiry polled twice does not become two rows.
  external_ref  TEXT,
  received_at   INTEGER NOT NULL,
  raw_text      TEXT NOT NULL,
  -- The photograph or PDF it arrived as, when it did.
  document_id   TEXT REFERENCES document (id),
  -- A local model's reading, and only a reading. 'unsorted' is the honest
  -- default: it means nothing has looked at this yet, which is different from
  -- having looked and found nothing (D-062).
  triage        TEXT NOT NULL DEFAULT 'unsorted'
                  CHECK (triage IN ('unsorted','real','junk')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER
);
CREATE UNIQUE INDEX enquiry_external_idx
  ON enquiry (channel, external_ref) WHERE external_ref IS NOT NULL;
-- Today's first question: what came in and has nothing priced against it.
CREATE INDEX enquiry_open_idx ON enquiry (received_at) WHERE archived_at IS NULL;

-- A priced reply to one enquiry. \`state\` is the sixth step of D-111 and the
-- reason this table exists at all: a quotation that cannot close teaches the
-- shop nothing about what it wins.
CREATE TABLE quotation (
  id            TEXT PRIMARY KEY,
  enquiry_id    TEXT NOT NULL REFERENCES enquiry (id),
  party_id      TEXT REFERENCES party (id),
  state         TEXT NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft','sent','won','lost','no_reply')),
  -- Basis points, so 18% is 1800 and never a float.
  gst_rate_bp   INTEGER,
  drafted_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  closed_at     INTEGER,
  -- The owner's words for why it closed that way. The most valuable sentence
  -- in the table and the only one a model must never write.
  closed_reason TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER,
  -- A close has a date; anything open must not pretend to.
  CHECK ((state IN ('won','lost','no_reply')) = (closed_at IS NOT NULL))
);
CREATE INDEX quotation_enquiry_idx ON quotation (enquiry_id);
-- Today's second question: what was sent and is still waiting.
CREATE INDEX quotation_waiting_idx ON quotation (sent_at) WHERE state = 'sent';

-- The lines of a quotation. No total column: a total is derived on read like
-- every other figure in this book (D-058), so an edited line cannot leave a
-- stale number behind it.
CREATE TABLE quotation_item (
  id               TEXT PRIMARY KEY,
  quotation_id     TEXT NOT NULL REFERENCES quotation (id),
  position         INTEGER NOT NULL,
  description      TEXT NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit             TEXT,
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0)
);
CREATE UNIQUE INDEX quotation_item_order_idx ON quotation_item (quotation_id, position);
`
};

/** Projects outlive tasks; saved procedures keep the version a person reviewed.
 * Shipped migration SQL is immutable. The existing runner backs up before this runs.
 */
const V8: Migration = {
  version: 8,
  summary: "Persistent projects, shared brief versions and owner-saved routines",
  sql: `
CREATE TABLE workstation_project (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

CREATE TABLE workstation_project_revision (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL CHECK (revision > 0),
  title       TEXT NOT NULL,
  brief       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, revision)
);
CREATE INDEX workstation_project_revision_idx
  ON workstation_project_revision (project_id, revision DESC);

CREATE TABLE workstation_project_link (
  case_id     TEXT PRIMARY KEY REFERENCES work_case (id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX workstation_project_link_project_idx
  ON workstation_project_link (project_id);

CREATE TABLE workstation_project_source (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL CHECK (revision > 0),
  source_turn_id  TEXT NOT NULL REFERENCES case_turn (id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  UNIQUE (case_id, project_id, revision)
);
CREATE INDEX workstation_project_source_case_idx
  ON workstation_project_source (case_id);
CREATE INDEX workstation_project_source_turn_idx
  ON workstation_project_source (source_turn_id);

CREATE TABLE workstation_routine (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  origin_case_id   TEXT,
  origin_turn_id   TEXT
);
CREATE INDEX workstation_routine_updated_idx ON workstation_routine (updated_at DESC);

CREATE TABLE workstation_routine_version (
  routine_id       TEXT NOT NULL REFERENCES workstation_routine (id) ON DELETE CASCADE,
  revision         INTEGER NOT NULL CHECK (revision > 0),
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  icon             TEXT NOT NULL CHECK (icon IN ('write', 'research', 'build', 'review', 'data')),
  source_hint      TEXT NOT NULL,
  output_label     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (routine_id, revision)
);
CREATE INDEX workstation_routine_version_idx ON workstation_routine_version (routine_id, revision ASC);
`
};

/** Original images travel with the book and erase with their task. Earlier migrations are unchanged. */
const V9: Migration = { version: 9, summary: "Original image assets attached to work", sql: `
CREATE TABLE workstation_image_asset (
  id           TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  mime         TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  width        INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height       INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  byte_length  INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 8388608),
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  content      BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  CHECK (width * height <= 16000000)
);

CREATE UNIQUE INDEX workstation_image_asset_case_sha_idx
  ON workstation_image_asset (case_id, sha256);

CREATE INDEX workstation_image_asset_case_created_idx
  ON workstation_image_asset (case_id, created_at ASC, id ASC);
` };

/**
 * v10 — canonical minimum project memory and governance disclosures.
 *
 * Appends a monotonic memory_epoch to workstation_project and adds entry and
 * revision tables for project-scoped memory. Approved history is immutable
 * unless explicitly forgotten.
 */
const V10: Migration = {
  version: 10,
  summary: "Canonical project memory entry, revision history, and disclosure epoch",
  sql: `
ALTER TABLE workstation_project ADD COLUMN memory_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE workstation_project_memory_entry (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('instruction', 'decision', 'exclusion', 'finding')),
  head_revision    INTEGER NOT NULL CHECK (head_revision >= 1),
  active_revision  INTEGER CHECK (active_revision IS NULL OR (active_revision >= 1 AND active_revision <= head_revision)),
  created_at       INTEGER NOT NULL
);
CREATE INDEX workstation_project_memory_entry_project_idx
  ON workstation_project_memory_entry (project_id);

CREATE TABLE workstation_project_memory_revision (
  entry_id         TEXT NOT NULL REFERENCES workstation_project_memory_entry (id) ON DELETE CASCADE,
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  state            TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'rejected', 'forgotten')),
  body             TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  approver_id      TEXT,
  approved_at      INTEGER,
  reason           TEXT,
  PRIMARY KEY (entry_id, revision)
);
CREATE INDEX workstation_project_memory_revision_entry_idx
  ON workstation_project_memory_revision (entry_id, revision DESC);
`
};

/** Exact reviewed context retained for restart inspection and selective forget. */
const V11: Migration = {
  version: 11,
  summary: "Reviewed workstation context and dispatch attempts",
  sql: `
CREATE TABLE workstation_context_snapshot (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES work_case (id) ON DELETE CASCADE,
  project_id TEXT REFERENCES workstation_project (id) ON DELETE CASCADE,
  memory_epoch INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  packet_hash TEXT NOT NULL,
  packet TEXT,
  manifest_json TEXT,
  created_at INTEGER NOT NULL,
  dispatch_attempted_at INTEGER,
  redacted_at INTEGER
);
CREATE INDEX workstation_context_snapshot_case_idx ON workstation_context_snapshot (case_id);
CREATE TABLE workstation_context_snapshot_constraint (
  snapshot_id TEXT NOT NULL REFERENCES workstation_context_snapshot (id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, memory_id)
);
CREATE INDEX workstation_context_snapshot_constraint_memory_idx
  ON workstation_context_snapshot_constraint (memory_id);
`
};

/** Owner-authored model preferences belong to a project and can be forgotten. */
const V12: Migration = {
  version: 12,
  summary: "Project model preferences with revision and forgetting",
  sql: `
CREATE TABLE workstation_project_model_preference (
  project_id   TEXT PRIMARY KEY REFERENCES workstation_project (id) ON DELETE CASCADE,
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
`
};

/** Owner-declared contradictions between exact approved project-memory versions. */
const V13: Migration = {
  version: 13,
  summary: "Versioned project memory conflicts and owner resolutions",
  sql: `
CREATE TABLE workstation_project_memory_conflict (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
  first_memory_id TEXT NOT NULL REFERENCES workstation_project_memory_entry (id) ON DELETE CASCADE,
  second_memory_id TEXT NOT NULL REFERENCES workstation_project_memory_entry (id) ON DELETE CASCADE,
  head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
  created_at INTEGER NOT NULL,
  CHECK (first_memory_id < second_memory_id),
  UNIQUE (project_id, first_memory_id, second_memory_id)
);
CREATE INDEX workstation_project_memory_conflict_project_idx
  ON workstation_project_memory_conflict (project_id);
CREATE TABLE workstation_project_memory_conflict_revision (
  conflict_id TEXT NOT NULL REFERENCES workstation_project_memory_conflict (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('declared', 'resolved')),
  first_active_revision INTEGER CHECK (first_active_revision IS NULL OR first_active_revision >= 1),
  second_active_revision INTEGER CHECK (second_active_revision IS NULL OR second_active_revision >= 1),
  resolution TEXT CHECK (resolution IN ('first_wins', 'second_wins', 'both_retired')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conflict_id, revision),
  CHECK ((state = 'declared' AND resolution IS NULL
    AND first_active_revision IS NOT NULL AND second_active_revision IS NOT NULL)
    OR (state = 'resolved' AND resolution IS NOT NULL))
);
`
};

/** Explicit finding audiences live with each immutable memory revision. */
const V14: Migration = {
  version: 14,
  summary: "Versioned owner-assigned finding role tags",
  sql: `
ALTER TABLE workstation_project_memory_revision
  ADD COLUMN role_tags_json TEXT NOT NULL DEFAULT '[]';
`
};

/** Future adaptive advice needs exact proposal evidence and recoverable policy versions. */
const V15: Migration = {
  version: 15,
  summary: "Append-only project model policy and adaptation proposal history",
  sql: `
CREATE TABLE workstation_project_model_adaptation_proposal (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  base_deleted_at INTEGER,
  catalog_sha256 TEXT NOT NULL CHECK (length(catalog_sha256) = 64),
  catalog_json TEXT NOT NULL CHECK (json_valid(catalog_json) = 1 AND length(catalog_json) <= 32768),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json) = 1 AND length(evidence_refs_json) <= 1048576),
  evidence_operations INTEGER NOT NULL CHECK (evidence_operations BETWEEN 0 AND 200),
  delta_json TEXT NOT NULL CHECK (json_valid(delta_json) = 1 AND length(delta_json) <= 32768),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) = 1 AND length(reasons_json) <= 8192),
  unknowns_json TEXT NOT NULL CHECK (json_valid(unknowns_json) = 1 AND length(unknowns_json) <= 8192),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (project_id, id)
);
CREATE INDEX workstation_project_model_adaptation_proposal_project_idx
  ON workstation_project_model_adaptation_proposal (project_id, created_at DESC);
CREATE TRIGGER workstation_project_model_adaptation_proposal_no_update
  BEFORE UPDATE ON workstation_project_model_adaptation_proposal
  BEGIN SELECT RAISE(ABORT, 'Model adaptation proposals are immutable'); END;
CREATE TABLE workstation_project_model_preference_revision (
  project_id TEXT NOT NULL REFERENCES workstation_project (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('legacy_baseline', 'owner_save', 'owner_forget', 'adaptive_accept')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  deleted_at INTEGER,
  proposal_id TEXT,
  PRIMARY KEY (project_id, revision),
  FOREIGN KEY (project_id, proposal_id)
    REFERENCES workstation_project_model_adaptation_proposal (project_id, id) ON DELETE CASCADE,
  CHECK ((change_kind = 'adaptive_accept') = (proposal_id IS NOT NULL)),
  CHECK ((change_kind = 'owner_forget' AND deleted_at IS NOT NULL)
    OR change_kind = 'legacy_baseline'
    OR (change_kind IN ('owner_save', 'adaptive_accept') AND deleted_at IS NULL))
);
CREATE TRIGGER workstation_project_model_preference_revision_no_update
  BEFORE UPDATE ON workstation_project_model_preference_revision
  BEGIN SELECT RAISE(ABORT, 'Project model preference revisions are immutable'); END;
`
};

/** Preparatory local brief drafts have no Case; retain their exact dispatch packet and restart truth separately. */
const V16: Migration = {
  version: 16,
  summary: "Durable local Agent brief draft admission and receipts",
  sql: `
CREATE TABLE workstation_local_brief_attempt (
  id TEXT PRIMARY KEY,
  input_json TEXT NOT NULL CHECK (json_valid(input_json) = 1 AND length(input_json) <= 32768),
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);
CREATE TRIGGER workstation_local_brief_attempt_no_update
  BEFORE UPDATE ON workstation_local_brief_attempt
  BEGIN SELECT RAISE(ABORT, 'Local brief admission is immutable'); END;
CREATE TABLE workstation_local_brief_request (
  attempt_id TEXT PRIMARY KEY REFERENCES workstation_local_brief_attempt (id) ON DELETE CASCADE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json) = 1 AND length(request_json) <= 32768),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  model_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL CHECK (attempted_at > 0)
);
CREATE TRIGGER workstation_local_brief_request_no_update
  BEFORE UPDATE ON workstation_local_brief_request
  BEGIN SELECT RAISE(ABORT, 'Local brief request is immutable'); END;
CREATE TABLE workstation_local_brief_receipt (
  attempt_id TEXT NOT NULL REFERENCES workstation_local_brief_attempt (id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  event TEXT NOT NULL CHECK (event IN ('admitted', 'dispatch_attempt', 'completed', 'failed', 'interrupted')),
  result_sha256 TEXT CHECK (result_sha256 IS NULL OR length(result_sha256) = 64),
  at INTEGER NOT NULL CHECK (at > 0),
  PRIMARY KEY (attempt_id, sequence)
);
CREATE TRIGGER workstation_local_brief_receipt_no_update
  BEFORE UPDATE ON workstation_local_brief_receipt
  BEGIN SELECT RAISE(ABORT, 'Local brief receipts are immutable'); END;
`
};

export const MIGRATIONS: readonly Migration[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16];

/** The version a fresh database ends up at. */
export const LATEST_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0
);
