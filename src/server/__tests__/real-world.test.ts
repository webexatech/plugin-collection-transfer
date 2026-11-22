import { Database } from '@nocobase/database';
import { createMockServer, MockServer } from '@nocobase/test';
import fsPromises from 'fs/promises';
import path from 'path';
import { QueryTypes } from 'sequelize';
import { CollectionExporter } from '../exporter';
import { CollectionImporter } from '../importer';
import { COLLECTIONS_FILE } from '../package-format';
import { createAssociation, createGeneralCollection, TEST_PLUGINS } from './helpers';

type Row = Record<string, unknown>;
const PLUGINS = [...TEST_PLUGINS, 'field-formula', 'workflow', 'workflow-dynamic-calculation'];

// Schemas seen in real installations: snake_case column names (DB_UNDERSCORED), a primary key that is also used as
// a foreign key, a junction table without a collection-manager row, formula notes in field descriptions.
async function createVendorSchema(db: Database) {
  await createGeneralCollection(db, 'Bullion_vendor', 'Bullion vendor', [
    { name: 'Name', type: 'string', interface: 'input' },
    { name: 'Gst_no', type: 'string', interface: 'input' },
  ]);
  await createGeneralCollection(db, 'Bullion_Purchase', 'Bullion Purchase', [
    { name: 'Weight', type: 'double', interface: 'number' },
    { name: 'Rate', type: 'double', interface: 'number' },
    {
      name: 'TDS_TCS',
      type: 'formula',
      interface: 'formula',
      dataType: 'double',
      engine: 'formula.js',
      expression: '{{Weight}} * {{Rate}}',
      description: '({{Weight}} || 0) * ({{Rate}} || 0)',
    },
  ]);
  // A belongsTo that uses the record's own primary key as foreign key; NocoBase then marks `id` as a key field.
  await createAssociation(db, {
    collectionName: 'Bullion_Purchase',
    name: 'Vendor_name',
    type: 'belongsTo',
    interface: 'm2o',
    target: 'Bullion_vendor',
    foreignKey: 'id',
    targetKey: 'id',
  });
  await createGeneralCollection(db, 'Recordings', 'Recordings', [
    { name: 'Label', type: 'string', interface: 'input' },
  ]);
  await createAssociation(db, {
    collectionName: 'Bullion_vendor',
    name: 'Recording',
    type: 'belongsToMany',
    interface: 'm2m',
    target: 'Recordings',
  });

  const vendor = await db.getRepository('Bullion_vendor').create({ values: { Name: 'Acme', Gst_no: 'GST1' } });
  const recording = await db.getRepository('Recordings').create({ values: { Label: 'Call 1' } });
  await db.getRepository('Bullion_vendor').update({
    filterByTk: vendor.get('id'),
    values: { Recording: [recording.get('id')] },
  });
  await db.getRepository('Bullion_Purchase').create({ values: { id: vendor.get('id'), Weight: 2, Rate: 10 } });
  return { vendorId: vendor.get('id') };
}

