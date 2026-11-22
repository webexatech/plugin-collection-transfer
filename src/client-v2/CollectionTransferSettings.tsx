import { InboxOutlined } from '@ant-design/icons';
import {
  Alert,
  Modal,
  Radio,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
  UploadProps,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { TOptions } from 'i18next';
import React, { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useT } from './locale';

/**
 * What the page needs from the host client. The v1 (`@nocobase/client`) and v2 (`@nocobase/client-v2`) settings
 * pages each pass their own implementation, so this component imports neither runtime.
 */
export interface TransferServices {
  request: (config: {
    url: string;
    method: 'get' | 'post';
    params?: Record<string, string>;
    data?: unknown;
    responseType?: 'blob' | 'json';
  }) => Promise<{ data: any; headers?: Record<string, string> }>;
  /** Whether the host UI knows a field interface (some plugins register interfaces only in the browser). */
  hasFieldInterface: (name: string) => boolean;
}

const ServicesContext = createContext<TransferServices | null>(null);

function useServices(): TransferServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('CollectionTransferSettings needs TransferServices');
  return services;
}

interface TransferableCollection {
  name: string;
  title: string;
  template: string;
  supported: boolean;
  unsupportedReason?: string;
  related: string[];
}

/** Collections reachable through relations from the selection (transitively) that are not selected yet. */
function missingRelated(collections: TransferableCollection[], selected: React.Key[]) {
  const byName = new Map(collections.map((collection) => [collection.name, collection]));
  const chosen = new Set(selected.map(String));
  const missing = new Set<string>();
  const queue = [...chosen];
  while (queue.length) {
    const current = byName.get(queue.shift());
    for (const name of current?.related || []) {
      if (chosen.has(name) || missing.has(name)) continue;
      missing.add(name);
      queue.push(name);
    }
  }
  return [...missing].map((name) => byName.get(name)).filter(Boolean);
}

interface Manifest {
  sourceAppVersion: string;
  dialect: string;
  exportedAt: string;
  includeData: boolean;
  selected: string[];
  collections: string[];
  through: string[];
  dependencies: string[];
}

interface Problem {
  code: string;
  collection?: string;
  field?: string;
  detail?: string;
}

interface PreviewCollection {
  name: string;
  title: string;
  fieldCount: number;
  rowCount: number;
  isThrough: boolean;
}

interface PreviewInterface {
  interface: string;
  collection: string;
  field: string;
}

interface PreviewConflict {
  name: string;
  title: string;
  referencedBy: { collection: string; field: string; restored: boolean }[];
  missingColumns: string[];
}

interface Preview {
  token: string;
  manifest: Manifest;
  collections: PreviewCollection[];
  problems: Problem[];
  interfaces: PreviewInterface[];
  missingPlugins: string[];
  conflicts: PreviewConflict[];
  expressions: Problem[];
  /** Not blocking: what the import does not carry (absent in plugin versions before 0.1.5). */
  notices?: Problem[];
}

interface ImportResult {
  collections: string[];
  overridden: string[];
  skipped: string[];
  through: string[];
  rowCounts: Record<string, number>;
}

interface ApiErrorShape {
  response?: { data?: unknown; status?: number };
  message?: string;
}

/** Server errors arrive as `{ errors: [{ message }] }`, or as a Blob when the request expected a file. */
async function readError(error: unknown): Promise<string> {
  const { response, message } = (error || {}) as ApiErrorShape;
  let data = response?.data;
  if (data instanceof Blob) {
    try {
      data = JSON.parse(await data.text());
    } catch (e) {
      data = undefined;
    }
  }
  const errors = (data as { errors?: { message?: string }[] })?.errors;
  return errors?.[0]?.message || message || String(error);
}

type Translate = (key: string, options?: TOptions) => string;

