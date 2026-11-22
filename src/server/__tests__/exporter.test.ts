import { Database } from '@nocobase/database';
import { MockServer } from '@nocobase/test';
import fsPromises from 'fs/promises';
import { CollectionExporter } from '../exporter';
import {
  ASSOCIATIONS_FILE,
  AssociationPayload,
  COLLECTIONS_FILE,
  CollectionPayload,
  DataMeta,
  Manifest,
  MANIFEST_FILE,
  THROUGH_FILE,
} from '../package-format';
import { createApp, createProjectSchema, openPackage } from './helpers';

describe('collection exporter', () => {
  let app: MockServer;
  let db: Database;
  let exporter: CollectionExporter;
  let throughName: string;

  beforeEach(async () => {
    app = await createApp();
    db = app.db;
    await createProjectSchema(db);
    exporter = new CollectionExporter(app);
    const tagsField = await db.getRepository('fields').findOne({ filter: { collectionName: 'tasks', name: 'tags' } });
    throughName = tagsField.get('through') as string;
  });

  afterEach(async () => {
    await app.destroy();
  });

  it('lists only user collections', async () => {
    const list = await exporter.listCollections();
    const names = list.map((item) => item.name).sort();
    expect(names).toEqual(['projects', 'tags', 'tasks']);
    // Relation targets among user collections (users is a system collection, so not listed).
    const related = Object.fromEntries(list.map((item) => [item.name, item.related]));
    expect(related).toEqual({ projects: ['tasks'], tasks: ['projects', 'tags'], tags: ['tasks'] });
    expect(list.every((item) => item.supported)).toBe(true);
  });

  it('exports schema in create-request shape', async () => {
    const result = await exporter.export({ collections: ['projects', 'tasks', 'tags'], includeData: false });
    const pkg = await openPackage(result.filePath);

    try {
      const manifest = await pkg.json<Manifest>(MANIFEST_FILE);
      expect(manifest.formatVersion).toBe(1);
      expect(manifest.dialect).toBe(db.sequelize.getDialect());
      expect(manifest.collections).toEqual(['projects', 'tasks', 'tags']);
      expect(manifest.through).toEqual([throughName]);
      expect(manifest.dependencies).toEqual(['users']);
      expect(await pkg.json<string[]>(THROUGH_FILE)).toEqual([throughName]);

      const collections = await pkg.json<CollectionPayload[]>(COLLECTIONS_FILE);
      expect(collections.map((c) => c.name)).toEqual(['projects', 'tasks', 'tags']);
      const tasks = collections.find((c) => c.name === 'tasks');
      expect(tasks).toMatchObject({ title: 'Tasks', template: 'general', autoGenId: false });
      expect(tasks).not.toHaveProperty('key');
      expect(tasks).not.toHaveProperty('options');
      // Scalar fields only; FK columns created by association hooks are left out.
      expect(tasks.fields.map((f) => f.name).sort()).toEqual(['createdAt', 'dueDate', 'id', 'name', 'updatedAt']);
      for (const field of tasks.fields) {
        expect(field).not.toHaveProperty('key');
        expect(field).not.toHaveProperty('collectionName');
        expect(field).not.toHaveProperty('options');
      }
      expect(tasks.fields.find((f) => f.name === 'id')).toMatchObject({ type: 'snowflakeId', primaryKey: true });

      const associations = await pkg.json<AssociationPayload[]>(ASSOCIATIONS_FILE);
      // createdBy + updatedBy per collection, plus one payload per reverse pair.
      expect(associations).toHaveLength(8);
      for (const association of associations) {
        expect(association).not.toHaveProperty('key');
        expect(association).not.toHaveProperty('reverseKey');
      }

      const projectPair = associations.find((a) => a.collectionName === 'projects' && a.name === 'tasks');
      expect(projectPair).toMatchObject({ type: 'hasMany', target: 'tasks', foreignKey: 'projectId' });
      expect(projectPair.reverseField).toMatchObject({ name: 'project', type: 'belongsTo', foreignKey: 'projectId' });
      expect(associations.find((a) => a.collectionName === 'tasks' && a.name === 'project')).toBeUndefined();

      const tagsPair = associations.find((a) => a.collectionName === 'tasks' && a.name === 'tags');
      expect(tagsPair).toMatchObject({ type: 'belongsToMany', target: 'tags', through: throughName });
      expect(tagsPair.foreignKey).toMatch(/^f_/);
      expect(tagsPair.otherKey).toMatch(/^f_/);
      expect(tagsPair.reverseField).toMatchObject({ name: 'tasks', type: 'belongsToMany', through: throughName });

      // Meta is written for every collection (column check on import); rows only with includeData.
      for (const name of [...manifest.collections, ...manifest.through]) {
        const meta = await pkg.json<DataMeta>(`data/${name}/meta`);
        expect(meta.columns.length).toBeGreaterThan(0);
        expect(await pkg.exists(`data/${name}/data`)).toBe(false);
      }
      const throughMeta = await pkg.json<DataMeta>(`data/${throughName}/meta`);
      expect(throughMeta.columns).toEqual(expect.arrayContaining([tagsPair.foreignKey, tagsPair.otherKey]));
    } finally {
      await pkg.cleanup();
      await fsPromises.rm(result.filePath, { force: true });
    }
  });

  it('exports rows with includeData', async () => {
    const project = await db.getRepository('projects').create({ values: { title: 'Website', status: 'open' } });
    const tag = await db.getRepository('tags').create({ values: { label: 'urgent' } });
    await db.getRepository('tasks').create({
      values: { name: 'Design', projectId: project.get('id'), tags: [tag.get('id')] },
    });

    const result = await exporter.export({ collections: ['projects', 'tasks', 'tags'], includeData: true });
    const pkg = await openPackage(result.filePath);

    try {
      const taskMeta = await pkg.json<DataMeta>('data/tasks/meta');
      expect(taskMeta.count).toBe(1);
      const [taskRow] = await pkg.lines('data/tasks/data');
      const record = Object.fromEntries(taskMeta.columns.map((column, index) => [column, taskRow[index]]));
      expect(record).toMatchObject({ name: 'Design', projectId: project.get('id') });

      const throughMeta = await pkg.json<DataMeta>(`data/${throughName}/meta`);
      expect(throughMeta.count).toBe(1);
    } finally {
      await pkg.cleanup();
      await fsPromises.rm(result.filePath, { force: true });
    }
  });

  it('expands the selection with a user-defined through collection', async () => {
    await db.getRepository('collections').create({
      values: { name: 'members', title: 'Members', fields: [{ name: 'role', type: 'string', interface: 'input' }] },
      context: {},
    });
    await db.getRepository('fields').create({
      values: {
        collectionName: 'projects',
        name: 'people',
        type: 'belongsToMany',
        interface: 'm2m',
        target: 'users',
        through: 'members',
        foreignKey: 'projectId',
        otherKey: 'userId',
      },
      context: {},
    });

    const result = await exporter.export({ collections: ['projects'], includeData: false });
    try {
      expect(result.manifest.collections).toEqual(['projects', 'members']);
      // `tasks` is the target of projects.tasks (hasMany) and was not selected.
      expect(result.manifest.dependencies).toEqual(['tasks', 'users']);
    } finally {
      await fsPromises.rm(result.filePath, { force: true });
    }
  });

  it('refuses system and unsupported collections', async () => {
    await expect(exporter.export({ collections: ['users'], includeData: false })).rejects.toThrow(
      /not a user collection/,
    );
    await expect(exporter.export({ collections: [], includeData: false })).rejects.toThrow(/No collections selected/);
  });

  it('serves list and export through the API for admins only', async () => {
    await app.destroy();
    app = await createApp({ acl: true });
    db = app.db;
    await createProjectSchema(db);

    const admin = await db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const adminAgent = await app.agent().login(admin);

    const list = await adminAgent.resource('collectionTransfer').listCollections();
    expect(list.status).toBe(200);
    expect(list.body.data.map((item: { name: string }) => item.name).sort()).toEqual(['projects', 'tags', 'tasks']);

    const exported = await adminAgent
      .post('/collectionTransfer:export')
      .send({ collections: ['projects'], includeData: false });
    expect(exported.status).toBe(200);
    // No data travels in headers (large headers make reverse proxies answer 502).
    expect(exported.headers['x-collection-transfer-manifest']).toBeUndefined();
    const { token, fileName, manifest } = exported.body.data;
    expect(fileName).toMatch(/^collections-.*\.zip$/);
    expect(manifest.collections).toEqual(['projects']);
    expect(manifest).not.toHaveProperty('plugins');

    const download = await adminAgent.get('/collectionTransfer:download').query({ token });
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/collections-.*\.zip/);
    // A prepared file can be downloaded once.
    expect((await adminAgent.get('/collectionTransfer:download').query({ token })).status).toBe(404);
    expect((await adminAgent.get('/collectionTransfer:download').query({ token: '../../etc' })).status).toBe(400);

    const member = await db.getRepository('users').create({ values: { nickname: 'member', roles: ['member'] } });
    const memberAgent = await app.agent().login(member);
    const denied = await memberAgent.resource('collectionTransfer').listCollections();
    expect(denied.status).toBe(403);
  });
});
