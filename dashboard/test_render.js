import React from 'react';
import { renderToString } from 'react-dom/server';
import SustainabilityRecommendationsPanel from './src/SustainabilityRecommendationsPanel.jsx';

const mockData = {
  carbonCreditRecommendations: {
    carbonBudgetKgCO2e: 50.0,
    currentEmissionsKgCO2e: 0,
    overBudget: false,
    deficitKgCO2e: 0,
    creditsNeededMetricTons: 0,
    wholeCertificatesNeeded: 0,
    marketQuote: {
      source: 'Toucan',
      spotPricePerMetricTonUSD: 12.5,
      currency: 'USD',
      isLive: true,
      fetchedAt: new Date().toISOString(),
    },
    alternativeQuotes: [
      { source: 'Alt 1', spotPricePerMetricTonUSD: 10.0, currency: 'USD' }
    ],
    estimatedCostUSD: 0,
    recommendation: 'Emissions are within target budget.',
  },
  predictiveMaintenance: {
    activeAlertsCount: 1,
    warnings: [
      {
        equipmentId: 'eq-1',
        zoneId: 'z-1',
        type: 'overheat',
        severity: 'critical',
        message: 'Too hot',
        metricValue: 100,
        threshold: 90,
        troubleshooting: ['Turn off'],
        healthScore: 50,
      }
    ]
  }
};

const html = renderToString(<SustainabilityRecommendationsPanel customData={mockData} />);
if (html.includes('Alt 1')) console.log('Alt 1 found'); else console.log('Alt 1 missing');
if (html.includes('Turn off')) console.log('Turn off found'); else console.log('Turn off missing');
if (html.includes('50%')) console.log('50% found'); else console.log('50% missing');
