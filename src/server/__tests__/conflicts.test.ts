import { Database } from '@nocobase/database';
import { MockServer } from '@nocobase/test';
import fsPromises from 'fs/promises';
import { CollectionExporter } from '../exporter';
import { CollectionImporter, ConflictMode, ImportBlockedError } from '../importer';
import { createApp, createAssociation, createGeneralCollection, createProjectSchema } from './helpers';

async function seed(db: Database) {
  const website = await db.getRepository('projects').create({ values: { title: 'Website', status: 'open' } });
  const crm = await db.getRepository('projects').create({ values: { title: 'CRM', status: 'done' } });
  const tag = await db.getRepository('tags').create({ values: { label: 'urgent' } });
  await db
    .getRepository('tasks')
    .create({ values: { name: 'Design', projectId: website.get('id'), tags: [tag.get('id')] } });
  await db.getRepository('tasks').create({ values: { name: 'Import', projectId: crm.get('id') } });
}

describe('import conflicts', () => {
  let target: MockServer;
  let zipPath: string;

  // Export projects/tasks/tags with data from a source app, then start a fresh target app on the test database.
  beforeEach(async () => {
    const source = await createApp();
    await createProjectSchema(source.db);
    await seed(source.db);
    zipPath = (
      await new CollectionExporter(source).export({ collections: ['projects', 'tasks', 'tags'], includeData: true })
    ).filePath;
    await source.destroy();
    target = await createApp();
  });

  afterEach(async () => {
    await target?.destroy();
    await fsPromises.rm(zipPath, { force: true });
  });

  async function importWith(resolutions: Record<string, ConflictMode> = {}) {
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    return {
      importer,
      token,
      preview: await importer.preview(token),
      run: () => importer.import(token, { resolutions }),
    };
  }

  /** An existing `projects` in the target with a different schema and one row of its own. */
  async function createDifferentProjects() {
    await createGeneralCollection(target.db, 'projects', 'Old projects', [
      { name: 'code', type: 'string', interface: 'input' },
    ]);
    await target.db.getRepository('projects').create({ values: { code: 'OLD-1' } });
  }

  it('overrides an existing collection with the package schema and data', async () => {
    await createDifferentProjects();
    const { preview, run } = await importWith({ projects: 'overrideAll' });
    expect(preview.problems).toEqual([]);
    expect(preview.conflicts).toEqual([
      expect.objectContaining({
        name: 'projects',
        title: 'Old projects',
        missingColumns: expect.arrayContaining(['title']),
      }),
    ]);

    const result = await run();
    expect(result.overridden).toEqual(['projects']);
    expect(result.rowCounts).toMatchObject({ projects: 2, tasks: 2 });
    const db = target.db;
    expect(db.getCollection('projects').getField('code')).toBeUndefined();
    const projects = await db.getRepository('projects').find({ appends: ['tasks'], sort: ['title'] });
    expect(projects.map((p) => p.get('title'))).toEqual(['CRM', 'Website']);
    expect(projects.map((p) => p.get('tasks').length)).toEqual([1, 1]);
  });

  it('overrides the schema only, leaving the collection empty', async () => {
    await createDifferentProjects();
    const result = await (await importWith({ projects: 'overrideSchema' })).run();
    expect(result.rowCounts.projects).toBeUndefined();
    expect(await target.db.getRepository('projects').count()).toBe(0);
    expect(target.db.getCollection('projects').getField('title')).toBeTruthy();
    expect(await target.db.getRepository('tasks').count()).toBe(2);
  });

  it('skips an existing collection entirely and still links the new ones to it', async () => {
    await createDifferentProjects();
    const result = await (await importWith({ projects: 'skipAll' })).run();
    expect(result.skipped).toEqual(['projects']);
    const db = target.db;
    expect(db.getCollection('projects').getField('code')).toBeTruthy();
    expect(db.getCollection('projects').getField('title')).toBeUndefined();
    expect((await db.getRepository('projects').find()).map((p) => p.get('code'))).toEqual(['OLD-1']);
    // The new tasks collection gets its side of the relation; the skipped projects collection keeps its own fields.
    expect(db.getCollection('tasks').getField('project')).toBeTruthy();
    expect(db.getCollection('projects').getField('tasks')).toBeUndefined();
  });

  it('keeps an existing collection and adds only the rows it does not have', async () => {
    // First import creates everything; then the target diverges.
    await (await importWith()).run();
    const db = target.db;
    const website = await db.getRepository('projects').findOne({ filter: { title: 'Website' } });
    await db.getRepository('projects').update({ filterByTk: website.get('id'), values: { status: 'paused' } });
    await db.getRepository('projects').destroy({ filter: { title: 'CRM' } });

    const result = await (
      await importWith({ projects: 'skipCollectionImportData', tasks: 'skipAll', tags: 'skipAll' })
    ).run();
    expect(result.rowCounts.projects).toBe(1);
    const projects = await db.getRepository('projects').find({ sort: ['title'] });
    expect(projects.map((p) => `${p.get('title')}:${p.get('status')}`)).toEqual(['CRM:done', 'Website:paused']);
  });

  it('refuses to add rows to an existing collection that lacks package columns', async () => {
    await createDifferentProjects();
    const { run } = await importWith({ projects: 'skipCollectionImportData' });
    await expect(run()).rejects.toBeInstanceOf(ImportBlockedError);
    await expect(run()).rejects.toMatchObject({
      problems: [expect.objectContaining({ code: 'columnsMismatch', collection: 'projects' })],
    });
    expect(target.db.hasCollection('tasks')).toBe(false);
  });

  it('requires a decision for every existing collection', async () => {
    await createDifferentProjects();
    const { run } = await importWith();
    await expect(run()).rejects.toMatchObject({
      problems: [expect.objectContaining({ code: 'unresolvedConflict', collection: 'projects' })],
    });
  });

  it('reports fields elsewhere that an override would remove', async () => {
    await createDifferentProjects();
    await createGeneralCollection(target.db, 'reports', 'Reports');
    await createAssociation(target.db, {
      collectionName: 'reports',
      name: 'project',
      type: 'belongsTo',
      interface: 'm2o',
      target: 'projects',
      foreignKey: 'projectId',
    });
    const { preview } = await importWith();
    expect(preview.conflicts[0].referencedBy).toEqual([{ collection: 'reports', field: 'project', restored: false }]);
  });

  it('re-creates the other side on skipped collections when overriding removed it', async () => {
    await (await importWith()).run();
    const db = target.db;
    // Override tasks; projects and tags are skipped. Their tasks fields point at tasks, so the override removes them.
    const { preview, run } = await importWith({ projects: 'skipAll', tasks: 'overrideAll', tags: 'skipAll' });
    const tasksConflict = preview.conflicts.find((c) => c.name === 'tasks');
    expect(tasksConflict.referencedBy).toEqual(
      expect.arrayContaining([
        { collection: 'projects', field: 'tasks', restored: true },
        { collection: 'tags', field: 'tasks', restored: true },
      ]),
    );
    await run();
    expect(db.getCollection('projects').getField('tasks')).toBeTruthy();
    expect(db.getCollection('tags').getField('tasks')).toBeTruthy();
    const project = await db.getRepository('projects').findOne({ filter: { title: 'Website' }, appends: ['tasks'] });
    expect(project.get('tasks')).toHaveLength(1);
    const tag = await db.getRepository('tags').findOne({ appends: ['tasks'] });
    expect(tag.get('tasks')).toHaveLength(1);
  });

  it('restores an overridden collection when the import fails', async () => {
    await createDifferentProjects();
    const db = target.db;
    const { run } = await importWith({ projects: 'overrideAll' });
    const fieldsRepository = db.getRepository('fields');
    const originalCreate = fieldsRepository.create.bind(fieldsRepository);
    let calls = 0;
    fieldsRepository.create = async (options) => {
      calls += 1;
      if (calls === 3) throw new Error('injected failure');
      return originalCreate(options);
    };
    await expect(run()).rejects.toThrow('injected failure');
    fieldsRepository.create = originalCreate;

    expect(db.getCollection('projects').getField('code')).toBeTruthy();
    expect((await db.getRepository('projects').find()).map((p) => p.get('code'))).toEqual(['OLD-1']);
    expect(db.hasCollection('tasks')).toBe(false);
  });
});
