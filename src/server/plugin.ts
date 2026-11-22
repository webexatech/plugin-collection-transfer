import { Plugin } from '@nocobase/server';
import resourcer from './resourcer';

export const ACL_SNIPPET = 'pm.collection-transfer';

export class PluginCollectionTransferServer extends Plugin {
  async load() {
    this.app.acl.registerSnippet({
      name: ACL_SNIPPET,
      actions: ['collectionTransfer:*'],
    });

    this.app.resourceManager.define(resourcer);
  }
}

export default PluginCollectionTransferServer;
