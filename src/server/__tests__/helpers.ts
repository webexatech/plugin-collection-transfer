import { Database } from '@nocobase/database';
import { createMockServer, MockServer } from '@nocobase/test';
import decompress from '@xhmikosr/decompress';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import PluginCollectionTransferServer from '../plugin';

export const TEST_PLUGINS = [
  'error-handler',
  'field-sort',
  'auth',
  'users',
  'acl',
  'data-source-manager',
  'data-source-main',
  'system-settings',
  'ui-schema-storage',
  PluginCollectionTransferServer,
];

// createMockServer disables ACL unless asked; tests that check permissions pass `acl: true`.
export async function createApp(options: { acl?: boolean } = {}): Promise<MockServer> {
  return createMockServer({ plugins: TEST_PLUGINS, acl: !!options.acl });
}

// The preset fields the collection manager UI sends for a new general collection
// (plugin-data-source-main/src/client/index.ts), together with `autoGenId: false`.
function presetFields() {
  return [
    {
      name: 'id',
      type: 'snowflakeId',
      autoIncrement: false,
      primaryKey: true,
      allowNull: false,
      interface: 'snowflakeId',
      uiSchema: { type: 'number', title: '{{t("ID")}}', 'x-component': 'InputNumber' },
    },
    {
      name: 'createdAt',
      interface: 'createdAt',
      type: 'date',
      field: 'createdAt',
      uiSchema: { type: 'datetime', title: '{{t("Created at")}}', 'x-component': 'DatePicker' },
    },
    {
      name: 'createdBy',
      interface: 'createdBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'createdById',
      uiSchema: { type: 'object', title: '{{t("Created by")}}', 'x-component': 'AssociationField' },
    },
    {
      name: 'updatedAt',
      interface: 'updatedAt',
      type: 'date',
      field: 'updatedAt',
      uiSchema: { type: 'datetime', title: '{{t("Last updated at")}}', 'x-component': 'DatePicker' },
    },
    {
      name: 'updatedBy',
      interface: 'updatedBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'updatedById',
      uiSchema: { type: 'object', title: '{{t("Last updated by")}}', 'x-component': 'AssociationField' },
    },
  ];
}

export async function createGeneralCollection(
  db: Database,
  name: string,
  title: string,
  fields: Record<string, unknown>[] = [],
) {
  await db.getRepository('collections').create({
    values: {
      name,
      title,
      template: 'general',
      autoGenId: false,
      createdAt: true,
      updatedAt: true,
      createdBy: true,
      updatedBy: true,
      logging: true,
      fields: [...presetFields(), ...fields],
    },
    context: {},
  });
}

export async function createAssociation(db: Database, values: Record<string, unknown>) {
  await db.getRepository('fields').create({
    values,
    updateAssociationValues: ['reverseField'],
    context: {},
  });
}

/** projects 1-n tasks (with reverse field), tasks n-n tags (auto-created through, with reverse field). */
export async function createProjectSchema(db: Database) {
  await createGeneralCollection(db, 'projects', 'Projects', [
    {
      name: 'title',
      type: 'string',
      interface: 'input',
      uiSchema: { type: 'string', title: 'Title', 'x-component': 'Input' },
    },
    {
      name: 'status',
      type: 'string',
      interface: 'select',
      uiSchema: {
        type: 'string',
        title: 'Status',
        'x-component': 'Select',
        enum: [
          { value: 'open', label: 'Open' },
          { value: 'done', label: 'Done' },
        ],
      },
    },
  ]);
  await createGeneralCollection(db, 'tasks', 'Tasks', [
    {
      name: 'name',
      type: 'string',
      interface: 'input',
      uiSchema: { type: 'string', title: 'Name', 'x-component': 'Input' },
    },
    {
      name: 'dueDate',
      type: 'date',
      interface: 'datetime',
      uiSchema: { type: 'string', title: 'Due date', 'x-component': 'DatePicker' },
    },
  ]);
  await createGeneralCollection(db, 'tags', 'Tags', [
    {
      name: 'label',
      type: 'string',
      interface: 'input',
      uiSchema: { type: 'string', title: 'Label', 'x-component': 'Input' },
    },
  ]);

  await createAssociation(db, {
    collectionName: 'tasks',
    name: 'project',
    type: 'belongsTo',
    interface: 'm2o',
    target: 'projects',
    foreignKey: 'projectId',
    uiSchema: { title: 'Project', 'x-component': 'AssociationField' },
    reverseField: {
      name: 'tasks',
      interface: 'o2m',
      uiSchema: { title: 'Tasks', 'x-component': 'AssociationField' },
    },
  });

  await createAssociation(db, {
    collectionName: 'tasks',
    name: 'tags',
    type: 'belongsToMany',
    interface: 'm2m',
    target: 'tags',
    uiSchema: { title: 'Tags', 'x-component': 'AssociationField' },
    reverseField: {
      name: 'tasks',
      interface: 'm2m',
      uiSchema: { title: 'Tasks', 'x-component': 'AssociationField' },
    },
  });
}

/** Extracts an exported zip into a temp dir and returns a reader for its files. */
export async function openPackage(zipPath: string) {
  const dir = path.resolve(
    os.tmpdir(),
    `collection-transfer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await decompress(zipPath, dir);
  return {
    dir,
    async json<T>(relativePath: string): Promise<T> {
      return JSON.parse(await fsPromises.readFile(path.join(dir, relativePath), 'utf8')) as T;
    },
    async lines(relativePath: string): Promise<unknown[][]> {
      const content = await fsPromises.readFile(path.join(dir, relativePath), 'utf8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown[]);
    },
    async exists(relativePath: string) {
      return fsPromises
        .stat(path.join(dir, relativePath))
        .then(() => true)
        .catch(() => false);
    },
    async cleanup() {
      await fsPromises.rm(dir, { recursive: true, force: true });
    },
  };
}
