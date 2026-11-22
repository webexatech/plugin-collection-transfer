import { Collection, Database, Model } from '@nocobase/database';
import { Application } from '@nocobase/server';
import archiver from 'archiver';
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import lodash from 'lodash';
import os from 'os';
import path from 'path';
import { QueryTypes } from 'sequelize';
import { finished } from 'stream/promises';
import { FieldValueWriter } from './field-value-writer';
import {
  ASSOCIATIONS_FILE,
  ASSOCIATION_TYPES,
  AssociationPayload,
  COLLECTION_BOOKKEEPING_KEYS,
  COLLECTIONS_FILE,
  CollectionPayload,
  dataDir,
  DATALESS_TEMPLATES,
  DataMeta,
  FIELD_BOOKKEEPING_KEYS,
  FieldPayload,
  FORMAT_VERSION,
  isValidName,
  isVirtual,
  Manifest,
  MANIFEST_FILE,
  MIRRORED_ORIGINS,
  SUPPORTED_TEMPLATES,
  templateOf,
  THROUGH_FILE,
} from './package-format';
// @ts-ignore
import pkg from '../../package.json';

type Row = Record<string, unknown>;

export interface TransferableCollection {
  name: string;
  title: string;
  template: string;
  supported: boolean;
  unsupportedReason?: string;
  /** Other user collections this one's relation fields point to (system collections are dependencies instead). */
  related: string[];
}

export interface ExportOptions {
  collections: string[];
  includeData: boolean;
}

export interface ExportResult {
  filePath: string;
  fileName: string;
  manifest: Manifest;
}

function unsupportedReason(row: Row): string | undefined {
  const template = templateOf(row);
  if (!SUPPORTED_TEMPLATES.includes(template)) {
    return `template:${template}`;
  }
  if (!isValidName(row.name)) {
    return 'name';
  }
  return undefined;
}

function isUserCollection(row: Row) {
  return !row.hidden && !row.isThrough && !MIRRORED_ORIGINS.includes(row.from as string);
}

/** Package names (or names) of the plugins enabled in this app, from the plugin manager. */
export function enabledPluginNames(app: Application): string[] {
  const names = new Set<string>();
  for (const plugin of app.pm.getPlugins().values()) {
    if (!plugin.enabled) continue;
    const options = plugin.options as { packageName?: string; name?: string };
    const name = options.packageName || options.name;
    if (name) names.add(name);
  }
  return [...names].sort();
}

export class CollectionExporter {
  constructor(private app: Application) {}

  private get db(): Database {
    return this.app.db;
  }

  /** Collections a user may pick for export, with a flag for the ones the PoC cannot transfer. */
  async listCollections(): Promise<TransferableCollection[]> {
    const rows = (await this.collectionRows()).filter(isUserCollection);
    const userNames = new Set(rows.map((row) => row.name as string));

    // Relation targets per collection, limited to user collections (the UI offers to add them to the export).
    const related = new Map<string, Set<string>>();
    for (const field of await this.fieldRowsOf([...userNames])) {
      if (!ASSOCIATION_TYPES.includes(field.type as string)) continue;
      const owner = field.collectionName as string;
      const target = field.target as string;
      if (target === owner || !userNames.has(target)) continue;
      if (!related.has(owner)) related.set(owner, new Set());
      related.get(owner).add(target);
    }

    return rows.map((row) => {
      const name = row.name as string;
      const reason = unsupportedReason(row);
      return {
        name,
        title: (row.title as string) || name,
        template: templateOf(row),
        supported: !reason,
        unsupportedReason: reason,
        related: [...(related.get(name) || [])].sort(),
      };
    });
  }

