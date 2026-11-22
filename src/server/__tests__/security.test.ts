import archiver from 'archiver';
import fs from 'fs';
import fsPromises from 'fs/promises';
import { MockServer } from '@nocobase/test';
import os from 'os';
import path from 'path';
import { CollectionExporter } from '../exporter';
import { CollectionImporter, ImportBlockedError } from '../importer';
import { COLLECTIONS_FILE, MANIFEST_FILE } from '../package-format';
import { createApp, createProjectSchema } from './helpers';

type Row = Record<string, unknown>;

describe('import security', () => {
  let target: MockServer;
  let zipPath: string;

  beforeEach(async () => {
    const source = await createApp();
    await createProjectSchema(source.db);
    zipPath = (
      await new CollectionExporter(source).export({ collections: ['projects', 'tasks', 'tags'], includeData: false })
    ).filePath;
    await source.destroy();
    target = await createApp();
  });

  afterEach(async () => {
    await target?.destroy();
    await fsPromises.rm(zipPath, { force: true });
  });

  async function tampered(change: (dir: string) => Promise<void>) {
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    await change(path.join(CollectionImporter.uploadDir(), token));
    return { importer, token };
  }

  async function rewrite(file: string, change: (value: any) => void) {
    const value = JSON.parse(await fsPromises.readFile(file, 'utf8'));
    change(value);
    await fsPromises.writeFile(file, JSON.stringify(value));
  }

  it('never treats a system collection as a conflict that could be overridden', async () => {
    // Rename the package's "tags" to "users" (an existing system collection here).
    const { importer, token } = await tampered(async (dir) => {
      await rewrite(path.join(dir, MANIFEST_FILE), (m) => {
        m.collections = m.collections.map((n: string) => (n === 'tags' ? 'users' : n));
      });
      await rewrite(path.join(dir, COLLECTIONS_FILE), (c: Row[]) => {
        c.forEach((x) => x.name === 'tags' && (x.name = 'users'));
      });
      await fsPromises.mkdir(path.join(dir, 'data/users'), { recursive: true });
      const meta = JSON.parse(await fsPromises.readFile(path.join(dir, 'data/tags/meta'), 'utf8'));
      await fsPromises.writeFile(path.join(dir, 'data/users/meta'), JSON.stringify({ ...meta, name: 'users' }));
    });

    const preview = await importer.preview(token);
    expect(preview.conflicts.map((c) => c.name)).not.toContain('users');
    expect(preview.problems).toContainEqual({ code: 'systemCollection', collection: 'users' });
    await expect(importer.import(token, { resolutions: { users: 'overrideAll' } })).rejects.toBeInstanceOf(
      ImportBlockedError,
    );
    expect(target.db.getCollection('users')).toBeTruthy();
    expect(await target.db.getRepository('users').count()).toBeGreaterThan(0);
  });

  it('refuses an existing table that is not the junction of the owning relation', async () => {
    // Claim the system junction "rolesUsers" as the package's junction table.
    const { importer, token } = await tampered(async (dir) => {
      const manifestPath = path.join(dir, MANIFEST_FILE);
      const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
      const through = manifest.through[0];
      manifest.through = ['rolesUsers'];
      await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));
      await fsPromises.writeFile(path.join(dir, 'schema/through.json'), JSON.stringify(['rolesUsers']));
      await rewrite(path.join(dir, 'schema/associations.json'), (a: Row[]) => {
        a.forEach((x) => x.through === through && (x.through = 'rolesUsers'));
      });
      await fsPromises.mkdir(path.join(dir, 'data/rolesUsers'), { recursive: true });
      const meta = JSON.parse(await fsPromises.readFile(path.join(dir, `data/${through}/meta`), 'utf8'));
      await fsPromises.writeFile(
        path.join(dir, 'data/rolesUsers/meta'),
        JSON.stringify({ ...meta, name: 'rolesUsers' }),
      );
    });

    const preview = await importer.preview(token);
    expect(preview.problems).toContainEqual({ code: 'collectionExists', collection: 'rolesUsers' });
    await expect(importer.import(token)).rejects.toBeInstanceOf(ImportBlockedError);
  });

  it('refuses relation fields hidden among the plain fields of a collection', async () => {
    const { importer, token } = await tampered(async (dir) => {
      await rewrite(path.join(dir, COLLECTIONS_FILE), (c: Row[]) => {
        (c[0].fields as Row[]).push({ name: 'owners', type: 'hasMany', target: 'users', foreignKey: 'evilProjectId' });
      });
    });
    const preview = await importer.preview(token);
    expect(preview.problems).toContainEqual({
      code: 'outsidePackage',
      collection: 'projects',
      field: 'owners',
      detail: 'relation fields are only allowed in associations.json',
    });
    await expect(importer.import(token)).rejects.toBeInstanceOf(ImportBlockedError);
    const usersColumns = await target.db.sequelize.getQueryInterface().describeTable('users');
    expect(Object.keys(usersColumns)).not.toContain('evilProjectId');
  });

  it('refuses raw options objects that would bypass the checks on top-level keys', async () => {
    const { importer, token } = await tampered(async (dir) => {
      await rewrite(path.join(dir, COLLECTIONS_FILE), (c: Row[]) => {
        c[0].options = { tableName: 'users' };
        (c[1].fields as Row[]).push({ name: 'sneaky', type: 'string', options: { target: 'users' } });
        // A relation type without any relation keys is still recognised by its field class.
        (c[2].fields as Row[]).push({ name: 'bare', type: 'belongsTo' });
      });
    });
    const preview = await importer.preview(token);
    const outside = preview.problems
      .filter((p) => p.code === 'outsidePackage')
      .map((p) => `${p.collection}:${p.field ?? ''}:${p.detail}`);
    expect(outside).toEqual(
      expect.arrayContaining([
        'projects::raw "options" is not allowed',
        'tasks:sneaky:raw "options" is not allowed',
        'tags:bare:relation fields are only allowed in associations.json',
      ]),
    );
    await expect(importer.import(token)).rejects.toBeInstanceOf(ImportBlockedError);
  });

  it('refuses archive entries beyond the size limit', async () => {
    const original = { ...CollectionImporter.limits };
    CollectionImporter.limits = { ...original, maxEntryBytes: 64 };
    try {
      await expect(new CollectionImporter(target).receive(zipPath)).rejects.toThrow(/Package refused/);
    } finally {
      CollectionImporter.limits = original;
    }
  });

  it('stops an import at a data row larger than the row limit, leaving nothing behind', async () => {
    const { importer, token } = await tampered(async (dir) => {
      await rewrite(path.join(dir, MANIFEST_FILE), (m) => {
        m.includeData = true;
      });
      const metaPath = path.join(dir, 'data/tags/meta');
      const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
      await fsPromises.writeFile(metaPath, JSON.stringify({ ...meta, count: 1 }));
      await fsPromises.writeFile(path.join(dir, 'data/tags/data'), JSON.stringify(['x'.repeat(5000)]) + '\n');
    });
    const original = { ...CollectionImporter.limits };
    CollectionImporter.limits = { ...original, maxRowBytes: 1024 };
    try {
      await expect(importer.import(token)).rejects.toThrow(/larger than the allowed row size/);
    } finally {
      CollectionImporter.limits = original;
    }
    expect(target.db.hasCollection('tags')).toBe(false);
  });

  it('refuses archives that expand far beyond their size before extracting them', async () => {
    const original = { ...CollectionImporter.limits };
    CollectionImporter.limits = { ...original, ratioCheckBytes: 1024 * 1024, maxCompressionRatio: 10 };
    const bomb = path.join(os.tmpdir(), `bomb-${Date.now()}.zip`);
    try {
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(bomb);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve());
        archive.on('error', reject);
        archive.pipe(output);
        archive.append(Buffer.alloc(4 * 1024 * 1024), { name: 'data/projects/data' });
        archive.append('{}', { name: MANIFEST_FILE });
        archive.finalize();
      });
      await expect(new CollectionImporter(target).receive(bomb)).rejects.toThrow(/suspiciously compressed/);
    } finally {
      CollectionImporter.limits = original;
      await fsPromises.rm(bomb, { force: true });
    }
  });
});