function problemMessage(t: Translate, problem: Problem) {
  const values = { collection: problem.collection, field: problem.field, detail: problem.detail };
  switch (problem.code) {
    case 'collectionExists':
      return t('Collection "{{collection}}" already exists in this environment', values);
    case 'tableExists':
      return t('A database table for "{{collection}}" already exists in this environment', values);
    case 'missingDependency':
      return t(
        'Collection "{{collection}}" is referenced by a relation but does not exist in this environment',
        values,
      );
    case 'unknownFieldType':
      return t('Field "{{collection}}.{{field}}" uses type "{{detail}}", which is not available here', values);
    case 'unsupportedTemplate':
      return t('Collection "{{collection}}" uses template "{{detail}}", which cannot be transferred', values);
    case 'missingTemplatePlugin':
      return t('Collection "{{collection}}" needs the plugin {{detail}}; enable it here first', values);
    case 'inheritanceNeedsPostgres':
      return t('Collection "{{collection}}" inherits from another collection, which needs PostgreSQL', values);
    case 'missingView':
      return t('View collection "{{collection}}" needs the database view "{{detail}}"; create it here first', values);
    case 'missingDatabaseServer':
      return t('Collection "{{collection}}" needs the database server "{{detail}}"; add it here first', values);
    case 'missingStorage':
      return t('File collection "{{collection}}" needs the file storage "{{detail}}"; add it here first', values);
    case 'unsafeSql':
      return t('The SQL of collection "{{collection}}" is not allowed ({{detail}})', values);
    case 'sqlStatement':
      return t('"{{collection}}" runs this SQL: {{detail}}', values);
    case 'filesNotCarried':
      return t(
        'File collection "{{collection}}": the file records are imported, the files themselves are not. They must be reachable in a storage of the same name here.',
        values,
      );
    case 'relationRowsNotCarried':
      return t(
        '"{{collection}}.{{field}}": links to {{detail}} are not imported, because those records differ between environments',
        values,
      );
    case 'dataNotCarried':
      return t('"{{collection}}" ({{detail}}) has no data of its own; it shows the data of this environment', values);
    case 'identifierTooLong':
      return t('Name "{{detail}}" in "{{collection}}" is too long for the database', {
        ...values,
        detail: problem.detail || problem.collection,
      });
    case 'dialect':
      return t('The package was exported from a different database type ({{detail}})', values);
    case 'formatVersion':
      return t('The package format version {{detail}} is not supported', values);
    case 'unknownInterface':
      return t(
        'Field "{{collection}}.{{field}}" uses the "{{detail}}" field kind, which is not available here',
        values,
      );
    case 'systemCollection':
      return t('"{{collection}}" is a system or plugin collection here and cannot be replaced by an import', values);
    case 'unresolvedConflict':
      return t('Choose what to do with the existing collection "{{collection}}"', values);
    case 'columnsMismatch':
      return t('"{{collection}}" here lacks columns from the file ({{detail}}), so its data cannot be added', values);
    case 'outsidePackage':
      return t('"{{collection}}" would change something outside the package: {{detail}}', values);
    case 'unsafeExpression':
      return problem.field
        ? t('"{{collection}}.{{field}}": {{detail}}', values)
        : t('"{{collection}}": {{detail}}', values);
    case 'missingPrimaryKey':
      return t(
        '"{{collection}}" has no primary key field in this file; export it again with plugin 0.1.5 or later',
        values,
      );
    case 'expressionsNotConfirmed':
      return t('Confirm that you trust this file before importing its expressions', values);
    case 'invalidName':
      return t('Collection name "{{collection}}" is not valid', values);
    default:
      return t('The package is incomplete or damaged ({{detail}})', {
        ...values,
        detail: problem.detail || problem.code,
      });
  }
}

