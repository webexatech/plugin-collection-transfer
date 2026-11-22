import type { TOptions } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
// @ts-ignore
import pkg from '../../package.json';

export const NAMESPACE: string = pkg.name;

/**
 * Translation hook for this plugin. React already escapes rendered text, so i18next's own HTML escaping is turned
 * off; otherwise interpolated values such as "@nocobase/plugin-x" render as "@nocobase&#x2F;plugin-x".
 */
export function useT() {
  const { t } = useTranslation([NAMESPACE, 'client'], { nsMode: 'fallback' });
  return useCallback(
    (key: string, options?: TOptions) =>
      t(key, { ...options, interpolation: { escapeValue: false, ...options?.interpolation } }) as string,
    [t],
  );
}
