import { Collection, Database, RelationField, Transaction } from '@nocobase/database';
import { Application } from '@nocobase/server';
import { storagePathJoin } from '@nocobase/utils';
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import lodash from 'lodash';
import path from 'path';
import { QueryInterface, QueryTypes } from 'sequelize';
import yauzl from 'yauzl';
import { enabledPluginNames } from './exporter';
import { FieldValueWriter } from './field-value-writer';
import {
  ASSOCIATIONS_FILE,
  AssociationPayload,
  COLLECTIONS_FILE,
  CollectionPayload,
  dataDir,
  DataMeta,
  findUnsafeExpression,
  FORMAT_VERSION,
  isValidName,
  Manifest,
  MANIFEST_FILE,
  MAX_IDENTIFIER_LENGTH,
  MIRRORED_ORIGINS,
  SUPPORTED_TEMPLATES,
  THROUGH_FILE,
} from './package-format';

const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

// Collection options that would place a collection somewhere other than its own new table, or bypass NocoBase's
// "already exists" check (isThrough). Exports never contain them; a package that does is refused.
const PLACEMENT_OPTIONS = [
  'tableName',
  'schema',
  'viewName',
  'view',
  'sql',
  'from',
  'isThrough',
  'autoCreate',
  'dataSourceKey',
];
// Bookkeeping keys stripped from payloads before create, so a package cannot point rows at other records.
const NESTED_FIELD_STRIP = ['key', 'sort', 'collectionName', 'parentKey', 'reverseKey', 'reverseField', 'children'];
const ASSOCIATION_STRIP = ['key', 'sort', 'parentKey', 'reverseKey', 'children'];
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const INSERT_CHUNK_SIZE = 500;
const ASSOCIATION_TYPES_FOR_REFERENCES = ['belongsTo', 'hasOne', 'hasMany', 'belongsToMany'];

// Only these entries are extracted from an uploaded package; anything else is ignored.
const ALLOWED_ENTRY =
  /^(manifest\.json|schema\/(collections|associations|through)\.json|data\/[A-Za-z_][A-Za-z0-9_]*\/(meta|data))$/;

export type ProblemCode =
  | 'formatVersion'
  | 'dialect'
  | 'invalidPackage'
  | 'invalidName'
  | 'collectionExists'
  | 'tableExists'
  | 'missingDependency'
  | 'unknownFieldType'
  | 'unsupportedTemplate'
  | 'identifierTooLong'
  | 'unsafeExpression'
  | 'outsidePackage'
  | 'unresolvedConflict'
  | 'columnsMismatch'
  | 'systemCollection';

/** What to do with a collection from the package that already exists in this environment. */
export const CONFLICT_MODES = ['skipCollectionImportData', 'skipAll', 'overrideSchema', 'overrideAll'] as const;
export type ConflictMode = (typeof CONFLICT_MODES)[number];
export const DEFAULT_CONFLICT_MODE: ConflictMode = 'overrideAll';

export interface PreviewConflict {
  name: string;
  title: string;
  /** Association fields here that target this collection (or use it as junction table). Override removes them. */
  referencedBy: { collection: string; field: string; restored: boolean }[];
  /** Package columns the existing table lacks; "Skip collection, import data" is only possible when empty. */
  missingColumns: string[];
}

export interface Problem {
  code: ProblemCode;
  collection?: string;
  field?: string;
  detail?: string;
}

export interface PreviewCollection {
  name: string;
  title: string;
  fieldCount: number;
  rowCount: number;
  isThrough: boolean;
}

/** One field's UI interface. Only the browser knows which interfaces the target supports, so the client checks. */
export interface PreviewInterface {
  interface: string;
  collection: string;
  field: string;
}

export interface Preview {
  token: string;
  manifest: Manifest;
  collections: PreviewCollection[];
  problems: Problem[];
  interfaces: PreviewInterface[];
  // Plugins enabled in the source but not in this environment (a hint for unknown interfaces).
  missingPlugins: string[];
  // Collections from the package that already exist here; each needs a ConflictMode on import.
  conflicts: PreviewConflict[];
}

export interface ImportResult {
  /** Collections created (new or overridden). */
  collections: string[];
  overridden: string[];
  skipped: string[];
  through: string[];
  rowCounts: Record<string, number>;
}

interface LoadedPackage {
  manifest: Manifest;
  collections: CollectionPayload[];
  associations: AssociationPayload[];
  through: string[];
  metas: Record<string, DataMeta>;
}

export interface ImportOptions {
  userId?: string | number | null;
  /** One mode per conflicting collection (see Preview.conflicts). */
  resolutions?: Record<string, ConflictMode>;
}

interface CollectionRepositoryWithLoad {
  load(options: { filter: Record<string, unknown> }): Promise<void>;
}

/**
 * Yields the non-empty lines of an NDJSON file without ever holding more than one line (up to `maxRowBytes`) in
 * memory, so a single huge line cannot exhaust memory.
 */