// Titles in an uploaded package are untrusted. NocoBase's compile() evaluates `{{ ... }}` expressions, so the
// preview never passes package strings to it: only the exact `{{t("key")}}` form NocoBase writes for built-in
// titles is translated, everything else is shown as plain text.
const TRANSLATION_TEMPLATE = /^\{\{\s*t\(\s*(["'])([^"'{}]*)\1\s*\)\s*\}\}$/;

function usePackageText() {
  const { t } = useTranslation('client');
  return (value: string) => {
    const match = TRANSLATION_TEMPLATE.exec(value || '');
    return match ? t(match[2]) : value;
  };
}

function downloadBlob(data: BlobPart, fileName: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fileNameFromDisposition(disposition: string | undefined) {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || '');
  return match ? decodeURIComponent(match[1]) : 'collections.zip';
}

const ExportPanel: React.FC = () => {
  const t = useT();
  // Collection titles are shown with the same restricted translator as package text: no expression evaluation.
  const displayTitle = usePackageText();
  const api = useServices();
  const switchId = useId();
  const [collections, setCollections] = useState<TransferableCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [includeData, setIncludeData] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [lastExport, setLastExport] = useState<Manifest>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const { data } = await api.request({ url: 'collectionTransfer:listCollections', method: 'get' });
      setCollections(data?.data || []);
    } catch (e) {
      setError(await readError(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const handleExport = async () => {
    setExporting(true);
    setError(undefined);
    setLastExport(undefined);
    try {
      // Two requests: the export returns a small JSON summary and a token, the file is then downloaded with it.
      const { data } = await api.request({
        url: 'collectionTransfer:export',
        method: 'post',
        data: { collections: selected, includeData },
      });
      const exported = data?.data as { token: string; fileName: string; manifest: Manifest };
      const file = await api.request({
        url: 'collectionTransfer:download',
        method: 'get',
        params: { token: exported.token },
        responseType: 'blob',
      });
      downloadBlob(file.data, exported.fileName || fileNameFromDisposition(file.headers?.['content-disposition']));
      setLastExport(exported.manifest);
    } catch (e) {
      setError(await readError(e));
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<TransferableCollection> = [
    { title: t('Title'), dataIndex: 'title', render: (value: string) => displayTitle(value) },
    { title: t('Name'), dataIndex: 'name', render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
    {
      title: t('Template'),
      dataIndex: 'template',
      render: (value: string, record) =>
        record.supported ? (
          <Tag>{value}</Tag>
        ) : (
          <Tooltip title={t('Only general collections can be transferred in this version')}>
            <Tag color="warning">{t('Not supported')}</Tag>
          </Tooltip>
        ),
    },
  ];

  const companions = lastExport ? lastExport.collections.filter((name) => !lastExport.selected.includes(name)) : [];
  const related = missingRelated(collections, selected);
  const addable = related.filter((collection) => collection.supported);
  const notAddable = related.filter((collection) => !collection.supported);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('Select the collections to export. The file can be imported into another environment.')}
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon message={error} role="alert" />}
      <Table
        rowKey="name"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={collections}
        pagination={false}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: setSelected,
          getCheckboxProps: (record) => ({ disabled: !record.supported, 'aria-label': displayTitle(record.title) }),
        }}
        locale={{ emptyText: t('No collections to export') }}
      />
      {related.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t('The selected collections have relations to collections that are not selected: {{names}}', {
            names: related.map((collection) => `${displayTitle(collection.title)} (${collection.name})`).join(', '),
          })}
          description={
            <Space direction="vertical" size={4}>
              <span>
                {t('The import refuses relations to collections that are neither in the file nor in the target.')}
              </span>
              {notAddable.length > 0 && (
                <span>
                  {t('These cannot be transferred and must already exist in the target: {{names}}', {
                    names: notAddable.map((collection) => collection.name).join(', '),
                  })}
                </span>
              )}
            </Space>
          }
          action={
            addable.length > 0 ? (
              <Button
                size="small"
                onClick={() => setSelected((prev) => [...prev, ...addable.map((collection) => collection.name)])}
              >
                {t('Add related collections')}
              </Button>
            ) : undefined
          }
        />
      )}
      <Space align="center" wrap>
        <Switch id={switchId} checked={includeData} onChange={setIncludeData} />
        <label htmlFor={switchId}>{t('Include data')}</label>
        <Button type="primary" onClick={handleExport} loading={exporting} disabled={!selected.length}>
          {t('Export')}
        </Button>
      </Space>
      {lastExport && (
        <Alert
          type="success"
          showIcon
          role="status"
          message={t('Exported {{count}} collection(s)', { count: lastExport.collections.length })}
          description={
            <Space direction="vertical" size={4}>
              {companions.length > 0 && (
                <span>{t('Added because they are needed: {{names}}', { names: companions.join(', ') })}</span>
              )}
              {lastExport.dependencies.length > 0 && (
                <span>
                  {t('Must already exist in the target environment: {{names}}', {
                    names: lastExport.dependencies.join(', '),
                  })}
                </span>
              )}
            </Space>
          }
        />
      )}
    </Space>
  );
};

type ConflictMode = 'skipCollectionImportData' | 'skipAll' | 'overrideSchema' | 'overrideAll';
const DATA_MODES: ConflictMode[] = ['skipCollectionImportData', 'overrideAll'];
const OVERRIDE_MODES: ConflictMode[] = ['overrideSchema', 'overrideAll'];

const ImportPanel: React.FC = () => {
  const t = useT();
  const packageText = usePackageText();
  const api = useServices();
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [resolutions, setResolutions] = useState<Record<string, ConflictMode>>({});
  const [trusted, setTrusted] = useState(false);
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState<string>();

  // Field interfaces live in the browser (some plugins register none on the server), so this check runs here.
  const unknownInterfaces: Problem[] = (preview?.interfaces || [])
    .filter((item) => !api.hasFieldInterface(item.interface))
    .map((item) => ({
      code: 'unknownInterface',
      collection: item.collection,
      field: item.field,
      detail: item.interface,
    }));
  const problems = [...(preview?.problems || []), ...unknownInterfaces];

  const includeData = !!preview?.manifest.includeData;
  const conflicts = preview?.conflicts || [];
  const expressions = preview?.expressions || [];
  const notices = preview?.notices || [];
  const overridden = conflicts.filter((conflict) => OVERRIDE_MODES.includes(resolutions[conflict.name]));
  // Collections recreated by this import: new ones plus overridden ones. Fields elsewhere that point at an overridden
  // collection are removed by NocoBase unless their own collection is recreated here too.
  const recreated = new Set([
    ...(preview?.manifest.collections || []).filter((name) => !conflicts.some((c) => c.name === name)),
    ...overridden.map((conflict) => conflict.name),
  ]);
  const lostFields = overridden.flatMap((conflict) =>
    conflict.referencedBy
      .filter((ref) => !recreated.has(ref.collection) && !ref.restored)
      .map((ref) => `${ref.collection}.${ref.field}`),
  );

  const reset = () => {
    setPreview(undefined);
    setResolutions({});
    setTrusted(false);
    setResult(undefined);
    setError(undefined);
  };

  const showPreview = (next: Preview) => {
    setPreview(next);
    const defaults: Record<string, ConflictMode> = {};
    for (const conflict of next.conflicts || []) {
      defaults[conflict.name] = next.manifest.includeData ? 'overrideAll' : 'overrideSchema';
    }
    setResolutions(defaults);
    setTrusted(false);
  };

  const uploadPackage: UploadProps['customRequest'] = async ({ file, onSuccess, onError }) => {
    reset();
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file as Blob);
    try {
      const { data } = await api.request({ url: 'collectionTransfer:preview', method: 'post', data: formData });
      showPreview(data?.data as Preview);
      onSuccess?.(data);
    } catch (e) {
      setError(await readError(e));
      onError?.(e as Error);
    } finally {
      setUploading(false);
    }
  };

  const runImport = async () => {
    if (!preview) return;
    setConfirming(false);
    setImporting(true);
    setError(undefined);
    try {
      const { data } = await api.request({
        url: 'collectionTransfer:import',
        method: 'post',
        data: { token: preview.token, resolutions, trustExpressions: trusted },
      });
      setResult(data?.data as ImportResult);
      setPreview(undefined);
    } catch (e) {
      const blocked = ((e as ApiErrorShape)?.response?.data as { problems?: Problem[] })?.problems;
      if (blocked?.length) {
        setPreview({ ...preview, problems: blocked });
      }
      setError(await readError(e));
    } finally {
      setImporting(false);
    }
  };

  const handleImport = () => {
    if (overridden.length) {
      setConfirming(true);
      return;
    }
    runImport();
  };

  const previewColumns: ColumnsType<PreviewCollection> = [
    {
      title: t('Collection'),
      dataIndex: 'title',
      render: (value: string, record) => (
        <Space size={4}>
          <span>{packageText(value)}</span>
          <Typography.Text type="secondary" code>
            {record.name}
          </Typography.Text>
          {record.isThrough && <Tag>{t('Junction table')}</Tag>}
        </Space>
      ),
    },
    { title: t('Fields'), dataIndex: 'fieldCount', width: 100, render: (v: number, r) => (r.isThrough ? '–' : v) },
    {
      title: t('Rows'),
      dataIndex: 'rowCount',
      width: 100,
      render: (value: number) => (includeData ? value : '–'),
    },
  ];

  const modeLabels: Record<ConflictMode, string> = {
    skipCollectionImportData: t('Skip collection, import data'),
    skipAll: t('Skip collection and data'),
    overrideSchema: t('Override collection, without data'),
    overrideAll: t('Override collection and data'),
  };

  const conflictColumns: ColumnsType<PreviewConflict> = [
    {
      title: t('Collection'),
      dataIndex: 'title',
      width: '35%',
      render: (value: string, record) => (
        <Space size={4} wrap>
          <span>{packageText(value)}</span>
          <Typography.Text type="secondary" code>
            {record.name}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: t('What to do'),
      dataIndex: 'name',
      render: (name: string, record) => {
        const columnsMissing = includeData && record.missingColumns.length > 0;
        return (
          <Radio.Group
            aria-label={t('What to do with "{{name}}"', { name })}
            value={resolutions[name]}
            onChange={(event) => setResolutions((prev) => ({ ...prev, [name]: event.target.value as ConflictMode }))}
          >
            <Space direction="vertical" size={2}>
              {(Object.keys(modeLabels) as ConflictMode[]).map((mode) => {
                const noData = !includeData && DATA_MODES.includes(mode);
                const disabled = noData || (mode === 'skipCollectionImportData' && columnsMissing);
                const hint = noData
                  ? t('The file contains no data')
                  : mode === 'skipCollectionImportData' && columnsMissing
                    ? t('Missing columns here: {{columns}}', { columns: record.missingColumns.join(', ') })
                    : undefined;
                return (
                  <Radio key={mode} value={mode} disabled={disabled}>
                    {modeLabels[mode]}
                    {hint && (
                      <Typography.Text type="secondary" style={{ marginInlineStart: 8 }}>
                        ({hint})
                      </Typography.Text>
                    )}
                  </Radio>
                );
              })}
            </Space>
          </Radio.Group>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Upload.Dragger
        accept=".zip"
        maxCount={1}
        showUploadList={false}
        customRequest={uploadPackage}
        disabled={uploading || importing}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined aria-hidden />
        </p>
        <p className="ant-upload-text">{t('Click or drag a collection package (.zip) here')}</p>
        <p className="ant-upload-hint">{t('Nothing is changed until you confirm the import.')}</p>
      </Upload.Dragger>

      {uploading && <Alert type="info" showIcon message={t('Checking package…')} role="status" aria-busy />}
      {error && <Alert type="error" showIcon message={error} role="alert" />}

      {preview && (
        <Card size="small" title={t('Preview')}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label={t('Exported at')}>
                {new Date(preview.manifest.exportedAt).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label={t('Source version')}>{preview.manifest.sourceAppVersion}</Descriptions.Item>
              <Descriptions.Item label={t('Includes data')}>{includeData ? t('Yes') : t('No')}</Descriptions.Item>
              <Descriptions.Item label={t('Requires')}>
                {preview.manifest.dependencies.join(', ') || '–'}
              </Descriptions.Item>
            </Descriptions>

            <Table
              rowKey="name"
              size="small"
              columns={previewColumns}
              dataSource={preview.collections}
              pagination={false}
            />

            {notices.length > 0 && (
              <Alert
                type="info"
                showIcon
                message={t('Not part of the import')}
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {notices.map((notice) => (
                      <li key={`${notice.code}-${notice.collection}-${notice.field}`}>{problemMessage(t, notice)}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {expressions.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('This file contains expressions or SQL queries that NocoBase evaluates in this environment')}
                description={
                  <Space direction="vertical" size={4}>
                    <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                      {expressions.map((item) => (
                        <li key={`${item.collection}-${item.field}-${item.detail}`}>
                          <Typography.Text code>{problemMessage(t, item)}</Typography.Text>
                        </li>
                      ))}
                    </ul>
                    <span>{t('Only import files from environments you trust.')}</span>
                    <Checkbox checked={trusted} onChange={(event) => setTrusted(event.target.checked)}>
                      {t('I trust this file and want to import them')}
                    </Checkbox>
                  </Space>
                }
              />
            )}
            {conflicts.length > 0 && (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {t('Already exists here')}
                </Typography.Title>
                <Table rowKey="name" size="small" columns={conflictColumns} dataSource={conflicts} pagination={false} />
                {lostFields.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    message={t('Overriding also removes these fields from other collections: {{fields}}', {
                      fields: lostFields.join(', '),
                    })}
                  />
                )}
              </Space>
            )}

            {problems.length > 0 ? (
              <Alert
                type="error"
                showIcon
                role="alert"
                message={t('This package cannot be imported here')}
                description={
                  <Space direction="vertical" size={4}>
                    <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                      {problems.map((problem) => (
                        <li key={`${problem.code}-${problem.collection}-${problem.field}-${problem.detail}`}>
                          {problemMessage(t, problem)}
                        </li>
                      ))}
                    </ul>
                    {unknownInterfaces.length > 0 && preview.missingPlugins.length > 0 && (
                      <span>
                        {t('Enabled in the source environment but not here: {{names}}', {
                          names: preview.missingPlugins.join(', '),
                        })}
                      </span>
                    )}
                  </Space>
                }
              />
            ) : (
              <Alert
                type="success"
                showIcon
                message={t('Ready to import. All collections are created in a single step and rolled back on error.')}
              />
            )}

            <Space>
              <Button
                type="primary"
                onClick={handleImport}
                loading={importing}
                disabled={problems.length > 0 || (expressions.length > 0 && !trusted)}
              >
                {t('Import')}
              </Button>
              <Button onClick={reset} disabled={importing}>
                {t('Cancel')}
              </Button>
            </Space>
          </Space>
        </Card>
      )}

      <Modal
        open={confirming}
        title={t('Replace existing collections?')}
        okText={t('Replace and import')}
        okButtonProps={{ danger: true }}
        cancelText={t('Cancel')}
        onOk={runImport}
        onCancel={() => setConfirming(false)}
      >
        <Space direction="vertical" size="small">
          <span>{t('The existing data of these collections will be permanently deleted:')}</span>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {overridden.map((conflict) => (
              <li key={conflict.name}>
                {packageText(conflict.title)} <Typography.Text code>{conflict.name}</Typography.Text> –{' '}
                {modeLabels[resolutions[conflict.name]]}
              </li>
            ))}
          </ul>
          {lostFields.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={t('Overriding also removes these fields from other collections: {{fields}}', {
                fields: lostFields.join(', '),
              })}
            />
          )}
        </Space>
      </Modal>

      {result && (
        <Alert
          type="success"
          showIcon
          role="status"
          message={t('Imported {{count}} collection(s)', { count: result.collections.length })}
          description={
            <Space direction="vertical" size={4}>
              {result.overridden.length > 0 && (
                <span>{t('Overridden: {{names}}', { names: result.overridden.join(', ') })}</span>
              )}
              {result.skipped.length > 0 && (
                <span>{t('Skipped: {{names}}', { names: result.skipped.join(', ') })}</span>
              )}
              {Object.keys(result.rowCounts).length > 0 ? (
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {Object.entries(result.rowCounts).map(([name, count]) => (
                    <li key={name}>{t('{{name}}: {{count}} row(s)', { name, count })}</li>
                  ))}
                </ul>
              ) : (
                <span>{t('No rows were imported.')}</span>
              )}
            </Space>
          }
        />
      )}
    </Space>
  );
};

const SettingsTabs: React.FC = () => {
  const t = useT();
  return (
    <Card variant="borderless">
      <Tabs
        items={[
          { key: 'export', label: t('Export'), children: <ExportPanel /> },
          { key: 'import', label: t('Import'), children: <ImportPanel /> },
        ]}
      />
    </Card>
  );
};

export const CollectionTransferSettings: React.FC<{ services: TransferServices }> = ({ services }) => (
  <ServicesContext.Provider value={services}>
    <SettingsTabs />
  </ServicesContext.Provider>
);
