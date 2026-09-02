import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { settingsApi } from '../lib/api';

/**
 * Site-wide configuration, loaded from GET /api/settings.
 *
 * Nothing about the site's copy, branding or behaviour flags should be baked
 * into a component. Components read from here; admins edit the same keys in
 * the admin Settings page. FALLBACKS only exist so the UI still renders if the
 * API is unreachable - they are not a second source of truth to edit.
 */

const FALLBACKS = {
  site_name: "espress0's repo",
  site_tagline: 'Personal Archive',
  hero_title: "espress0's repo",
  hero_subtitle: 'A curated personal archive of software, ISOs, tools and documentation.',
  hero_search_placeholder: 'Search files...',
  hero_stat_encryption_label: 'AES-256',
  footer_note: '',
  footer_links: [],
  allow_registration: true,
  show_dev_credentials_panel: false,
  ai_enabled: true,
  maintenance_mode: false,
  maintenance_message: '',
  theme_default: 'midnight',
  theme_light_default: 'daybreak',
  theme_allow_user_choice: true,
  theme_starfield: true,
  theme_shooting_stars: true,
  theme_aurora: true,
  theme_star_density: 100,
};

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(FALLBACKS);
  const [meta, setMeta] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await settingsApi.get();
      setSettings({ ...FALLBACKS, ...(data.settings || {}) });
      setMeta(data.meta || []);
    } catch (e) {
      // Keep fallbacks; the site must still render without the settings API.
      console.warn('Failed to load site settings, using defaults', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const value = useMemo(() => ({
    settings,
    meta,
    loading,
    refresh,
    get: (key, fallback) => {
      const v = settings[key];
      return v === undefined || v === null || v === '' ? (fallback ?? FALLBACKS[key] ?? null) : v;
    },
  }), [settings, meta, loading, refresh]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
