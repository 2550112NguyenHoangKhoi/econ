import { useState, useEffect, useCallback } from 'react';
import { API_BASE, getAdminToken } from './api';

export function useOperationMode(pollMs = 10000) {
  const [mode, setModeState] = useState('simulation');
  const [isReal, setIsReal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchMode = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/mode`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setModeState(data.mode || 'simulation');
      setIsReal(Boolean(data.is_real ?? data.isReal));
      setError(null);
      return data;
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetchMode();
    if (pollMs > 0) {
      const interval = setInterval(fetchMode, pollMs);
      return () => clearInterval(interval);
    }
  }, [fetchMode, pollMs]);

  const setMode = async (targetMode) => {
    setLoading(true);
    try {
      const token = getAdminToken();
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Admin-Token'] = token;

      const res = await fetch(`${API_BASE}/api/mode`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: targetMode }),
      });
      if (!res.ok) throw new Error(`Failed to update mode: HTTP ${res.status}`);
      const data = await res.json();
      setModeState(data.mode || 'simulation');
      setIsReal(Boolean(data.is_real ?? data.isReal));
      setError(null);
      return data;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  };

  // Adopt a mode that came FROM the engine (a state_sync replay on websocket connect, or
  // another operator's change). setMode POSTs /api/mode, so using it to apply an incoming
  // value made every reconnect WRITE the mode back — and the value being replayed is the
  // persisted toggle, a separate copy from the engine's live mode. Whenever the two had
  // drifted, reconnecting stamped the stale one over the real one, which is why returning
  // to a tab could silently put the engine back into simulation.
  const adoptMode = useCallback((targetMode) => {
    if (targetMode !== 'simulation' && targetMode !== 'real') return;
    setModeState(targetMode);
    setIsReal(targetMode === 'real');
  }, []);

  return { mode, isReal, loading, error, setMode, adoptMode, refresh: fetchMode };
}

export default useOperationMode;