  async export(options: ExportOptions): Promise<ExportResult> {
    const selected = lodash.uniq(options.collections || []);
    if (!selected.length) {
      throw new Error('No collections selected');
    }

    const rowsByName = lodash.keyBy(await this.collectionRows(), (row) => row.name as string);
    for (const name of selected) {
      const row = rowsByName[name];
      if (!row || !isUserCollection(row)) {
        throw new Error(`Collection "${name}" is not a user collection`);
      }
      const reason = unsupportedReason(row);
      if (reason) {
        throw new Error(`Collection "${name}" cannot be transferred (${reason})`);
      }
    }

    const { collections, through, fieldRows } = await this.resolveSelection(selected, rowsByName);

    const workDir = path.resolve(os.tmpdir(), `collection-transfer-${crypto.randomUUID()}`);
    await fsPromises.mkdir(path.join(workDir, 'schema'), { recursive: true });

    try {
      const { collectionPayloads, associationPayloads, dependencies } = this.buildPayloads(
        collections,
        through,
        rowsByName,
        fieldRows,
      );

      const storages = await this.storageNames(collections, rowsByName, !!options.includeData);
      const manifest: Manifest = {
        formatVersion: FORMAT_VERSION,
        pluginVersion: pkg.version,
        sourceAppVersion: this.app.getPackageVersion(),
        dialect: this.db.sequelize.getDialect(),
        exportedAt: new Date().toISOString(),
        includeData: !!options.includeData,
        selected,
        collections,
        through,
        dependencies,
        plugins: enabledPluginNames(this.app),
        ...(storages ? { storages } : {}),
      };

      await this.writeJson(workDir, COLLECTIONS_FILE, collectionPayloads);
      await this.writeJson(workDir, ASSOCIATIONS_FILE, associationPayloads);
      await this.writeJson(workDir, THROUGH_FILE, through);

      for (const name of [...collections, ...through]) {
        const dataless = DATALESS_TEMPLATES.includes(templateOf(rowsByName[name] || {}));
        await this.dumpCollection(workDir, name, manifest.includeData && !dataless);
      }

      await this.writeJson(workDir, MANIFEST_FILE, manifest);

      const fileName = `collections-${manifest.exportedAt.replace(/[:.]/g, '-')}.zip`;
      const filePath = path.resolve(os.tmpdir(), `${crypto.randomUUID()}-${fileName}`);
      await this.zipDir(workDir, filePath);

      return { filePath, fileName, manifest };
    } finally {
      await fsPromises.rm(workDir, { recursive: true, force: true });
    }
  }

  private async collectionRows(): Promise<Row[]> {
    const hasCategories = this.db.hasCollection('collectionCategories');
    const models: Model[] = await this.db
      .getRepository('collections')
      .find({ sort: ['sort'], ...(hasCategories ? { appends: ['category'] } : {}) });
    return models.map((model) => {
      const categories = ((model.get('category') as Model[] | undefined) || []).map((c) => String(c.get('name')));
      return { ...(model.get() as Row), categories };
    });
  }

  private async fieldRowsOf(collectionNames: string[]): Promise<Row[]> {
    if (!collectionNames.length) return [];
    const models: Model[] = await this.db.getRepository('fields').find({
      filter: { collectionName: { $in: collectionNames } },
      sort: ['sort'],
    });
    return models.map((model) => model.get() as Row);
  }

  /**
   * Expands the selection with the collections it cannot work without: user-defined through collections of
   * belongsToMany fields become companions; auto-created through collections are listed separately because the
   * belongsToMany hook recreates them on import.
   */
  private async resolveSelection(selected: string[], rowsByName: Record<string, Row>) {
    const collections = [...selected];
    const through: string[] = [];
    let pending = [...selected];
    const fieldRows: Row[] = [];

    while (pending.length) {
      // Parents of inherited collections (PostgreSQL) are companions too: the child table cannot exist without them.
      for (const name of pending) {
        for (const parent of lodash.castArray((rowsByName[name]?.inherits as string | string[]) || [])) {
          if (collections.includes(parent)) continue;
          const parentRow = rowsByName[parent];
          const reason = parentRow ? unsupportedReason(parentRow) : 'missing';
          if (!parentRow || !isUserCollection(parentRow) || reason) {
            throw new Error(`Parent collection "${parent}" of "${name}" cannot be transferred (${reason || 'system'})`);
          }
          collections.push(parent);
          pending.push(parent);
        }
      }
      const rows = await this.fieldRowsOf(pending);
      fieldRows.push(...rows);
      pending = [];

      for (const field of rows) {
        if (field.type !== 'belongsToMany' || !field.through) continue;
        const throughName = field.through as string;
        if (collections.includes(throughName) || through.includes(throughName)) continue;

        const throughRow = rowsByName[throughName];
        if (!throughRow) {
          // Older installations (and synced tables) can have a junction table that is only defined in memory by the
          // relation, without a collection-manager row. It is treated like an auto-created junction: the importer's
          // belongsToMany hook recreates it, and its rows are carried.
          if (!this.db.hasCollection(throughName)) {
            throw new Error(
              `Through collection "${throughName}" of field "${field.collectionName}.${field.name}" not found`,
            );
          }
          through.push(throughName);
          continue;
        }
        if (throughRow.autoCreate) {
          through.push(throughName);
        } else {
          const reason = unsupportedReason(throughRow);
          if (reason) {
            throw new Error(`Through collection "${throughName}" cannot be transferred (${reason})`);
          }
          collections.push(throughName);
          pending.push(throughName);
        }
      }
    }

    return { collections: this.parentsFirst(collections, rowsByName), through, fieldRows };
  }

