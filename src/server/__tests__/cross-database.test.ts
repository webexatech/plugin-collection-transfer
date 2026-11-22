import { Database } from '@nocobase/database';
import { createMockServer, MockServer } from '@nocobase/test';
import fsPromises from 'fs/promises';
import { CollectionExporter } from '../exporter';
import { CollectionImporter } from '../importer';
import { createAssociation, createGeneralCollection, TEST_PLUGINS } from './helpers';

// Runs only when a MySQL server for tests is configured, e.g.
// CT_MYSQL_HOST=localhost CT_MYSQL_PORT=3307 CT_MYSQL_DATABASE=ct_test CT_MYSQL_USER=nocobase CT_MYSQL_PASSWORD=nocobase
const mysql = process.env.CT_MYSQL_HOST
  ? {
      dialect: 'mysql',
      host: process.env.CT_MYSQL_HOST,
      port: Number(process.env.CT_MYSQL_PORT || 3306),
      database: process.env.CT_MYSQL_DATABASE || 'ct_test',
      username: process.env.CT_MYSQL_USER || 'nocobase',
      password: process.env.CT_MYSQL_PASSWORD || 'nocobase',
      schema: undefined,
      timezone: '+00:00',
    }
  : null;

async function app(database?: Record<string, unknown>): Promise<MockServer> {
  return createMockServer({ plugins: TEST_PLUGINS, ...(database ? { database } : {}) });
}

/** Collections with the value types that differ between databases, plus relations. */
async function createRichSchema(db: Database) {
  await createGeneralCollection(db, 'projects', 'Projects', [
    { name: 'title', type: 'string', interface: 'input' },
    { name: 'done', type: 'boolean', interface: 'checkbox' },
    { name: 'budget', type: 'decimal', interface: 'number', precision: 12, scale: 2 },
    { name: 'meta', type: 'json', interface: 'json' },
    { name: 'startedAt', type: 'date', interface: 'datetime' },
    { name: 'day', type: 'dateOnly', interface: 'date' },
  ]);
  await createGeneralCollection(db, 'tasks', 'Tasks', [{ name: 'name', type: 'string', interface: 'input' }]);
  await createGeneralCollection(db, 'tags', 'Tags', [{ name: 'label', type: 'string', interface: 'input' }]);
  await createAssociation(db, {
    collectionName: 'tasks',
    name: 'project',
    type: 'belongsTo',
    interface: 'm2o',
    target: 'projects',
    foreignKey: 'projectId',
    reverseField: { name: 'tasks', interface: 'o2m' },
  });
  await createAssociation(db, {
    collectionName: 'tasks',
    name: 'tags',
    type: 'belongsToMany',
    interface: 'm2m',
    target: 'tags',
    reverseField: { name: 'tasks', interface: 'm2m' },
  });

  const project = await db.getRepository('projects').create({
    values: {
      title: 'Website',
      done: true,
      budget: '1234.50',
      meta: { owner: 'ops', tags: ['a', 'b'] },
      startedAt: '2026-12-01T10:30:00.000Z',
      day: '2026-12-01',
    },
  });
  await db.getRepository('projects').create({ values: { title: 'Empty', done: false } });
  const tag = await db.getRepository('tags').create({ values: { label: 'urgent' } });
  await db
    .getRepository('tasks')
    .create({ values: { name: 'Design', projectId: project.get('id'), tags: [tag.get('id')] } });
}

async function expectRichData(db: Database) {
  const website = await db.getRepository('projects').findOne({ filter: { title: 'Website' }, appends: ['tasks'] });
  expect(Boolean(website.get('done'))).toBe(true);
  expect(Number(website.get('budget'))).toBe(1234.5);
  expect(website.get('meta')).toEqual({ owner: 'ops', tags: ['a', 'b'] });
  expect(new Date(website.get('startedAt') as string).toISOString()).toBe('2026-12-01T10:30:00.000Z');
  expect(website.get('day')).toBe('2026-12-01');
  expect(website.get('tasks')).toHaveLength(1);

  const empty = await db.getRepository('projects').findOne({ filter: { title: 'Empty' } });
  expect(Boolean(empty.get('done'))).toBe(false);
  expect(empty.get('startedAt')).toBeNull();

  const task = await db.getRepository('tasks').findOne({ appends: ['project', 'tags'] });
  expect(task.get('project').get('title')).toBe('Website');
  expect(task.get('tags').map((t) => t.get('label'))).toEqual(['urgent']);
  // New rows still work after the import.
  expect((await db.getRepository('tags').create({ values: { label: 'later' } })).get('id')).toBeTruthy();
}

describe.runIf(!!mysql)('cross-database transfer', () => {
  let source: MockServer;
  let target: MockServer;
  let zipPath: string;

  afterEach(async () => {
    await source?.destroy();
    await target?.destroy();
    source = null;
    target = null;
    if (zipPath) await fsPromises.rm(zipPath, { force: true });
  });

  async function transfer(from?: Record<string, unknown>, to?: Record<string, unknown>) {
    source = await app(from);
    expect(source.db.sequelize.getDialect()).toBe(from ? 'mysql' : 'postgres');
    await createRichSchema(source.db);
    zipPath = (
      await new CollectionExporter(source).export({ collections: ['projects', 'tasks', 'tags'], includeData: true })
    ).filePath;
    await source.destroy();
    source = null;

    target = await app(to);
    expect(target.db.sequelize.getDialect()).toBe(to ? 'mysql' : 'postgres');
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    const preview = await importer.preview(token);
    expect(preview.problems).toEqual([]);
    await importer.import(token);
    await expectRichData(target.db);
  }

  it('moves schema and data from PostgreSQL to MySQL', async () => {
    await transfer(undefined, mysql);
  });

  it('moves schema and data from MySQL to PostgreSQL', async () => {
    await transfer(mysql, undefined);
  });
});
