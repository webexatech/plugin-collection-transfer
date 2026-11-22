import { useAPIClient, useDataSourceManager } from '@nocobase/client';
import React, { useMemo } from 'react';
// The v1 client may import from the v2 client (never the other way round).
import { CollectionTransferSettings, TransferServices } from '../client-v2/CollectionTransferSettings';

/** Settings page for the v1 client (`/admin`): wires the shared page to the v1 API client and registries. */
export const SettingsPage: React.FC = () => {
  const api = useAPIClient();
  const dataSourceManager = useDataSourceManager();
  const services = useMemo<TransferServices>(
    () => ({
      request: (config) => api.request(config),
      hasFieldInterface: (name) => !!dataSourceManager?.collectionFieldInterfaceManager.getFieldInterface(name),
    }),
    [api, dataSourceManager],
  );
  return <CollectionTransferSettings services={services} />;
};
