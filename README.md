# @webexatech/plugin-collection-transfer

Move collections between NocoBase environments (for example dev → prod) without rebuilding them by hand.
Export one or more collections, with or without their data, to a `.zip` file, then import that file into
another environment or back into the same one.

## Compatibility

NocoBase checks a plugin against the versions it was **built** with, per minor release, and shows a "dependency
version mismatch" warning otherwise. Each NocoBase minor therefore has its own build — install the one for your
NocoBase version:

| NocoBase | Plugin version | npm tag | Tested on |
| --- | --- | --- | --- |
| 2.1.x | `0.1.4-nocobase.2.1` | `nocobase-2.1` | 2.1.39 |
| 2.2.x | `0.1.4` | `nocobase-2.2`, `latest` | 2.2.50 |
| 2.3.x (beta) | `0.1.4-nocobase.2.3` | `nocobase-2.3` | 2.3.0-beta.26 |

All builds: PostgreSQL and MySQL/MariaDB, including transfers between them (e.g. MySQL → PostgreSQL; tested with
PostgreSQL 16 and MySQL 8); settings page in the classic (`/admin`) and the new (`/v/admin`) admin UI.

## Install

Use the build for your NocoBase version (table above). Then enable **Collection transfer** in the plugin manager.

- **URL (any NocoBase version):** *Plugin manager → Add & update → URL*, paste the npm file for your version:
  `https://registry.npmjs.org/@webexatech/plugin-collection-transfer/-/plugin-collection-transfer-<plugin version>.tgz`
  (e.g. `…/plugin-collection-transfer-0.1.4-nocobase.2.1.tgz`).
- **Upload:** *Plugin manager → Add & update → Upload*, choose the `.tgz` for your NocoBase version from the GitHub
  release.
- **npm registry (NocoBase 2.2.x only):** *Plugin manager → Add & update → npm registry*, package
  `@webexatech/plugin-collection-transfer`, registry `https://registry.npmjs.org`. The form has no version field for
  new installs and always takes `latest` (the 2.2 build).
- **CLI:** `yarn pm add @webexatech/plugin-collection-transfer --registry=https://registry.npmjs.org --version=<plugin version>`,
  then `yarn pm enable @webexatech/plugin-collection-transfer`.

**Updating:** install the newer build the same way. *Add & update* replaces the files but does not restart the app —
restart NocoBase afterwards (Docker: restart the container; otherwise `yarn nocobase upgrade --skip-code-update` and
restart) and reload the browser. The plugin stores no data of its own, so updates need no migration.

## Usage

Open **Settings → Collection transfer** (admins only; ACL snippet `pm.collection-transfer`).

**Export tab**

1. Select the collections. Collection types that cannot be transferred are shown but disabled.
2. If the selected collections have relations to collections you did not select, a warning lists them; click
   **Add related collections** to include them (repeats until nothing is missing). System collections such as `users`
   are never exported and must exist in the target.
3. Turn on **Include data** to carry the rows as well.
4. Click **Export**. The result lists the join tables that were added automatically and the collections that must
   already exist in the target (for example `users`, the target of *Created by*).

**Import tab**

1. Drop the `.zip`. Nothing is written yet.
2. The preview shows what will be created (fields and rows per collection) and every blocking problem.
3. For each collection that **already exists** in the target, choose:

   | Option | Fields | Existing rows | Rows from the file |
   | --- | --- | --- | --- |
   | Skip collection, import data | kept | kept | added; rows whose id already exists are skipped |
   | Skip collection and data | kept | kept | not imported |
   | Override collection, without data | replaced | **deleted** | not imported |
   | **Override collection and data** (default) | replaced | **deleted** | imported |

   *Skip collection, import data* is only offered when the existing table has every column from the file.
   Overriding a collection makes NocoBase remove the relation fields that point at it from other collections;
   fields the file defines are re-created, and the preview lists any other field that would be lost.
4. Click **Import**. If anything is overridden, a confirmation lists what will be deleted. Everything runs in one
   transaction and is rolled back completely on any error.

**Created by / Updated by** of every imported row is set to the admin who runs the import. User ids from the source
environment do not identify the same people in the target.

## What is checked before importing

The import is blocked when:

- a relation points at a collection that is neither in the file nor in the target
- a field type is not available in the target (a plugin that adds a server-side type is missing)
- a field kind is not available in the target UI (e.g. the *Code* field without `plugin-field-code`); the plugins
  enabled in the source but not in the target are listed as a hint
