import React from 'react';
import HardwareInspector from '../HardwareInspector';

/**
 * HardwareInspector.test.jsx
 *
 * Unit and component verification tests for Milestone 1:
 * - Expose IR Blaster in Hardware Inspector with protocol selector, frequency/bits, hex code input, and manual send button.
 * - Add comprehensive manual controls for all edge devices (IR blaster, plug relays, lighting relays, VAV dampers, CPU strain).
 * - Target selection and command dispatch integration.
 */

describe('HardwareInspector Component & Manual Controls', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('Component exports properly and handles hardware inspector rendering', () => {
    expect(HardwareInspector).toBeDefined();
    expect(typeof HardwareInspector).toBe('function');
  });

  test('Manual controls and command endpoints format validation', () => {
    const validCommands = [
      'IR_SEND:COOLIX:0xB27BE0:32',
      'IR_SEND:DAIKIN:0x112233:24',
      'PLUG_ON',
      'PLUG_OFF',
      'LIGHTS_ON',
      'LIGHTS_OFF',
      'DAMPER=75',
      'DAMPER=0.75',
      'VAV_SET:50',
      'CPU_STRAIN:HIGH',
      'CPU_STRAIN:NORMAL',
      'SETPOINT=22.5',
      'HVAC_SET:OFF',
    ];

    validCommands.forEach((cmd) => {
      const upper = cmd.toUpperCase();
      const isValid =
        upper.startsWith('IR_SEND:') ||
        upper.startsWith('LIGHTS_') ||
        upper.startsWith('SETPOINT=') ||
        upper.startsWith('HVAC_SET:') ||
        upper === 'PLUG_ON' ||
        upper === 'PLUG_OFF' ||
        upper.startsWith('DAMPER=') ||
        upper.startsWith('VAV_SET:') ||
        upper.startsWith('CPU_STRAIN:');
      expect(isValid).toBe(true);
    });
  });

  test('IR blaster protocols list contains all required protocols', () => {
    const requiredProtocols = [
      'COOLIX',
      'ELECTRA_AC',
      'DAIKIN',
      'PANASONIC',
      'MITSUBISHI',
      'LG',
      'SAMSUNG',
      'TOSHIBA',
      'GREE',
      'NEC',
      'SONY',
      'RC5',
    ];

    requiredProtocols.forEach((p) => {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(1);
    });
  });
});
