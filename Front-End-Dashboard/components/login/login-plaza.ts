import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * The SmartFlow toll plaza on the sign-in road: blue-and-white canopy, islands, booths, the lane signal
 * and the barrier, which really turns about its hinge. Units as in login-scene.ts: the camera stands 1
 * above the road, so a lane is about 3 wide. The group's origin is on the road at the middle of Navie's
 * lane, under the canopy; +Z runs toward the camera. The curbs and road are the painting's (public/*_login_toll.png),
 * so the pillars and the barrier stand where the painted islands are. Nothing here reads or shows data.
 */

export type Plaza = {
  group: THREE.Group;
  /** Barrier angle: 0 lowered, 1 fully raised. */
  setBarrier(open01: number): void;
  /** Lane signal: 0 amber, 1 green. */
  setSignal(green01: number): void;
  /** 0 day, 1 night: the plaza's own lamps. */
  setNight(night01: number): void;
  /** 1 solid, 0 gone. */
  setOpacity(o: number): void;
  dispose(): void;
};

/** The barrier stands this far ahead of the canopy's centre, toward the camera. */
export const BARRIER_Z = 5.1;

/* Measured on the painting: where each island's centre line runs under the canopy, at the front and rear pillars.
   Their top surfaces, not the yellow walls. The islands are not quite parallel to the road, so the two differ. */
const PILLAR_Z = 1.32;
const ISLANDS = [
  { front: -6.26, rear: -6.24, booth: false },
  { front: -2.41, rear: -2.5, booth: true },
  { front: 1.93, rear: 1.92, booth: true },
  { front: 5.75, rear: 5.62, booth: false },
];
const HINGE_X = 1.94; // on the right island, well back from its nose
const ARM_TIP_X = -1.49; // the far side of the painted lane
const AMBER = new THREE.Color(0xff9a0a);
const GREEN = new THREE.Color(0x12d184);

let signLogoX = 0; // where signTexture left room for the disc, in sign px
const SIGN_W = 3120;
const LOGO_ART = { w: 2000, x: 982, y: 1020.5, r: 1153.7 };

/** The logo, whole, on a white disc with a gold rim. Its arrow and road reach the image's corners, so it is scaled to
 *  fit, and its square background is clipped to the circle. */
