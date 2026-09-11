// Learned recommendations: the ranked anomaly report from the engine's online baseline
// model (server/simulation/baselines.go), polled from GET /api/recommendations.
//
// This is what replaced the hardcoded threshold cards. Each recommendation is scored in σ
// against what a zone actually does at this hour, and the payload also reports the model's
// own maturity (established vs still-learning buckets) so the panel can say "nothing
// abnormal" and "still warming up" without ambiguity. One hook, both dashboards — desktop
// and mobile must agree on what the model is flagging.

import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from './api';

export function useRecommendations(pollMs = 10000) {
  const [report, setReport] = useState(null); // {recommendations:[], model:{...}} | null

  const load = useCallback(() => {
    fetch(`${API_BASE}/api/recommendations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (s) setReport(s); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  const recommendations = report?.recommendations || [];
  const model = report?.model || null;
  const forecast = report?.forecast || null;
  // What the engine can actually reach, and whether it applied the real-mode capability
  // gate to produce this list (server/simulation/capability.go).
  //
  // A short list means two entirely different things and they look identical without this.
  // In simulation mode an empty list means the building is behaving. In real mode it can
  // ALSO mean the twin is wired to nothing it could have an opinion about — and telling an
  // operator "no issues detected" when the truth is "no sensors connected" is the worst
  // failure this panel can have. Null until the engine answers; never defaulted, because a
  // fabricated zero here would assert exactly the thing that has not been established.
  const hardware = report?.hardware || null;
  const realMode = model?.realMode === true;
  return { recommendations, model, forecast, hardware, realMode, report, reload: load };
}
