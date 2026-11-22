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

// Templates the PoC can recreate faithfully. Collections without a template are treated as general.
export const SUPPORTED_TEMPLATES = ['general'];

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

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_IDENTIFIER_LENGTH = 63;

export type FieldPayload = Record<string, unknown> & { name: string; type: string; interface?: string };

export type CollectionPayload = Record<string, unknown> & {
  name: string;
  title?: string;
  template?: string;
  fields: FieldPayload[];
};

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
}

// The only \`{{ }}\` expression a package may contain: a plain translation, optionally with a namespace,
// e.g. {{t("Created at")}} or {{t("Title", { ns: "client" })}}. NocoBase's UI evaluates any other expression.
const EXPRESSION = /\{\{[\s\S]*?\}\}/g;
const SAFE_EXPRESSION = /^\{\{\s*t\(\s*(["'])[^"'{}]*\1\s*(,\s*\{\s*ns\s*:\s*(["'])[^"'{}]*\3\s*\})?\s*\)\s*\}\}$/;

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

export function isValidName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export function dataDir(collectionName: string) {
  if (!isValidName(collectionName)) {
    throw new Error(`Invalid collection name: ${String(collectionName)}`);
  }
  return `data/${collectionName}`;
}
