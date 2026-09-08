import { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE, WS_URL } from './api';

/**
 * useStatePersistence Hook
 * 
 * Provides centralized backend state persistence and multi-device synchronization:
 * 1. Fetches initial persisted state via GET /api/state on mount.
 * 2. Connects to WebSocket /ws to receive live state_sync and state_update frames.
 * 3. Provides updateToggle / updateToggles with debounced POST /api/state persistence.
 * 4. Broadcasts mutations via WebSocket so other open browser tabs/devices update immediately.
 * 
 * @param {Object} options
 * @param {Object} [options.initialToggles={}] Default toggle values if none are persisted
 * @param {Function} [options.onRemoteUpdate] Callback triggered when remote devices push changes
 */
export function useStatePersistence({ initialToggles = {}, onRemoteUpdate } = {}) {
  const [toggles, setTogglesState] = useState(initialToggles);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const togglesRef = useRef(initialToggles);
  togglesRef.current = toggles;

  const wsRef = useRef(null);
  const pendingUpdatesRef = useRef({});
  const debounceTimerRef = useRef(null);
  const onRemoteUpdateRef = useRef(onRemoteUpdate);
  onRemoteUpdateRef.current = onRemoteUpdate;

  // 1. Initial REST fetch from GET /api/state
  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/state`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!active) return;
        if (data && data.ok && data.toggles) {
          setTogglesState(prev => {
            const merged = { ...prev, ...data.toggles };
            togglesRef.current = merged;
            return merged;
          });
          if (onRemoteUpdateRef.current) {
            onRemoteUpdateRef.current(data.toggles, true);
          }
        }
        setIsLoaded(true);
      })
      .catch(err => {
        if (!active) return;
        console.warn('[state] Could not fetch initial state from /api/state:', err);
        setIsLoaded(true);
      });

    return () => {
      active = false;
    };
  }, []);

  // 2. WebSocket listener for live real-time multi-device sync
  useEffect(() => {
    let alive = true;
    let reconnectTimer = null;

    const connect = () => {
      if (!alive) return;
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!alive) return;
          setIsConnected(true);
        };

        ws.onclose = () => {
          if (!alive) return;
          setIsConnected(false);
          wsRef.current = null;
          reconnectTimer = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        };

        ws.onmessage = (event) => {
          if (!alive || typeof event.data !== 'string') return;
          try {
            const msg = JSON.parse(event.data);
            if (!msg || !msg.type) return;

            if (msg.type === 'state_sync' && msg.toggles) {
              setTogglesState(prev => {
                const merged = { ...prev, ...msg.toggles };
                togglesRef.current = merged;
                return merged;
              });
              if (onRemoteUpdateRef.current) {
                onRemoteUpdateRef.current(msg.toggles, false);
              }
            } else if (msg.type === 'state_update') {
              const updates = {};
              if (msg.toggles) {
                Object.assign(updates, msg.toggles);
              }
              if (msg.key !== undefined && msg.value !== undefined) {
                updates[msg.key] = msg.value;
              }
              if (Object.keys(updates).length > 0) {
                setTogglesState(prev => {
                  const next = { ...prev, ...updates };
                  togglesRef.current = next;
                  return next;
                });
                if (onRemoteUpdateRef.current) {
                  onRemoteUpdateRef.current(updates, false);
                }
              }
            }
          } catch (e) {
            // Non-JSON or binary frame ignored
          }
        };
      } catch (err) {
        if (!alive) return;
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // Flush pending updates to backend via POST /api/state
  const flushUpdates = useCallback(() => {
    const toSend = { ...pendingUpdatesRef.current };
    pendingUpdatesRef.current = {};
    if (Object.keys(toSend).length === 0) return;

    fetch(`${API_BASE}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toggles: toSend }),
    }).catch(err => {
      console.warn('[state] Failed to persist state to /api/state:', err);
    });
  }, []);

  // 3. updateToggle: updates local state, sends live WS frame, and debounces REST save
  const updateToggle = useCallback((key, value) => {
    if (!key) return;
    if (togglesRef.current[key] === value) return;

    // Optimistic local state update
    setTogglesState(prev => {
      const next = { ...prev, [key]: value };
      togglesRef.current = next;
      return next;
    });

    // Send immediate WebSocket event for low-latency multi-device sync
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({
          action: 'set_state',
          key,
          value,
        }));
      } catch (e) {
        // Fallback handled by HTTP flush
      }
    }

    // Buffer for debounced HTTP persistence
    pendingUpdatesRef.current[key] = value;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(flushUpdates, 400);
  }, [flushUpdates]);

  // 4. updateToggles: batch updates
  const updateToggles = useCallback((newToggles) => {
    if (!newToggles || Object.keys(newToggles).length === 0) return;

    let hasDiff = false;
    for (const [k, v] of Object.entries(newToggles)) {
      if (togglesRef.current[k] !== v) {
        hasDiff = true;
        break;
      }
    }
    if (!hasDiff) return;

    setTogglesState(prev => {
      const next = { ...prev, ...newToggles };
      togglesRef.current = next;
      return next;
    });

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({
          action: 'set_state',
          toggles: newToggles,
        }));
      } catch (e) {
        // Fallback handled by HTTP flush
      }
    }

    Object.assign(pendingUpdatesRef.current, newToggles);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(flushUpdates, 400);
  }, [flushUpdates]);

  // Force immediate save without debounce delay
  const saveNow = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    flushUpdates();
  }, [flushUpdates]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    toggles,
    setToggle: updateToggle,
    setToggles: updateToggles,
    updateToggle,
    updateToggles,
    saveNow,
    isLoaded,
    isConnected,
  };
}

export default useStatePersistence;
