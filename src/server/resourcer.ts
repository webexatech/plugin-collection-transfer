import { Context, Next } from '@nocobase/actions';
import { koaMulter as multer, storagePathJoin } from '@nocobase/utils';
import crypto from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionExporter } from './exporter';
import { CollectionImporter, CONFLICT_MODES, ConflictMode, ImportBlockedError } from './importer';
// @ts-ignore
import pkg from '../../package.json';

export const RESOURCE_NAME = 'collectionTransfer';
// Translation namespace = package name, as on the client.
const NS: string = pkg.name;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const EXPORT_TOKEN = /^[0-9a-f-]{36}$/;
const EXPORT_TTL_MS = 60 * 60 * 1000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function exportsDir() {
  return storagePathJoin('tmp', 'collection-transfer-exports');
}

/** Exports that were never downloaded are removed after an hour. */
async function removeExpiredExports() {
  const root = exportsDir();
  const entries = await fsPromises.readdir(root).catch((): string[] => []);
  const now = Date.now();
  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    const stat = await fsPromises.stat(entryPath).catch(() => null);
    if (stat && now - stat.mtimeMs > EXPORT_TTL_MS) {
      await fsPromises.rm(entryPath, { recursive: true, force: true });
    }
  }
}

export default {
  name: RESOURCE_NAME,
  middleware: async (ctx: Context, next: Next) => {
    if (ctx.action.actionName !== 'preview') {
      return next();
    }
    const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_UPLOAD_BYTES } }).single('file');
    return upload(ctx, next);
  },
  actions: {
    async listCollections(ctx: Context, next: Next) {
      ctx.body = await new CollectionExporter(ctx.app).listCollections();
      await next();
    },

    async export(ctx: Context, next: Next) {
      const { collections, includeData } = ctx.action.params.values || {};
      if (!Array.isArray(collections) || !collections.length) {
        ctx.throw(400, ctx.t('Select at least one collection', { ns: NS }));
      }

      let result: Awaited<ReturnType<CollectionExporter['export']>>;
      try {
        result = await new CollectionExporter(ctx.app).export({ collections, includeData: !!includeData });
      } catch (error) {
        ctx.throw(400, errorMessage(error));
      }

      // The file is kept for a separate download request and only a small JSON summary is returned. Sending the
      // manifest in a response header made reverse proxies (nginx: 4–8 KB header buffer) answer with 502.
      await removeExpiredExports();
      const token = crypto.randomUUID();
      const dir = path.join(exportsDir(), token);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.rename(result.filePath, path.join(dir, result.fileName)).catch(async () => {
        await fsPromises.copyFile(result.filePath, path.join(dir, result.fileName));
        await fsPromises.rm(result.filePath, { force: true });
      });
      const { plugins, ...summary } = result.manifest;
      ctx.body = { token, fileName: result.fileName, manifest: summary };
      await next();
    },

    /** Streams a file prepared by `export` once, then deletes it. */
    async download(ctx: Context, next: Next) {
      const { token } = ctx.action.params;
      if (typeof token !== 'string' || !EXPORT_TOKEN.test(token)) {
        ctx.throw(400, 'Invalid download token');
      }
      // Claim the export by renaming its folder first, so a second request finds nothing even while this one streams.
      const dir = path.join(exportsDir(), token);
      const claimed = `${dir}.sending-${crypto.randomUUID()}`;
      const owned = await fsPromises
        .rename(dir, claimed)
        .then(() => true)
        .catch(() => false);
      const [fileName] = owned ? await fsPromises.readdir(claimed).catch((): string[] => []) : [];
      if (!fileName) {
        ctx.throw(404, 'Export not found or already downloaded');
      }
      const stream = fs.createReadStream(path.join(claimed, fileName));
      stream.on('close', () => {
        fsPromises.rm(claimed, { recursive: true, force: true }).catch((error) => ctx.app.log.warn(error));
      });
      ctx.attachment(fileName);
      ctx.body = stream;
      await next();
    },

    /** Multipart upload of a package; returns what would be created and any blocking problems. No writes. */
    async preview(ctx: Context, next: Next) {
      const file = (ctx as Context & { file?: { path: string } }).file;
      if (!file) {
        ctx.throw(400, ctx.t('Upload a package file', { ns: NS }));
      }

      const importer = new CollectionImporter(ctx.app);
      let token: string;
      try {
        token = await importer.receive(file.path);
      } catch (error) {
        ctx.throw(400, errorMessage(error));
      } finally {
        await fsPromises.rm(file.path, { force: true });
      }

      try {
        ctx.body = await importer.preview(token);
      } catch (error) {
        await importer.discard(token);
        ctx.throw(400, errorMessage(error));
      }
      await next();
    },

    async import(ctx: Context, next: Next) {
      const { token, resolutions: rawResolutions, trustExpressions } = ctx.action.params.values || {};
      // Only known modes for valid names are passed on; anything else counts as unresolved.
      const resolutions: Record<string, ConflictMode> = {};
      if (rawResolutions && typeof rawResolutions === 'object' && !Array.isArray(rawResolutions)) {
        for (const [name, mode] of Object.entries(rawResolutions as Record<string, unknown>)) {
          if (CONFLICT_MODES.includes(mode as ConflictMode)) resolutions[name] = mode as ConflictMode;
        }
      }
      if (typeof token !== 'string') {
        ctx.throw(400, ctx.t('Upload a package file', { ns: NS }));
      }

      try {
        const userId = (ctx.state.currentUser as { id?: string | number } | undefined)?.id ?? null;
        ctx.body = await new CollectionImporter(ctx.app).import(token, {
          userId,
          resolutions,
          trustExpressions: trustExpressions === true,
        });
      } catch (error) {
        if (error instanceof ImportBlockedError) {
          ctx.status = 409;
          // Same shape as NocoBase errors ({ errors }), plus the problems; not wrapped in { data }.
          ctx.withoutDataWrapping = true;
          ctx.body = { errors: [{ message: error.message }], problems: error.problems };
          return;
        }
        ctx.throw(400, errorMessage(error));
      }
      await next();
    },
  },
};
