import { Database } from '@nocobase/database';
import { createMockServer, MockServer } from '@nocobase/test';
import fsPromises from 'fs/promises';
import { QueryTypes } from 'sequelize';
import { CollectionExporter } from '../exporter';
import { CollectionImporter } from '../importer';
import { createAssociation, TEST_PLUGINS } from './helpers';

type Row = Record<string, unknown>;

// file-manager must be installed before system-settings (its default storage is referenced there).
const BASE_PLUGINS = [...TEST_PLUGINS];
BASE_PLUGINS.splice(BASE_PLUGINS.indexOf('system-settings'), 0, 'file-manager');
const PLUGINS = [...BASE_PLUGINS, 'collection-tree', 'calendar', 'comments', 'collection-sql'];

async function createCollection(db: Database, values: Row) {
  await db.getRepository('collections').create({ values, context: {} });
}

async function count(db: Database, sql: string) {
  const [row] = await db.sequelize.query<{ n: string }>(sql, { type: QueryTypes.SELECT });
  return Number(row.n);
}

async function createStorage(db: Database, name: string) {
  return db.getRepository('storages').create({ values: { name, title: name, type: 'local', rules: {} } });
}

// Collections of every template that ships with NocoBase (FDW needs a remote database server and is covered by the
// preview check only).
async function createTemplateSchema(db: Database) {
  await createCollection(db, {
    name: 'areas',
    title: 'Areas',
    template: 'tree',
    tree: 'adjacencyList',
    fields: [{ name: 'title', type: 'string', interface: 'input' }],
  });
  await createAssociation(db, {
    collectionName: 'areas',
    name: 'parent',
    type: 'belongsTo',
    interface: 'm2o',
    target: 'areas',
    foreignKey: 'parentId',
    treeParent: true,
    onDelete: 'CASCADE',
  });
  await createAssociation(db, {
    collectionName: 'areas',
    name: 'children',
    type: 'hasMany',
    interface: 'o2m',
    target: 'areas',
    foreignKey: 'parentId',
    treeChildren: true,
    onDelete: 'CASCADE',
  });

  await createCollection(db, {
    name: 'events',
    title: 'Events',
    template: 'calendar',
    fields: [
      { name: 'title', type: 'string', interface: 'input' },
      { name: 'cron', type: 'string', interface: 'select' },
      { name: 'exclude', type: 'json' },
    ],
  });
  await createCollection(db, {
    name: 'notes',
    title: 'Notes',
    template: 'comment',
    fields: [{ name: 'content', type: 'text', interface: 'vditor' }],
  });

  const extra = await createStorage(db, 'documents');
  await createCollection(db, {
    name: 'docs',
    title: 'Docs',
    template: 'file',
    storage: 'documents',
    fields: [
      { name: 'title', type: 'string', interface: 'input' },
      { name: 'filename', type: 'string', interface: 'input' },
      { name: 'url', type: 'text', interface: 'input' },
    ],
  });
  await createAssociation(db, {
    collectionName: 'docs',
    name: 'storage',
    type: 'belongsTo',
    target: 'storages',
    foreignKey: 'storageId',
  });

  await createCollection(db, {
    name: 'areaTitles',
    title: 'Area titles',
    template: 'sql',
    sql: 'SELECT id, title FROM areas',
    fields: [
      { name: 'id', type: 'bigInt', source: 'areas.id', interface: 'integer' },
      { name: 'title', type: 'string', source: 'areas.title', interface: 'input' },
    ],
  });

  await db.sequelize.query('CREATE VIEW area_view AS SELECT id, title FROM areas');
  await createCollection(db, {
    name: 'areaView',
    title: 'Area view',
    template: 'view',
    view: true,
    viewName: 'area_view',
    schema: 'public',
    fields: [
      { name: 'id', type: 'bigInt', source: 'areas.id', interface: 'integer' },
      { name: 'title', type: 'string', source: 'areas.title', interface: 'input' },
    ],
  });

  const areas = db.getRepository('areas');
  const root = await areas.create({ values: { title: 'India' } });
  const state = await areas.create({ values: { title: 'Gujarat', parentId: root.get('id') } });
  await areas.create({ values: { title: 'Surat', parentId: state.get('id') } });
  await db.getRepository('events').create({ values: { title: 'Standup', cron: 'every_day' } });
  await db.getRepository('notes').create({ values: { content: 'Hello' } });
  await db
    .getRepository('docs')
    .create({ values: { title: 'Invoice', filename: 'a.pdf', storageId: extra.get('id') } });
}

