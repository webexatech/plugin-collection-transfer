import type { Application } from '@nocobase/client-v2';
import { Plugin } from '@nocobase/client-v2';
import { NAMESPACE } from './locale';

export const ACL_SNIPPET = 'pm.collection-transfer';

export class PluginCollectionTransferClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    const title = this.t('Collection transfer', { ns: NAMESPACE }) as unknown as string;

    this.pluginSettingsManager.addMenuItem({
      key: 'collection-transfer',
      title,
      icon: 'SwapOutlined',
      aclSnippet: ACL_SNIPPET,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'collection-transfer',
      key: 'index',
      title,
      componentLoader: () => import('./SettingsPage'),
    });
  }
}

export default PluginCollectionTransferClientV2;
