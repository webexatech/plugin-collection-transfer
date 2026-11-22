// Shared definition of the transfer package (a zip file). Both exporter and importer depend on this module only,
// so the on-disk format is described in one place.
//
// manifest.json              Manifest
// schema/collections.json    CollectionPayload[]   (shape of a `collections:create` request, scalar fields nested)
// schema/associations.json   AssociationPayload[]  (shape of a `collections.fields:create` request)
// schema/through.json        string[]              (auto-created through collections the importer must find)
// data/<name>/meta           DataMeta
// data/<name>/data           NDJSON, one JSON array of column values per row (only when includeData)

export const FORMAT_VERSION = 1;

export const MANIFEST_FILE = 'manifest.json';
export const COLLECTIONS_FILE = 'schema/collections.json';
export const ASSOCIATIONS_FILE = 'schema/associations.json';
export const THROUGH_FILE = 'schema/through.json';

export const ASSOCIATION_TYPES = ['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'];

// Collection templates and the plugin that provides each one (null: built into NocoBase). Collections without a
// template are general. Collections of other templates (from third-party plugins) are not transferred.
export const TEMPLATE_PLUGINS: Record<string, string | null> = {
  general: null,
  view: null,
  expression: '@nocobase/plugin-workflow-dynamic-calculation',
  calendar: '@nocobase/plugin-calendar',
  comment: '@nocobase/plugin-comments',
  tree: '@nocobase/plugin-collection-tree',
  file: '@nocobase/plugin-file-manager',
  sql: '@nocobase/plugin-collection-sql',
  foreign: '@nocobase/plugin-collection-fdw',
};
export const SUPPORTED_TEMPLATES = Object.keys(TEMPLATE_PLUGINS);

// Templates whose rows do not live in a table of their own: a database view, a SQL query, a foreign table. Only the
// definition is transferred; the data stays where it is.
export const DATALESS_TEMPLATES = ['view', 'sql', 'foreign'];

/** Template of a collection definition; collections without one are general. */
export function templateOf(collection: Record<string, unknown>): string {
  return (collection.template as string) || 'general';
}

// Collections that live in the `collections` table but are mirrored from code-defined collections.
export const MIRRORED_ORIGINS = ['db2cm', 'dbsync'];

// Bookkeeping attributes of `collections` / `fields` rows that a create request never carries.
export const COLLECTION_BOOKKEEPING_KEYS = ['key', 'sort', 'fields', 'category'];
export const FIELD_BOOKKEEPING_KEYS = [
  'key',
  'sort',
  'collectionName',
  'parentKey',
  'reverseKey',
  'reverseField',
  'children',
];

// Collection and field names as NocoBase allows them (letters, digits, underscore, hyphen; not starting with a digit or
// hyphen). No dots or slashes, so a name is also safe as a folder name in the package.
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const MAX_IDENTIFIER_LENGTH = 63;

export type FieldPayload = Record<string, unknown> & { name: string; type: string; interface?: string };

export type CollectionPayload = Record<string, unknown> & {
  name: string;
  title?: string;
  template?: string;
  fields: FieldPayload[];
  /** Names of the collection categories in the source (absent in packages from 0.1.5 and earlier). */
  categories?: string[];
};

/** Per collection of the package (by its name in the file): a new name and/or display name for the import. */
export type Renames = Record<string, { name?: string; title?: string }>;

export type AssociationPayload = FieldPayload & {
  collectionName: string;
  target: string;
  reverseField?: FieldPayload;
};

export interface DataMeta {
  name: string;
  columns: string[];
  count: number;
  autoIncrementColumn: string | null;
  /** Column → field (attribute) name; absent in packages from 0.1.4 and earlier. */
  attributes?: Record<string, string>;
  /**
   * Columns shared by several fields (e.g. a plain field and a relation's key on the same column, in collections
   * synced from an existing table): every field name. Absent in packages from 0.1.4 and earlier.
   */
  aliases?: Record<string, string[]>;
}

export interface Manifest {
  formatVersion: number;
  pluginVersion: string;
  sourceAppVersion: string;
  dialect: string;
  exportedAt: string;
  includeData: boolean;
  // What the user picked.
  selected: string[];
  // Every collection created from collections.json, in creation order (selected + companions).
  collections: string[];
  // Auto-created through collections (created by NocoBase hooks on import, data still carried).
  through: string[];
  // Association targets outside the package that must already exist in the target environment.
  dependencies: string[];
  // Package names of the plugins enabled in the source, so the target can name what to enable.
  plugins?: string[];
  // File collections: storage id → storage name in the source, so file records point at the storage of the same name.
  storages?: Record<string, string>;
}

