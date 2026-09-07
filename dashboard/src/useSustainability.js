import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from './api';

/**
 * useSustainability
 * Polling hook for querying GET /api/sustainability from the Go backend.
 * Provides real-time Scope 2 operational carbon accounting, Toucan Protocol carbon credits,
 * predictive equipment maintenance alerts, and space utilization metrics.
 *
 * @param {number} pollMs Polling interval in milliseconds (default: 5000ms).
 * @returns {object} { data, loading, error, refresh, carbonAccounting, spaceUtilization, predictiveMaintenance, carbonCreditRecommendations }
 */
export function useSustainability(pollMs = 5000) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isMountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sustainability`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const payload = await res.json();
      if (isMountedRef.current) {
        setData(payload);
        setError(null);
      }
      return payload;
    } catch (e) {
      if (isMountedRef.current) {
        setError(e.message || 'Failed to fetch sustainability data');
      }
      return null;
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    fetchData();

    if (pollMs > 0) {
      const interval = setInterval(fetchData, pollMs);
      return () => {
        isMountedRef.current = false;
        clearInterval(interval);
      };
    }

    return () => {
      isMountedRef.current = false;
    };
  }, [fetchData, pollMs]);

  return {
    data,
    loading,
    error,
    refresh: fetchData,
    carbonAccounting: data?.carbonAccounting || null,
    spaceUtilization: data?.spaceUtilization || null,
    predictiveMaintenance: data?.predictiveMaintenance || null,
    carbonCreditRecommendations: data?.carbonCreditRecommendations || null,
  };
}
