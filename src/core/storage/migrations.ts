import { DataFromNewerVersionError } from "../errors";
import type { Database } from "./database";

/**
 * Schema migrations. The `schema_migrations` table records each one applied, so
 * a migration with a lower number that lands after a higher one (tickets built
 * in parallel reserve numbers up front) still runs. Never edit a migration that
 * has shipped; add a new one.
 *
 * Sync-ready rules (ADR-0003), for every table:
 * - `id` is a random UUID generated on the device;
 * - `created_at` and `updated_at` are ISO 8601 UTC timestamps;
 * - `deleted_at` marks a soft delete, and queries ignore rows where it is set.
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    description: "Minds, per-User settings and per-device settings",
    sql: `
      CREATE TABLE minds (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX minds_by_updated_at ON minds (updated_at) WHERE deleted_at IS NULL;

      -- Per-User settings: will sync across the User's devices.
      CREATE TABLE user_settings (
        id TEXT PRIMARY KEY NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL, -- JSON
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX user_settings_by_key ON user_settings (key) WHERE deleted_at IS NULL;

      -- Per-device settings: never sync.
      CREATE TABLE device_settings (
        id TEXT PRIMARY KEY NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL, -- JSON
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX device_settings_by_key ON device_settings (key) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 2,
    description: "Mind content, stored as Yjs updates",
    sql: `
      -- A Mind's content is one Yjs document (ADR-0003), stored as the updates
      -- that built it, in insertion order. Compaction replaces a Mind's rows with
      -- one row holding the merged state; that row carries the same content, so
      -- the merged rows are removed outright. Deleting a Mind marks its rows
      -- deleted. No foreign key: a later sync may deliver rows before their Mind.
      CREATE TABLE mind_updates (
        id TEXT PRIMARY KEY NOT NULL,
        mind_id TEXT NOT NULL,
        data BLOB NOT NULL, -- a Yjs update, v1 encoding
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX mind_updates_by_mind ON mind_updates (mind_id) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 3,
    description: "Documents, their Passages and a keyword index over Passage text",
    sql: `
      -- Files the User added. The copy in the data folder is named by content_hash.
      -- status: queued | extracting | ready | failed | no-text (checked in code, so later tickets can add states).
      CREATE TABLE documents (
        id TEXT PRIMARY KEY NOT NULL,
        content_hash TEXT NOT NULL, -- SHA-256 of the file, hex
        name TEXT NOT NULL,
        kind TEXT NOT NULL, -- pdf | text | markdown
        size INTEGER NOT NULL,
        page_count INTEGER,
        status TEXT NOT NULL,
        failure_reason TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      -- The same file is one Document (ADR-0003).
      CREATE UNIQUE INDEX documents_by_content_hash ON documents (content_hash) WHERE deleted_at IS NULL;
      CREATE INDEX documents_by_created_at ON documents (created_at) WHERE deleted_at IS NULL;

      -- Spans of a Document's text that can be retrieved and cited. Never edited:
      -- processing a Document again would replace them. Pages are 1-based and NULL
      -- for Documents without pages; window_from and window_to are the positions of
      -- the first and last Passage in this Passage's sliding window.
      CREATE TABLE passages (
        seq INTEGER PRIMARY KEY, -- local key for the keyword index only: rowids not declared like this can change on VACUUM
        id TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL REFERENCES documents (id),
        position INTEGER NOT NULL,
        page_from INTEGER,
        page_to INTEGER,
        window_from INTEGER NOT NULL,
        window_to INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX passages_by_document ON passages (document_id, position) WHERE deleted_at IS NULL;

      -- PROVISIONAL (ticket #21 decides): the trigram tokenizer matches any substring
      -- of 3 or more characters, so Chinese works without word segmentation.
      -- The index holds live Passages only: soft-deleting one removes it.
      CREATE VIRTUAL TABLE passages_fts USING fts5 (
        text,
        content = 'passages',
        content_rowid = 'seq',
        tokenize = 'trigram remove_diacritics 1'
      );
      CREATE TRIGGER passages_fts_insert AFTER INSERT ON passages WHEN new.deleted_at IS NULL BEGIN
        INSERT INTO passages_fts (rowid, text) VALUES (new.seq, new.text);
      END;
      CREATE TRIGGER passages_fts_soft_delete AFTER UPDATE OF deleted_at ON passages
      WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
        INSERT INTO passages_fts (passages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
      END;
      CREATE TRIGGER passages_fts_delete AFTER DELETE ON passages WHEN old.deleted_at IS NULL BEGIN
        INSERT INTO passages_fts (passages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
      END;
    `,
  },
  {
    version: 4,
    description: "Chat providers and data-flow consent",
    sql: `
      -- Chat provider settings without secrets: API keys live in the secrets file (ADR-0003).
      CREATE TABLE chat_providers (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT, -- NULL for OpenAI, Anthropic and Google
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX chat_providers_by_server ON chat_providers (kind, coalesce(base_url, ''))
        WHERE deleted_at IS NULL;

      -- The User's decision on each external data flow, per service.
      CREATE TABLE data_flow_consents (
        id TEXT PRIMARY KEY NOT NULL,
        flow TEXT NOT NULL,
        service_id TEXT NOT NULL,
        service_name TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'declined')),
        data_kinds TEXT NOT NULL, -- JSON array of the kinds of data accepted
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX data_flow_consents_by_flow ON data_flow_consents (flow, service_id)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 6,
    description: "Folders, and the Folder each Document is filed in",
    sql: `
      -- Folders the User files Documents in by hand. They nest with no depth
      -- limit: parent_id is NULL at the top level. No foreign key: a later sync
      -- may deliver a Folder before its parent. Deleting a Folder marks it and
      -- its sub-Folders deleted.
      CREATE TABLE folders (
        id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX folders_by_parent ON folders (parent_id) WHERE deleted_at IS NULL;

      -- A Document is in at most one Folder, so the Folder is a column on the
      -- Document rather than a link table. NULL means unfiled. Filing a Document
      -- moves its updated_at, like any other change to it.
      ALTER TABLE documents ADD COLUMN folder_id TEXT;
      CREATE INDEX documents_by_folder ON documents (folder_id) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 10,
    description: "Segmented keyword index, Passage embeddings and processing versions (ADR-0009)",
    sql: `
      -- The keyword index holds each live Passage's words as segmented by
      -- Intl.Segmenter (the Document's name, then the Passage's text), joined
      -- by spaces for the default unicode61 tokenizer. The core writes the rows,
      -- since the segmenting happens in JavaScript; rowid is passages.seq. Only
      -- the index is stored (content = ''), and the triggers remove a Passage's
      -- row when it is deleted. It replaces migration 3's provisional trigram index.
      DROP TRIGGER passages_fts_insert;
      DROP TRIGGER passages_fts_soft_delete;
      DROP TRIGGER passages_fts_delete;
      DROP TABLE passages_fts;
      CREATE VIRTUAL TABLE passages_fts USING fts5 (
        text,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER passages_fts_soft_delete AFTER UPDATE OF deleted_at ON passages
      WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
        DELETE FROM passages_fts WHERE rowid = old.seq;
      END;
      CREATE TRIGGER passages_fts_delete AFTER DELETE ON passages WHEN old.deleted_at IS NULL BEGIN
        DELETE FROM passages_fts WHERE rowid = old.seq;
      END;

      -- The Passage's vector from the embedding model in documents.embedding_model:
      -- little-endian float32s, L2-normalised. NULL until it is embedded.
      ALTER TABLE passages ADD COLUMN embedding BLOB;

      -- Which version of the processing pipeline (text normalisation, Passage
      -- sizes, keyword indexing) built a Document's Passages. Documents from an
      -- older version are processed again at startup. Version 1 is #25's.
      ALTER TABLE documents ADD COLUMN processing_version INTEGER NOT NULL DEFAULT 1;
      -- The embedding model the Document's Passage vectors come from, once embedding starts.
      ALTER TABLE documents ADD COLUMN embedding_model TEXT;
    `,
  },
  {
    version: 11,
    description: "Each Document's page text, for the Citation check (#30)",
    sql: `
      -- The text of each page of a Document as its Passages were built from it:
      -- extracted, with running headers, footers and page numbers removed. The
      -- Citation check looks for a quote in the pages a Citation names, so it
      -- needs the pages themselves, not the Passages, which overlap and don't
      -- mark where a page ends. Stored rather than extracted again: the check
      -- runs when an Answer finishes, and must see exactly this text. page is
      -- 1-based, and NULL for the one row of a Document without pages (TXT,
      -- Markdown). Like Passages, rows are replaced when the Document is
      -- processed again, and deleted with it.
      CREATE TABLE document_pages (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents (id),
        page INTEGER,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX document_pages_by_document ON document_pages (document_id, page)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 12,
    description: "Tags, the Tags on each Document, and automatic tagging's state",
    sql: `
      -- Labels with a short description. preset is the key of the preset Tag a
      -- row was created as on first run (e.g. 'paper'), NULL for the User's own;
      -- it outlives edits, so a later sync can tell two devices' presets apart.
      -- Names are unique among live Tags, ignoring case: the core checks it,
      -- since a later sync may bring two.
      CREATE TABLE tags (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        preset TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX tags_by_name ON tags (name COLLATE NOCASE) WHERE deleted_at IS NULL;

      -- The Tags each Document carries: one live row per Document and Tag.
      -- source is 'automatic' (automatic tagging applied it, and may take it
      -- away again) or 'user' (the User added it). Taking a Tag off marks the
      -- row deleted; when the User does, the row's source becomes 'user'. So a
      -- Document and Tag with any 'user' row, live or deleted, are the User's:
      -- automatic tagging never adds, keeps or removes that Tag there again.
      -- confidence (0 to 1) and needs_review are set by taggers that give a
      -- probability; the chat model doesn't. No foreign keys: a later sync may
      -- deliver a link before its Document or Tag.
      CREATE TABLE document_tags (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('automatic', 'user')),
        confidence REAL,
        needs_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX document_tags_by_pair ON document_tags (document_id, tag_id)
        WHERE deleted_at IS NULL;
      CREATE INDEX document_tags_by_tag ON document_tags (tag_id) WHERE deleted_at IS NULL;
      CREATE INDEX document_tags_by_user ON document_tags (document_id, tag_id)
        WHERE source = 'user';

      -- Where automatic tagging is for each Document, separately from status
      -- (a Document is searchable once ready, tagged or not): pending |
      -- waiting-for-provider | tagging | tagged | failed, checked in code. A
      -- failure keeps the provider's error kind and message. Documents from
      -- before this migration start pending, so they get tagged too.
      ALTER TABLE documents ADD COLUMN tagging_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE documents ADD COLUMN tagging_error_kind TEXT;
      ALTER TABLE documents ADD COLUMN tagging_error_message TEXT;
    `,
  },
  {
    version: 14,
    description: "Connectors",
    sql: `
      -- Connectors (MCP servers). transport: 'stdio' for a program on this
      -- computer (remote ones come later), checked in code. config is JSON
      -- without secrets: for stdio, { command, args, env }, where env lists
      -- only the names of the environment variables; their values are in the
      -- keychain, never here. Names are unique among live Connectors, ignoring case.
      CREATE TABLE connectors (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX connectors_by_name ON connectors (name COLLATE NOCASE)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 15,
    description: "Skills (#40)",
    sql: `
      -- Skills the User imported. Their files are in the data folder under
      -- skills/<id>/, and this row holds what the app shows and lists without
      -- reading them: the frontmatter fields, and files, a JSON array of
      -- { path, size, script } with SKILL.md first. Importing a Skill of the
      -- same name again updates the row in place, so it keeps its id. Removing
      -- one marks it deleted; its folder goes once nothing uses it. Names are
      -- unique among live Skills: the core checks it, since a later sync may
      -- bring two. enabled is 1 for on.
      CREATE TABLE skills (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        license TEXT,
        compatibility TEXT,
        files TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX skills_by_name ON skills (name) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 17,
    description: "The size of each Document's vectors, beside their embedding model (#32)",
    sql: `
      -- With a choice of embedding providers (#32), documents.embedding_model
      -- names the provider and server as well as the model (the built-in
      -- model keeps its id), and this records how many float32s each of its
      -- Passages' vectors has: set with the first vector. Search compares a
      -- query only with vectors of the same model and size, so vectors from
      -- different models are never mixed. Every vector so far is the built-in
      -- model's, of 384.
      ALTER TABLE documents ADD COLUMN embedding_dimensions INTEGER;
      UPDATE documents SET embedding_dimensions = 384
        WHERE embedding_model = 'multilingual-e5-small-int8';
    `,
  },
  {
    version: 19,
    description: "Built-in Skills (#42)",
    sql: `
      -- Skills that ship with the app. built_in is 1 for one the core
      -- installed from the app's copy at startup, 0 for one the User imported
      -- or duplicated. built_in_digest is the SHA-256 of the app's files it was
      -- installed from: a start with other files (a newer version of the app)
      -- updates it in place, keeping its id and whether it's on. Removing one
      -- marks the row deleted, like any Skill; a deleted built-in row of a name
      -- is how later starts know the User removed it, so it isn't installed again.
      ALTER TABLE skills ADD COLUMN built_in INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE skills ADD COLUMN built_in_digest TEXT;
    `,
  },
  {
    version: 20,
    description: "Approval policies (#38)",
    sql: `
      -- What the User chose about asking before something runs, replacing the
      -- default. subject_kind: 'tool' (one Tool of one Connector) or
      -- 'skill-script' (the scripts of one Skill, #41), checked in code.
      -- subject_id: for 'tool', the Connector's id and the Tool's name as the
      -- Connector gives it, joined by ':' (a UUID has none); for
      -- 'skill-script', the Skill's id. policy: 'always' (always allow, or
      -- always run) or 'ask' (ask every time, even for a Tool its Connector
      -- says only reads), checked in code. One live row per subject: changing
      -- the policy updates it, revoking it marks it deleted. No foreign keys: a
      -- later sync may deliver a policy before its Connector or Skill.
      CREATE TABLE approval_policies (
        id TEXT PRIMARY KEY NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        policy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX approval_policies_by_subject ON approval_policies (subject_kind, subject_id)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 21,
    description: "Documents indexed in place: Linked folders, file paths and versions (ADR-0010)",
    sql: `
      -- Folders on the User's computer that IncarnaMind keeps in sync, read
      -- only: every supported file in one, at any depth, is a Document. path is
      -- absolute, with symbolic links resolved. layout is how the sidebar shows
      -- it: 'tree' (its sub-folders as Folders) or 'flat' (one list, for
      -- Zotero-style folders of one file each), NULL until its first scan
      -- suggests one. paused is 1 while its indexing is paused.
      -- ignore_patterns is a JSON array of extra names or relative paths to
      -- leave out, on top of hidden files, .git and node_modules (no UI yet).
      CREATE TABLE linked_folders (
        id TEXT PRIMARY KEY NOT NULL,
        path TEXT NOT NULL,
        layout TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        ignore_patterns TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX linked_folders_by_path ON linked_folders (path) WHERE deleted_at IS NULL;

      -- Folders now mirror the folders inside Linked folders, as they are on
      -- disk; the in-app Folders the User filed Documents in by hand are gone.
      -- They are marked deleted, so a Search scope naming one shows it as a
      -- deleted Folder. A Folder's id is derived from its Linked folder and its
      -- relative_path ('' for the Linked folder itself, '/' between names), so
      -- it is the same at every scan.
      UPDATE folders SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE deleted_at IS NULL;
      ALTER TABLE folders ADD COLUMN linked_folder_id TEXT;
      ALTER TABLE folders ADD COLUMN relative_path TEXT;
      CREATE INDEX folders_by_linked_folder ON folders (linked_folder_id) WHERE deleted_at IS NULL;

      -- A Document is a file at a path, indexed where the User keeps it. The
      -- same content at two paths is two Documents, so content_hash is no
      -- longer unique. content_hash is the version whose text is indexed (the
      -- SHA-256 of the file as it was read). path is absolute: NULL only for
      -- Documents copied into the data folder before this migration, whose
      -- path the core fills in at startup (their copy in documents/, until
      -- the User links the folder the original is in). linked_folder_id is the
      -- Linked folder the file is in, NULL for a file added on its own.
      -- file_status: 'available' | 'missing' (the file is gone) |
      -- 'unavailable' (its Linked folder, or a single file's folder, can't be
      -- reached, or the file can't be read), checked in code. size and
      -- file_mtime_ms are the file's as last seen, so a scan only reads files
      -- whose size or modified time changed. Documents filed in the old
      -- Folders become unfiled.
      UPDATE documents SET folder_id = NULL WHERE folder_id IS NOT NULL;
      DROP INDEX documents_by_content_hash;
      CREATE INDEX documents_by_content_hash ON documents (content_hash) WHERE deleted_at IS NULL;
      ALTER TABLE documents ADD COLUMN path TEXT;
      ALTER TABLE documents ADD COLUMN linked_folder_id TEXT;
      ALTER TABLE documents ADD COLUMN file_status TEXT NOT NULL DEFAULT 'available';
      ALTER TABLE documents ADD COLUMN file_mtime_ms REAL;
      CREATE UNIQUE INDEX documents_by_path ON documents (path) WHERE deleted_at IS NULL;
      CREATE INDEX documents_by_linked_folder ON documents (linked_folder_id)
        WHERE deleted_at IS NULL;

      -- Each Passage and each page of text belongs to one version of its
      -- Document: the content_hash it was built from. When the file changes,
      -- the new version's Passages replace the old ones in search, but the old
      -- version's pages stay for as long as a Citation quotes that version,
      -- so its check still reads the text it quoted.
      ALTER TABLE passages ADD COLUMN content_hash TEXT;
      UPDATE passages SET content_hash =
        (SELECT d.content_hash FROM documents d WHERE d.id = passages.document_id);
      ALTER TABLE document_pages ADD COLUMN content_hash TEXT;
      UPDATE document_pages SET content_hash =
        (SELECT d.content_hash FROM documents d WHERE d.id = document_pages.document_id);
      DROP INDEX document_pages_by_document;
      CREATE INDEX document_pages_by_version ON document_pages (document_id, content_hash, page)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 22,
    description: "Each Document's text as Units: pages, slides, sections, rows, lines (ADR-0011)",
    sql: `
      -- Each row of document_pages is now one Unit of a version's text: a
      -- PDF's page, a deck's slide (its speaker notes included), a section of
      -- a Word or Markdown file, a block of rows of one sheet of a spreadsheet
      -- or CSV, or a block of lines of a plain-text file. page is the Unit's
      -- number, from 1: a PDF's page, a deck's slide. kind says which:
      -- 'page' | 'slide' | 'section' | 'rows' | 'lines' | 'text', checked in
      -- code. label is JSON (UnitLabel in src/shared/units.ts: a section's
      -- heading path, a block's sheet and rows…), NULL for pages. anchors is
      -- a JSON array of { start, end, target } mapping spans of the text to a
      -- slide's shapes and notes or a section's paragraphs, NULL where none
      -- are stored (pages; rows work theirs out from the text). A TXT or
      -- Markdown file stored as one text, with page NULL, becomes Unit 1 of
      -- kind 'text': the current versions are processed again into sections
      -- and lines, and the old versions Citations quote keep their one text.
      ALTER TABLE document_pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';
      ALTER TABLE document_pages ADD COLUMN label TEXT;
      ALTER TABLE document_pages ADD COLUMN anchors TEXT;
      UPDATE document_pages SET kind = 'text', page = 1 WHERE page IS NULL;
    `,
  },
  {
    // 23 was reserved for Topics, which Folders and Tags replaced (ADR-0012); it stays unused.
    version: 24,
    description: "Each Document's creation date, read without processing it again (#53)",
    sql: `
      -- When the Document itself was created, for the Library's year: the
      -- creation date in its file's metadata (a PDF's Info dictionary or
      -- XMP, the core properties of a Word, PowerPoint or Excel file), or
      -- else a year written in its first Unit; never a modification date.
      -- ISO 8601 at the precision the file gives, with the offset from UTC
      -- it gives, so the first four characters are the year:
      -- '2019-03-04T10:30:00+01:00', '2019-03-04', or '2019' from text. NULL
      -- when nothing gives one. metadata_version is the version of the
      -- metadata read that set it (METADATA_VERSION in
      -- src/core/documents/processing.ts), 0 for none: those Documents have
      -- their metadata read in the background, one at a time, without being
      -- processed or embedded again. A new version of the file is read as
      -- it is processed.
      ALTER TABLE documents ADD COLUMN creation_date TEXT;
      ALTER TABLE documents ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX documents_by_metadata_version ON documents (metadata_version)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 25,
    description: "User-defined Library groups and persistent primary classifications",
    sql: `
      CREATE TABLE library_groups (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE TABLE document_groups (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id),
        group_id TEXT REFERENCES library_groups(id),
        source TEXT NOT NULL CHECK (source IN ('automatic', 'user')),
        status TEXT NOT NULL,
        content_hash TEXT,
        request_id TEXT NOT NULL,
        error_kind TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX document_groups_live ON document_groups(document_id)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 26,
    description: "Record the model and routing reason for Library classifications",
    sql: `ALTER TABLE document_groups ADD COLUMN classification_model TEXT;`,
  },
  {
    version: 27,
    description: "Tag colours: presets their own, the User's Tags in turn through the palette",
    // The palette is src/shared/tagColours.ts, in order; the preset colours are
    // src/core/tags/presets.ts. Deleted Tags are coloured too, harmlessly.
    sql: `
      ALTER TABLE tags ADD COLUMN colour TEXT NOT NULL DEFAULT 'stone';
      UPDATE tags SET colour = CASE preset
        WHEN 'paper' THEN 'violet'
        WHEN 'report' THEN 'petrol'
        WHEN 'book' THEN 'brick'
        WHEN 'contract' THEN 'indigo'
        WHEN 'invoice' THEN 'rose'
        WHEN 'slides' THEN 'orchid'
        WHEN 'notes' THEN 'taupe'
        ELSE 'stone' END
      WHERE preset IS NOT NULL;
      UPDATE tags SET colour = (
        SELECT CASE turn.n % 8
          WHEN 0 THEN 'stone' WHEN 1 THEN 'taupe' WHEN 2 THEN 'brick' WHEN 3 THEN 'rose'
          WHEN 4 THEN 'orchid' WHEN 5 THEN 'violet' WHEN 6 THEN 'indigo' ELSE 'petrol' END
        FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, rowid) - 1 AS n
          FROM tags WHERE preset IS NULL
        ) AS turn
        WHERE turn.id = tags.id
      )
      WHERE preset IS NULL;
    `,
  },
  {
    version: 28,
    description: "Tag colours: the bright, Finder-like palette",
    // A preset still on its first colour takes its new one (src/core/tags/presets.ts);
    // any other colour takes the nearest bright hue, each a different one, so Tags that
    // differed still do. The column's default, 'stone', is never used: every insert
    // names its colour.
    sql: `
      UPDATE tags SET colour = CASE
        WHEN preset = 'paper' AND colour = 'violet' THEN 'purple'
        WHEN preset = 'report' AND colour = 'petrol' THEN 'blue'
        WHEN preset = 'book' AND colour = 'brick' THEN 'orange'
        WHEN preset = 'contract' AND colour = 'indigo' THEN 'red'
        WHEN preset = 'invoice' AND colour = 'rose' THEN 'green'
        WHEN preset = 'slides' AND colour = 'orchid' THEN 'yellow'
        WHEN preset = 'notes' AND colour = 'taupe' THEN 'gray'
        WHEN colour = 'stone' THEN 'gray'
        WHEN colour = 'taupe' THEN 'yellow'
        WHEN colour = 'brick' THEN 'orange'
        WHEN colour = 'rose' THEN 'red'
        WHEN colour = 'orchid' THEN 'purple'
        WHEN colour = 'violet' THEN 'teal'
        WHEN colour = 'indigo' THEN 'blue'
        WHEN colour = 'petrol' THEN 'green'
        ELSE colour END;
    `,
  },
  {
    version: 29,
    description: "A Document's own title, for names that are machine-made",
    // Read with the metadata (METADATA_VERSION 2 in src/core/documents/processing.ts):
    // Documents from before are read again in the background, once.
    sql: `ALTER TABLE documents ADD COLUMN title TEXT;`,
  },
  {
    version: 30,
    description: "Minds have a kind",
    // Checked in code, not here, so a Mind of a kind a newer version wrote still loads
    // (it is listed, and opens as "update to open"). Every Mind so far is a plain one.
    sql: `
      ALTER TABLE minds ADD COLUMN kind TEXT NOT NULL DEFAULT 'mind';
    `,
  },
  {
    version: 31,
    description: "Chat providers name their provider in the catalog, and its endpoint",
    // The catalog is src/core/providers/catalog/providers.ts: each kind saved so far is one
    // of its providers, except the ChatGPT plan, which has none. A hosted provider is on its
    // one endpoint, "global"; a server keeps its URL in base_url. Keys stay in the keychain
    // under the row's id, which doesn't change.
    sql: `
      ALTER TABLE chat_providers ADD COLUMN catalog_id TEXT;
      ALTER TABLE chat_providers ADD COLUMN endpoint TEXT;
      UPDATE chat_providers SET catalog_id = kind
        WHERE kind IN ('openai', 'anthropic', 'google', 'openai-compatible', 'ollama');
      UPDATE chat_providers SET endpoint = 'global'
        WHERE kind IN ('openai', 'anthropic', 'google');
      -- A provider is one per catalog provider and server, as it was one per kind and server.
      DROP INDEX chat_providers_by_server;
      CREATE UNIQUE INDEX chat_providers_by_server
        ON chat_providers (coalesce(catalog_id, kind), coalesce(base_url, ''))
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 33,
    description: "A provider is one per catalog provider, server and endpoint",
    // Keys and model lists differ by region (Qwen's Beijing and Singapore, Kimi's .cn and .ai),
    // so each endpoint of a hosted provider is its own row with its own key.
    sql: `
      DROP INDEX chat_providers_by_server;
      CREATE UNIQUE INDEX chat_providers_by_server
        ON chat_providers (coalesce(catalog_id, kind), coalesce(base_url, ''), coalesce(endpoint, ''))
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 34,
    description: "A Mind belongs to one Folder, or to none (#111)",
    // The in-app Folder (library_groups) a Mind belongs to; NULL: Not in a
    // Folder, where every Mind made before is. No foreign key: a later sync
    // may deliver a Mind before its Folder. Deleting a Folder sets its Minds'
    // folder_id back to NULL.
    sql: `
      ALTER TABLE minds ADD COLUMN folder_id TEXT;
      CREATE INDEX minds_by_folder ON minds (folder_id) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 35,
    description: "Whether IncarnaMind may add new files inside a Linked folder (#124)",
    // Asked at the first save there, and changed in Settings; allowed is 1 or 0. It ends with
    // its Linked folder: linked again, the folder is asked about again (src/core/outputFiles.ts).
    sql: `
      CREATE TABLE linked_folder_writes (
        id TEXT PRIMARY KEY NOT NULL,
        linked_folder_id TEXT NOT NULL,
        allowed INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX linked_folder_writes_by_folder ON linked_folder_writes (linked_folder_id)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 36,
    description: "Suggested Folders wait for the User, and a rejected one isn't suggested again",
    // Every assignment so far keeps what it was: none of them is a suggestion. No foreign
    // keys: a later sync may deliver a rejection before its Document or Folder.
    sql: `
      ALTER TABLE document_groups ADD COLUMN suggested INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE document_group_rejections (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX document_group_rejections_live
        ON document_group_rejections (document_id, group_id) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 38,
    description:
      "Meetings: a recording's state, its stretches and how long its audio is kept (#135)",
    // The audio itself is in the data folder, meetings/<id>/, one WAV file per 10 seconds per
    // source (src/core/meetings/audioFiles.ts): the files are what survives a crash, so they
    // aren't listed here. periods is JSON, the stretches recorded, in order: each
    // { start, offsetMs, end, endedBy }, start and end ISO 8601 UTC wall-clock times (end null
    // while it lasts), offsetMs the Meeting's time when it began, endedBy one of 'pause',
    // 'stop', 'sleep' or 'interrupted' (IncarnaMind closed while recording).
    sql: `
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY NOT NULL,
        mind_id TEXT NOT NULL REFERENCES minds(id),
        status TEXT NOT NULL CHECK (status IN ('ready', 'recording', 'paused', 'stopped')),
        paused_by TEXT CHECK (paused_by IN ('user', 'interrupted')),
        system_audio INTEGER NOT NULL DEFAULT 1,
        periods TEXT NOT NULL DEFAULT '[]',
        started_at TEXT,
        stopped_at TEXT,
        audio_expires_at TEXT,
        audio_deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX meetings_by_mind ON meetings (mind_id) WHERE deleted_at IS NULL;
    `,
  },
  {
    // 37 and 38 are reserved by work in progress.
    version: 39,
    description:
      "Recently deleted: what was deleted permanently, and what a Folder's deletion took out",
    // Restoring a deleted row brings back the rows deleted with it: those whose deleted_at is
    // its own (src/core/recentlyDeleted.ts).
    sql: `
      -- When a deleted row's content was dropped, by the User or 30 days after it was
      -- deleted. The row stays as its tombstone, so a later sync can pass the deletion on.
      ALTER TABLE minds ADD COLUMN purged_at TEXT;
      ALTER TABLE documents ADD COLUMN purged_at TEXT;
      ALTER TABLE tags ADD COLUMN purged_at TEXT;
      ALTER TABLE library_groups ADD COLUMN purged_at TEXT;
      CREATE INDEX documents_by_deleted_at ON documents (deleted_at)
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

      -- What deleting a Folder (library_groups) took out of it: one row per Document and Mind
      -- in it (item_kind 'document' or 'mind', checked in code), so restoring the Folder puts
      -- back those still in none, a suggested Folder as a suggestion again (suggested is 1).
      -- Restoring it marks its rows deleted.
      CREATE TABLE deleted_folder_items (
        id TEXT PRIMARY KEY NOT NULL,
        folder_id TEXT NOT NULL,
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        suggested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX deleted_folder_items_by_folder ON deleted_folder_items (folder_id)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 40,
    description: "A Mind without a title is named by its first line of text",
    // Kept up to date by the core as the Mind is edited; the title the User typed stays in `title`.
    sql: `ALTER TABLE minds ADD COLUMN auto_title TEXT NOT NULL DEFAULT '';`,
  },
  {
    version: 42,
    description: "Reference records: what a citation style needs to cite a Document (#286)",
    sql: `
      -- A Document's reference record (src/core/referenceRecords): its type, title,
      -- authors, date, venue, volume, issue, pages, publisher, DOI, URL and
      -- language. fields is JSON, one entry per field that has a value or
      -- that the User cleared: { "<field>": { "value": …, "source": "file" |
      -- "lookup" | "user" } }, checked in code, so a field a later version
      -- adds needs no migration. Reading the file again replaces only "file"
      -- values; the User's edits ("user") are never replaced. looked_up_at:
      -- when Look up last filled it, NULL if never. document_id is NULL for
      -- a reference with no Document yet (an imported one, #287), and stays
      -- set when its Document leaves the index, so the Citations that quote
      -- it can still be listed in a Bibliography. No foreign key: a later
      -- sync may deliver a record before its Document.
      CREATE TABLE reference_records (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT,
        fields TEXT NOT NULL,
        looked_up_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX reference_records_by_document ON reference_records (document_id)
        WHERE deleted_at IS NULL AND document_id IS NOT NULL;
    `,
  },
  {
    // 41, 43 and 44 are reserved by work in progress.
    version: 45,
    description: "Conversations: the assistant's own history, kept per Folder (ADR-0017)",
    // No foreign keys: a later sync may bring a message before its conversation, or a
    // conversation before its Folder or the Mind a Question was asked from.
    sql: `
      -- A conversation of the assistant. title is the one the User typed ('' for none);
      -- auto_title is its name from what was asked (the first Question, cut). folder_id is the
      -- in-app Folder (library_groups) it belongs to, NULL: Not in a Folder. Deleting a Folder
      -- sets it back to NULL, recorded in deleted_folder_items as item_kind 'conversation'.
      -- purged_at: when it was deleted permanently, its messages and titles dropped; the row
      -- stays as its tombstone.
      CREATE TABLE conversations (
        seq INTEGER PRIMARY KEY, -- local key for the keyword index only
        id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        auto_title TEXT NOT NULL DEFAULT '',
        folder_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        purged_at TEXT
      ) STRICT;
      CREATE INDEX conversations_by_folder ON conversations (folder_id) WHERE deleted_at IS NULL;
      CREATE INDEX conversations_by_updated_at ON conversations (updated_at) WHERE deleted_at IS NULL;
      CREATE INDEX conversations_by_deleted_at ON conversations (deleted_at)
        WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

      -- Its messages, in order of position (given on the computer that adds one; a sync that
      -- brings two at one position orders them by created_at, then id). kind: 'question' |
      -- 'answer', checked in code, so a kind a newer version writes is skipped. A Question
      -- keeps its text, the Mind in focus when it was asked (asked_from_mind_id, NULL: none),
      -- its Search scope (JSON { folderIds, tagIds, documentIds }, NULL: none), the model
      -- picked (provider_id, model_id, NULL: the default) and the Skill forced on it. An
      -- Answer keeps its Question (question_id), its text (Markdown with a Citation marker
      -- "[^n]" where each Citation goes), its Citations (a JSON array, each with its marker),
      -- the model that wrote it, status ('streaming' | 'done' | 'stopped' | 'failed', checked
      -- in code), why it failed, how the model cited and its Tool calls (a JSON array).
      CREATE TABLE conversation_messages (
        seq INTEGER PRIMARY KEY, -- local key for the keyword index only
        id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        question_id TEXT,
        text TEXT NOT NULL,
        asked_from_mind_id TEXT,
        scope TEXT,
        provider_id TEXT,
        model_id TEXT,
        forced_skill TEXT,
        status TEXT,
        error_kind TEXT,
        error_message TEXT,
        citation_support TEXT,
        citations TEXT NOT NULL DEFAULT '[]',
        tool_calls TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX conversation_messages_by_conversation
        ON conversation_messages (conversation_id, position) WHERE deleted_at IS NULL;

      -- Keyword indexes, as for Passages (migration 10): the words of each conversation's name
      -- and of each message's text, segmented by the core; rowid is the row's seq. Only the
      -- index is stored.
      CREATE VIRTUAL TABLE conversations_fts USING fts5 (
        text,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE conversation_messages_fts USING fts5 (
        text,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Conversations are no longer Minds of kind 'chat' (ADR-0017). Nothing made one, but
      -- any that exists becomes a plain Mind rather than one this version can't open.
      UPDATE minds SET kind = 'mind' WHERE kind = 'chat';
    `,
  },
  {
    version: 46,
    description: "The record of AI use: what the AI wrote into a Mind and what became of it (#292)",
    sql: `
      -- One row per AI insertion (or rejected proposal) in a Mind (src/core/aiUse).
      -- Kept on this computer and never sent anywhere (ADR-0014). It holds no
      -- text of the Mind or of the AI: only the kind of use, the model, the size
      -- in characters, the Block ids the insertion made, and a hash of each
      -- Block's text when it was inserted, so a later edit or deletion can be
      -- told from the Block id alone. kind: answer-added | suggestion-accepted |
      -- assistant-change-accepted | assistant-change-rejected | edit-with-ai-accepted.
      -- outcome: kept | edited | deleted | rejected. blocks is JSON:
      -- [{ "id": "<Block id>", "hash": "<sha-256 of its text>" | null }], hash
      -- NULL until the Block has been seen in the Mind. No foreign key to
      -- minds: a later sync may deliver a row before its Mind.
      CREATE TABLE ai_use (
        id TEXT PRIMARY KEY NOT NULL,
        mind_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        outcome TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        characters INTEGER NOT NULL,
        blocks TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX ai_use_by_mind ON ai_use (mind_id) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 47,
    description: "Web pages saved as Documents: each version's address, site and fetch time",
    // A web page Document's file is its snapshot (src/core/documents/web); a row per
    // version it has had, by the snapshot's content hash, so a Citation of an older
    // version still says when that one was fetched.
    sql: `
      CREATE TABLE web_pages (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents (id),
        content_hash TEXT NOT NULL,
        address TEXT NOT NULL,
        site_name TEXT NOT NULL,
        author TEXT,
        published TEXT,
        fetched_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX web_pages_by_version ON web_pages (document_id, content_hash)
        WHERE deleted_at IS NULL;
      CREATE INDEX web_pages_by_address ON web_pages (address) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 48,
    description:
      "Versions of Documents that check results, saved pages, Tasks and Checkpoints need",
    sql: `
      -- One row per version of a Document, and place in it, that an owner retains
      -- (src/core/documents/retention.ts). kind is 'check-result', 'saved-page', 'task'
      -- or 'checkpoint', checked in code; owner_id is that check result, saved page, Task
      -- or Checkpoint. page_from and page_to are the Units (pages, slides…), from 1, both
      -- NULL for all of them; location is where, as a Citation's Location (JSON), NULL if
      -- it doesn't say. The start-up clean-up keeps a retained version's text, as it keeps
      -- a quoted one's. A release marks rows deleted; they are forgotten 30 days later.
      -- No foreign keys: a later sync may bring a row before its Document or owner.
      CREATE TABLE retained_versions (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        page_from INTEGER,
        page_to INTEGER,
        location TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX retained_versions_by_owner ON retained_versions (kind, owner_id)
        WHERE deleted_at IS NULL;
      CREATE INDEX retained_versions_by_version ON retained_versions (document_id, content_hash)
        WHERE deleted_at IS NULL;
      CREATE INDEX retained_versions_released ON retained_versions (deleted_at)
        WHERE deleted_at IS NOT NULL;
    `,
  },
  {
    version: 49,
    description: "Found sources: where a Document or reference Find sources added came from (#296)",
    sql: `
      -- One row per Document, or reference record with no Document, that Find
      -- sources added (src/core/sources, ADR-0018): the Source provider whose
      -- copy or record it is (its id, e.g. "openalex"), the work's key
      -- ("doi:10.1038/…", "arxiv:1706.03762"), the provider's name as it was
      -- then ("OpenAlex"), the address its text was
      -- fetched from (its page at the publisher, for a reference alone), the
      -- licence and version of that text ("cc-by"; "published", "accepted"
      -- or "submitted") and the version's date (ISO 8601 at the precision
      -- known), and when it was fetched (NULL for a reference alone). No
      -- foreign keys: a later sync may deliver a row before its Document.
      CREATE TABLE found_sources (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT,
        reference_record_id TEXT,
        provider TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        work_key TEXT NOT NULL,
        address TEXT,
        licence TEXT,
        version TEXT,
        version_date TEXT,
        fetched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX found_sources_by_work ON found_sources (work_key) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX found_sources_by_document ON found_sources (document_id)
        WHERE deleted_at IS NULL AND document_id IS NOT NULL;
    `,
  },
  {
    version: 50,
    description:
      "Files IncarnaMind wrote: their fingerprints, the Documents they became, and Count it (#80)",
    sql: `
      -- The content fingerprint of each file IncarnaMind wrote (src/core/documents/ownFiles.ts):
      -- the SHA-256 of its bytes, hex, as documents.content_hash is. kind is 'export' or
      -- 'source-pack', checked in code. Recorded before the file is written. No path: the
      -- same bytes are the same file wherever they are copied, on any device.
      CREATE TABLE own_files (
        id TEXT PRIMARY KEY NOT NULL,
        content_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX own_files_by_content_hash ON own_files (content_hash) WHERE deleted_at IS NULL;

      -- own_file: the kind IncarnaMind wrote a Document's file as, set once a version of it
      -- has a recorded fingerprint, and kept when the User edits the file, since what it says
      -- still came from a Mind. NULL: the User's own file, or a source IncarnaMind saved (a
      -- web page, a Transcript). Checks leave such a Document out of their evidence unless
      -- counted_as_evidence is 1 (the User's "Count it"), its Folder counts IncarnaMind's
      -- files, or Settings does.
      ALTER TABLE documents ADD COLUMN own_file TEXT;
      ALTER TABLE documents ADD COLUMN counted_as_evidence INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX documents_by_own_file ON documents (own_file)
        WHERE deleted_at IS NULL AND own_file IS NOT NULL;

      -- Kept in step here, whichever comes first, so no way a Document gets a version (added,
      -- moved, a new version indexed, a later sync) can miss it. Derived on each device, like
      -- the keyword index, so updated_at is left alone.
      CREATE TRIGGER documents_own_file_added AFTER INSERT ON documents
      WHEN new.own_file IS NULL AND EXISTS (
        SELECT 1 FROM own_files WHERE content_hash = new.content_hash AND deleted_at IS NULL
      ) BEGIN
        UPDATE documents SET own_file = (
          SELECT kind FROM own_files WHERE content_hash = new.content_hash AND deleted_at IS NULL
          ORDER BY created_at, rowid LIMIT 1
        ) WHERE id = new.id;
      END;
      CREATE TRIGGER documents_own_file_versioned AFTER UPDATE OF content_hash ON documents
      WHEN new.own_file IS NULL AND EXISTS (
        SELECT 1 FROM own_files WHERE content_hash = new.content_hash AND deleted_at IS NULL
      ) BEGIN
        UPDATE documents SET own_file = (
          SELECT kind FROM own_files WHERE content_hash = new.content_hash AND deleted_at IS NULL
          ORDER BY created_at, rowid LIMIT 1
        ) WHERE id = new.id;
      END;
      CREATE TRIGGER own_files_recorded AFTER INSERT ON own_files
      WHEN new.deleted_at IS NULL BEGIN
        UPDATE documents SET own_file = new.kind
        WHERE content_hash = new.content_hash AND own_file IS NULL AND deleted_at IS NULL;
      END;

      -- A Folder where checks count IncarnaMind's files as evidence: the User switched their
      -- exclusion off there. 0 or 1.
      ALTER TABLE library_groups ADD COLUMN counts_own_files INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 51,
    description: "Outside agents: pairings, the Citations minted for them, and what they did",
    sql: `
      -- Each outside agent the User connected (#351), on this device only: the agent runs on
      -- this computer, so these rows never sync. folder_ids is the Folders it may read (a JSON
      -- list of ids), none by default. client is the agent it was set up in (e.g. "codex"), so
      -- disconnecting can take IncarnaMind out of that agent's settings too; NULL for one set
      -- up by hand. Its token is kept by secrets.ts, never here.
      CREATE TABLE agent_pairings (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        folder_ids TEXT NOT NULL DEFAULT '[]',
        client TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      -- A Citation minted for an outside agent: its token ("[cite:k3x9a2b7]") stands for one
      -- quote, checked as found at one Location of one version of a Document, so a later check
      -- and opening it read the same. location is a Citation's Location (JSON), or NULL.
      -- The same quote of the same Passage for the same pairing keeps its token.
      CREATE TABLE agent_citations (
        id TEXT PRIMARY KEY NOT NULL,
        token TEXT NOT NULL,
        pairing_id TEXT NOT NULL,
        passage_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        page_from INTEGER,
        page_to INTEGER,
        location TEXT,
        quote TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX agent_citations_by_token ON agent_citations (token)
        WHERE deleted_at IS NULL;
      CREATE INDEX agent_citations_by_quote ON agent_citations (pairing_id, passage_id)
        WHERE deleted_at IS NULL;

      -- Every call an outside agent made, for its activity list: summary is what it asked, as
      -- the list shows it; document_ids and effects are JSON. No Document text is kept here.
      CREATE TABLE agent_activity (
        id TEXT PRIMARY KEY NOT NULL,
        pairing_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        summary TEXT NOT NULL,
        outcome TEXT NOT NULL,
        problem TEXT,
        result_count INTEGER,
        document_ids TEXT NOT NULL DEFAULT '[]',
        effects TEXT NOT NULL DEFAULT '[]',
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX agent_activity_by_pairing ON agent_activity (pairing_id, created_at)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 52,
    description: "The citation style new Minds in a Folder start in (#289)",
    // The id of the style last chosen for a Mind in the Folder (src/shared/citationStyles.ts);
    // NULL: none was, and its new Minds are Numbered. One a newer version knows and this one
    // doesn't reads as NULL.
    sql: `
      ALTER TABLE library_groups ADD COLUMN citation_style TEXT;
    `,
  },
  {
    version: 53,
    description: "Sign in with ChatGPT replaces the experimental ChatGPT plan provider",
    sql: `
      -- Sign in with ChatGPT (#122) replaces the experimental "ChatGPT plan (via Codex
      -- sign-in)" provider and its per-device switch. Its providers (kind 'chatgpt') stay
      -- where the switch was on, and need a new sign-in; where it was off they were hidden,
      -- and now go, with a default chat model on one of them. Nothing is sent to chatgpt.com
      -- any more, so decisions about sending there go too. The core forgets the switch and
      -- the old tokens in the secret store at start-up (forgetCodexSignIn), after this.
      UPDATE chat_providers
        SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE kind = 'chatgpt' AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM device_settings
            WHERE key = 'chatGptPlanEnabled' AND value = 'true' AND deleted_at IS NULL
          );
      UPDATE user_settings
        SET value = 'null', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE key = 'chatModel' AND deleted_at IS NULL
          AND json_extract(value, '$.providerId') IN (
            SELECT id FROM chat_providers WHERE kind = 'chatgpt' AND deleted_at IS NOT NULL
          );
      UPDATE data_flow_consents
        SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE service_id = 'https://chatgpt.com' AND deleted_at IS NULL;
    `,
  },
  {
    version: 54,
    description:
      "Answers in conversations keep where the third-party text their Run read came from (#78)",
    sql: `
      -- An Answer written by a Run that had read third-party text (src/core/answers, ADR-0013):
      -- where it came from, 'imported' | 'web-page' | 'checked-document', checked in code.
      -- NULL: the Run read none. A later Question in the conversation then counts as having
      -- read it too, and asks before an "always allowed" write or send. Questions keep NULL.
      ALTER TABLE conversation_messages ADD COLUMN text_origin TEXT;
    `,
  },
  {
    version: 56,
    description: "Each cloud model request's tokens and cost, for the monthly cap (#83)",
    sql: `
      -- One row per request to a cloud chat model (src/core/cost/meter.ts). A request billed per
      -- token is first 'reserved' at its most (its prompt and its output limit), then 'settled' at
      -- what its provider reported, or at the reservation when it reported nothing. A request
      -- the provider refused before answering is soft-deleted: it cost nothing. A ChatGPT plan
      -- request has no price: its tokens are recorded, never its cost.
      -- billing: 'per-token' | 'plan'; status: 'reserved' | 'settled'; flow: the data flow it
      -- went out on ('chat', 'tagging'…) or 'test'. Amounts are in currency ('USD' | 'CNY'),
      -- NULL with no known price.
      CREATE TABLE model_requests (
        id TEXT PRIMARY KEY NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        flow TEXT NOT NULL,
        billing TEXT NOT NULL,
        status TEXT NOT NULL,
        currency TEXT,
        reserved REAL,
        cost REAL,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        cache_write_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX model_requests_by_created_at ON model_requests (created_at)
        WHERE deleted_at IS NULL;
      CREATE INDEX model_requests_reserved ON model_requests (status)
        WHERE status = 'reserved' AND deleted_at IS NULL;
    `,
  },
  {
    version: 58,
    description:
      "Documents known by where they belong, not by their path on one computer (ADR-0020)",
    sql: `
      -- Where a Document's file belongs, the same on every computer. source_kind:
      -- 'linked-folder' (relative_path is inside its Linked folder), 'data-folder' (a file
      -- IncarnaMind keeps, such as a web page's snapshot: relative_path is inside the data
      -- folder) or 'file' (added on its own: nothing but its id; relative_path is NULL),
      -- checked in code, so a kind a newer version adds is left alone. relative_path has "/"
      -- between names on every system. path, file_mtime_ms and file_status, and a Linked
      -- folder's path, are this computer's: derived from these, or seen here, never synced.
      -- The core marks the files in the data folder at its next start: only it knows where
      -- that is. Files aren't read: each is found where it was.
      ALTER TABLE documents ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'file';
      ALTER TABLE documents ADD COLUMN relative_path TEXT;
      -- A Linked folder's path has "/" first on macOS and Linux, and "\\" between names on
      -- Windows, which become "/". A path not inside its Linked folder gets none.
      UPDATE documents SET source_kind = 'linked-folder', relative_path = (
        SELECT CASE
          WHEN substr(l.path, 1, 1) = '/' THEN CASE
            WHEN substr(documents.path, 1, length(rtrim(l.path, '/')) + 1) = rtrim(l.path, '/') || '/'
            THEN substr(documents.path, length(rtrim(l.path, '/')) + 2) END
          ELSE CASE
            WHEN substr(documents.path, 1, length(rtrim(l.path, '\\')) + 1) = rtrim(l.path, '\\') || '\\'
            THEN replace(substr(documents.path, length(rtrim(l.path, '\\')) + 2), '\\', '/') END
        END
        FROM linked_folders l WHERE l.id = documents.linked_folder_id
      ) WHERE linked_folder_id IS NOT NULL;
      CREATE UNIQUE INDEX documents_by_place ON documents (linked_folder_id, relative_path)
        WHERE deleted_at IS NULL AND linked_folder_id IS NOT NULL;

      -- The workspace: everything this data folder holds. One live row, made by the core at
      -- its first start; computers that sync a User's Minds will share it. No account.
      CREATE TABLE workspace (
        id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
    `,
  },
  {
    version: 59,
    description:
      "Outside agents remember the settings files and folders IncarnaMind created (#495)",
    sql: `
      -- The settings files, and the folders for them, that setting an agent up created because
      -- they did not exist (a JSON list of absolute paths, shallowest first), so Disconnect can
      -- take back what IncarnaMind made and nothing the User had. On this device only.
      ALTER TABLE agent_pairings ADD COLUMN created_paths TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 62,
    description: "Answers in conversations keep how they were reached: their steps (#391)",
    sql: `
      -- An Answer's steps (src/core/answers, AnswerSteps), as JSON: when its Question went to the
      -- model and when it ended, its phases and when each began (ISO 8601, UTC), and its model's
      -- reasoning summary and how long it thought, from a provider that summarizes reasoning
      -- (raw chain of thought is never stored). NULL: an Answer written before, and Questions.
      ALTER TABLE conversation_messages ADD COLUMN steps TEXT;
    `,
  },
  {
    version: 67,
    description: "Answers in conversations keep their calculated figures (#438)",
    sql: `
      -- An Answer's calculated figures (src/core/answers/calculations.ts, ADR-0021), as a JSON
      -- list: each figure's marker ("[=1]" in the text), label, formula, inputs (each with the
      -- Citation it reads its number from, the number as written and where, and the cell or the
      -- unit line it came with), result, shown text, and the evaluator version it was worked out
      -- by. '[]' for a Question, and for an Answer with none.
      ALTER TABLE conversation_messages ADD COLUMN figures TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 68,
    description:
      "A Document's file is known on this computer's disk, so moved and edited it stays the same Document (#389)",
    sql: `
      -- Which file a Document's is on this computer's disks, from stat: its device, file number
      -- and creation time in nanoseconds, as decimal text (src/core/documents/files.ts). A file
      -- moved and edited on the same disk while IncarnaMind didn't see it keeps all three. Like
      -- path, file_mtime_ms and file_status, they are this computer's (ADR-0020): seen here,
      -- different on another computer, and never synced. NULL until the file is next seen;
      -- file_number and file_created_ns stay NULL where the file system gives none.
      ALTER TABLE documents ADD COLUMN file_device TEXT;
      ALTER TABLE documents ADD COLUMN file_number TEXT;
      ALTER TABLE documents ADD COLUMN file_created_ns TEXT;
      CREATE INDEX documents_by_file_number ON documents (file_number)
        WHERE deleted_at IS NULL AND file_number IS NOT NULL;
    `,
  },
  {
    // 69 to 71 are reserved by work in progress.
    version: 72,
    description: "A Question in the assistant reads the Mind it was asked from (#544)",
    sql: `
      -- A Question keeps where the User was in the Mind it was asked from, as JSON
      -- { selection, blockIds }: the text they selected ('' for none) and the ids of the
      -- top-level Blocks it is in, or the one the cursor is in. NULL: none.
      ALTER TABLE conversation_messages ADD COLUMN focus TEXT;
      -- An Answer keeps the Mind it read (NULL: none), its version as read (a fingerprint of
      -- its text), and 1 if only part of it fitted the model's window.
      ALTER TABLE conversation_messages ADD COLUMN read_mind_id TEXT;
      ALTER TABLE conversation_messages ADD COLUMN read_mind_version TEXT;
      ALTER TABLE conversation_messages ADD COLUMN read_partial INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 73,
    description: "The cited page, saved when a Citation is made (#133)",
    sql: `
      -- How one Location of one version of a Document looked (src/core/citedPages.ts): a
      -- picture in the data folder's "Cited pages", <id>.png or <id>.jpg, never in the
      -- database, and never searched. One row per Location and version: page_from and
      -- page_to are its Units, area what of them is drawn (JSON: a sheet's cited rows, or
      -- the kind of Location for all of them). image_type is NULL while it waits to be drawn;
      -- then the picture's type, its size in pixels, and the text drawn on it (JSON: each
      -- run's text and box, for a quote to be found on it). A row goes (deleted_at) when it
      -- can't be drawn, or at a start once no Citation or Checkpoint points at it; gone rows
      -- are forgotten 30 days later. The pictures are this computer's.
      CREATE TABLE cited_pages (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        page_from INTEGER NOT NULL,
        page_to INTEGER NOT NULL,
        area TEXT NOT NULL,
        image_type TEXT,
        width INTEGER,
        height INTEGER,
        text TEXT,
        saved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX cited_pages_by_place
        ON cited_pages (document_id, content_hash, page_from, page_to, area)
        WHERE deleted_at IS NULL;
      CREATE INDEX cited_pages_waiting ON cited_pages (created_at)
        WHERE deleted_at IS NULL AND image_type IS NULL;
      CREATE INDEX cited_pages_gone ON cited_pages (deleted_at) WHERE deleted_at IS NOT NULL;
    `,
  },
  {
    version: 75,
    description: "Word files imported as Minds keep their original package (#104)",
    sql: `
      -- The .docx a Mind was imported from, kept in the data folder as "Word imports/<sha256>.docx"
      -- so export can write back into it (#105) after the User's file has moved or gone. Two Minds
      -- imported from the same file share it. completed_at: when every Block was written; NULL
      -- while the import runs, so one a quit cut short goes on at the next start. deleted_at: the
      -- Mind was deleted permanently, and the package goes once no Mind keeps it.
      CREATE TABLE word_packages (
        id TEXT PRIMARY KEY NOT NULL,
        mind_id TEXT NOT NULL REFERENCES minds (id),
        sha256 TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX word_packages_by_mind ON word_packages (mind_id) WHERE deleted_at IS NULL;
      CREATE INDEX word_packages_by_sha256 ON word_packages (sha256) WHERE deleted_at IS NULL;
    `,
  },
  {
    // 76 to 79 are reserved by work in progress.
    version: 80,
    description: "Models the User added to a provider's model menu (#513)",
    sql: `
      -- A model id the catalog does not offer in the menu by default (an unknown, deprecated or
      -- other-API id), that the User put there from Settings → Models → Other models.
      CREATE TABLE chat_menu_models (
        id TEXT PRIMARY KEY NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX chat_menu_models_by_model ON chat_menu_models (provider_id, model_id)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 81,
    description: "Tasks keep a journal that survives a force-quit, and schedules (#126)",
    sql: `
      -- One row per Task: a Run that goes on in the background (src/core/runs/tasks.ts). kind
      -- names what runs it ('comparison'…), checked in code, so a kind a newer version adds is
      -- left alone; input is what it runs, its kind's JSON. status: 'running' | 'paused' |
      -- 'done' | 'stopped' | 'failed'. paused_reason: 'user' | 'closed' | 'cost-cap' |
      -- 'plan-limit' | 'not-ready'; resets_at: when a plan's limit resets. ask: what it waits
      -- for the User to answer (JSON), NULL for nothing; asks: how many times it has asked.
      -- progress: its items settled and in all (JSON). problem: why it failed.
      -- A Task left 'running' by a quit or a crash is settled at the next start.
      CREATE TABLE runs (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        mind_id TEXT,
        input TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        paused_reason TEXT,
        resets_at TEXT,
        ask TEXT,
        asks INTEGER NOT NULL DEFAULT 0,
        progress TEXT,
        problem TEXT,
        schedule_id TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX runs_unfinished ON runs (status)
        WHERE deleted_at IS NULL AND finished_at IS NULL;
      CREATE INDEX runs_by_finished_at ON runs (finished_at)
        WHERE deleted_at IS NULL AND finished_at IS NOT NULL;

      -- The journal: one row per step of a Task, written as started before the step runs and as
      -- completed after, each with the database synced to disk (synchronous=FULL). key names the
      -- step within its Task, the same on every attempt. effect: what the step changes outside
      -- this database (a file it writes, a Connector's Tool it calls), as JSON, so that after a
      -- crash its outcome is checked before anything is done again; NULL for none. status:
      -- 'started' | 'completed' | 'failed' | 'skipped'; result: its kind's JSON. No foreign
      -- keys: a later sync may bring a step before its Task.
      CREATE TABLE run_steps (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        effect TEXT,
        status TEXT NOT NULL,
        result TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX run_steps_by_key ON run_steps (run_id, key) WHERE deleted_at IS NULL;

      -- Tasks that start by themselves (#147): what to run (template: a kind and its input, as
      -- JSON), when (trigger, JSON), the Mind it writes into, what it has seen so far (cursor),
      -- and when it runs next. Nothing writes one yet.
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        template TEXT NOT NULL DEFAULT '{}',
        trigger TEXT NOT NULL DEFAULT '{}',
        mind_id TEXT,
        cursor TEXT,
        paused_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      -- The Task a model request was made for, so a Task's cost can be told; NULL for the rest.
      ALTER TABLE model_requests ADD COLUMN run_id TEXT;
      CREATE INDEX model_requests_by_run ON model_requests (run_id)
        WHERE run_id IS NOT NULL AND deleted_at IS NULL;
    `,
  },
  {
    // 82 is reserved by work in progress.
    version: 83,
    description: "The words inside Minds, Block by Block, for ⌘K (#116)",
    sql: `
      -- Each top-level Block of each Mind as plain text (src/core/mindIndex.ts): its id, its node
      -- type ('paragraph', 'heading', 'answer'…), its place among the Mind's Blocks from 0, and
      -- its text, each paragraph, list item or cell on a line. The core derives the rows from the
      -- Mind's content as it changes, so a computer that syncs a Mind derives its own. A Block
      -- taken out of its Mind is marked deleted, its text dropped; the same row comes back with
      -- the Block. No foreign key: a later sync may bring a Mind's content before its row.
      CREATE TABLE mind_blocks (
        seq INTEGER PRIMARY KEY, -- local key for the keyword index only
        id TEXT NOT NULL UNIQUE,
        mind_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX mind_blocks_by_block ON mind_blocks (mind_id, block_id);

      -- Keyword index, as for Passages (migration 10): each Block's words, segmented by the
      -- core; rowid is the row's seq. Only the index is stored.
      CREATE VIRTUAL TABLE mind_blocks_fts USING fts5 (
        text,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER mind_blocks_fts_soft_delete AFTER UPDATE OF deleted_at ON mind_blocks
      WHEN old.deleted_at IS NULL AND new.deleted_at IS NOT NULL BEGIN
        DELETE FROM mind_blocks_fts WHERE rowid = old.seq;
      END;
      CREATE TRIGGER mind_blocks_fts_delete AFTER DELETE ON mind_blocks
      WHEN old.deleted_at IS NULL BEGIN
        DELETE FROM mind_blocks_fts WHERE rowid = old.seq;
      END;

      -- When the core last read each Mind's Blocks into mind_blocks (updated_at). A Mind whose
      -- content was stored after that, as when the app quit before reading it, or that was never
      -- read, such as every Mind written before this migration, is read at the next start.
      CREATE TABLE mind_block_reads (
        id TEXT PRIMARY KEY NOT NULL,
        mind_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX mind_block_reads_by_mind ON mind_block_reads (mind_id)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 84,
    description: "Checkpoints: a Mind as it was before an AI change, or after a pause (#113)",
    sql: `
      -- One row per Checkpoint (src/core/checkpoints): the Mind's whole Yjs document as one
      -- update (v1), and its Yjs snapshot, so a state already saved isn't saved again (a
      -- snapshot holds what was deleted, which a state vector doesn't). reason is 'accept',
      -- 'regenerate', 'enhance', 'compare', 'others', 'restore' or 'idle', checked in code. Only
      -- idle ones are thinned as they age: a thinned row is marked deleted with its data
      -- emptied, and forgotten 30 days later. The Document versions a Checkpoint's Citations
      -- quote are retained in retained_versions (kind 'checkpoint'). No foreign key: a later
      -- sync may deliver a row before its Mind.
      CREATE TABLE mind_checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        mind_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        data BLOB NOT NULL,
        snapshot BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX mind_checkpoints_by_mind ON mind_checkpoints (mind_id, created_at)
        WHERE deleted_at IS NULL;
    `,
  },
  {
    // 85 is reserved by work in progress.
    version: 86,
    description: "A Word file imported as a Mind is also a Document (#720)",
    sql: `
      -- The Document the original file was also added as, so the Mind can say where it came
      -- from and leave it out of its own checks, and the Document can open its Mind. NULL: the
      -- User left it out of the Library, or the import was made before. No foreign key: a
      -- later sync may deliver a row before its Document.
      ALTER TABLE word_packages ADD COLUMN document_id TEXT;
      CREATE INDEX word_packages_by_document ON word_packages (document_id)
        WHERE document_id IS NOT NULL AND deleted_at IS NULL;
    `,
  },
  {
    version: 87,
    description: "A data flow allowed when the User chose its service says so (ADR-0022, #718)",
    sql: `
      -- 1: the flow was allowed when the User chose the service, where a line said what goes
      -- (first-run setup, Settings, a plan sign-in); 0: allowed in a dialog or in Settings ›
      -- Privacy, as every decision made before this. A declined flow is always 0.
      ALTER TABLE data_flow_consents ADD COLUMN chosen INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 88,
    description: "Organize: a waiting or failed Document's problem as a wording (#654)",
    sql: `
      -- The problem in error_message as a key of the dictionary and its values (JSON), so the
      -- window says it in the interface language; NULL when the core gave only its sentence.
      ALTER TABLE document_groups ADD COLUMN error_wording TEXT;
    `,
  },
  {
    version: 89,
    description: "Web pages keep their pictures: each version's, and how many were left out (#756)",
    // A saved page's pictures are files named by their content (src/core/documents/web),
    // shared by its versions; a row per picture per version, numbered as the page shows
    // them, says which files a version shows, so a picture an older version still has stays.
    sql: `
      CREATE TABLE web_page_pictures (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents (id),
        content_hash TEXT NOT NULL,
        number INTEGER NOT NULL,
        picture_hash TEXT NOT NULL,
        media_type TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        address TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX web_page_pictures_by_number
        ON web_page_pictures (document_id, content_hash, number) WHERE deleted_at IS NULL;
      CREATE INDEX web_page_pictures_by_picture
        ON web_page_pictures (picture_hash) WHERE deleted_at IS NULL;
      -- Pictures over the caps (too many, too large, past the page's total), per version.
      ALTER TABLE web_pages ADD COLUMN pictures_left_out INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 90,
    description: "A Mind imported from Word keeps the file's look (#746)",
    sql: `
      -- WORD_LOOK_VERSION the look was read with; NULL for imports from before it was kept.
      -- Lets start-up find Minds needing it without loading each one.
      ALTER TABLE word_packages ADD COLUMN look_version INTEGER;
    `,
  },
  {
    version: 91,
    description: "Web pages kept as they look: a PDF of each version, when the User asks (#756)",
    // The PDF is a file named by its content, beside the snapshots (src/core/documents/web).
    // A version asked for it is 'saving' until it is made, and made again at the next start
    // if the app quit meanwhile; 'failed' says why in look_failure.
    sql: `
      ALTER TABLE web_pages ADD COLUMN look_status TEXT
        CHECK (look_status IS NULL OR look_status IN ('saving', 'saved', 'failed'));
      ALTER TABLE web_pages ADD COLUMN look_hash TEXT;
      ALTER TABLE web_pages ADD COLUMN look_saved_at TEXT;
      ALTER TABLE web_pages ADD COLUMN look_failure TEXT;
    `,
  },
  {
    version: 94,
    description: "A Document the User keeps as their own workings: read, never cited (#897)",
    sql: `
      -- 1: Answers search and read the Document but never cite it, and checks never use it as
      -- evidence; the User's choice, kept until they take it back. 0: cited as any Document.
      ALTER TABLE documents ADD COLUMN not_cited INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 95,
    description: "A web page keeps who saved it: the User, or a web search (#896)",
    // A page only the User saved can stand for a court decision's opinion in a check. Pages saved
    // before this was kept can't be told apart, so they read as a search's until the User saves
    // the address again.
    sql: `
      ALTER TABLE web_pages ADD COLUMN origin TEXT NOT NULL DEFAULT 'search'
        CHECK (origin IN ('user', 'search'));
    `,
  },
  {
    version: 96,
    description: "Reference lookups kept, so checking a list again asks only about misses (#711)",
    // OpenAlex's free allowance is per network and per day; a student re-checks the same list often.
    // `service` is where the answer came from, which the check still names.
    sql: `
      CREATE TABLE reference_lookups (
        id TEXT PRIMARY KEY NOT NULL,
        service TEXT NOT NULL CHECK (service IN ('crossref', 'openalex', 'arxiv')),
        kind TEXT NOT NULL,
        lookup_key TEXT NOT NULL,
        answer TEXT NOT NULL,
        -- 1: an answer that found the work cited, kept for good; 0: a miss, asked again after a while.
        kept INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX reference_lookups_by_key
        ON reference_lookups (service, kind, lookup_key) WHERE deleted_at IS NULL;
    `,
  },
  {
    version: 97,
    description: "A failed Answer keeps which of its sign-in route's problems stopped it",
    // A Claude account's or a Copilot plan's own problem (SignInRouteProblem, checked in code), so
    // its line and ways back are the route's after a restart; NULL for any other failure.
    sql: `
      ALTER TABLE conversation_messages ADD COLUMN error_sign_in_route TEXT;
    `,
  },
  {
    version: 98,
    description: "A Document's Folder keeps when it was filed there",
    // When the Document joined the Folder's scope, for checks of a Mind there it could change
    // (#993). NULL on a row filed before: its created_at stands for it.
    sql: `
      ALTER TABLE document_groups ADD COLUMN filed_at TEXT;
    `,
  },
  {
    version: 99,
    description: "A Document waiting out a rate limit keeps when it resumes (#1127)",
    // ISO 8601 UTC, beside the error kind and message the tagging state already keeps; NULL when
    // the error carries no time.
    sql: `
      ALTER TABLE documents ADD COLUMN tagging_error_resets_at TEXT;
    `,
  },
  {
    version: 101,
    description: "A provider's own model can be taken out of the model menu (#179)",
    // 1: the User put the id in the menu (as before); 0: the User took one the provider offers
    // in the menu by default out of it, with Settings › Models' "In the menu".
    sql: `
      ALTER TABLE chat_menu_models ADD COLUMN in_menu INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 102,
    description: "A Meeting's notes filled in from its Transcript after Stop (#142)",
    // JSON: the fill's state, mode, problem, and the ids of the Blocks it added, for Undo.
    // NULL before Stop.
    sql: `
      ALTER TABLE meetings ADD COLUMN fill TEXT;
    `,
  },
  {
    version: 103,
    description: "Tagging and sorting new Documents by themselves is off for a cloud model (#1617)",
    // The Library setting "automatic" was saved as true by every save of the Tagging setting, so a
    // true can't tell the User's choice from the old default. It is forgotten, and the switch
    // follows the model: on for one on this computer, off for a cloud model. Only a false stays.
    // Where Documents were being tagged by themselves, the Library decides at its first start
    // whether to say it is off now: only then is the model known (the "pending" value).
    sql: `
      INSERT INTO device_settings (id, key, value, created_at, updated_at)
        SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
            || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (random() & 3), 1)
            || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
          'libraryAutomaticOffNotice', '"pending"',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE EXISTS (SELECT 1 FROM documents WHERE deleted_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM device_settings
            WHERE key = 'library' AND deleted_at IS NULL
              AND json_extract(value, '$.automatic') = 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM device_settings WHERE key = 'libraryAutomaticOffNotice'
          );
      UPDATE device_settings
        SET value = json_remove(value, '$.automatic'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE key = 'library' AND deleted_at IS NULL
          AND json_extract(value, '$.automatic') = 1;
    `,
  },
  {
    version: 104,
    description: "How long each AI request and local step took, by flow (#1624)",
    // This computer's own measurements, never synced: times in milliseconds from started_at,
    // tokens, and names, never text. Rows past 30 days are deleted at start rather than marked
    // with deleted_at: nothing else reads them, and a kept row would only grow the database.
    sql: `
      CREATE TABLE ai_timings (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        flow TEXT,
        step TEXT,
        data_flow TEXT,
        provider_kind TEXT,
        model_id TEXT NOT NULL,
        reasoning TEXT,
        started_at TEXT NOT NULL,
        first_byte_ms INTEGER,
        first_reasoning_ms INTEGER,
        first_text_ms INTEGER,
        first_tool_ms INTEGER,
        end_ms INTEGER NOT NULL,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        units REAL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX ai_timings_by_started_at ON ai_timings (started_at);
    `,
  },
  {
    version: 105,
    description: "A Question keeps the words the User selected in Documents to ask about (#101)",
    // JSON: a Question's quotes, each its Document, words and Location; NULL for none, and for an Answer.
    sql: `
      ALTER TABLE conversation_messages ADD COLUMN quotes TEXT;
    `,
  },
  {
    version: 106,
    description: "Remote Connector transport and header names (#1995)",
    sql: `
      UPDATE connectors
      SET config = json_set(config, '$.connection', 'http', '$.headers', json('[]'))
      WHERE transport = 'http' AND json_valid(config);
    `,
  },
  {
    version: 107,
    description: "A workbook says which sheets and rows weren't read (#740)",
    // JSON, an UnreadParts: hidden and very hidden sheets left out, sheets the reading limit cut
    // short, and sheets after it. NULL when every part was read, and for every other kind.
    sql: `
      ALTER TABLE documents ADD COLUMN unread_parts TEXT;
    `,
  },
  {
    version: 108,
    description: "A Meeting can be a voice memo, the User alone (#1568)",
    sql: `
      ALTER TABLE meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting'
        CHECK (kind IN ('meeting', 'memo'));
    `,
  },
  {
    version: 109,
    description: "Answers in conversations keep their Analyses, and a Question that asked for one",
    sql: `
      ALTER TABLE conversation_messages ADD COLUMN analyses TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE conversation_messages ADD COLUMN analyse INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 110,
    description: "Outside-agent connections need new approval for the public alpha",
    sql: `
      UPDATE device_settings
      SET value = 'false', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE key = 'agentsEnabled' AND deleted_at IS NULL;
    `,
  },
  {
    version: 111,
    description:
      "Each Document's name in a keyword index of its own, once for the Document (#2042)",
    sql: `
      -- A Document's name, segmented as the Passages are (the core writes the
      -- words: src/core/documents/keywords.ts), in an index whose document
      -- frequency counts Documents: a word of a name weighs its Document once,
      -- not once a Passage. Keyword search scores a Passage by its own words
      -- and adds its Document's name match separately. The Passages' index is
      -- rebuilt without the name by processing version 15 (see
      -- NAME_INDEX_CURRENT_SINCE in src/core/documents/processing.ts).
      -- One row a Document, deleted and written again when a Document is
      -- renamed; a derived index, never synced.
      CREATE VIRTUAL TABLE document_names_fts USING fts5 (
        document_id UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    version: 112,
    description:
      "A Checkpoint the User named, or one saved when the Note was sent, keeps its name and file",
    sql: `
      -- A name the User gave the version (#1933), and the file a Checkpoint saved as the Note
      -- was exported holds (reason 'export'). A named one is never thinned.
      ALTER TABLE mind_checkpoints ADD COLUMN name TEXT;
      ALTER TABLE mind_checkpoints ADD COLUMN detail TEXT;
    `,
  },
  {
    version: 113,
    description: "A cited page whose drawing failed waits to be drawn again (#2161)",
    sql: `
      -- tries counts a page's failed drawings, so one that keeps failing stops being tried on
      -- its own (src/core/citedPages.ts). Pages a failed drawing deleted wait again, as their
      -- version may still be drawn: the newest of a Location, which the unique index allows
      -- only where none waits or is saved; the start-up clean-up removes those nothing cites.
      ALTER TABLE cited_pages ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
      UPDATE cited_pages
      SET deleted_at = NULL, tries = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id IN (
        SELECT gone.id FROM cited_pages AS gone
        WHERE gone.deleted_at IS NOT NULL AND gone.image_type IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM cited_pages AS other
            WHERE other.document_id = gone.document_id
              AND other.content_hash = gone.content_hash
              AND other.page_from = gone.page_from
              AND other.page_to = gone.page_to
              AND other.area = gone.area
              AND (other.deleted_at IS NULL
                OR (other.image_type IS NULL AND other.rowid > gone.rowid))
          )
      );
    `,
  },
  {
    version: 114,
    description: "A Folder can keep its work inside it (#1934)",
    sql: `
      -- 1: a Folder's Notes, Answers and checks may read only its own Documents.
      -- 0 by default. Kept with the Folder so it follows the User to other devices.
      ALTER TABLE library_groups ADD COLUMN keep_inside INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation_messages ADD COLUMN wall_id TEXT;
      UPDATE conversation_messages
      SET wall_id = COALESCE(
        (SELECT minds.folder_id FROM minds WHERE minds.id = asked_from_mind_id),
        (SELECT conversations.folder_id FROM conversations WHERE conversations.id = conversation_messages.conversation_id)
      )
      WHERE kind = 'question' AND wall_id IS NULL;
    `,
  },
];

/**
 * Brings the database up to the latest schema: every migration in the list that
 * isn't recorded as applied runs, in version order, in one transaction. A database
 * recording a migration this build doesn't know was written by a newer version of
 * IncarnaMind, and is refused.
 */
