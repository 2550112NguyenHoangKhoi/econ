import React from 'react';
import { renderToString } from 'react-dom/server';
import HardwareInspector from './src/HardwareInspector.jsx';

try {
  const html = renderToString(<HardwareInspector />);
  console.log("Rendered successfully!");
} catch (e) {
  console.error("Render failed:", e);
}
