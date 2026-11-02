import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * Traffic on the sign-in road, in the lanes either side of Navie. All of it travels Navie's way, toward the camera.
 * Left lane: faster, so it comes up from the horizon and overtakes. Right lane: slower, so it falls back from beside
 * the camera. Each lane keeps one speed, so nothing in it can run into anything else. Decoration: it shows no data.
 */

export type Traffic = {
  group: THREE.Group;
  /** dt seconds; roadSpeed how fast Navie is going; 0..1 how much to show; 0..1 night. */
  update(dt: number, roadSpeed: number, show: number, night: number): void;
  /** Back to the start of the road, out of sight. */
  reset(): void;
  dispose(): void;
};

type Kind = "sedan" | "suv" | "van";
type Lane = { x: number; rel: number; from: number; to: number };

const LANES: Record<"left" | "right", Lane> = {
  left: { x: -3.05, rel: 10, from: 90, to: -6 }, // gaining on the camera
  right: { x: 3.05, rel: -6, from: -6, to: 96 }, // dropping behind it
};
/* Everyone starts out of sight, beyond the horizon or behind the camera, and drives into view: none appears mid-road. */
const FLEET: { kind: Kind; paint: number; lane: keyof typeof LANES; start: number }[] = [
  { kind: "sedan", paint: 0xd8342e, lane: "left", start: 88 },
  { kind: "van", paint: 0xf1f4f8, lane: "left", start: 120 },
  { kind: "suv", paint: 0x2f3f55, lane: "right", start: -8 },
  { kind: "sedan", paint: 0xf2b632, lane: "right", start: -30 },
];
const SHAPES: Record<Kind, { w: number; body: [number, number][]; cabin: [number, number][]; roofY: number }> = {
  // Side profiles, nose at +z: [z, y]. Corners are rounded by the bevel.
  sedan: {
    w: 1.5,
    body: [[-1.9, 0.3], [-1.92, 0.68], [-1.7, 0.78], [0.72, 0.8], [1.8, 0.66], [1.92, 0.5], [1.9, 0.3]],
    cabin: [[-1.5, 0.74], [-1.05, 1.16], [0.12, 1.18], [0.86, 0.74]],
    roofY: 1.18,
  },
  suv: {
    w: 1.6,
    body: [[-1.95, 0.32], [-1.97, 0.86], [1.25, 0.9], [1.88, 0.78], [1.97, 0.56], [1.95, 0.32]],
    cabin: [[-1.85, 0.84], [-1.72, 1.42], [0.42, 1.44], [1.18, 0.86]],
    roofY: 1.44,
  },
  van: {
    w: 1.7,
    body: [[-2.25, 0.34], [-2.27, 0.95], [1.5, 1], [2.16, 0.82], [2.25, 0.58], [2.23, 0.34]],
    cabin: [[-2.2, 0.92], [-2.12, 1.72], [0.92, 1.74], [1.62, 0.96]],
    roofY: 1.74,
  },
};
const WHEEL_R = 0.33;

/** A side profile with its corners rounded, extruded across the car. */
function profile(points: [number, number][], width: number, corner: number, bevel: number): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  const n = points.length;
  points.forEach((p, i) => {
    const prev = points[(i + n - 1) % n];
    const next = points[(i + 1) % n];
    const toward = (o: [number, number]) => {
      const dx = o[0] - p[0];
      const dy = o[1] - p[1];
      const len = Math.hypot(dx, dy);
      const r = Math.min(corner, len * 0.45);
      return [p[0] + (dx / len) * r, p[1] + (dy / len) * r];
    };
    const [ax, ay] = toward(prev);
    const [bx, by] = toward(next);
    if (i) s.lineTo(ax, ay);
    else s.moveTo(ax, ay);
    s.quadraticCurveTo(p[0], p[1], bx, by);
  });
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 5, curveSegments: 10 });
  g.rotateY(-Math.PI / 2); // extruded along x, its nose (shape +x) now at +z
  g.translate(width / 2 - bevel, 0, 0);
  return g;
}

/** The same outline drawn in toward its middle: a window inside a pillar frame. */
function inset(points: [number, number][], by: number): [number, number][] {
  const cz = points.reduce((a, p) => a + p[0], 0) / points.length;
  const cy = points.reduce((a, p) => a + p[1], 0) / points.length;
  return points.map(([z, y]) => [z + Math.sign(cz - z) * by, y + Math.sign(cy - y) * by * 0.8]);
}