async function* readRows(filePath: string, maxRowBytes: number): AsyncGenerator<string> {
  const rowTooLarge = () => new Error('A data row is larger than the allowed row size');
  // The unfinished row is kept as a list of pieces with a running byte count: each chunk is scanned once for newlines
  // and nothing is re-scanned or re-measured, so a long row costs linear time up to the limit.
  let pieces: string[] = [];
  let pendingBytes = 0;
  for await (const value of fs.createReadStream(filePath, { encoding: 'utf8' })) {
    const chunk = value as string;
    let start = 0;
    let index = chunk.indexOf('\n');
    while (index >= 0) {
      const piece = chunk.slice(start, index);
      if (pendingBytes + Buffer.byteLength(piece) > maxRowBytes) throw rowTooLarge();
      const line = (pieces.length ? pieces.join('') + piece : piece).replace(/\r$/, '');
      pieces = [];
      pendingBytes = 0;
      if (line) yield line;
      start = index + 1;
      index = chunk.indexOf('\n', start);
    }
    const rest = chunk.slice(start);
    if (rest) {
      pendingBytes += Buffer.byteLength(rest);
      if (pendingBytes > maxRowBytes) throw rowTooLarge();
      pieces.push(rest);
    }
  }
  const last = pieces.join('');
  if (last.trim()) yield last;
}

export class ImportBlockedError extends Error {
  constructor(public problems: Problem[]) {
    super(`Import blocked by ${problems.length} problem(s): ${problems.map((p) => p.code).join(', ')}`);
  }
}

export class CollectionImporter {
  constructor(private app: Application) {}

  private get db(): Database {
    return this.app.db;
  }

  static uploadDir() {
    return storagePathJoin('tmp', 'collection-transfer');
  }

  private packageDir(token: string) {
    if (!TOKEN_PATTERN.test(token)) {
      throw new Error('Invalid upload token');
    }
    return path.join(CollectionImporter.uploadDir(), token);
  }

