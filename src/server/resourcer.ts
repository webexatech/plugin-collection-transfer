import { Context, Next } from '@nocobase/actions';
import { koaMulter as multer } from '@nocobase/utils';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import { CollectionExporter } from './exporter';
import { CollectionImporter, CONFLICT_MODES, ConflictMode, ImportBlockedError } from './importer';
// @ts-ignore
import pkg from '../../package.json';

export const RESOURCE_NAME = 'collectionTransfer';
// Translation namespace = package name, as on the client.
const NS: string = pkg.name;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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

      const stream = fs.createReadStream(result.filePath);
      stream.on('close', () => {
        fsPromises.rm(result.filePath, { force: true }).catch((error) => ctx.app.log.warn(error));
      });
      ctx.attachment(result.fileName);
      ctx.set('X-Collection-Transfer-Manifest', encodeURIComponent(JSON.stringify(result.manifest)));
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
      const { token, resolutions: rawResolutions } = ctx.action.params.values || {};
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
        ctx.body = await new CollectionImporter(ctx.app).import(token, { userId, resolutions });
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
