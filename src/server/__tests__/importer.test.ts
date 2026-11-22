import { Database } from '@nocobase/database';
import { createMockServer, MockServer } from '@nocobase/test';
import fsPromises from 'fs/promises';
import path from 'path';
import { QueryTypes } from 'sequelize';
import { CollectionExporter } from '../exporter';
import { CollectionImporter, ImportBlockedError } from '../importer';
import { ASSOCIATIONS_FILE, COLLECTIONS_FILE, MANIFEST_FILE } from '../package-format';
import { createApp, createGeneralCollection, createProjectSchema, openPackage, TEST_PLUGINS } from './helpers';

type Row = Record<string, unknown>;

async function exportFrom(app: MockServer, collections: string[], includeData: boolean) {
  const result = await new CollectionExporter(app).export({ collections, includeData });
  return result.filePath;
}

async function receive(app: MockServer, zipPath: string) {
  const importer = new CollectionImporter(app);
  const token = await importer.receive(zipPath);
  return { importer, token };
}

async function seedProjects(db: Database) {
  const project = await db.getRepository('projects').create({ values: { title: 'Website', status: 'open' } });
  const urgent = await db.getRepository('tags').create({ values: { label: 'urgent' } });
  const later = await db.getRepository('tags').create({ values: { label: 'later' } });
  await db.getRepository('tasks').create({
    values: {
      name: 'Design',
      dueDate: '2026-12-01T00:00:00.000Z',
      projectId: project.get('id'),
      tags: [urgent.get('id')],
    },
  });
  await db.getRepository('tasks').create({
    values: { name: 'Build', projectId: project.get('id'), tags: [urgent.get('id'), later.get('id')] },
  });
}

async function fieldSnapshot(db: Database, collectionName: string) {
  const fields = await db.getRepository('fields').find({ filter: { collectionName }, sort: ['name'] });
  return fields.map((field) => {
    const { key, sort, reverseKey, collectionName: _c, ...rest } = field.get() as Row;
    // When a belongsTo is recreated as the reverse side of a hasMany, NocoBase's reverse-field hook fills in
    // `sourceKey`; Sequelize's belongsTo does not use it (it joins on foreignKey -> targetKey), so it is ignored.
    if (rest.type === 'belongsTo') delete rest.sourceKey;
    return { ...rest, hasReverse: !!reverseKey };
  });
}

