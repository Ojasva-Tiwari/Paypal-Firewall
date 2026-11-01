export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'payguard_theme';

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
}

interface DocumentLike {
  documentElement: {
    classList: {
      remove: (...tokens: string[]) => void;
      add: (...tokens: string[]) => void;
    };
    style: {
      colorScheme: string;
    };
  };
}

export function getInitialTheme(): Theme {
  try {
    const storage = (globalThis as unknown as { localStorage?: StorageLike }).localStorage;
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // LocalStorage might be disabled or throw in restricted environments
  }
  return 'dark'; // Dark mode is default
}

export function applyThemeToDocument(theme: Theme): void {
  const doc = (globalThis as unknown as { document?: DocumentLike }).document;
  if (!doc) return;
  const root = doc.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

export function resolveNextTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}
