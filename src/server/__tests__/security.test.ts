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
