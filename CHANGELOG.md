# Changelog

All notable changes to this plugin are documented here. Versions follow [semver](https://semver.org/).

## 0.1.0 – NocoBase 2.2.x

- Export one or more general collections, with or without data, to a `.zip` package.
- Import with a preview that blocks unsupported or unsafe packages (missing dependencies, unknown field types or
  field kinds, collections or tables outside the package, unsafe expressions).
- Per-collection conflict handling for existing collections: skip collection and import data, skip collection and
  data, override without data, override with data (default), with a confirmation before deleting anything.
- *Created by* / *Updated by* of imported rows set to the importing user.
- Settings page in both the classic (`/admin`) and the new (`/v/admin`) admin UI; English and Chinese.