async function foreignKeyConstraints(db: Database, tables: string[]) {
  const rows = await db.sequelize.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.table_constraints
     WHERE constraint_type = 'FOREIGN KEY' AND table_schema = current_schema() AND table_name IN (:tables)`,
    { replacements: { tables }, type: QueryTypes.SELECT },
  );
  return rows.map((row) => row.table_name);
}

describe('collection importer', () => {
  let source: MockServer;
  let target: MockServer;
  let zipPath: string;
  let throughName: string;
  let sourceFields: Record<string, unknown[]>;

  // Source and target never share a database at the same time: build in source, export, destroy it, then start a
  // freshly installed target on the same test database.
  async function buildSourceAndExport(collections: string[], includeData: boolean) {
    source = await createApp();
    await createProjectSchema(source.db);
    await seedProjects(source.db);
    const tagsField = await source.db
      .getRepository('fields')
      .findOne({ filter: { collectionName: 'tasks', name: 'tags' } });
    throughName = tagsField.get('through') as string;
    sourceFields = {};
    for (const name of ['projects', 'tasks', 'tags', throughName]) {
      sourceFields[name] = await fieldSnapshot(source.db, name);
    }
    zipPath = await exportFrom(source, collections, includeData);
    await source.destroy();
    source = null;
  }

  afterEach(async () => {
    await source?.destroy();
    await target?.destroy();
    source = null;
    target = null;
    if (zipPath) await fsPromises.rm(zipPath, { force: true });
    zipPath = null;
  });

  it('round-trips schema and data into a fresh environment', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], true);
    target = await createApp();
    const db = target.db;

    const { importer, token } = await receive(target, zipPath);
    const preview = await importer.preview(token);
    expect(preview.problems).toEqual([]);
    expect(preview.collections.map((c) => c.name)).toEqual(['projects', 'tasks', 'tags', throughName]);
    expect(preview.collections.find((c) => c.name === 'tasks').rowCount).toBe(2);

    const result = await importer.import(token);
    expect(result.rowCounts).toMatchObject({ projects: 1, tasks: 2, tags: 2, [throughName]: 3 });

    // Same field definitions (options, uiSchema, generated names, reverse links) as in the source.
    for (const name of ['projects', 'tasks', 'tags', throughName]) {
      expect(await fieldSnapshot(db, name)).toEqual(sourceFields[name]);
    }

    const tasks = await db.getRepository('tasks').find({ appends: ['project', 'tags'], sort: ['name'] });
    expect(tasks.map((t) => t.get('name'))).toEqual(['Build', 'Design']);
    expect(tasks[0].get('project').get('title')).toBe('Website');
    expect(
      tasks[0]
        .get('tags')
        .map((t) => t.get('label'))
        .sort(),
    ).toEqual(['later', 'urgent']);
    const project = await db.getRepository('projects').findOne({ appends: ['tasks'] });
    expect(project.get('tasks')).toHaveLength(2);

    // New rows still work after import (snowflake ids, relations).
    const created = await db.getRepository('tasks').create({ values: { name: 'Ship', projectId: project.get('id') } });
    expect(created.get('id')).toBeTruthy();

    // NocoBase associations do not create database FK constraints; data insert order relies on it.
    expect(await foreignKeyConstraints(db, ['projects', 'tasks', 'tags', throughName])).toEqual([]);
  });

  it('round-trips one-to-one, self-reference and an explicit through collection', async () => {
    source = await createApp();
    const sdb = source.db;
    await createGeneralCollection(sdb, 'people', 'People', [{ name: 'fullName', type: 'string', interface: 'input' }]);
    await createGeneralCollection(sdb, 'passports', 'Passports', [
      { name: 'number', type: 'string', interface: 'input' },
    ]);
    await createGeneralCollection(sdb, 'teams', 'Teams', [{ name: 'label', type: 'string', interface: 'input' }]);
    await createGeneralCollection(sdb, 'memberships', 'Memberships', [
      { name: 'role', type: 'string', interface: 'input' },
    ]);
    const field = (values: Row) =>
      sdb.getRepository('fields').create({ values, updateAssociationValues: ['reverseField'], context: {} });
    // one-to-one
    await field({
      collectionName: 'people',
      name: 'passport',
      type: 'hasOne',
      interface: 'oho',
      target: 'passports',
      foreignKey: 'personId',
      reverseField: { name: 'person', interface: 'obo' },
    });
    // self-reference
    await field({
      collectionName: 'people',
      name: 'manager',
      type: 'belongsTo',
      interface: 'm2o',
      target: 'people',
      foreignKey: 'managerId',
      reverseField: { name: 'reports', interface: 'o2m' },
    });
    // explicit through collection
    await field({
      collectionName: 'people',
      name: 'teams',
      type: 'belongsToMany',
      interface: 'm2m',
      target: 'teams',
      through: 'memberships',
      foreignKey: 'personId',
      otherKey: 'teamId',
      reverseField: { name: 'people', interface: 'm2m' },
    });

    const boss = await sdb.getRepository('people').create({ values: { fullName: 'Boss' } });
    const team = await sdb.getRepository('teams').create({ values: { label: 'Core' } });
    await sdb.getRepository('people').create({
      values: { fullName: 'Ana', managerId: boss.get('id'), passport: { number: 'X1' }, teams: [team.get('id')] },
    });
    const snapshots: Record<string, unknown[]> = {};
    for (const name of ['people', 'passports', 'teams', 'memberships'])
      snapshots[name] = await fieldSnapshot(sdb, name);

    zipPath = await exportFrom(source, ['people', 'passports', 'teams'], true);
    await source.destroy();
    source = null;

    target = await createApp();
    const { importer, token } = await receive(target, zipPath);
    const preview = await importer.preview(token);
    expect(preview.problems).toEqual([]);
    expect(preview.manifest.collections).toEqual(['people', 'passports', 'teams', 'memberships']);
    await importer.import(token);

    for (const name of ['people', 'passports', 'teams', 'memberships']) {
      expect(await fieldSnapshot(target.db, name)).toEqual(snapshots[name]);
    }
    const ana = await target.db
      .getRepository('people')
      .findOne({ filter: { fullName: 'Ana' }, appends: ['manager', 'passport', 'teams'] });
    expect(ana.get('manager').get('fullName')).toBe('Boss');
    expect(ana.get('passport').get('number')).toBe('X1');
    expect(ana.get('teams').map((t) => t.get('label'))).toEqual(['Core']);
    const bossInTarget = await target.db
      .getRepository('people')
      .findOne({ filter: { fullName: 'Boss' }, appends: ['reports'] });
    expect(bossInTarget.get('reports')).toHaveLength(1);
  });

  it('produces the same package when re-exported from the target', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], false);
    const original = await openPackage(zipPath);
    target = await createApp();
    const { importer, token } = await receive(target, zipPath);
    await importer.import(token);

    const reExported = await openPackage(await exportFrom(target, ['projects', 'tasks', 'tags'], false));
    // Same normalisation as fieldSnapshot: `sourceKey` on a belongsTo is filled in by the reverse-field hook and unused.
    const withoutBelongsToSourceKey = (associations: Row[]) =>
      associations.map((a) => {
        const strip = (f: Row) =>
          f.type === 'belongsTo' ? Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'sourceKey')) : f;
        return a.reverseField ? { ...strip(a), reverseField: strip(a.reverseField as Row) } : strip(a);
      });
    try {
      expect(await reExported.json(COLLECTIONS_FILE)).toEqual(await original.json(COLLECTIONS_FILE));
      expect(withoutBelongsToSourceKey(await reExported.json<Row[]>(ASSOCIATIONS_FILE))).toEqual(
        withoutBelongsToSourceKey(await original.json<Row[]>(ASSOCIATIONS_FILE)),
      );
    } finally {
      await original.cleanup();
      await reExported.cleanup();
    }
  });

  it('loads imported collections after a restart', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], true);
    target = await createApp();
    const { importer, token } = await receive(target, zipPath);
    await importer.import(token);
    await target.destroy();

    target = await createMockServer({ plugins: TEST_PLUGINS, skipInstall: true });
    const tasks = await target.db.getRepository('tasks').find({ appends: ['project', 'tags'] });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.get('project'))).toBe(true);
  });

  it('continues a serial primary key sequence after import', async () => {
    source = await createApp();
    await source.db.getRepository('collections').create({
      values: { name: 'counters', title: 'Counters', fields: [{ name: 'label', type: 'string', interface: 'input' }] },
      context: {},
    });
    await source.db.getRepository('collections').create({
      values: { name: 'empties', title: 'Empties', fields: [{ name: 'label', type: 'string', interface: 'input' }] },
      context: {},
    });
    for (const label of ['a', 'b', 'c']) {
      await source.db.getRepository('counters').create({ values: { label } });
    }
    zipPath = await exportFrom(source, ['counters', 'empties'], true);
    await source.destroy();
    source = null;

    target = await createApp();
    const { importer, token } = await receive(target, zipPath);
    const result = await importer.import(token);
    expect(result.rowCounts).toMatchObject({ counters: 3, empties: 0 });

    const next = await target.db.getRepository('counters').create({ values: { label: 'd' } });
    expect(Number(next.get('id'))).toBe(4);
    const first = await target.db.getRepository('empties').create({ values: { label: 'x' } });
    expect(Number(first.get('id'))).toBe(1);
  });

  it('blocks in preview without writing anything', async () => {
    await buildSourceAndExport(['tasks'], false);
    target = await createApp();
    await createGeneralCollection(target.db, 'tasks', 'Existing tasks');

    const { importer, token } = await receive(target, zipPath);
    const preview = await importer.preview(token);
    const codes = preview.problems.map((p) => `${p.code}:${p.collection}`);
    // An existing collection is a conflict to resolve, not a problem.
    expect(preview.conflicts.map((c) => c.name)).toEqual(['tasks']);
    expect(codes).not.toContain('collectionExists:tasks');
    // tasks references projects and tags, which were not exported and do not exist here.
    expect(codes).toContain('missingDependency:projects');
    expect(codes).toContain('missingDependency:tags');
    expect(codes).not.toContain('missingDependency:users');

    await expect(importer.import(token)).rejects.toBeInstanceOf(ImportBlockedError);
    expect(target.db.hasCollection('projects')).toBe(false);
  });

  it('blocks an existing table and an unknown field type', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], false);
    target = await createApp();
    await target.db.sequelize.query('CREATE TABLE "projects" (id integer)');

    const { importer, token } = await receive(target, zipPath);
    const dir = path.join(CollectionImporter.uploadDir(), token);
    const collectionsPath = path.join(dir, COLLECTIONS_FILE);
    const collections = JSON.parse(await fsPromises.readFile(collectionsPath, 'utf8'));
    collections[2].fields.push({ name: 'weird', type: 'notAFieldType', interface: 'input' });
    await fsPromises.writeFile(collectionsPath, JSON.stringify(collections));

    const preview = await importer.preview(token);
    const codes = preview.problems.map((p) => `${p.code}:${p.collection}`);
    expect(codes).toContain('tableExists:projects');
    expect(codes).toContain('unknownFieldType:tags');
    await target.db.sequelize.query('DROP TABLE "projects"');
  });

  it('reports field interfaces and plugins missing here, and blocks unsafe expressions', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], false);
    target = await createApp();
    const { importer, token } = await receive(target, zipPath);

    const clean = await importer.preview(token);
    expect(clean.manifest.plugins).toEqual(expect.arrayContaining(['@nocobase/plugin-data-source-main']));
    expect(clean.missingPlugins).toEqual([]);
    expect(clean.interfaces).toEqual(
      expect.arrayContaining([
        { interface: 'select', collection: 'projects', field: 'status' },
        { interface: 'm2o', collection: 'tasks', field: 'project' },
        { interface: 'o2m', collection: 'projects', field: 'tasks' },
      ]),
    );

    const dir = path.join(CollectionImporter.uploadDir(), token);
    const manifestPath = path.join(dir, MANIFEST_FILE);
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    manifest.plugins.push('@nocobase/plugin-field-code');
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest));
    const collectionsPath = path.join(dir, COLLECTIONS_FILE);
    const collections = JSON.parse(await fsPromises.readFile(collectionsPath, 'utf8'));
    collections[0].title = '{{ alert(document.cookie) }}';
    await fsPromises.writeFile(collectionsPath, JSON.stringify(collections));

    const tampered = await importer.preview(token);
    expect(tampered.missingPlugins).toEqual(['@nocobase/plugin-field-code']);
    expect(tampered.problems).toContainEqual({
      code: 'unsafeExpression',
      collection: 'projects',
      detail: '{{ alert(document.cookie) }}',
    });
    await expect(importer.import(token)).rejects.toBeInstanceOf(ImportBlockedError);
  });

  it('refuses packages that would change collections or tables outside the package', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], true);
    target = await createApp();
    const { importer, token } = await receive(target, zipPath);
    const dir = path.join(CollectionImporter.uploadDir(), token);
    const rewrite = async (file: string, change: (value: Row[]) => void) => {
      const filePath = path.join(dir, file);
      const value = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      change(value);
      await fsPromises.writeFile(filePath, JSON.stringify(value));
    };

    expect((await importer.preview(token)).problems).toEqual([]);

    await rewrite(COLLECTIONS_FILE, (collections) => {
      collections[0].tableName = 'users'; // projects -> existing users table
      collections[1].isThrough = true; // would bypass the "already exists" check
    });
    await rewrite(ASSOCIATIONS_FILE, (associations) => {
      associations.push({
        collectionName: 'users',
        name: 'evil',
        type: 'belongsTo',
        target: 'projects',
        foreignKey: 'evilId',
      });
      associations.push({
        collectionName: 'projects',
        name: 'owners',
        type: 'hasMany',
        target: 'users',
        foreignKey: 'projectRef',
      });
      associations.push({
        collectionName: 'tags',
        name: 'roles',
        type: 'belongsToMany',
        target: 'roles',
        through: 'rolesUsers',
      });
    });

    const preview = await importer.preview(token);
    const outside = preview.problems
      .filter((p) => p.code === 'outsidePackage')
      .map((p) => `${p.collection}:${p.detail}`);
    expect(outside).toEqual(
      expect.arrayContaining([
        'projects:option "tableName" is not allowed',
        'tasks:option "isThrough" is not allowed',
        'users:adds a field to a collection that is not in the package',
        'projects:would add a key column to "users"',
        'tags:target "roles" is neither in the package nor a declared dependency',
        'tags:junction table "rolesUsers" is not in the package',
      ]),
    );
    await expect(importer.import(token)).rejects.toBeInstanceOf(ImportBlockedError);
    const usersTable = await target.db.sequelize.getQueryInterface().describeTable('users');
    expect(Object.keys(usersTable)).not.toContain('evilId');
    expect(target.db.hasCollection('projects')).toBe(false);
  });

  it('refuses a data meta that points rows at another table', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], true);
    target = await createApp();
    const usersBefore = await target.db.getRepository('users').count();
    const { importer, token } = await receive(target, zipPath);
    const dir = path.join(CollectionImporter.uploadDir(), token);

    // data/projects/meta claims to describe "users", and a data/users/data file carries rows for it.
    const metaPath = path.join(dir, 'data/projects/meta');
    const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
    await fsPromises.writeFile(
      metaPath,
      JSON.stringify({ ...meta, name: 'users', columns: ['id', 'nickname'], count: 1 }),
    );
    await fsPromises.mkdir(path.join(dir, 'data/users'), { recursive: true });
    await fsPromises.writeFile(path.join(dir, 'data/users/data'), `${JSON.stringify([999, 'injected'])}\n`);

    const preview = await importer.preview(token);
    expect(preview.problems).toContainEqual({ code: 'invalidPackage', collection: 'projects', detail: 'meta missing' });
    await expect(importer.import(token)).rejects.toBeInstanceOf(ImportBlockedError);
    expect(await target.db.getRepository('users').count()).toBe(usersBefore);
  });

  it('rolls back completely on failure and can be retried', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], true);
    target = await createApp();
    const db = target.db;
    const { importer, token } = await receive(target, zipPath);

    const fieldsRepository = db.getRepository('fields');
    const originalCreate = fieldsRepository.create.bind(fieldsRepository);
    let calls = 0;
    fieldsRepository.create = async (options) => {
      calls += 1;
      if (calls === 3) throw new Error('injected failure in pass 2');
      return originalCreate(options);
    };

    await expect(importer.import(token)).rejects.toThrow('injected failure in pass 2');
    fieldsRepository.create = originalCreate;

    for (const name of ['projects', 'tasks', 'tags', throughName]) {
      expect(db.hasCollection(name)).toBe(false);
      expect(await db.getRepository('collections').count({ filter: { name } })).toBe(0);
    }
    const tables = await db.sequelize.getQueryInterface().showAllTables();
    expect(tables).not.toEqual(expect.arrayContaining(['projects']));
    expect(tables).not.toEqual(expect.arrayContaining(['tasks']));

    // The uploaded package is kept after a failure, so the same token can be retried.
    const result = await importer.import(token);
    expect(result.rowCounts).toMatchObject({ tasks: 2 });
    expect(await db.getRepository('tasks').count()).toBe(2);
  });

  it('previews and imports over HTTP for admins only', async () => {
    await buildSourceAndExport(['projects', 'tasks', 'tags'], true);
    target = await createApp({ acl: true });
    const db = target.db;

    const member = await db.getRepository('users').create({ values: { nickname: 'member', roles: ['member'] } });
    const memberAgent = await target.agent().login(member);
    expect((await memberAgent.post('/collectionTransfer:preview').attach('file', zipPath)).status).toBe(403);
    expect((await memberAgent.post('/collectionTransfer:import').send({ token: 'x' })).status).toBe(403);

    const admin = await db.getRepository('users').findOne({ filter: { 'roles.name': 'root' } });
    const adminAgent = await target.agent().login(admin);
    const preview = await adminAgent.post('/collectionTransfer:preview').attach('file', zipPath);
    expect(preview.status).toBe(200);
    expect(preview.body.data.problems).toEqual([]);

    const imported = await adminAgent.post('/collectionTransfer:import').send({ token: preview.body.data.token });
    expect(imported.status).toBe(200);
    expect(imported.body.data.rowCounts.tasks).toBe(2);

    // "Created by" / "Updated by" belong to whoever imported, not to the exporting environment's users.
    const importedTasks = await db.getRepository('tasks').find();
    expect(importedTasks.map((t) => t.get('createdById'))).toEqual([admin.get('id'), admin.get('id')]);
    expect(importedTasks.map((t) => t.get('updatedById'))).toEqual([admin.get('id'), admin.get('id')]);

    const again = await adminAgent.post('/collectionTransfer:preview').attach('file', zipPath);
    expect(again.body.data.problems).toEqual([]);
    expect(again.body.data.conflicts.map((c: { name: string }) => c.name).sort()).toEqual([
      'projects',
      'tags',
      'tasks',
    ]);
    const blocked = await adminAgent.post('/collectionTransfer:import').send({ token: again.body.data.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.problems.map((p: { code: string }) => p.code)).toContain('unresolvedConflict');

    const resolved = await adminAgent.post('/collectionTransfer:import').send({
      token: again.body.data.token,
      resolutions: { projects: 'skipAll', tasks: 'skipAll', tags: 'skipAll', bogus: 'dropEverything' },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.skipped.sort()).toEqual(['projects', 'tags', 'tasks']);
  });

  it('rejects files that are not transfer packages', async () => {
    target = await createApp();
    const bogus = path.join(CollectionImporter.uploadDir(), 'bogus.zip');
    await fsPromises.mkdir(path.dirname(bogus), { recursive: true });
    await fsPromises.writeFile(bogus, 'not a zip');
    const importer = new CollectionImporter(target);
    await expect(importer.receive(bogus)).rejects.toThrow('Not a collection transfer package');
    await fsPromises.rm(bogus, { force: true });

    await expect(importer.preview('../../etc')).rejects.toThrow('Invalid upload token');
    expect(MANIFEST_FILE).toBe('manifest.json');
  });
});