describe.runIf(process.env.DB_DIALECT === 'postgres' || !process.env.DB_DIALECT)('collection templates', () => {
  let source: MockServer;
  let target: MockServer;
  let zipPath: string;

  afterEach(async () => {
    await source?.destroy();
    await target?.destroy();
    source = null;
    target = null;
    if (zipPath) await fsPromises.rm(zipPath, { force: true });
    zipPath = null;
  });

  it('moves tree, calendar, comment, file, SQL and view collections', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    await createTemplateSchema(source.db);
    const exporter = new CollectionExporter(source);
    const listed = await exporter.listCollections();
    for (const name of ['areas', 'events', 'notes', 'docs', 'areaTitles', 'areaView']) {
      expect(listed.find((c) => c.name === name)).toMatchObject({ supported: true });
    }
    const result = await exporter.export({
      collections: ['areas', 'events', 'notes', 'docs', 'areaTitles', 'areaView'],
      includeData: true,
    });
    zipPath = result.filePath;
    expect(Object.values(result.manifest.storages)).toEqual(['documents']);
    await source.db.sequelize.query('DROP VIEW area_view');
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const tdb = target.db;
    // Ids differ from the source: records must follow the storage name, not its id.
    await createStorage(tdb, 'archive');
    const documents = await createStorage(tdb, 'documents');

    const importer = new CollectionImporter(target);
    let token = await importer.receive(zipPath);
    let preview = await importer.preview(token);
    expect(preview.problems).toEqual([{ code: 'missingView', collection: 'areaView', detail: 'area_view' }]);

    await tdb.sequelize.query(`CREATE VIEW area_view AS SELECT 1::bigint AS id, 'x'::varchar AS title`);
    preview = await importer.preview(token);
    expect(preview.problems).toEqual([]);
    expect(preview.expressions).toEqual([
      { code: 'sqlStatement', collection: 'areaTitles', detail: 'SELECT id, title FROM areas' },
    ]);
    expect(preview.notices).toEqual(
      expect.arrayContaining([
        { code: 'filesNotCarried', collection: 'docs' },
        { code: 'dataNotCarried', collection: 'areaTitles', detail: 'sql' },
        { code: 'dataNotCarried', collection: 'areaView', detail: 'view' },
      ]),
    );
    await expect(importer.import(token)).rejects.toThrow();
    token = await importer.receive(zipPath);
    const imported = await importer.import(token, { trustExpressions: true });
    expect(imported.rowCounts).toMatchObject({ areas: 3, events: 1, notes: 1, docs: 1 });

    for (const [name, template] of Object.entries({
      areas: 'tree',
      events: 'calendar',
      notes: 'comment',
      docs: 'file',
      areaTitles: 'sql',
      areaView: 'view',
    })) {
      const row = await tdb.getRepository('collections').findOne({ filter: { name } });
      expect(row.get('template')).toBe(template);
    }

    // Tree paths are rebuilt, so tree queries and new children work.
    const surat = await tdb.getRepository('areas').findOne({ filter: { title: 'Surat' } });
    const paths = await tdb.getRepository('main_areas_path').find();
    const suratPath = paths.find((p) => String(p.get('nodePk')) === String(surat.get('id')));
    expect((suratPath.get('path') as string).split('/').length).toBe(4);
    const tree = await tdb.getRepository('areas').find({ tree: true, filter: { parentId: null } } as never);
    expect(tree.map((node) => node.get('title'))).toEqual(['India']);
    const child = await tdb.getRepository('areas').create({ values: { title: 'Mumbai', parentId: surat.get('id') } });
    expect(child.get('id')).toBeGreaterThan(Number(surat.get('id')));

    const doc = await tdb.getRepository('docs').findOne();
    expect(String(doc.get('storageId'))).toBe(String(documents.get('id')));

    // The SQL collection queries the imported table; the view collection reads the view of this environment.
    const titles = await tdb.getRepository('areaTitles').find();
    expect(titles.map((t) => t.get('title')).sort()).toEqual(['Gujarat', 'India', 'Mumbai', 'Surat']);
    expect((await tdb.getRepository('areaView').find()).map((v) => v.get('title'))).toEqual(['x']);
    expect(await count(tdb, 'SELECT count(*) AS n FROM area_view')).toBe(1);
  });

  it('moves inherited collections with their parents (PostgreSQL)', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    const sdb = source.db;
    await createCollection(sdb, {
      name: 'animals',
      title: 'Animals',
      fields: [{ name: 'name', type: 'string', interface: 'input' }],
    });
    await createCollection(sdb, {
      name: 'dogs',
      title: 'Dogs',
      inherits: ['animals'],
      fields: [{ name: 'breed', type: 'string', interface: 'input' }],
    });
    await sdb.getRepository('animals').create({ values: { name: 'Tom' } });
    await sdb.getRepository('dogs').create({ values: { name: 'Rex', breed: 'Beagle' } });

    const result = await new CollectionExporter(source).export({ collections: ['dogs'], includeData: true });
    zipPath = result.filePath;
    expect(result.manifest.collections).toEqual(['animals', 'dogs']);
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    expect((await importer.preview(token)).problems).toEqual([]);
    const imported = await importer.import(token);
    expect(imported.rowCounts).toMatchObject({ animals: 1, dogs: 1 });

    const tdb = target.db;
    expect(await count(tdb, 'SELECT count(*) AS n FROM ONLY animals')).toBe(1);
    expect(await tdb.getRepository('animals').count()).toBe(2);
    const dog = await tdb.getRepository('dogs').findOne();
    expect(dog.get('breed')).toBe('Beagle');
    expect(dog.get('name')).toBe('Rex');
    // Child ids come from the parent's sequence, which was moved past every imported id.
    const next = await tdb.getRepository('dogs').create({ values: { name: 'Max' } });
    const ids = (await tdb.getRepository('animals').find()).map((a) => Number(a.get('id')));
    expect(new Set(ids).size).toBe(3);
    expect(Number(next.get('id'))).toBe(Math.max(...ids));
  });

  it('keeps attachment fields, without links to attachments of the source', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    const sdb = source.db;
    await createCollection(sdb, {
      name: 'contracts',
      title: 'Contracts',
      fields: [{ name: 'title', type: 'string', interface: 'input' }],
    });
    // As the collection manager creates an attachment field: a belongsToMany to attachments whose junction table has
    // no collection row (NocoBase only creates one for m2m fields).
    await sdb.getRepository('fields').create({
      values: {
        collectionName: 'contracts',
        name: 'files',
        type: 'belongsToMany',
        interface: 'attachment',
        target: 'attachments',
        uiSchema: { title: 'Files', 'x-component': 'Upload.Attachment' },
      },
      context: {},
    });
    const through = (await sdb.getRepository('fields').findOne({ filter: { name: 'files' } })).get('through') as string;
    expect(await sdb.getRepository('collections').count({ filter: { name: through } })).toBe(0);
    const attachment = await sdb.getRepository('attachments').create({ values: { title: 'a', filename: 'a.pdf' } });
    await sdb.getRepository('contracts').create({ values: { title: 'Lease', files: [attachment.get('id')] } });

    const result = await new CollectionExporter(source).export({ collections: ['contracts'], includeData: true });
    zipPath = result.filePath;
    expect(result.manifest.through).toEqual([through]);
    expect(result.manifest.dependencies).toEqual(['attachments']);
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    const preview = await importer.preview(token);
    expect(preview.problems).toEqual([]);
    expect(preview.notices).toEqual([
      { code: 'relationRowsNotCarried', collection: 'contracts', field: 'files', detail: 'attachments' },
    ]);
    const imported = await importer.import(token);
    expect(imported.rowCounts).toEqual({ contracts: 1 });

    const contract = await target.db.getRepository('contracts').findOne({ appends: ['files'] });
    expect(contract.get('title')).toBe('Lease');
    expect(contract.get('files')).toEqual([]);
    // The field still works in the target.
    const local = await target.db.getRepository('attachments').create({ values: { title: 'b', filename: 'b.pdf' } });
    await target.db.getRepository('contracts').update({
      filterByTk: contract.get('id'),
      values: { files: [local.get('id')] },
    });
    const updated = await target.db.getRepository('contracts').findOne({ appends: ['files'] });
    expect(updated.get('files').map((file) => file.get('title'))).toEqual(['b']);
  });

  it('names the plugin a template needs when it is not enabled here', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    await createCollection(source.db, {
      name: 'notes',
      title: 'Notes',
      template: 'comment',
      fields: [{ name: 'content', type: 'text', interface: 'vditor' }],
    });
    zipPath = (await new CollectionExporter(source).export({ collections: ['notes'], includeData: false })).filePath;
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: BASE_PLUGINS });
    const importer = new CollectionImporter(target);
    const preview = await importer.preview(await importer.receive(zipPath));
    expect(preview.problems).toEqual([
      { code: 'missingTemplatePlugin', collection: 'notes', detail: '@nocobase/plugin-comments' },
    ]);
  });
});