  /** Extracts an uploaded zip into its own directory and returns the token that identifies it. */
  async receive(zipPath: string): Promise<string> {
    await this.removeExpiredUploads();
    await CollectionImporter.inspectArchive(zipPath);
    const token = crypto.randomUUID();
    const dir = this.packageDir(token);
    await fsPromises.mkdir(dir, { recursive: true });
    try {
      await CollectionImporter.extractArchive(zipPath, dir);
      await fsPromises.access(path.join(dir, MANIFEST_FILE));
    } catch (error) {
      await fsPromises.rm(dir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : '';
      throw new Error(message.startsWith('Package refused') ? message : 'Not a collection transfer package');
    }
    return token;
  }

  /**
   * Extracts only the entries the package format defines, streaming each one to disk while counting bytes, and stops as
   * soon as an entry or the whole package passes the limits. Nothing is buffered in memory.
   */
  static async extractArchive(zipPath: string, dir: string) {
    const limits = CollectionImporter.limits;
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
        if (openError || !zipfile) {
          reject(openError || new Error('Not a collection transfer package'));
          return;
        }
        const fail = (error: Error) => {
          zipfile.close();
          reject(error);
        };
        zipfile.on('error', fail);
        zipfile.on('end', () => resolve());
        zipfile.on('entry', (entry: yauzl.Entry) => {
          const name = entry.fileName.replace(/\\/g, '/');
          if (name.endsWith('/') || !ALLOWED_ENTRY.test(name)) {
            zipfile.readEntry();
            return;
          }
          zipfile.openReadStream(entry, (streamError, input) => {
            if (streamError || !input) {
              fail(streamError || new Error('Not a collection transfer package'));
              return;
            }
            const target = path.join(dir, name);
            let written = 0;
            fsPromises
              .mkdir(path.dirname(target), { recursive: true })
              .then(() => {
                const output = fs.createWriteStream(target);
                input.on('data', (chunk: Buffer) => {
                  written += chunk.length;
                  total += chunk.length;
                  if (written > limits.maxEntryBytes || total > limits.maxTotalBytes) {
                    input.destroy();
                    output.destroy();
                    fail(new Error(`Package refused: ${name} expands beyond the size limit`));
                  }
                });
                input.on('error', fail);
                output.on('error', fail);
                output.on('finish', () => zipfile.readEntry());
                input.pipe(output);
              })
              .catch(fail);
          });
        });
        zipfile.readEntry();
      });
    });
  }

  async discard(token: string) {
    await fsPromises.rm(this.packageDir(token), { recursive: true, force: true });
  }

  /** Upper bounds for an uploaded package (static so tests can lower them). */
  static limits = {
    maxEntries: 10_000,
    maxEntryBytes: 1024 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
    // Only checked for entries above `ratioCheckBytes`; text compresses well, bombs compress absurdly well.
    maxCompressionRatio: 200,
    ratioCheckBytes: 10 * 1024 * 1024,
    maxSchemaFileBytes: 50 * 1024 * 1024,
    // One data row (one line of NDJSON).
    maxRowBytes: 16 * 1024 * 1024,
  };

  /**
   * Reads the zip's central directory before anything is extracted and refuses archives that would expand beyond the
   * limits (zip bombs). yauzl validates the declared sizes while extracting, so the declared values cannot be undercut.
   */
  static async inspectArchive(zipPath: string) {
    const limits = CollectionImporter.limits;
    await new Promise<void>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
        if (openError || !zipfile) {
          reject(new Error('Not a collection transfer package'));
          return;
        }
        if (zipfile.entryCount > limits.maxEntries) {
          zipfile.close();
          reject(new Error(`Package has too many entries (${zipfile.entryCount})`));
          return;
        }
        let total = 0;
        zipfile.on('entry', (entry: yauzl.Entry) => {
          const size = entry.uncompressedSize;
          const ratio = entry.compressedSize > 0 ? size / entry.compressedSize : size > 0 ? Infinity : 1;
          total += size;
          let reason: string | undefined;
          if (size > limits.maxEntryBytes) reason = `entry ${entry.fileName} is too large`;
          else if (total > limits.maxTotalBytes) reason = 'package expands beyond the size limit';
          else if (size > limits.ratioCheckBytes && ratio > limits.maxCompressionRatio) {
            reason = `entry ${entry.fileName} is suspiciously compressed`;
          }
          if (reason) {
            zipfile.close();
            reject(new Error(`Package refused: ${reason}`));
            return;
          }
          zipfile.readEntry();
        });
        zipfile.on('end', () => resolve());
        zipfile.on('error', () => reject(new Error('Not a collection transfer package')));
        zipfile.readEntry();
      });
    });
  }

  async preview(token: string): Promise<Preview> {
    const pkg = await this.load(token);
    const problems = await this.check(pkg);
    const fieldCounts = lodash.countBy(pkg.associations, (a) => a.collectionName);

    const collections: PreviewCollection[] = [
      ...pkg.collections.map((c) => ({
        name: c.name,
        title: c.title || c.name,
        fieldCount: c.fields.length + (fieldCounts[c.name] || 0),
        rowCount: pkg.metas[c.name]?.count || 0,
        isThrough: false,
      })),
      ...pkg.through.map((name) => ({
        name,
        title: name,
        fieldCount: 0,
        rowCount: pkg.metas[name]?.count || 0,
        isThrough: true,
      })),
    ];

    return {
      token,
      manifest: pkg.manifest,
      collections,
      problems,
      interfaces: this.interfacesOf(pkg),
      missingPlugins: this.missingPlugins(pkg.manifest),
      conflicts: await this.conflicts(pkg),
    };
  }

  /**
   * @param options.userId the importing user. "Created by" / "Updated by" of every imported row is set to this user,
   *   because user ids from the source environment do not identify the same people here.
   */
  async import(token: string, options: ImportOptions = {}): Promise<ImportResult> {
    const pkg = await this.load(token);
    const { manifest } = pkg;
    // The target may have changed since the preview, so every check runs again.
    const problems = await this.check(pkg);
    const conflicts = await this.conflicts(pkg);
    const resolutions = options.resolutions || {};
    for (const conflict of conflicts) {
      const mode = resolutions[conflict.name];
      if (!CONFLICT_MODES.includes(mode)) {
        problems.push({ code: 'unresolvedConflict', collection: conflict.name });
      } else if (mode === 'skipCollectionImportData' && manifest.includeData && conflict.missingColumns.length) {
        problems.push({
          code: 'columnsMismatch',
          collection: conflict.name,
          detail: conflict.missingColumns.join(', '),
        });
      }
    }
    if (problems.length) {
      throw new ImportBlockedError(problems);
    }

    const existing = new Set(conflicts.map((conflict) => conflict.name));
    const modeOf = (name: string): ConflictMode | 'new' => (existing.has(name) ? resolutions[name] : 'new');
    const isOverride = (name: string) => ['overrideSchema', 'overrideAll'].includes(modeOf(name));
    const create = new Set(manifest.collections.filter((name) => modeOf(name) === 'new' || isOverride(name)));
    const overridden = manifest.collections.filter(isOverride);
    const skipped = manifest.collections.filter((name) => existing.has(name) && !isOverride(name));
    const wantsData = (name: string) =>
      manifest.includeData && ['new', 'overrideAll', 'skipCollectionImportData'].includes(modeOf(name));

    // Junction tables follow the collection that owns the belongsToMany field.
    const owners = this.throughOwners(pkg);
    const throughCreate = manifest.through.filter((name) => create.has(owners[name]));
    const throughExisting = new Set(manifest.through.filter((name) => this.db.hasCollection(name)));
    const throughAppend = manifest.through.filter(
      (name) =>
        !create.has(owners[name]) && modeOf(owners[name]) === 'skipCollectionImportData' && throughExisting.has(name),
    );

    // Collections whose in-memory definition changes when an override removes fields; reloaded on rollback.
    const reloadOnRollback = new Set<string>([...overridden, ...throughCreate.filter((n) => throughExisting.has(n))]);
    for (const conflict of conflicts) {
      if (isOverride(conflict.name)) conflict.referencedBy.forEach((ref) => reloadOnRollback.add(ref.collection));
    }

    const collectionsRepository = this.db.getRepository('collections');

    // Package fields that exist on skipped collections before anything changes. If an override removes one of them
    // (because it points at the overridden collection), the import re-creates it from the package.
    const skippedFieldsBefore = new Set<string>();
    for (const association of pkg.associations) {
      const sides: [string, string][] = [[association.collectionName, association.name]];
      if (association.reverseField) sides.push([association.target, association.reverseField.name]);
      for (const [collectionName, name] of sides) {
        if (!skipped.includes(collectionName)) continue;
        if ((await this.db.getRepository('fields').count({ filter: { collectionName, name } })) > 0) {
          skippedFieldsBefore.add(`${collectionName}.${name}`);
        }
      }
    }
    const transaction = await this.db.sequelize.transaction();
    const rowCounts: Record<string, number> = {};

    try {
      // Override: drop the existing collections (NocoBase also removes the fields that point at them) and the
      // package's junction tables they own, then recreate them below like new ones.
      for (const name of [...overridden, ...throughCreate.filter((n) => throughExisting.has(n))]) {
        await collectionsRepository.destroy({ filter: { name }, cascade: true, context: {}, transaction });
      }

      // Pass 1: collections with their scalar fields. Tables are built by the
      // collections.afterSaveWithAssociations hook, which only runs when `context` is passed.
      for (const collection of pkg.collections) {
        if (!create.has(collection.name)) continue;
        const values = {
          ...lodash.omit(collection, ['key', 'sort', 'category']),
          fields: collection.fields.map((field) => lodash.omit(field, NESTED_FIELD_STRIP)),
        };
        await collectionsRepository.create({ values, context: {}, transaction });
      }

      // Pass 2: associations, with their original foreignKey/through/otherKey. NocoBase hooks create the FK
      // columns, auto through collections and the reverse side from `reverseField`.
      // A skipped collection keeps its fields as they are; only a package field the override removed is re-created.
      const fieldExists = async (collectionName: string, name: string) =>
        (await this.db.getRepository('fields').count({ filter: { collectionName, name }, transaction })) > 0;
      const needsSide = async (collectionName: string, name: string) =>
        create.has(collectionName) ||
        (skippedFieldsBefore.has(`${collectionName}.${name}`) && !(await fieldExists(collectionName, name)));

      const createdAssociations: AssociationPayload[] = [];
      for (const association of pkg.associations) {
        const ownerNeeded = await needsSide(association.collectionName, association.name);
        const reverseNeeded =
          !!association.reverseField && (await needsSide(association.target, association.reverseField.name));
        let values: AssociationPayload | null = null;
        if (ownerNeeded) {
          values = {
            ...(lodash.omit(association, [...ASSOCIATION_STRIP, 'reverseField']) as AssociationPayload),
            ...(reverseNeeded
              ? { reverseField: lodash.omit(association.reverseField, NESTED_FIELD_STRIP) as AssociationPayload }
              : {}),
          };
        } else if (reverseNeeded) {
          values = {
            ...(lodash.omit(association.reverseField, NESTED_FIELD_STRIP) as AssociationPayload),
            collectionName: association.target,
            target: association.collectionName,
          };
        }
        if (!values) continue;
        await this.db.getRepository('fields').create({
          values,
          updateAssociationValues: ['reverseField'],
          context: {},
          transaction,
        });
        createdAssociations.push(values);
      }

      await this.assertHookResults(createdAssociations, throughCreate, transaction);
      await this.assertColumns(pkg, [...create, ...throughCreate], transaction);

      const userId = options.userId ?? null;
      for (const name of create) {
        if (wantsData(name)) rowCounts[name] = await this.insertRows(token, name, pkg.metas[name], transaction, userId);
      }
      for (const name of skipped) {
        if (wantsData(name)) {
          rowCounts[name] = await this.insertRows(token, name, pkg.metas[name], transaction, userId, true);
        }
      }
      for (const name of throughCreate) {
        if (wantsData(owners[name]))
          rowCounts[name] = await this.insertRows(token, name, pkg.metas[name], transaction, userId);
      }
      for (const name of throughAppend) {
        if (manifest.includeData) {
          await this.assertColumnsSubset(name, pkg.metas[name], transaction);
          rowCounts[name] = await this.insertRows(token, name, pkg.metas[name], transaction, userId, true);
        }
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      // Collections defined in memory during the transaction would otherwise linger as ghosts, and overridden
      // collections (plus the collections whose fields pointed at them) must be loaded back as they were.
      for (const name of [...create, ...throughCreate]) {
        if (this.db.hasCollection(name)) this.db.removeCollection(name);
      }
      if (reloadOnRollback.size) {
        await (collectionsRepository as unknown as CollectionRepositoryWithLoad).load({
          filter: { name: { $in: [...reloadOnRollback] } },
        });
      }
      throw error;
    }

    await this.discard(token);
    return {
      collections: [...create],
      overridden,
      skipped,
      through: [...throughCreate, ...throughAppend],
      rowCounts,
    };
  }

  /** Collections of the package that already exist here, with what an override would remove. */
  private async conflicts(pkg: LoadedPackage): Promise<PreviewConflict[]> {
    const result: PreviewConflict[] = [];
    const packageFields = new Set<string>();
    for (const association of pkg.associations) {
      packageFields.add(`${association.collectionName}.${association.name}`);
      if (association.reverseField) packageFields.add(`${association.target}.${association.reverseField.name}`);
    }
    for (const name of pkg.manifest.collections) {
      if (!isValidName(name)) continue;
      const row = await this.db.getRepository('collections').findOne({ filter: { name } });
      if (!row && !this.db.hasCollection(name)) continue;
      // System or code-defined collections are reported as problems by check(), never offered as conflicts.
      if (!(await this.isUserCollection(name))) continue;

      const references = await this.db.getRepository('fields').find({
        filter: { type: { $in: ASSOCIATION_TYPES_FOR_REFERENCES }, collectionName: { $ne: name } },
      });
      const referencedBy = references
        .filter((field) => field.get('target') === name || field.get('through') === name)
        .map((field) => {
          const collection = field.get('collectionName') as string;
          const fieldName = field.get('name') as string;
          // Fields the package defines on its own collections are re-created by the import after an override.
          return { collection, field: fieldName, restored: packageFields.has(`${collection}.${fieldName}`) };
        });

      let missingColumns: string[] = [];
      const collection = this.db.getCollection(name);
      if (collection && pkg.metas[name]) {
        const live = await this.db.sequelize.getQueryInterface().describeTable(collection.getTableNameWithSchema());
        missingColumns = pkg.metas[name].columns.filter((column) => !(column in live));
      }

      result.push({ name, title: ((row?.get('title') as string) || name) as string, referencedBy, missingColumns });
    }
    return result;
  }

  /** A collection created in the collection manager: has a row, is not hidden, not a junction, not mirrored from code. */
  private async isUserCollection(name: string) {
    const row = await this.db.getRepository('collections').findOne({ filter: { name } });
    if (!row) return false;
    const values = row.get() as Record<string, unknown>;
    return !values.hidden && !values.isThrough && !MIRRORED_ORIGINS.includes(values.from as string);
  }

  /** An auto-created junction table whose owner is a user collection with a belongsToMany field using it. */
  private async isOwnedJunction(name: string, owner: string | undefined) {
    if (!owner || !(await this.isUserCollection(owner))) return false;
    const row = await this.db.getRepository('collections').findOne({ filter: { name } });
    const values = (row?.get() || {}) as Record<string, unknown>;
    if (!values.isThrough || !values.autoCreate) return false;
    const fields = await this.db
      .getRepository('fields')
      .find({ filter: { collectionName: owner, type: 'belongsToMany' } });
    return fields.some((field) => field.get('through') === name);
  }

  /** Junction table name → collection that owns the belongsToMany field using it. */
  private throughOwners(pkg: LoadedPackage): Record<string, string> {
    const owners: Record<string, string> = {};
    for (const association of pkg.associations) {
      if (association.type === 'belongsToMany' && typeof association.through === 'string') {
        owners[association.through] ??= association.collectionName;
      }
    }
    return owners;
  }

  private async load(token: string): Promise<LoadedPackage> {
    const dir = this.packageDir(token);
    const readJson = async <T>(relativePath: string): Promise<T> => {
      const filePath = path.join(dir, relativePath);
      if ((await fsPromises.stat(filePath)).size > CollectionImporter.limits.maxSchemaFileBytes) {
        throw new Error(`${relativePath} is too large`);
      }
      return JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as T;
    };

    let manifest: Manifest;
    try {
      manifest = await readJson<Manifest>(MANIFEST_FILE);
    } catch (error) {
      throw new Error('Not a collection transfer package (manifest.json missing or unreadable)');
    }

    const collections = await readJson<CollectionPayload[]>(COLLECTIONS_FILE);
    const associations = await readJson<AssociationPayload[]>(ASSOCIATIONS_FILE);
    const through = await readJson<string[]>(THROUGH_FILE);

    const metas: Record<string, DataMeta> = {};
    for (const name of [...(manifest.collections || []), ...(manifest.through || [])]) {
      if (!isValidName(name)) continue;
      try {
        const meta = await readJson<DataMeta>(`${dataDir(name)}/meta`);
        // The meta must describe the collection whose folder it is in, with plain column names; otherwise a package
        // could point rows at another table. A rejected meta is reported as invalidPackage by check().
        const valid =
          meta?.name === name &&
          Array.isArray(meta.columns) &&
          meta.columns.every((column) => isValidName(column)) &&
          Number.isInteger(meta.count) &&
          meta.count >= 0;
        if (valid) metas[name] = meta;
      } catch (error) {
        // Reported as invalidPackage by check().
      }
    }

    return { manifest, collections, associations, through, metas };
  }

  private async check(pkg: LoadedPackage): Promise<Problem[]> {
    const { manifest } = pkg;
    const problems: Problem[] = [];

    if (manifest.formatVersion !== FORMAT_VERSION) {
      problems.push({ code: 'formatVersion', detail: String(manifest.formatVersion) });
      return problems;
    }
    const dialect = this.db.sequelize.getDialect();
    if (manifest.dialect !== dialect) {
      problems.push({ code: 'dialect', detail: `${manifest.dialect} → ${dialect}` });
    }

    const names = [...manifest.collections, ...manifest.through];
    const payloadNames = pkg.collections.map((c) => c.name);
    if (!lodash.isEqual(payloadNames, manifest.collections) || !lodash.isEqual(pkg.through, manifest.through)) {
      problems.push({ code: 'invalidPackage', detail: 'schema files do not match manifest' });
    }

    const existingTables = await this.existingTableNames();
    const owners = this.throughOwners(pkg);
    const exists = async (name: string) => this.db.hasCollection(name) || (await this.collectionRowExists(name));
    for (const name of names) {
      if (!isValidName(name)) {
        problems.push({ code: 'invalidName', collection: String(name) });
        continue;
      }
      if (!pkg.metas[name]) {
        problems.push({ code: 'invalidPackage', collection: name, detail: 'meta missing' });
      }
      if (name.length > MAX_IDENTIFIER_LENGTH) {
        problems.push({ code: 'identifierTooLong', collection: name });
      }
      if (await exists(name)) {
        // Only collections created in the collection manager may be resolved as conflicts (skip / override). System,
        // plugin and code-defined collections are never touched. An existing junction table is accepted only when it is
        // an auto-created junction that the existing owner's belongsToMany field really uses.
        if (manifest.collections.includes(name)) {
          if (!(await this.isUserCollection(name))) problems.push({ code: 'systemCollection', collection: name });
        } else if (!(await this.isOwnedJunction(name, owners[name]))) {
          problems.push({ code: 'collectionExists', collection: name });
        }
      } else if (existingTables.has(this.expectedTableName(name))) {
        problems.push({ code: 'tableExists', collection: name });
      }
    }

    for (const collection of pkg.collections) {
      const template = (collection.template as string) || 'general';
      if (!SUPPORTED_TEMPLATES.includes(template) || !lodash.isEmpty(collection.inherits)) {
        problems.push({ code: 'unsupportedTemplate', collection: collection.name, detail: template });
      }
      for (const field of collection.fields) {
        this.checkField(field, collection.name, problems);
      }
    }

    for (const association of pkg.associations) {
      this.checkField(association, association.collectionName, problems);
      if (association.reverseField) {
        this.checkField(association.reverseField, association.target, problems);
      }
    }

    this.checkContainment(pkg, problems);

    // Titles and uiSchema strings are compiled by NocoBase's UI later; only plain translations are allowed.
    for (const payload of [...pkg.collections, ...pkg.associations]) {
      const unsafe = findUnsafeExpression(payload);
      if (unsafe) {
        const collection = 'collectionName' in payload ? (payload.collectionName as string) : payload.name;
        problems.push({ code: 'unsafeExpression', collection, detail: unsafe.slice(0, 120) });
      }
    }

    for (const dependency of manifest.dependencies) {
      if (!this.db.hasCollection(dependency)) {
        problems.push({ code: 'missingDependency', collection: dependency });
      }
    }

    return lodash.uniqWith(problems, lodash.isEqual);
  }

  private interfacesOf(pkg: LoadedPackage): PreviewInterface[] {
    const result: PreviewInterface[] = [];
    const add = (field: Record<string, unknown>, collection: string) => {
      if (typeof field.interface === 'string' && field.interface) {
        result.push({ interface: field.interface, collection, field: field.name as string });
      }
    };
    for (const collection of pkg.collections) {
      for (const field of collection.fields) add(field, collection.name);
    }
    for (const association of pkg.associations) {
      add(association, association.collectionName);
      if (association.reverseField) add(association.reverseField, association.target);
    }
    return result;
  }

  private missingPlugins(manifest: Manifest): string[] {
    if (!manifest.plugins?.length) return [];
    const here = new Set(enabledPluginNames(this.app));
    return manifest.plugins.filter((name) => !here.has(name));
  }

  /**
   * Everything an import creates (collections, fields, FK columns, through tables) must belong to the package.
   * Exports only produce such packages; this refuses crafted ones that point at existing collections or tables.
   */
  private checkContainment(pkg: LoadedPackage, problems: Problem[]) {
    const { manifest } = pkg;
    const own = new Set(manifest.collections);
    const ownOrThrough = new Set([...manifest.collections, ...manifest.through]);
    const dependencies = new Set(manifest.dependencies);
    const outside = (collection: string, detail: string, field?: string) =>
      problems.push({ code: 'outsidePackage', collection, field, detail });

    for (const name of manifest.dependencies) {
      if (ownOrThrough.has(name)) outside(name, 'listed both as a dependency and as part of the package');
    }

    for (const collection of pkg.collections) {
      for (const option of PLACEMENT_OPTIONS) {
        const value = collection[option];
        if (value === undefined || value === null || value === false) continue;
        if (option === 'tableName' && value === collection.name) continue;
        outside(collection.name, `option "${option}" is not allowed`);
      }
      // Fields nested in a collection are plain columns; relations are only accepted from associations.json, where the
      // checks below apply. A relation hidden here could otherwise point at collections outside the package.
      for (const field of collection.fields || []) {
        // Decided by the registered field class, so relation types added by plugins are covered too.
        const fieldClass = this.db.fieldTypes.get(field.type) as { prototype?: unknown } | undefined;
        const isRelation = !!fieldClass?.prototype && fieldClass.prototype instanceof RelationField;
        const relationKeys = ['target', 'through', 'foreignKey', 'otherKey', 'sourceKey', 'targetKey'];
        if (isRelation || relationKeys.some((key) => field[key] !== undefined && field[key] !== null)) {
          outside(collection.name, 'relation fields are only allowed in associations.json', field.name);
        }
      }
    }

    // Exports flatten `options` into top-level keys. A raw `options` object would be stored as is and bypass every
    // check on top-level keys (e.g. options.tableName), so it is refused wherever it appears.
    const hasRawOptions = (value: Record<string, unknown> | undefined) =>
      !!value && Object.prototype.hasOwnProperty.call(value, 'options');
    for (const collection of pkg.collections) {
      if (hasRawOptions(collection)) outside(collection.name, 'raw "options" is not allowed');
      for (const field of collection.fields || []) {
        if (hasRawOptions(field)) outside(collection.name, 'raw "options" is not allowed', field.name);
      }
    }
    for (const association of pkg.associations) {
      if (hasRawOptions(association) || hasRawOptions(association.reverseField)) {
        outside(String(association.collectionName), 'raw "options" is not allowed', association.name);
      }
    }

    for (const association of pkg.associations) {
      const { collectionName, name, type, target, through, reverseField } = association;
      if (!own.has(collectionName)) {
        outside(String(collectionName), 'adds a field to a collection that is not in the package', name);
        continue;
      }
      if (!ownOrThrough.has(target) && !dependencies.has(target)) {
        outside(collectionName, `target "${target}" is neither in the package nor a declared dependency`, name);
      }
      // hasMany/hasOne keep their key column on the target; a reverse field is created on the target.
      if ((type === 'hasMany' || type === 'hasOne') && !own.has(target)) {
        outside(collectionName, `would add a key column to "${target}"`, name);
      }
      if (reverseField && !own.has(target)) {
        outside(collectionName, `would add a field to "${target}"`, name);
      }
      if (type === 'belongsToMany' && (typeof through !== 'string' || !ownOrThrough.has(through))) {
        outside(collectionName, `junction table "${String(through)}" is not in the package`, name);
      }
    }
  }

  private checkField(field: Record<string, unknown>, collectionName: string, problems: Problem[]) {
    const name = field.name as string;
    if (!this.db.fieldTypes.get(field.type as string)) {
      problems.push({ code: 'unknownFieldType', collection: collectionName, field: name, detail: String(field.type) });
    }
    for (const identifier of [name, field.foreignKey, field.otherKey, field.through]) {
      if (typeof identifier === 'string' && identifier.length > MAX_IDENTIFIER_LENGTH) {
        problems.push({ code: 'identifierTooLong', collection: collectionName, field: name, detail: identifier });
      }
    }
  }

  private async collectionRowExists(name: string) {
    return (await this.db.getRepository('collections').count({ filter: { name } })) > 0;
  }

  private expectedTableName(name: string) {
    const options = this.db.options as { tablePrefix?: string; underscored?: boolean };
    const tableName = options.underscored ? lodash.snakeCase(name) : name;
    return `${options.tablePrefix || ''}${tableName}`;
  }

  private async existingTableNames(): Promise<Set<string>> {
    const tables = (await this.db.sequelize.getQueryInterface().showAllTables()) as unknown[];
    return new Set(
      tables.map((table) =>
        typeof table === 'string' ? table : String((table as { tableName?: string }).tableName ?? ''),
      ),
    );
  }

  /**
   * afterCreateForForeignKeyField catches and only logs its own errors, so a through collection or FK field that
   * failed to be created would not abort the transaction. Verify every expected object explicitly.
   */
  private async assertHookResults(associations: AssociationPayload[], through: string[], transaction: Transaction) {
    const missing: string[] = [];

    for (const name of through) {
      const exists = await this.db.getRepository('collections').count({ filter: { name }, transaction });
      if (!exists || !this.db.hasCollection(name)) missing.push(`collection ${name}`);
    }

    const expectFk = async (collectionName: string, fieldName: unknown) => {
      if (typeof fieldName !== 'string') return;
      const collection = this.db.getCollection(collectionName);
      if (!collection) return; // external collection: its FK column already exists or is not ours to create
      const exists = await this.db
        .getRepository('fields')
        .count({ filter: { collectionName, name: fieldName }, transaction });
      if (!exists && !collection.getField(fieldName)) missing.push(`field ${collectionName}.${fieldName}`);
    };

    for (const association of associations) {
      const { type, collectionName, target, foreignKey, otherKey, through } = association;
      if (type === 'belongsTo') await expectFk(collectionName, foreignKey);
      if (type === 'hasMany' || type === 'hasOne') await expectFk(target, foreignKey);
      if (type === 'belongsToMany' && typeof through === 'string') {
        await expectFk(through, foreignKey);
        await expectFk(through, otherKey);
      }
    }

    if (missing.length) {
      throw new Error(`NocoBase did not create: ${missing.join(', ')}`);
    }
  }

  /** Rows are appended by column name into an existing table, so every package column must exist there. */
  private async assertColumnsSubset(name: string, meta: DataMeta, transaction: Transaction) {
    const collection = this.db.getCollection(name);
    const describeOptions = { transaction } as unknown as Parameters<QueryInterface['describeTable']>[1];
    const live = await this.db.sequelize
      .getQueryInterface()
      .describeTable(collection.getTableNameWithSchema(), describeOptions);
    const missing = meta.columns.filter((column) => !(column in live));
    if (missing.length) {
      throw new Error(`Columns missing in ${name}: ${missing.join(', ')}`);
    }
  }

  /** The dumped rows are column arrays, so the tables created here must have exactly the source columns. */
  private async assertColumns(pkg: LoadedPackage, names: string[], transaction: Transaction) {
    for (const name of names) {
      const collection = this.db.getCollection(name);
      // The tables only exist inside the uncommitted transaction. Sequelize forwards describeTable options to the
      // query (core Collection does the same), but its typings omit `transaction`.
      const describeOptions = { transaction } as unknown as Parameters<QueryInterface['describeTable']>[1];
      const live = Object.keys(
        await this.db.sequelize.getQueryInterface().describeTable(collection.getTableNameWithSchema(), describeOptions),
      ).sort();
      const expected = [...pkg.metas[name].columns].sort();
      if (!lodash.isEqual(live, expected)) {
        throw new Error(
          `Columns of ${name} differ from the package: expected [${expected.join(', ')}], got [${live.join(', ')}]`,
        );
      }
    }
  }

  /**
   * @param intoExisting rows go into a table that existed before (skip mode): rows whose primary key already exists
   *   are left alone, and the returned count is the number of rows actually added.
   */
  private async insertRows(
    token: string,
    name: string,
    meta: DataMeta,
    transaction: Transaction,
    importingUserId: string | number | null,
    intoExisting = false,
  ): Promise<number> {
    const dataPath = path.join(this.packageDir(token), dataDir(name), 'data');
    const exists = await fsPromises
      .stat(dataPath)
      .then(() => true)
      .catch(() => false);
    if (!exists || !meta.count) return 0;

    const collection: Collection = this.db.getCollection(name);
    const attributes = collection.model.getAttributes();
    const attributeByColumn = new Map(
      Object.entries(attributes).map(([attributeName, attribute]) => [attribute.field || attributeName, attributeName]),
    );
    const columnAttributes = Object.fromEntries(
      Object.entries(attributes).map(([attributeName, attribute]) => [attribute.field || attributeName, attribute]),
    );
    const queryInterface = this.db.sequelize.getQueryInterface();
    const tableName = collection.getTableNameWithSchema();

    // Key columns of "Created by" / "Updated by" (belongsTo users with those interfaces).
    const userColumns = new Set<string>();
    for (const field of collection.fields.values()) {
      const fieldOptions = field.options as { interface?: string; foreignKey?: string };
      if (field.type !== 'belongsTo' || !['createdBy', 'updatedBy'].includes(fieldOptions.interface)) continue;
      const foreignKey = fieldOptions.foreignKey;
      if (foreignKey) userColumns.add(attributes[foreignKey]?.field || foreignKey);
    }

    const countRows = () => collection.repository.count({ transaction });
    const before = intoExisting ? await countRows() : 0;
    // Sequelize's bulk insert query honours ignoreDuplicates (ON CONFLICT DO NOTHING on Postgres); its typings omit it.
    const insertOptions = { transaction, ignoreDuplicates: intoExisting } as unknown as Parameters<
      QueryInterface['bulkInsert']
    >[2];

    let batch: Record<string, unknown>[] = [];
    let count = 0;
    const flush = async () => {
      if (!batch.length) return;
      await queryInterface.bulkInsert(tableName, batch, insertOptions, columnAttributes);
      count += batch.length;
      batch = [];
    };

    for await (const line of readRows(dataPath, CollectionImporter.limits.maxRowBytes)) {
      const values = JSON.parse(line);
      if (!Array.isArray(values)) {
        throw new Error(`Invalid row in ${name}`);
      }
      const record: Record<string, unknown> = {};
      meta.columns.forEach((column, index) => {
        const field = collection.getField(attributeByColumn.get(column));
        if (userColumns.has(column)) {
          record[column] = importingUserId;
          return;
        }
        record[column] = field ? FieldValueWriter.write(field, values[index], this.db) : values[index];
      });
      batch.push(record);
      if (batch.length >= INSERT_CHUNK_SIZE) await flush();
    }
    await flush();

    await this.resetSequence(collection, transaction);
    return intoExisting ? (await countRows()) - before : count;
  }

  /** Serial PKs only: move the sequence past the imported ids. Snowflake/uid PKs have no sequence. */
  private async resetSequence(collection: Collection, transaction: Transaction) {
    if (!this.db.inDialect('postgres')) return;
    const entry = Object.entries(collection.model.getAttributes()).find(([, attribute]) => attribute.autoIncrement);
    if (!entry) return;
    const column = entry[1].field || entry[0];
    const table = collection.quotedTableName();
    const quotedColumn = this.db.sequelize.getQueryInterface().quoteIdentifier(column);
    await this.db.sequelize.query(
      `SELECT setval(pg_get_serial_sequence(:table, :column), COALESCE(MAX(${quotedColumn}), 0) + 1, false) FROM ${table}`,
      { replacements: { table, column }, type: QueryTypes.SELECT, transaction },
    );
  }

  private async removeExpiredUploads() {
    const root = CollectionImporter.uploadDir();
    const entries = await fsPromises.readdir(root, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    for (const entry of entries) {
      const entryPath = path.join(root, entry.name);
      const stat = await fsPromises.stat(entryPath).catch(() => null);
      if (stat && now - stat.mtimeMs > UPLOAD_TTL_MS) {
        await fsPromises.rm(entryPath, { recursive: true, force: true });
      }
    }
  }
}
