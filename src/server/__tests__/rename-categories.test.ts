import { Database } from '@nocobase/database';
import { createMockServer, MockServer } from '@nocobase/test';
import fsPromises from 'fs/promises';
import { CollectionExporter } from '../exporter';
import { CollectionImporter, ImportBlockedError } from '../importer';
import { createGeneralCollection, createProjectSchema, TEST_PLUGINS } from './helpers';

const PLUGINS = [...TEST_PLUGINS, 'collection-sql'];

async function createCategory(db: Database, name: string) {
  return db.getRepository('collectionCategories').create({ values: { name } });
}

async function categoriesOf(db: Database, name: string) {
  const row = await db.getRepository('collections').findOne({ filter: { name }, appends: ['category'] });
  return (row.get('category') as { get(key: string): unknown }[]).map((category) => category.get('name'));
}

async function blockedProblems(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  expect(error).toBeInstanceOf(ImportBlockedError);
  return (error as ImportBlockedError).problems;
}

describe('renames and categories on import', () => {
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

  async function exportProjects(withCategory = true) {
    source = await createMockServer({ plugins: PLUGINS });
    const sdb = source.db;
    await createProjectSchema(sdb);
    if (withCategory) {
      const sales = await createCategory(sdb, 'Sales');
      await sdb
        .getRepository('collections')
        .update({ filterByTk: 'projects', values: { category: [sales.get('id')] } });
    }
    await sdb.getRepository('collections').create({
      values: {
        name: 'taskIds',
        title: 'Task ids',
        template: 'sql',
        sql: 'SELECT id, name FROM tasks',
        fields: [
          { name: 'id', type: 'bigInt', source: 'tasks.id', interface: 'integer' },
          { name: 'name', type: 'string', source: 'tasks.name', interface: 'input' },
        ],
      },
      context: {},
    });
    const project = await sdb.getRepository('projects').create({ values: { title: 'Website' } });
    const tag = await sdb.getRepository('tags').create({ values: { label: 'urgent' } });
    await sdb.getRepository('tasks').create({
      values: { name: 'Design', project: project.get('id'), tags: [tag.get('id')] },
    });
    zipPath = (
      await new CollectionExporter(source).export({
        collections: ['projects', 'tasks', 'tags', 'taskIds'],
        includeData: true,
      })
    ).filePath;
    await source.destroy();
    source = null;
  }

  it('puts collections into the categories chosen per collection', async () => {
    await exportProjects();
    target = await createMockServer({ plugins: PLUGINS });
    const tdb = target.db;
    await createCategory(tdb, 'Ops');
    const sales = await createCategory(tdb, 'Sales');
    const ops = await tdb.getRepository('collectionCategories').findOne({ filter: { name: 'Ops' } });

    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    const preview = await importer.preview(token);
    expect(preview.collections.find((c) => c.name === 'projects').categories).toEqual(['Sales']);
    expect(preview.collections.find((c) => c.name === 'tasks').categories).toEqual([]);
    expect(preview.categories.map((c) => c.name).sort()).toEqual(['Ops', 'Sales']);

    expect(
      await blockedProblems(importer.import(token, { trustExpressions: true, categories: { tasks: ['999'] } })),
    ).toContainEqual({ code: 'invalidCategory', collection: 'tasks' });

    await importer.import(token, {
      trustExpressions: true,
      categories: {
        projects: [sales.get('id') as string],
        tasks: [ops.get('id') as string, sales.get('id') as string],
      },
    });
    expect(await categoriesOf(tdb, 'projects')).toEqual(['Sales']);
    expect((await categoriesOf(tdb, 'tasks')).sort()).toEqual(['Ops', 'Sales']);
    expect(await categoriesOf(tdb, 'tags')).toEqual([]);
  });

  it('imports collections under other names next to the existing ones', async () => {
    await exportProjects(false);
    target = await createMockServer({ plugins: PLUGINS });
    const tdb = target.db;
    await createGeneralCollection(tdb, 'projects', 'Projects here', [{ name: 'title', type: 'string' }]);
    await tdb.getRepository('projects').create({ values: { title: 'Existing' } });

    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    expect((await importer.preview(token)).conflicts.map((c) => c.name)).toEqual(['projects']);

    const renames = {
      projects: { name: 'projects_copy', title: 'Projects (copy)' },
      tasks: { name: 'jobs' },
    };
    const preview = await importer.preview(token, { renames });
    expect(preview.problems).toEqual([]);
    expect(preview.conflicts).toEqual([]);
    expect(preview.collections.filter((c) => !c.isThrough).map((c) => [c.originalName, c.name, c.title])).toEqual([
      ['projects', 'projects_copy', 'Projects (copy)'],
      ['tasks', 'jobs', 'Tasks'],
      ['tags', 'tags', 'Tags'],
      ['taskIds', 'taskIds', 'Task ids'],
    ]);
    // The SQL query still reads "tasks"; the admin is told.
    expect(preview.notices).toContainEqual({ code: 'sqlNotRenamed', collection: 'taskIds', detail: 'tasks' });

    const result = await importer.import(token, { trustExpressions: true, renames });
    expect(result.collections.sort()).toEqual(['jobs', 'projects_copy', 'tags', 'taskIds']);
    expect(result.rowCounts).toMatchObject({ projects_copy: 1, jobs: 1, tags: 1 });

    const copy = await tdb.getRepository('collections').findOne({ filter: { name: 'projects_copy' } });
    expect(copy.get('title')).toBe('Projects (copy)');
    const job = await tdb.getRepository('jobs').findOne({ appends: ['project', 'tags'] });
    expect(job.get('name')).toBe('Design');
    expect(job.get('project').get('title')).toBe('Website');
    expect(job.get('tags').map((t) => t.get('label'))).toEqual(['urgent']);
    const project = await tdb.getRepository('projects_copy').findOne({ appends: ['tasks'] });
    expect(project.get('tasks').map((t) => t.get('name'))).toEqual(['Design']);
    const tag = await tdb.getRepository('tags').findOne({ appends: ['tasks'] });
    expect(tag.get('tasks').map((t) => t.get('name'))).toEqual(['Design']);
    // The existing collection is untouched.
    expect((await tdb.getRepository('projects').find()).map((p) => p.get('title'))).toEqual(['Existing']);
  });

  it('imports a renamed copy into the same environment, junction tables included', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    const db = source.db;
    await createProjectSchema(db);
    const project = await db.getRepository('projects').create({ values: { title: 'Website' } });
    const tag = await db.getRepository('tags').create({ values: { label: 'urgent' } });
    await db
      .getRepository('tasks')
      .create({ values: { name: 'Design', project: project.get('id'), tags: [tag.get('id')] } });
    zipPath = (
      await new CollectionExporter(source).export({ collections: ['projects', 'tasks', 'tags'], includeData: true })
    ).filePath;

    const importer = new CollectionImporter(source);
    const token = await importer.receive(zipPath);
    const renames = {
      projects: { name: 'projects_copy' },
      tasks: { name: 'tasks_copy' },
      tags: { name: 'tags_copy' },
    };
    const preview = await importer.preview(token, { renames });
    expect(preview.problems).toEqual([]);
    expect(preview.conflicts).toEqual([]);
    const result = await importer.import(token, { renames });
    expect(result.through).toHaveLength(1);

    const copy = await db.getRepository('tasks_copy').findOne({ appends: ['project', 'tags'] });
    expect(copy.get('project').get('title')).toBe('Website');
    expect(copy.get('tags').map((t) => t.get('label'))).toEqual(['urgent']);
    // The original keeps its own junction table and links.
    const original = await db.getRepository('tasks').findOne({ appends: ['tags'] });
    expect(original.get('tags').map((t) => t.get('label'))).toEqual(['urgent']);
    await db.getRepository('tasks_copy').update({ filterByTk: copy.get('id'), values: { tags: [] } });
    expect((await db.getRepository('tasks').findOne({ appends: ['tags'] })).get('tags')).toHaveLength(1);
  });

  it('refuses invalid or clashing names', async () => {
    await exportProjects(false);
    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    const preview = await importer.preview(token, {
      renames: { projects: { name: 'bad name' }, tasks: { name: 'tags' }, unknown: { name: 'x' } },
    });
    expect(preview.problems).toEqual(
      expect.arrayContaining([
        { code: 'invalidRename', collection: 'projects', detail: 'bad name' },
        { code: 'invalidRename', collection: 'tasks', detail: 'tags is used twice' },
        { code: 'invalidRename', collection: 'unknown', detail: 'not a collection of the file' },
      ]),
    );
    expect(await blockedProblems(importer.import(token, { renames: { projects: { name: 'users' } } }))).toContainEqual({
      code: 'invalidRename',
      collection: 'projects',
      detail: 'users is used twice',
    });
  });
});
