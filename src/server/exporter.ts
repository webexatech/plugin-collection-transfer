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
  DataMeta,
  FIELD_BOOKKEEPING_KEYS,
  FieldPayload,
  FORMAT_VERSION,
  isValidName,
  Manifest,
  MANIFEST_FILE,
  MIRRORED_ORIGINS,
  SUPPORTED_TEMPLATES,
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
  const template = (row.template as string) || 'general';
  if (!SUPPORTED_TEMPLATES.includes(template)) {
    return `template:${template}`;
  }
  if (!lodash.isEmpty(row.inherits)) {
    return 'inherits';
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
    const rows = await this.collectionRows();
    return rows.filter(isUserCollection).map((row) => {
      const reason = unsupportedReason(row);
      return {
        name: row.name as string,
        title: (row.title as string) || (row.name as string),
        template: (row.template as string) || 'general',
        supported: !reason,
        unsupportedReason: reason,
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
      };

      await this.writeJson(workDir, COLLECTIONS_FILE, collectionPayloads);
      await this.writeJson(workDir, ASSOCIATIONS_FILE, associationPayloads);
      await this.writeJson(workDir, THROUGH_FILE, through);

      for (const name of [...collections, ...through]) {
        await this.dumpCollection(workDir, name, manifest.includeData);
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
    const models: Model[] = await this.db.getRepository('collections').find({ sort: ['sort'] });
    return models.map((model) => model.get() as Row);
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
      const rows = await this.fieldRowsOf(pending);
      fieldRows.push(...rows);
      pending = [];

      for (const field of rows) {
        if (field.type !== 'belongsToMany' || !field.through) continue;
        const throughName = field.through as string;
        if (collections.includes(throughName) || through.includes(throughName)) continue;

        const throughRow = rowsByName[throughName];
        if (!throughRow) {
          throw new Error(
            `Through collection "${throughName}" of field "${field.collectionName}.${field.name}" not found`,
          );
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

    return { collections, through, fieldRows };
  }

  private buildPayloads(collections: string[], through: string[], rowsByName: Record<string, Row>, fieldRows: Row[]) {
    const inPackage = new Set([...collections, ...through]);
    const fieldsByCollection = lodash.groupBy(fieldRows, (field) => field.collectionName as string);
    const fieldsByKey = lodash.keyBy(fieldRows, (field) => field.key as string);

    const collectionPayloads: CollectionPayload[] = collections.map((name) => {
      const row = rowsByName[name];
      const scalarFields = (fieldsByCollection[name] || [])
        .filter((field) => !ASSOCIATION_TYPES.includes(field.type as string) && !field.isForeignKey)
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
    for (const [attributeName, attribute] of Object.entries(rawAttributes)) {
      columnToAttribute.set(attribute.field || attributeName, attributeName);
    }
    const columns = [...columnToAttribute.keys()];

    const autoIncrementAttribute = Object.entries(rawAttributes).find(([, attribute]) => attribute.autoIncrement);

    let count = 0;
    if (includeData && columns.length) {
      const stream = fs.createWriteStream(path.join(dir, 'data'));
      const rows = await this.db.sequelize.query<Row>(`SELECT * FROM ${collection.quotedTableName()}`, {
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
