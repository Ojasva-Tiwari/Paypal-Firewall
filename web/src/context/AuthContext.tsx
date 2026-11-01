import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { apiClient, setCsrfToken, ApiError } from '../lib/api';
import type { SessionResponse, LoginResponse } from '../types/api';

export interface OwnerUser {
  id: string;
  displayName: string;
}

export interface AuthContextValue {
  owner: OwnerUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (passphrase: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [owner, setOwner] = useState<OwnerUser | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await apiClient.get<SessionResponse>('/api/session');
      if (res.authenticated && res.owner && res.csrfToken) {
        setOwner(res.owner);
        setIsAuthenticated(true);
        setCsrfToken(res.csrfToken);
      } else {
        setOwner(null);
        setIsAuthenticated(false);
        setCsrfToken(null);
      }
    } catch {
      setOwner(null);
      setIsAuthenticated(false);
      setCsrfToken(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const login = async (passphrase: string): Promise<boolean> => {
    try {
      setError(null);
      const res = await apiClient.post<LoginResponse>('/api/login', { passphrase });
      if (res.ok && res.owner && res.csrfToken) {
        setOwner(res.owner);
        setIsAuthenticated(true);
        setCsrfToken(res.csrfToken);
        return true;
      }
      return false;
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Login failed. Please try again.';
      setError(msg);
      return false;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await apiClient.post('/api/logout', {});
    } catch {
      // Best-effort logout: even if network fails, clear local state
    } finally {
      setOwner(null);
      setIsAuthenticated(false);
      setCsrfToken(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        owner,
        isAuthenticated,
        isLoading,
        error,
        login,
        logout,
        refreshSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