- a database table with the same name exists without a collection, or a collection uses an unsupported template
- the file has an unsupported format version, or a name is too long for the database
- the file tries to change anything outside its own collections (other tables, fields on other collections)
- a title, description or UI schema contains a `{{ }}` expression other than a plain `{{t("…")}}` translation (values
  such as formula expressions are not affected)
- the file is not a valid package

The same checks run again when you click **Import**, in case the target changed after the preview.

## What it does not transfer

By design, the plugin moves **collection definitions and their rows only**. It does not transfer:

- pages, blocks and menus (UI schemas), workflows, role permissions, collection categories
- files behind attachment fields (the attachment records reference storage that differs per environment)
- relation fields that live on collections outside the file

Recreate those in the target, or use NocoBase's own tools for them.

**Collection types:** this edition transfers **general collections**. Tree, file, calendar, SQL, view, inherited,
FDW and expression collections are listed but cannot be selected.

## Known limitations

- Only the main data source. Supported databases: PostgreSQL and MySQL/MariaDB (SQLite is not supported).
- Primary-key conflicts are resolved per collection (skip or override), not per row; rows are not merged.
- Sequence counters, encrypted fields, sort scopes, custom primary keys and indexes defined in collection options are
  not specially handled. A key column created by hand before its relation comes back with default display settings.
- Whole tables are read into memory on export, and there is no progress reporting for very large imports.
- Only import files from environments you trust.

## How it works

- **Export** reads the definitions from the `collections` / `fields` tables. Each collection is written in the shape
  the UI sends to `collections:create`: scalar fields nested, relation fields stored once per pair with the other side
  as `reverseField`, generated join-table and key-column names kept so the rows still line up. Rows are dumped per
  table as NDJSON.
- **Import** creates the collections, then the relation fields; NocoBase's own hooks build tables, key columns, join
  tables and reverse fields. The importer then verifies every expected join table, key field and column, inserts rows
  in batches and moves serial id sequences past the imported ids.

### File format

```
manifest.json              versions, dialect, collections, dependencies, source plugins
schema/collections.json    collections (collections:create shape, scalar fields nested)
schema/associations.json   relation fields (collections.fields:create shape, reverseField nested)
schema/through.json        auto-created join tables recreated by NocoBase on import
data/<collection>/meta     columns, row count, auto-increment column
data/<collection>/data     one JSON array of column values per row (only with "Include data")
```

### API

| Action | Request | Response |
| --- | --- | --- |
| `collectionTransfer:listCollections` | `GET` | collections that can be selected |
| `collectionTransfer:export` | `POST { collections: string[], includeData: boolean }` | `{ token, fileName, manifest }`; the file is prepared for download |
| `collectionTransfer:download` | `GET ?token=…` | the `.zip`, once; prepared files expire after an hour |
| `collectionTransfer:preview` | `POST` multipart, field `file` | `token`, `problems`, `conflicts`, `interfaces` |
| `collectionTransfer:import` | `POST { token, resolutions: { [collection]: mode } }` | created / overridden / skipped, `rowCounts`; `409 { errors, problems }` when blocked |

Modes: `skipCollectionImportData`, `skipAll`, `overrideSchema`, `overrideAll`. Uploads are kept in
`<storage>/tmp/collection-transfer/` for one hour, and after a failed import so it can be retried with the same token.

## Development

The plugin lives at `packages/plugins/@webexatech/plugin-collection-transfer` inside a NocoBase source checkout.

```bash
yarn test packages/plugins/@webexatech/plugin-collection-transfer   # server tests (separate DB via .env.test)
# cross-database tests also run when a MySQL test server is configured:
# CT_MYSQL_HOST=localhost CT_MYSQL_PORT=3307 CT_MYSQL_DATABASE=ct_test CT_MYSQL_USER=nocobase CT_MYSQL_PASSWORD=nocobase yarn test …
yarn eslint --fix packages/plugins/@webexatech/plugin-collection-transfer/src
bash scripts/check-plugin-peer-deps.sh packages/plugins/@webexa
yarn build @webexatech/plugin-collection-transfer --tar               # storage/tar/@webexatech/…tgz
```

The settings page is written once in `src/client-v2/CollectionTransferSettings.tsx` (no runtime imports) and mounted
by both the v2 client (`src/client-v2/SettingsPage.tsx`) and the classic client (`src/client/SettingsPage.tsx`).
The data dump logic and `FieldValueWriter` are adapted from `@nocobase/plugin-backup-restore`, which does not export
them.

## License

Apache-2.0