  /** Orders collections so that every parent of an inherited collection is created before its children. */
  private parentsFirst(collections: string[], rowsByName: Record<string, Row>) {
    const ordered: string[] = [];
    const visit = (name: string, trail: string[]) => {
      if (ordered.includes(name) || !collections.includes(name)) return;
      if (trail.includes(name)) throw new Error(`Inheritance cycle: ${[...trail, name].join(' → ')}`);
      for (const parent of lodash.castArray((rowsByName[name]?.inherits as string | string[]) || [])) {
        visit(parent, [...trail, name]);
      }
      ordered.push(name);
    };
    collections.forEach((name) => visit(name, []));
    return ordered;
  }

  /**
   * Storage id → name of the storages the records of file collections are in (records refer to storages by id; the
   * target matches them by name).
   */
  private async storageNames(collections: string[], rowsByName: Record<string, Row>, includeData: boolean) {
    const files = collections.filter((name) => templateOf(rowsByName[name]) === 'file');
    if (!includeData || !files.length || !this.db.hasCollection('storages')) return undefined;
    const used = new Set<string>();
    for (const name of files) {
      const rows = (await this.db.getCollection(name).model.findAll({
        attributes: ['storageId'],
        group: ['storageId'],
        raw: true,
      })) as unknown as Row[];
      rows.forEach((row) => row.storageId !== null && row.storageId !== undefined && used.add(String(row.storageId)));
    }
    if (!used.size) return undefined;
    const storages: Model[] = await this.db.getRepository('storages').find({ filter: { id: { $in: [...used] } } });
    return Object.fromEntries(storages.map((storage) => [String(storage.get('id')), String(storage.get('name'))]));
  }

  private buildPayloads(collections: string[], through: string[], rowsByName: Record<string, Row>, fieldRows: Row[]) {
    const inPackage = new Set([...collections, ...through]);
    const fieldsByCollection = lodash.groupBy(fieldRows, (field) => field.collectionName as string);
    const fieldsByKey = lodash.keyBy(fieldRows, (field) => field.key as string);

    // Key columns that NocoBase recreates on import from an exported relation (collection.column).
    const recreatedKeys = new Set<string>();
    for (const field of fieldRows) {
      const { type, foreignKey, otherKey, through, target } = field as Record<string, string>;
      if (!collections.includes(field.collectionName as string)) continue;
      if (type === 'belongsTo') recreatedKeys.add(`${field.collectionName}.${foreignKey}`);
      if (type === 'hasMany' || type === 'hasOne') recreatedKeys.add(`${target}.${foreignKey}`);
      if (type === 'belongsToMany') {
        recreatedKeys.add(`${through}.${foreignKey}`);
        recreatedKeys.add(`${through}.${otherKey}`);
      }
    }

    const collectionPayloads: CollectionPayload[] = collections.map((name) => {
      const row = rowsByName[name];
      const scalarFields = (fieldsByCollection[name] || [])
        // Key columns of exported relations are recreated by NocoBase on import, except a primary key that is also
        // used as a foreign key (e.g. a belongsTo with foreignKey "id"): without it the collection would have no key.
        // Other key columns (their relation was deleted, or lives outside the package) are plain columns.
        .filter(
          (field) =>
            !ASSOCIATION_TYPES.includes(field.type as string) &&
            (!field.isForeignKey || field.primaryKey || !recreatedKeys.has(`${name}.${field.name}`)),
        )
        .map((field) => this.fieldPayload(field));
      return {
        ...(lodash.omit(row, COLLECTION_BOOKKEEPING_KEYS) as Omit<CollectionPayload, 'fields'>),
        name,
        fields: scalarFields,
      };
    });

    const associationPayloads: AssociationPayload[] = [];
    const handledKeys = new Set<string>();
    const dependencies = new Set<string>();

    for (const name of collections) {
      for (const field of fieldsByCollection[name] || []) {
        if (!ASSOCIATION_TYPES.includes(field.type as string) || handledKeys.has(field.key as string)) continue;
        handledKeys.add(field.key as string);

        const target = field.target as string;
        if (!inPackage.has(target)) {
          dependencies.add(target);
        }

        const payload: AssociationPayload = {
          ...(this.fieldPayload(field) as FieldPayload),
          collectionName: name,
          target,
        };

        // One side per reverse pair; the other side is created by NocoBase from `reverseField`.
        const reverse = field.reverseKey ? fieldsByKey[field.reverseKey as string] : undefined;
        if (reverse && !handledKeys.has(reverse.key as string)) {
          handledKeys.add(reverse.key as string);
          payload.reverseField = this.fieldPayload(reverse);
        }

        associationPayloads.push(payload);
      }
    }

    return { collectionPayloads, associationPayloads, dependencies: [...dependencies].sort() };
  }