describe('real-world schemas', () => {
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

  it('moves an underscored schema with a key used as foreign key and a junction without collection row', async () => {
    source = await createMockServer({ plugins: PLUGINS, database: { underscored: true } });
    const db = source.db;
    const { vendorId } = await createVendorSchema(db);
    const recording = await db.getRepository('fields').findOne({
      filter: { collectionName: 'Bullion_vendor', name: 'Recording' },
    });
    const through = recording.get('through') as string;
    // Older installations: the junction table exists (defined by the relation) but has no collection-manager row.
    await db.sequelize.query(`DELETE FROM ${db.getCollection('collections').quotedTableName()} WHERE name = :through`, {
      replacements: { through },
      type: QueryTypes.DELETE,
    });
    expect(await db.getRepository('collections').count({ filter: { name: through } })).toBe(0);
    expect(db.hasCollection(through)).toBe(true);

    const result = await new CollectionExporter(source).export({
      collections: ['Bullion_Purchase', 'Bullion_vendor', 'Recordings'],
      includeData: true,
    });
    zipPath = result.filePath;
    expect(result.manifest.through).toEqual([through]);
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    const preview = await importer.preview(token);
    expect(preview.problems).toEqual([]);
    // The formula note in the description must be confirmed; the formula expression itself is not listed.
    expect(preview.expressions).toEqual([
      expect.objectContaining({ collection: 'Bullion_Purchase', field: 'TDS_TCS' }),
    ]);
    await importer.import(token, { trustExpressions: true });

    const tdb = target.db;
    expect(tdb.getCollection('Bullion_vendor').model.primaryKeyAttribute).toBe('id');
    const purchase = await tdb.getRepository('Bullion_Purchase').findOne({ appends: ['Vendor_name'] });
    expect(purchase.get('Weight')).toBe(2);
    expect(purchase.get('Vendor_name').get('Name')).toBe('Acme');
    expect(String(purchase.get('id'))).toBe(String(vendorId));
    const vendor = await tdb.getRepository('Bullion_vendor').findOne({ appends: ['Recording'] });
    expect(vendor.get('Recording').map((r) => r.get('Label'))).toEqual(['Call 1']);
  });

  it('moves expression collections (Workflow: Dynamic calculation) like general ones', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    const sdb = source.db;
    await createGeneralCollection(sdb, 'Stock_In', 'Stock in', [{ name: 'Qty', type: 'double', interface: 'number' }]);
    await sdb.getRepository('collections').create({
      values: {
        name: 'testGroup',
        title: 'Test group',
        template: 'expression',
        createdBy: true,
        updatedBy: true,
        fields: [
          { name: 'engine', type: 'string', interface: 'radioGroup' },
          { name: 'sourceCollection', type: 'string', interface: 'select' },
          { name: 'expression', type: 'text', interface: 'expression' },
        ],
      },
      context: {},
    });
    await createAssociation(sdb, {
      collectionName: 'testGroup',
      name: 'stock',
      type: 'belongsTo',
      interface: 'm2o',
      target: 'Stock_In',
      foreignKey: 'stockId',
    });
    await sdb.getRepository('testGroup').create({
      values: { engine: 'formula.js', sourceCollection: 'Stock_In', expression: '{{Qty}} * 2' },
    });

    const exporter = new CollectionExporter(source);
    expect((await exporter.listCollections()).find((c) => c.name === 'testGroup')).toMatchObject({ supported: true });
    zipPath = (await exporter.export({ collections: ['Stock_In', 'testGroup'], includeData: true })).filePath;
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    const preview = await importer.preview(token);
    expect(preview.problems).toEqual([]);
    // The stored expression is a value, not UI text: nothing to confirm.
    expect(preview.expressions).toEqual([]);
    await importer.import(token);
    const row = (await target.db.getRepository('collections').findOne({ filter: { name: 'testGroup' } })).get() as Row;
    expect(row.template).toBe('expression');
    const group = await target.db.getRepository('testGroup').findOne();
    expect(group.get('expression')).toBe('{{Qty}} * 2');
  });

  it('keeps key columns whose relation was deleted', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    const sdb = source.db;
    await createGeneralCollection(sdb, 'Items', 'Items', [{ name: 'Name', type: 'string', interface: 'input' }]);
    // A key column left behind after its relation field was deleted: still marked as foreign key, used by nothing.
    await sdb.getRepository('fields').create({
      values: { collectionName: 'Items', name: 'f_old', type: 'bigInt', interface: 'integer', isForeignKey: true },
      context: {},
    });
    await sdb.getRepository('Items').create({ values: { Name: 'Ring', f_old: 42 } });
    zipPath = (await new CollectionExporter(source).export({ collections: ['Items'], includeData: true })).filePath;
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    expect((await importer.preview(token)).problems).toEqual([]);
    await importer.import(token);
    const item = await target.db.getRepository('Items').findOne();
    expect(Number(item.get('f_old'))).toBe(42);
  });

  it('fills every field of a column shared by two fields when the naming differs', async () => {
    source = await createMockServer({ plugins: PLUGINS, database: { underscored: true } });
    const sdb = source.db;
    await createGeneralCollection(sdb, 'Statement', 'Statement', [
      { name: 'Amount', type: 'double', interface: 'number' },
    ]);
    // As after "sync from database": the key column of "Created by" also has a plain field of its own.
    await sdb.getRepository('fields').create({
      values: {
        collectionName: 'Statement',
        name: 'created_by_id',
        type: 'bigInt',
        interface: 'integer',
        field: 'created_by_id',
      },
      context: {},
    });
    await sdb.getRepository('Statement').create({ values: { Amount: 5 } });
    zipPath = (await new CollectionExporter(source).export({ collections: ['Statement'], includeData: true })).filePath;
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    expect((await importer.preview(token)).problems).toEqual([]);
    await importer.import(token);
    const row = await target.db.getRepository('Statement').findOne();
    expect(row.get('Amount')).toBe(5);
  });

  it('asks for a re-export when an older package lacks the primary key field', async () => {
    source = await createMockServer({ plugins: PLUGINS });
    await createVendorSchema(source.db);
    zipPath = (
      await new CollectionExporter(source).export({ collections: ['Bullion_vendor', 'Recordings'], includeData: false })
    ).filePath;
    await source.destroy();
    source = null;

    target = await createMockServer({ plugins: PLUGINS });
    const importer = new CollectionImporter(target);
    const token = await importer.receive(zipPath);
    const file = path.join(CollectionImporter.uploadDir(), token, COLLECTIONS_FILE);
    const collections = JSON.parse(await fsPromises.readFile(file, 'utf8')) as Row[];
    collections[0].fields = (collections[0].fields as Row[]).filter((field) => !field.primaryKey);
    await fsPromises.writeFile(file, JSON.stringify(collections));
    const preview = await importer.preview(token);
    expect(preview.problems).toContainEqual({ code: 'missingPrimaryKey', collection: 'Bullion_vendor' });
  });
});
