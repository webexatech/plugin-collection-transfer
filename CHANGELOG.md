# Changelog

All notable changes to this plugin are documented here. Versions follow [semver](https://semver.org/).

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
