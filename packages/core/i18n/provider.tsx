"use client";

import { useEffect, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "./create-i18n";
import type { LocaleResources, SupportedLocale } from "./types";

export interface I18nProviderProps {
  locale: SupportedLocale;
  resources: Record<string, LocaleResources>;
  children: ReactNode;
}

export function I18nProvider({
  locale,
  resources,
  children,
}: I18nProviderProps) {
  // Lazy init via useState so the instance survives re-renders.
  // Locale is determined at boot; language switching goes through
  // window.location.reload(). Resource objects can change during Vite HMR,
  // so the effect below refreshes bundles without recreating the provider.
  const [instance] = useState(() => createI18n(locale, resources));

  useEffect(() => {
    for (const [lng, namespaces] of Object.entries(resources)) {
      for (const [namespace, bundle] of Object.entries(namespaces)) {
        instance.addResourceBundle(lng, namespace, bundle, true, true);
      }
    }
  }, [instance, resources]);

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