export function createTraffic(env: THREE.Texture, shadowMap: THREE.Texture, glowMap: THREE.Texture): Traffic {
  const group = new THREE.Group();
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const G = <T extends THREE.BufferGeometry>(g: T) => (geos.add(g), g);
  const fading = <T extends THREE.Material>(m: T) => {
    m.transparent = true; // blended from the start: changing it later recompiles, which hitches
    mats.add(m);
    return m;
  };
  const baseGlass = fading(new THREE.MeshStandardMaterial({ color: 0x1b2c44, roughness: 0.08, metalness: 0.6, envMap: env, envMapIntensity: 1 }));
  const baseTrim = fading(new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.55, envMap: env, envMapIntensity: 0.4 }));
  const baseRubber = fading(new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 }));
  const baseRim = fading(new THREE.MeshStandardMaterial({ color: 0xc6ced9, roughness: 0.3, metalness: 0.75, envMap: env, envMapIntensity: 0.8 }));
  const baseLamp = fading(new THREE.MeshStandardMaterial({ color: 0xfff6e0, roughness: 0.2, emissive: 0xfff0cf, emissiveIntensity: 0.4, envMap: env }));
  const tyreG = G(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.26, 28).rotateZ(Math.PI / 2));
  const rimG = G(new THREE.CylinderGeometry(WHEEL_R * 0.6, WHEEL_R * 0.6, 0.27, 7).rotateZ(Math.PI / 2));
  const lampG = G(new RoundedBoxGeometry(0.34, 0.15, 0.08, 3, 0.035));
  const grilleG = G(new RoundedBoxGeometry(0.72, 0.13, 0.06, 3, 0.03));
  const intakeG = G(new RoundedBoxGeometry(0.9, 0.1, 0.06, 3, 0.03));
  const plane = G(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const shapeG: Partial<Record<Kind, { body: THREE.BufferGeometry; cabin: THREE.BufferGeometry; side: THREE.BufferGeometry; screen: THREE.BufferGeometry; mirror: THREE.BufferGeometry; pillar: THREE.BufferGeometry }>> = {};

  const vehicles = FLEET.map(({ kind, paint, lane, start }) => {
    const shape = SHAPES[kind];
    // Each its own copy of the shared finishes, so a car fades in whole.
    const glass = fading(baseGlass.clone());
    const trim = fading(baseTrim.clone());
    const rubber = fading(baseRubber.clone());
    const rim = fading(baseRim.clone());
    const lamp = fading(baseLamp.clone());
    const cabinW = shape.w - 0.2;
    const [, , top, foot] = shape.cabin; // the windscreen runs from the roof's front down to the cabin's foot
    const screenLen = Math.hypot(top[0] - foot[0], top[1] - foot[1]);
    const made = (shapeG[kind] ??= {
      body: G(profile(shape.body, shape.w, 0.2, 0.1)),
      cabin: G(profile(shape.cabin, cabinW, 0.16, 0.07)),
      side: G(profile(inset(shape.cabin, 0.1), cabinW + 0.02, 0.08, 0.01)),
      screen: G(new RoundedBoxGeometry(cabinW - 0.22, screenLen * 0.76, 0.02, 3, 0.009)),
      mirror: G(new RoundedBoxGeometry(0.16, 0.08, 0.1, 3, 0.035)),
      pillar: G(new RoundedBoxGeometry(cabinW + 0.05, shape.roofY - 0.74, 0.1, 2, 0.02)),
    });
    const car = new THREE.Group();
    const body = fading(new THREE.MeshStandardMaterial({ color: paint, roughness: 0.28, metalness: 0.25, envMap: env, envMapIntensity: 0.9 }));
    car.add(new THREE.Mesh(made.body, body), new THREE.Mesh(made.cabin, body), new THREE.Mesh(made.side, glass));
    const screen = new THREE.Mesh(made.screen, glass);
    // Lifted off the cabin along the glass's normal, past the bevel that fattens the cabin's outline.
    const lift = 0.085 / screenLen;
    screen.position.set(0, (top[1] + foot[1]) / 2 + (foot[0] - top[0]) * lift, (top[0] + foot[0]) / 2 + (top[1] - foot[1]) * lift);
    screen.rotation.x = Math.atan2(top[0] - foot[0], top[1] - foot[1]);
    const pillar = new THREE.Mesh(made.pillar, body);
    pillar.position.set(0, (shape.roofY + 0.74) / 2, (top[0] + shape.cabin[1][0]) / 2);
    car.add(screen, pillar);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(made.mirror, body);
      m.position.set(sx * (shape.w / 2 + 0.03), foot[1] + 0.1, foot[0] - 0.12);
      car.add(m);
    }
    const nose = shape.body.reduce((m, [z]) => Math.max(m, z), 0) + 0.1; // the bevel adds this to the outline
    const lampY = shape.body[shape.body.length - 3]?.[1] ?? 0.62;
    const y = Math.min(lampY, 0.74);
    for (const sx of [-1, 1]) {
      const l = new THREE.Mesh(lampG, lamp);
      l.position.set(sx * (shape.w / 2 - 0.27), y - 0.04, nose);
      car.add(l);
    }
    const grille = new THREE.Mesh(grilleG, trim);
    grille.position.set(0, y - 0.05, nose);
    const intake = new THREE.Mesh(intakeG, trim);
    intake.position.set(0, 0.42, nose);
    car.add(grille, intake);
    const wheels: THREE.Group[] = [];
    const axle = nose * 0.66;
    for (const az of [axle, -axle]) {
      for (const sx of [-1, 1]) {
        const w = new THREE.Group();
        w.position.set(sx * (shape.w / 2 - 0.1), WHEEL_R, az);
        w.add(new THREE.Mesh(tyreG, rubber), new THREE.Mesh(rimG, rim));
        car.add(w);
        wheels.push(w);
      }
    }
    const shadowMat = fading(new THREE.MeshBasicMaterial({ map: shadowMap, depthWrite: false, toneMapped: false }));
    const shadow = new THREE.Mesh(plane, shadowMat);
    shadow.scale.set(shape.w * 1.5, 1, nose * 2.5);
    shadow.position.y = 0.015;
    shadow.renderOrder = 2;
    car.add(shadow);
    const beamMat = fading(new THREE.MeshBasicMaterial({ map: glowMap, color: 0xfff0d2, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 }));
    const beam = new THREE.Mesh(plane, beamMat);
    beam.scale.set(shape.w * 1.3, 1, 3.2);
    beam.position.set(0, 0.02, nose + 1.5);
    beam.renderOrder = 3;
    car.add(beam);
    car.traverse((o) => {
      if (o.renderOrder === 0) o.renderOrder = 1; // over the guardrail strips, which ignore depth
    });
    group.add(car);
    return { car, wheels, lane: LANES[lane], d: start, start, body, parts: [glass, trim, rubber, rim, lamp], lamp, shadowMat, beamMat, nose };
  });

  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    group,
    update(dt, roadSpeed, show, night) {
      group.visible = show > 0.01;
      if (!group.visible) return;
      for (const v of vehicles) {
        const { lane } = v;
        v.d -= lane.rel * dt;
        const past = lane.rel > 0 ? v.d < lane.to : v.d > lane.to;
        if (past) {
          // Back to the start of the lane, once whoever is there has made room.
          const clear = vehicles.every((o) => o === v || o.lane !== lane || Math.abs(o.d - lane.from) > 24);
          if (clear) v.d = lane.from;
          else v.d = lane.to;
        }
        v.car.position.set(lane.x, 0, -v.d);
        const vis = show * (1 - clamp((v.d - 66) / 24));
        v.car.visible = vis > 0.01;
        v.body.opacity = vis;
        v.parts.forEach((m) => (m.opacity = vis));
        v.lamp.emissiveIntensity = 0.4 + 3.2 * night;
        v.shadowMat.opacity = vis * (0.55 + 0.2 * night);
        v.beamMat.opacity = vis * 0.4 * night;
        const spin = Math.min(12, (roadSpeed + lane.rel) * 0.86) * dt;
        v.wheels.forEach((w) => (w.rotation.x += spin));
      }
    },
    reset() {
      for (const v of vehicles) v.d = v.start;
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}
