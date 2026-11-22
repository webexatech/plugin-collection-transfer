import { useApp } from '@nocobase/client-v2';
import React, { useMemo } from 'react';
import { CollectionTransferSettings, TransferServices } from './CollectionTransferSettings';

interface FieldInterfaceLookup {
  collectionFieldInterfaceManager?: { getFieldInterface: (name: string) => unknown };
}

/** Settings page for the v2 client: wires the shared page to the v2 application's API client and registries. */
const SettingsPage: React.FC = () => {
  const app = useApp();
  const services = useMemo<TransferServices>(
    () => ({
      request: (config) => app.apiClient.request(config),
      hasFieldInterface: (name) =>
        !!(app.dataSourceManager as FieldInterfaceLookup)?.collectionFieldInterfaceManager?.getFieldInterface(name),
    }),
    [app],
  );
  return <CollectionTransferSettings services={services} />;
};

export default SettingsPage;
