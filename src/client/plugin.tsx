import { lazy, Plugin } from '@nocobase/client';
import { NAMESPACE } from '../client-v2/locale';

const { SettingsPage } = lazy(() => import('./SettingsPage'), 'SettingsPage');

export class PluginCollectionTransferClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('collection-transfer', {
      title: this.t('Collection transfer', { ns: NAMESPACE }),
      icon: 'SwapOutlined',
      Component: SettingsPage,
      aclSnippet: 'pm.collection-transfer',
    });
  }
}

export default PluginCollectionTransferClient;
