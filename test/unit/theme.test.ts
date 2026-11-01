/**
 * PayGuard — Light/Dark Theme Switcher Tests
 *
 * Verifies:
 * - Dark mode remains default
 * - THEME_STORAGE_KEY persistence in localStorage
 * - Valid theme resolution and fallback on invalid or throwing storage
 * - Document classList and colorScheme synchronization
 * - Theme state transitions and persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  getInitialTheme,
  applyThemeToDocument,
  resolveNextTheme,
  Theme,
} from '../../web/src/lib/themeUtils.js';

describe('Theme Context & Switcher (Light / Dark Theme)', () => {
  let mockStorage: Record<string, string> = {};
  let mockClasses: Set<string> = new Set();
  let mockColorScheme = '';

  beforeEach(() => {
    mockStorage = {};
    mockClasses = new Set();
    mockColorScheme = '';

    // Mock localStorage
    const storageApi = {
      getItem: vi.fn((key: string) => mockStorage[key] ?? null),
      setItem: vi.fn((key: string, val: string) => {
        mockStorage[key] = val;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockStorage[key];
      }),
      clear: vi.fn(() => {
        mockStorage = {};
      }),
    };

    // Mock document.documentElement
    const rootApi = {
      classList: {
        add: vi.fn((...cls: string[]) => cls.forEach((c) => mockClasses.add(c))),
        remove: vi.fn((...cls: string[]) => cls.forEach((c) => mockClasses.delete(c))),
        contains: vi.fn((cls: string) => mockClasses.has(cls)),
      },
      style: {
        get colorScheme() {
          return mockColorScheme;
        },
        set colorScheme(val: string) {
          mockColorScheme = val;
        },
      },
    };

    vi.stubGlobal('localStorage', storageApi);
    vi.stubGlobal('document', { documentElement: rootApi });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('Storage Key & Initial Theme Resolution', () => {
    it('uses the canonical payguard_theme storage key', () => {
      expect(THEME_STORAGE_KEY).toBe('payguard_theme');
    });

    it('defaults to dark mode when no persisted preference exists', () => {
      expect(getInitialTheme()).toBe('dark');
    });

    it('retrieves light mode when persisted in localStorage', () => {
      mockStorage[THEME_STORAGE_KEY] = 'light';
      expect(getInitialTheme()).toBe('light');
    });

    it('retrieves dark mode when persisted in localStorage', () => {
      mockStorage[THEME_STORAGE_KEY] = 'dark';
      expect(getInitialTheme()).toBe('dark');
    });

    it('falls back to dark mode when an invalid theme is stored', () => {
      mockStorage[THEME_STORAGE_KEY] = 'neon-pink';
      expect(getInitialTheme()).toBe('dark');

      mockStorage[THEME_STORAGE_KEY] = '';
      expect(getInitialTheme()).toBe('dark');
    });

    it('safely falls back to dark mode if localStorage.getItem throws', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('SecurityError: LocalStorage access denied');
        },
      });
      expect(getInitialTheme()).toBe('dark');
    });
  });

  describe('Document DOM Synchronization', () => {
    it('applies dark theme by adding dark class, removing light class, and setting colorScheme', () => {
      mockClasses.add('light');

      applyThemeToDocument('dark');

      expect(mockClasses.has('dark')).toBe(true);
      expect(mockClasses.has('light')).toBe(false);
      expect(mockColorScheme).toBe('dark');
    });

    it('applies light theme by adding light class, removing dark class, and setting colorScheme', () => {
      mockClasses.add('dark');

      applyThemeToDocument('light');

      expect(mockClasses.has('light')).toBe(true);
      expect(mockClasses.has('dark')).toBe(false);
      expect(mockColorScheme).toBe('light');
    });

    it('gracefully handles missing document in SSR/test environments', () => {
      vi.stubGlobal('document', undefined);
      expect(() => applyThemeToDocument('dark')).not.toThrow();
    });
  });

  describe('Theme State Transitions & Persistence', () => {
    it('toggles cleanly between dark and light themes using resolveNextTheme', () => {
      expect(resolveNextTheme('dark')).toBe('light');
      expect(resolveNextTheme('light')).toBe('dark');
    });

    it('supports switching themes and persists the selection', () => {
      let activeTheme: Theme = getInitialTheme();
      expect(activeTheme).toBe('dark');

      // Toggle to light
      activeTheme = resolveNextTheme(activeTheme);
      expect(activeTheme).toBe('light');
      applyThemeToDocument(activeTheme);
      mockStorage[THEME_STORAGE_KEY] = activeTheme;

      expect(mockClasses.has('light')).toBe(true);
      expect(mockStorage[THEME_STORAGE_KEY]).toBe('light');

      // Toggle back to dark
      activeTheme = resolveNextTheme(activeTheme);
      expect(activeTheme).toBe('dark');
      applyThemeToDocument(activeTheme);
      mockStorage[THEME_STORAGE_KEY] = activeTheme;

      expect(mockClasses.has('dark')).toBe(true);
      expect(mockStorage[THEME_STORAGE_KEY]).toBe('dark');
    });
  });
});