function logoDisc(anisotropy: number, logo: HTMLImageElement): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffc531";
  g.beginPath();
  g.arc(256, 256, 256, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(256, 256, 243, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 512, 512);
  g.imageSmoothingQuality = "high";
  // Centred on the artwork, not the image: its margins are uneven. LOGO_ART is the smallest circle around it, in the
  // file's px; the small lift is optical, the heavy road at its foot makes it sit low otherwise.
  const k = 232 / LOGO_ART.r;
  const size = LOGO_ART.w * k;
  g.drawImage(logo, 256 - LOGO_ART.x * k, 256 - LOGO_ART.y * k - 7, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

function signTexture(anisotropy: number, logo: HTMLImageElement | null): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = SIGN_W; // the fascia's proportions, so the name is not stretched
  c.height = 228;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, c.height);
  bg.addColorStop(0, "#2a6ee0");
  bg.addColorStop(1, "#1a4fbe");
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#ffc531";
  g.fillRect(0, c.height - 14, c.width, 14);
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = "#ffffff";
  g.font = '700 104px Inter, "Segoe UI", Arial, sans-serif';
  const text = "SmartFlow NLEX";
  const tw = g.measureText(text).width;
  const lw = logo ? 188 : 0;
  const x0 = c.width / 2 - (tw + lw + 34) / 2;
  signLogoX = x0 + lw / 2; // the disc itself is its own plane: see logoDisc
  g.fillText(text, x0 + lw + 34, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

function stripeTexture(anisotropy: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 32;
  const g = c.getContext("2d")!;
  const n = 7;
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 2 ? "#1f5fd8" : "#f6f9ff";
    g.fillRect((i * c.width) / n, 0, c.width / n + 1, c.height);
  }
  g.fillStyle = "#ffc531";
  g.fillRect(0, 0, 40, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => r.addColorStop(o, col));
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createPlaza(env: THREE.Texture, anisotropy: number, logo: HTMLImageElement | null): Plaza {
  const group = new THREE.Group();
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  const std = (color: number, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, envMap: env, envMapIntensity: 0.55, ...extra });
    mats.add(m);
    return m;
  };
  const rbox = (w: number, h: number, d: number, r: number) => {
    const g = new RoundedBoxGeometry(w, h, d, 4, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
    geos.add(g);
    return g;
  };
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = group) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };

  const white = std(0xe6eefa, 0.46);
  const blue = std(0x2467e0, 0.34);
  const deep = std(0x153f9c, 0.38);
  const steel = std(0xb9c8dc, 0.3, 0.6);
  const glass = std(0x8fc4f2, 0.12, 0.2, { emissive: 0xffd9a0, emissiveIntensity: 0 });
  const strip = std(0xffffff, 0.3, 0, { emissive: 0xffe6bf, emissiveIntensity: 0.12 });

  // --- canopy: a slim roof, the fascia with the name, a lit soffit -----------------------------
  const CANOPY_W = 12.9;
  const CANOPY_X = -0.28;
  const ROOF_Y = 3.3;
  const FACE_H = 1;
  const DEPTH = 3.4;
  add(rbox(CANOPY_W + 0.16, 0.12, DEPTH + 0.14, 0.05), white, CANOPY_X, ROOF_Y + FACE_H + 0.05, 0);
  add(rbox(CANOPY_W, FACE_H, DEPTH, 0.06), deep, CANOPY_X, ROOF_Y + FACE_H / 2, 0);
  const signTex = signTexture(anisotropy, logo);
  texs.add(signTex);
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.5, envMap: env, envMapIntensity: 0.25, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.1 });
  mats.add(signMat);
  const signGeo = new THREE.PlaneGeometry(CANOPY_W - 0.08, FACE_H - 0.06);
  geos.add(signGeo);
  add(signGeo, signMat, CANOPY_X, ROOF_Y + FACE_H / 2, DEPTH / 2 + 0.008);
  if (logo) {
    const perPx = (CANOPY_W - 0.08) / SIGN_W;
    const discTex = logoDisc(anisotropy, logo);
    texs.add(discTex);
    const discMat = new THREE.MeshBasicMaterial({ map: discTex, transparent: true, toneMapped: false, fog: false });
    mats.add(discMat);
    const dia = 0.76;
    const discGeo = new THREE.PlaneGeometry(dia, dia);
    geos.add(discGeo);
    add(discGeo, discMat, CANOPY_X + (signLogoX - SIGN_W / 2) * perPx, ROOF_Y + FACE_H / 2 + 0.03, DEPTH / 2 + 0.014);
  }
  // the soffit's light strips, one over each lane
  for (const x of [-4.28, -0.33, 3.72]) add(rbox(2.3, 0.04, 0.14, 0.015), strip, x, ROOF_Y - 0.03, 0.5);

  // --- pillars and booths, on the painted islands --------------------------------------------
  const shadowTex = radialTexture([[0, "rgba(10,24,60,0.75)"], [0.55, "rgba(10,24,60,0.32)"], [1, "rgba(10,24,60,0)"]]);
  texs.add(shadowTex);
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  geos.add(shadowGeo);
  const blob = (x: number, z: number, w: number, d: number, opacity = 1) => {
    const m = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity });
    mats.add(m);
    const s = new THREE.Mesh(shadowGeo, m);
    s.rotation.x = -Math.PI / 2;
    s.position.set(x, 0.012, z);
    s.renderOrder = 1;
    group.add(s);
  };
  blob(CANOPY_X, 0, CANOPY_W + 2.6, 7, 0.5); // the canopy's broad shade

  const pillarGeo = rbox(0.26, ROOF_Y, 0.36, 0.08);
  const bandGeo = rbox(0.29, 0.1, 0.39, 0.04);
  const plinthGeo = rbox(0.42, 0.14, 0.62, 0.05);
  const boothGeo = rbox(0.5, 1.08, 2.04, 0.1);
  const boothCap = rbox(0.6, 0.09, 2.2, 0.04);
  const windowGeo = rbox(0.51, 0.44, 1.5, 0.05);
  const windowFront = rbox(0.34, 0.44, 0.02, 0.008);
  for (const { front, rear, booth } of ISLANDS) {
    for (const [x, z] of [[front, PILLAR_Z], [rear, -PILLAR_Z]]) {
      add(plinthGeo, white, x, 0.07, z);
      add(pillarGeo, white, x, ROOF_Y / 2, z);
      add(bandGeo, blue, x, 0.5, z);
      blob(x, z, 0.8, 0.9);
    }
    if (booth) {
      // A cabin along the island between its pillars, turned to follow it.
      const cabin = new THREE.Group();
      cabin.position.set((front + rear) / 2, 0, 0);
      cabin.rotation.y = Math.atan2(front - rear, PILLAR_Z * 2);
      group.add(cabin);
      add(boothGeo, white, 0, 0.54, 0, cabin);
      add(boothCap, blue, 0, 1.12, 0, cabin);
      add(windowGeo, glass, 0, 0.74, 0, cabin);
      add(windowFront, glass, 0, 0.74, 1.03, cabin);
      blob(cabin.position.x, 0, 0.9, 2.5);
    }
  }

  // --- barrier: post, hinge, arm, and the lane signal on top ----------------------------------
  const HINGE_Y = 0.62;
  const postZ = BARRIER_Z;
  add(rbox(0.3, 0.12, 0.36, 0.04), steel, HINGE_X, 0.06, postZ);
  add(rbox(0.22, HINGE_Y + 0.14, 0.26, 0.07), blue, HINGE_X, (HINGE_Y + 0.14) / 2, postZ);
  blob(HINGE_X, postZ, 0.9, 0.7);
  // the signal head
  add(rbox(0.12, 0.44, 0.2, 0.03), deep, HINGE_X, HINGE_Y + 0.4, postZ);
  const lampGeo = new THREE.SphereGeometry(0.085, 20, 14);
  geos.add(lampGeo);
  const lampMat = new THREE.MeshBasicMaterial({ color: AMBER.clone(), toneMapped: false });
  mats.add(lampMat);
  const lamp = add(lampGeo, lampMat, HINGE_X, HINGE_Y + 0.46, postZ + 0.09);
  lamp.scale.z = 0.5;
  const glowTex = radialTexture([[0, "rgba(255,255,255,1)"], [0.3, "rgba(255,255,255,0.4)"], [1, "rgba(255,255,255,0)"]]);
  texs.add(glowTex);
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, color: AMBER.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.8 });
  mats.add(glowMat);
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(0.5);
  glow.position.set(HINGE_X, HINGE_Y + 0.46, postZ + 0.14);
  group.add(glow);

  // the hinge drum, then the arm hung on the pivot, with its counterweight behind the hinge
  const hinge = new THREE.Group();
  hinge.position.set(HINGE_X, HINGE_Y, postZ + 0.18);
  group.add(hinge);
  const drumGeo = new THREE.CylinderGeometry(0.085, 0.085, 0.1, 24);
  geos.add(drumGeo);
  const drum = add(drumGeo, deep, 0, 0, 0);
  drum.rotation.x = Math.PI / 2;
  drum.position.copy(hinge.position);
  const stripes = stripeTexture(anisotropy);
  texs.add(stripes);
  const armMat = std(0xffffff, 0.36, 0, { map: stripes });
  const ARM = HINGE_X - ARM_TIP_X;
  const armGeo = rbox(ARM, 0.085, 0.05, 0.024);
  // Rounded-box UVs repeat per face; give every face the whole stripe run, tip to hinge.
  const uv = armGeo.getAttribute("uv") as THREE.BufferAttribute;
  const pos = armGeo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / ARM + 0.5, 0.5);
  uv.needsUpdate = true;
  add(armGeo, armMat, -ARM / 2, 0, 0, hinge);
  add(rbox(0.34, 0.13, 0.08, 0.03), deep, 0.2, 0, 0, hinge);

  // Solid until the end of the journey; then everything fades together.
  // Blended from the start: changing a material's blending later recompiles it, which hitches mid-journey.
  const fadeable = [...mats];
  const baseOpacity = fadeable.map((m) => m.opacity);
  fadeable.forEach((m) => (m.transparent = true));

  // Lit canopy at night: warm light falling on the road under it.
  const under = new THREE.PointLight(0xffd9a6, 0, 16, 1.6);
  under.position.set(0, 1.7, -0.4); // behind the fascia: it lights the road, not the sign
  group.add(under);

  const smooth = (t: number) => t * t * (3 - 2 * t);
  const colour = new THREE.Color();
  return {
    group,
    setBarrier(o) {
      hinge.rotation.z = -smooth(Math.min(1, Math.max(0, o))) * THREE.MathUtils.degToRad(84);
    },
    setSignal(g) {
      colour.copy(AMBER).lerp(GREEN, g);
      lampMat.color.copy(colour);
      glowMat.color.copy(colour);
    },
    setNight(n) {
      // The studio reflections are a daylight look; at night the materials sit in the dark with the scene.
      for (const m of mats) if (m instanceof THREE.MeshStandardMaterial && m.envMap) m.envMapIntensity = (m === signMat ? 0.25 : 0.55) * (1 - 0.82 * n);
      glass.emissiveIntensity = 1.3 * n;
      strip.emissiveIntensity = 0.3 + 3 * n;
      signMat.emissiveIntensity = 0.1 + 0.42 * n;
      under.intensity = 22 * n;
      glowMat.opacity = 0.55 + 0.4 * n;
      glow.scale.setScalar(0.42 + 0.3 * n);
    },
    setOpacity(o) {
      fadeable.forEach((m, i) => (m.opacity = baseOpacity[i] * o));
      group.visible = o > 0.002;
    },
    dispose() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
    },
  };
}