  private fieldPayload(field: Row): FieldPayload {
    return lodash.omit(field, FIELD_BOOKKEEPING_KEYS) as FieldPayload;
  }

  /** Adapted from plugin-backup-restore Dumper.dumpCollection: meta always, rows only when includeData. */
  private async dumpCollection(workDir: string, name: string, includeData: boolean) {
    const collection: Collection = this.db.getCollection(name);
    if (!collection) {
      throw new Error(`Collection "${name}" is not loaded`);
    }

    const dir = path.join(workDir, dataDir(name));
    await fsPromises.mkdir(dir, { recursive: true });

    const rawAttributes = collection.model.getAttributes();
    const columnToAttribute = new Map<string, string>();
    const columnToAttributes = new Map<string, string[]>();
    for (const [attributeName, attribute] of Object.entries(rawAttributes)) {
      if (isVirtual(attribute)) continue; // no column (e.g. computed or plugin helper attributes)
      const column = attribute.field || attributeName;
      columnToAttribute.set(column, attributeName);
      columnToAttributes.set(column, [...(columnToAttributes.get(column) || []), attributeName]);
    }
    const columns = [...columnToAttribute.keys()];

    const autoIncrementAttribute = Object.entries(rawAttributes).find(([, attribute]) => attribute.autoIncrement);

    let count = 0;
    if (includeData && columns.length) {
      const stream = fs.createWriteStream(path.join(dir, 'data'));
      // ONLY: on PostgreSQL a parent table would otherwise also return the rows of inherited collections.
      const only = this.db.inDialect('postgres') ? 'ONLY ' : '';
      const rows = await this.db.sequelize.query<Row>(`SELECT * FROM ${only}${collection.quotedTableName()}`, {
        type: QueryTypes.SELECT,
      });
      for (const row of rows) {
        const values = columns.map((column) => {
          const field = collection.getField(columnToAttribute.get(column));
          return field ? FieldValueWriter.toDumpedValue(field, row[column]) : row[column];
        });
        stream.write(JSON.stringify(values) + '\n', 'utf8');
      }
      stream.end();
      await finished(stream);
      count = rows.length;
    }

    const meta: DataMeta = {
      name,
      columns,
      count,
      autoIncrementColumn: autoIncrementAttribute ? autoIncrementAttribute[1].field || autoIncrementAttribute[0] : null,
      // Column → field name, so the target can map columns when its naming differs (e.g. DB_UNDERSCORED).
      attributes: Object.fromEntries(columns.map((column) => [column, columnToAttribute.get(column)])),
      aliases: Object.fromEntries([...columnToAttributes].filter(([, names]) => names.length > 1)),
    };
    await fsPromises.writeFile(path.join(dir, 'meta'), JSON.stringify(meta), 'utf8');
  }

  private async writeJson(workDir: string, relativePath: string, value: unknown) {
    await fsPromises.writeFile(path.join(workDir, relativePath), JSON.stringify(value, null, 2), 'utf8');
  }

  private async zipDir(dir: string, filePath: string) {
    const output = fs.createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const closed = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('warning', (err) => {
        if (err.code !== 'ENOENT') reject(err);
      });
      archive.on('error', reject);
    });
    archive.pipe(output);
    archive.directory(dir, false);
    await archive.finalize();
    await closed;
  }
}
