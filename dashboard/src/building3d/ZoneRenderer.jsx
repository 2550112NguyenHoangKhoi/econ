import React, { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html, Edges } from '@react-three/drei';
import { ORIGIN } from '../floorGeometry';

// One zone's volume, coloured by its thermal state.
//
// The heatmap is the model's main channel for 'which room is in trouble', so it is
// driven by the zone's deviation from its own setpoint rather than an absolute scale --
// a 26 C server room and a 26 C office are not the same finding.

// ========== STEP 4: Zone Renderer with Thermal Heatmap ==========
function ZoneRenderer({ zone, isActive, simState, isHovered, onHover, isSelected, onSelect, viewMode = 'hybrid' }) {
  const meshRef = useRef();
  const zoneSim = simState.zones[zone.zoneId];
  const alertState = zoneSim?.alert;
  const temperature = zoneSim ? zoneSim.temp : zone.thermalProperties.setpoint;
  const setpoint = zone.thermalProperties.setpoint;
  const deadband = zone.thermalProperties.deadband;

  const thickness = 3.8;
  const cx = zone.centroid.x - ORIGIN.x;
  const cy = -(zone.centroid.y - ORIGIN.y);

  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    zone.polygon.forEach((p, idx) => {
      if (idx === 0) shape.moveTo(p[0] - ORIGIN.x, p[1] - ORIGIN.y);
      else shape.lineTo(p[0] - ORIGIN.x, p[1] - ORIGIN.y);
    });
    shape.lineTo(zone.polygon[0][0] - ORIGIN.x, zone.polygon[0][1] - ORIGIN.y);
    
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: thickness,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 3,
      curveSegments: 12,
    });

    geom.rotateX(-Math.PI / 2);
    geom.computeVertexNormals();
    return geom.index ? geom.toNonIndexed() : geom;
  }, [zone, thickness]);

  const isPhysical = viewMode === 'physical';

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        temperature: { value: temperature },
        setpoint: { value: setpoint },
        deadband: { value: deadband },
        opacity: { value: isActive ? (isHovered ? 0.9 : 0.65) : 0.15 },
        isPhysical: { value: isPhysical ? 1.0 : 0.0 },
        lightsOn: { value: 1.0 } // 1 lit, 0 dark — actuated lighting streamed from the engine
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float temperature;
        uniform float setpoint;
        uniform float deadband;
        uniform float opacity;
        uniform float isPhysical;
        uniform float lightsOn;
        varying vec2 vUv;
        
        vec3 heatmap(float deviation) {
          float amount = clamp(deviation, -1.0, 3.0);
          vec3 cool = vec3(0.0, 0.5, 1.0);  // Blue
          vec3 good = vec3(0.0, 1.0, 0.0);  // Green
          vec3 warn = vec3(1.0, 1.0, 0.0);  // Yellow
          vec3 hot = vec3(1.0, 0.0, 0.0);   // Red
          
          if (amount < 0.0) return mix(good, cool, -amount);
          if (amount < 1.0) return mix(good, warn, amount);
          return mix(warn, hot, min(1.0, amount - 1.0));
        }
        
        void main() {
          float deviation = (temperature - setpoint) / deadband;
          vec3 heatColor = heatmap(deviation);
          vec3 physColor = vec3(0.2, 0.2, 0.2);
          vec3 finalColor = mix(heatColor, physColor, isPhysical);
          // Lights-off zones go visibly dark (engine setback / manual veto).
          finalColor *= mix(0.3, 1.0, lightsOn);
          float finalOpacity = mix(opacity, opacity * 0.1, isPhysical);
          gl_FragColor = vec4(finalColor, finalOpacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }, [isActive, isHovered, isPhysical]);

  // Per-frame work is the dominant CPU cost (126 zones × 60 fps). Only the active floor and
  // alarmed zones need the smooth lerp + pulse every frame; the ~110 faded inactive zones
  // (opacity 0.15) just snap their uniform when the live temp actually moves, so the bulk of
  // the loop early-returns. No element is removed — only the redundant updates are.
  const lastLive = useRef(null);
  const lastLights = useRef(null);
  useFrame((state) => {
    if (!material || !material.uniforms.temperature) return;
    const liveTemp = simState.zones[zone.zoneId]?.temp || setpoint;
    const liveLights = simState.zones[zone.zoneId]?.lightsOn === false ? 0.0 : 1.0;
    if (isActive || alertState === true) {
      material.uniforms.temperature.value = THREE.MathUtils.lerp(material.uniforms.temperature.value, liveTemp, 0.05);
      material.uniforms.lightsOn.value = THREE.MathUtils.lerp(material.uniforms.lightsOn.value, liveLights, 0.1);
      material.uniforms.opacity.value = alertState === true
        ? 0.65 + 0.3 * Math.sin(state.clock.elapsedTime * 8)
        : (isHovered ? 0.9 : 0.65);
    } else if (lastLive.current === null || Math.abs(lastLive.current - liveTemp) > 0.05
               || lastLights.current !== liveLights) {
      material.uniforms.temperature.value = liveTemp;
      material.uniforms.lightsOn.value = liveLights;
      material.uniforms.opacity.value = 0.15;
      lastLive.current = liveTemp;
      lastLights.current = liveLights;
    }
  });

  return (
    <group position={[0, 0.01, 0]}>
      <mesh 
        ref={meshRef} 
        geometry={geometry}
        onClick={(e) => {
          if (isActive) {
            e.stopPropagation();
            onSelect(zone.zoneId);
          }
        }}
        onPointerOver={(e) => {
          if (isActive) {
            e.stopPropagation();
            onHover(zone.zoneId);
            document.body.style.cursor = 'pointer';
          }
        }}
        onPointerOut={(e) => {
          if (isActive) {
            onHover(null);
            document.body.style.cursor = 'auto';
          }
        }}
      >
        <primitive object={material} attach="material" />
        <Edges color={(isHovered || isSelected) && isActive ? "#ffffff" : (alertState === true ? "#ff0000" : "#222222")} threshold={15} />
      </mesh>

      {/* VIRTUAL IOT SENSORS (Only visible when drilled down into the room) */}
      {isActive && isSelected && (
        <group position={[cx, 1.5, cy]}>
          {/* Smart Thermostat */}
          <mesh position={[-1.5, 0, 0]}>
            <boxGeometry args={[0.3, 0.5, 0.1]} />
            <meshBasicMaterial color="#00e5ff" />
            <pointLight distance={3} intensity={0.5} color="#00e5ff" />
          </mesh>
          {/* Air Quality / CO2 Monitor */}
          <mesh position={[1.5, 0, 0]}>
            <boxGeometry args={[0.4, 0.3, 0.1]} />
            <meshBasicMaterial color="#00ff00" />
            <pointLight distance={3} intensity={0.5} color="#00ff00" />
          </mesh>
          {/* Ceiling Occupancy Camera */}
          <mesh position={[0, 2.0, 0]}>
            <sphereGeometry args={[0.2, 16, 16]} />
            <meshBasicMaterial color="#ff00ff" />
          </mesh>
        </group>
      )}

      {isActive && alertState && (
        <mesh position={[cx, 15, cy]}>
          <cylinderGeometry args={[1, 1, 30, 16]} />
          <meshBasicMaterial 
            color={alertState === 'REMEDIATING' ? "#ffff00" : "#ff0000"} 
            transparent 
            opacity={0.3} 
            blending={THREE.AdditiveBlending} 
            depthWrite={false} 
          />
        </mesh>
      )}
      
      {isActive && isHovered && (
        <Html position={[cx, 2.5, cy]} center zIndexRange={[100, 0]}>
          <div style={{
            background: 'rgba(0,0,0,0.8)',
            border: '1px solid #00e5ff',
            padding: '4px 8px',
            borderRadius: '4px',
            color: '#00e5ff',
            fontFamily: 'monospace',
            fontSize: '10px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap'
          }}>
            Asset: {zone.bim_asset_id}
          </div>
        </Html>
      )}
    </group>
  );
}

export { ZoneRenderer };