// The only \`{{ }}\` expression a package may contain: a plain translation, optionally with a namespace,
// e.g. {{t("Created at")}} or {{t("Title", { ns: "client" })}}. NocoBase's UI evaluates any other expression.
const EXPRESSION = /\{\{[\s\S]*?\}\}/g;
const SAFE_EXPRESSION = /^\{\{\s*t\(\s*(["'])[^"'{}]*\1\s*(,\s*\{\s*ns\s*:\s*(["'])[^"'{}]*\3\s*\})?\s*\)\s*\}\}$/;

// The parts of a collection / field / relation definition that NocoBase's UI compiles.
const UI_COMPILED_KEYS = ['title', 'description', 'uiSchema'];

/** Returns the first unsafe expression in the UI-compiled parts of one definition (not its nested fields). */
export function findUnsafeExpressionInUi(entry: Record<string, unknown> | undefined): string | undefined {
  if (!entry) return undefined;
  for (const key of UI_COMPILED_KEYS) {
    const found = findUnsafeExpression(entry[key]);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every complete text in the UI-compiled parts of one definition that contains an unsafe expression. The admin
 * confirms these texts as they will be imported, not just a matched fragment.
 */
export function findUnsafeTextsInUi(entry: Record<string, unknown> | undefined): string[] {
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (findUnsafeExpression(value)) texts.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  if (entry) UI_COMPILED_KEYS.forEach((key) => walk(entry[key]));
  return texts;
}

/** Returns the first unsafe expression found anywhere in a JSON value, or undefined. */
export function findUnsafeExpression(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return undefined;
    const expressions = value.match(EXPRESSION) || [];
    const unsafe = expressions.find((expression) => !SAFE_EXPRESSION.test(expression));
    if (unsafe) return unsafe;
    // An opening {{ without a matching }} is not a translation either.
    return value.replace(EXPRESSION, '').includes('{{') ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUnsafeExpression(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findUnsafeExpression(item);
      if (found) return found;
    }
  }
  return undefined;
}

// Functions and catalogs a SQL collection has no business reading (server settings, files, other schemas' metadata).
const SQL_FORBIDDEN = [
  'pg_',
  'current_setting',
  'set_config',
  'generate_series',
  'information_schema',
  'load_file',
  'benchmark',
  'sleep(',
  '@@',
  'load_extension',
  'into outfile',
  'into dumpfile',
];

/**
 * Why the query of a SQL collection may not be imported, or undefined. Only one read-only statement (SELECT, or WITH …
 * SELECT) is accepted. NocoBase applies a similar rule when a SQL collection is created in the UI; the import creates
 * collections through the repository, which does not, so the rule is applied here.
 */
export function sqlProblem(sql: unknown): string | undefined {
  if (typeof sql !== 'string' || !sql.trim()) return 'empty query';
  const statement = sql.trim().replace(/;\s*$/, '');
  if (statement.includes(';')) return 'more than one statement';
  if (!/^select\b/i.test(statement) && !/^with\b[\s\S]+\bselect\b/i.test(statement)) return 'not a SELECT statement';
  const lower = statement.toLowerCase();
  const forbidden = SQL_FORBIDDEN.find((keyword) => lower.includes(keyword));
  if (forbidden) return `uses "${forbidden}"`;
  // Functions that run SQL given as a string, or reach outside the database.
  const call = lower.match(
    /\b(query_to_xml|table_to_xml|cursor_to_xml|database_to_xml|schema_to_xml|dblink\w*|lo_\w+|xpath|sys_exec|sys_eval)\s*\(/,
  );
  if (call) return `uses "${call[1]}"`;
  // Writes hidden in a WITH clause (PostgreSQL data-modifying CTEs) or SELECT … INTO (creates a table).
  const writing = lower.match(
    /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|execute|into|lock)\b/,
  );
  return writing ? `uses "${writing[1]}"` : undefined;
}

export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export function dataDir(collectionName: string) {
  if (!isValidName(collectionName)) {
    throw new Error(`Invalid collection name: ${String(collectionName)}`);
  }
  return `data/${collectionName}`;
}

/** A model attribute without a database column (Sequelize VIRTUAL). */
export function isVirtual(attribute: { type?: unknown }): boolean {
  const type = attribute.type as { key?: string } | undefined;
  return type?.key === 'VIRTUAL';
}
