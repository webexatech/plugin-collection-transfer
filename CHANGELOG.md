# Changelog

All notable changes to this plugin are documented here. Versions follow [semver](https://semver.org/).

## 0.2.0

- **Rename on import**: the import preview lets you change each collection's display name and collection name (e.g. to
  import a copy next to an existing collection). References inside the file follow, junction tables of renamed
  collections get new names, and the checks run again with the new names.
- **Categories on import**: choose the collection categories per collection in the import preview; categories with the
  same name as in the source are pre-selected. Exports now carry category names.

## 0.1.5

- **All collection templates that ship with NocoBase** can be transferred: tree (paths rebuilt), file (records follow
  the storage of the same name; files are not copied), calendar, comment, expression, inherited (PostgreSQL; parents
  are added automatically), SQL, view and foreign data (definitions only). The preview names a missing template
  plugin, database view, database server or file storage, lists SQL queries for confirmation, and says what is not
  carried.
- Fixed: import failed with `NocoBase did not create: collection t_…` for attachment fields (their junction tables have
  no collection row). Links of many-to-many fields to collections outside the package (attachments, users) are no
  longer imported, since those ids identify other records in the target; the preview says so.
- Fixed: helper attributes without a database column (e.g. file collections' `local`) were exported as columns.
- **Expressions in titles and descriptions** (e.g. formula notes like `({{VTOTALBASE}} || 0)` in a field description) no
  longer block the import: the preview lists them and the import runs after you confirm **I trust this file**.
- Fixed: collections without generated id lost their primary key on export when the key was also used as a foreign key
  (e.g. a belongsTo with foreignKey `id`); the import then failed with `Unknown attribute "id" passed as targetKey`.
  Older packages with this problem are now reported in the preview.
- Fixed: export failed with `Through collection … not found` for many-to-many relations whose junction table has no
  collection-manager row (older installations, synced tables); such junction tables are transferred now.
- Fixed: import between installations with different column naming (`DB_UNDERSCORED`): columns are matched by field
  name.

## 0.1.4

- **Transfers between database types**: a package exported from MySQL/MariaDB can be imported into PostgreSQL and the
  other way round (tested with MySQL 8 and PostgreSQL 16, including booleans, decimals, JSON, dates and relations).
- **Related collections**: the Export tab lists collections that the selection has relations to but that are not
  selected, and adds them with one click.
- Fixed: the import refused legitimate packages containing formula fields (e.g. `{{gross_weight}} * 2`). The
  expression check now only covers titles, descriptions and UI schemas, the parts NocoBase's UI evaluates.

## 0.1.3

- Fixed: **Export failed with 502 behind a reverse proxy** (e.g. nginx). The export summary was sent in a response
  header that outgrew the proxy's header buffer; exporting is now two requests (prepare, then download) and no data
  travels in headers.
- Builds for each NocoBase line: `0.1.3-nocobase.2.1` (2.1.x), `0.1.3` (2.2.x), `0.1.3-nocobase.2.3` (2.3.x beta).

## 0.1.2 – NocoBase 2.2.x

Security hardening of the import (upgrade recommended):

- Raw `options` objects in collections, fields and relations are refused; they would otherwise bypass the checks on
  top-level keys (for example `options.tableName`).
- Relation fields among a collection's plain fields are recognised by their registered field class, so relation types
  added by plugins are refused there too.
- Reading data rows costs linear time up to the row size limit.

## 0.1.1 – NocoBase 2.2.x

Security hardening of the import (upgrade recommended):

- Relation fields are only accepted from `associations.json`; a relation hidden among a collection's plain fields is
  refused, so a package cannot add fields or key columns to collections outside it.
- Archives are extracted by streaming each allowed entry to disk with per-entry and total size limits instead of
  decompressing into memory; the compression-ratio check now applies from 10 MB.
- Data rows have a size limit (16 MB per row), so one oversized row cannot exhaust memory.

## 0.1.0 – NocoBase 2.2.x

- Export one or more general collections, with or without data, to a `.zip` package.
- Import with a preview that blocks unsupported or unsafe packages (missing dependencies, unknown field types or
  field kinds, collections or tables outside the package, unsafe expressions).
- Per-collection conflict handling for existing collections: skip collection and import data, skip collection and
  data, override without data, override with data (default), with a confirmation before deleting anything.
- *Created by* / *Updated by* of imported rows set to the importing user.
- Settings page in both the classic (`/admin`) and the new (`/v/admin`) admin UI; English and Chinese.