export function migrate(db: Database, list: readonly Migration[] = migrations): void {
  list.forEach((migration, index) => {
    const previous = list[index - 1];
    if (previous && migration.version <= previous.version) {
      throw new Error(
        `Migration ${migration.version} comes after ${previous.version}: versions must increase.`,
      );
    }
  });

  const applied = appliedVersions(db, list);
  const known = new Set(list.map((migration) => migration.version));
  const unknown = [...applied].filter((version) => !known.has(version));
  if (unknown.length > 0) {
    throw new DataFromNewerVersionError(Math.max(...unknown));
  }

  const pending = list.filter((migration) => !applied.has(migration.version));
  if (pending.length === 0) return;

  db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        new Date().toISOString(),
      ]);
    }
    // Kept for tools that read it: the highest migration applied.
    const highest = db.get<{ v: number }>("SELECT max(version) AS v FROM schema_migrations")?.v;
    db.exec(`PRAGMA user_version = ${highest ?? 0}`);
  });
}

/**
 * The versions recorded as applied. Creates the bookkeeping table on first use.
 * It is local to this device and never synced, so the sync-ready rules don't apply.
 *
 * Databases from before the table existed recorded only their highest version in
 * `PRAGMA user_version`: every listed migration up to it counts as applied.
 */
function appliedVersions(db: Database, list: readonly Migration[]): Set<number> {
  const exists = db.get(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (!exists) {
    db.transaction(() => {
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL) STRICT",
      );
      const legacy = db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
      const at = new Date().toISOString();
      for (const migration of list) {
        if (migration.version > legacy) break;
        db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
          migration.version,
          at,
        ]);
      }
      // A legacy database at a version this build doesn't list was written by a newer build.
      if (legacy > (list.at(-1)?.version ?? 0)) {
        db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [legacy, at]);
      }
    });
  }
  return new Set(
    db.all<{ version: number }>("SELECT version FROM schema_migrations").map((row) => row.version),
  );
}
