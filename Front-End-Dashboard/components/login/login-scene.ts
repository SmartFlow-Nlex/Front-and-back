import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { NlexMascotHandles } from "../stage/mascot/createNlexMascotModel";
import { createPlaza, type Plaza } from "./login-plaza";
import { createTraffic } from "./login-traffic";

/**
 * "Enter the SmartFlow Expressway": the 3D half of the sign-in page. The painting behind it is plain HTML
 * (LoginStage.tsx); this draws everything that has to move, on a transparent canvas locked to the painting.
 *
 * Locking to the art. The camera stands 1 unit above the road looking level, its vanishing point on the painted
 * road's middle at (642, 561) in art pixels, with a focal length of 917 art px, and setViewOffset makes its picture
 * coincide with the art however CSS crops it (cover). A road point at lateral X and distance d lands at art
 * (642 + 917 X / d, 561 + 917 / d). The toll plaza's pillars and barrier are placed on the painted islands that way.
 *
 * What moves, and what it is made of:
 *   - the road's dashes: ribbons along the painted dash lines. The painted dashes are removed by
 *     public/login/patch-*.webp (scripts/build-login-layers.py).
 *   - the guardrail and verge: the painting itself, flattened to a tile and scrolled on two strips laid exactly
 *     over the painted ones, passing through the painted posts (RAIL must match the script).
 *   - Navie: the dashboard's own model and rig (mascot/createNlexMascotModel, values from ../stage/mascot3d.ts)
 *     in its own scene, so the plaza's lights cannot change its paint; both share one depth buffer.
 *   - the trees, hedge and sky are the unmoved painting: the eye reads them as the distance.
 *
 * States: plaza -> opening -> passing -> driving; static is the still picture (Effects off, reduced motion).
 * The world moves and the camera stays, which is the same thing as the camera tracking back with Navie, and
 * keeps the numbers small. The loop runs outside React, so nothing here re-renders the form.
 */

export type SceneState = "plaza" | "opening" | "passing" | "driving" | "static";
export type LightsCue = "flash" | "pending" | "error" | "";

export type LoginScene = {
  state(): SceneState;
  /** "Enter SmartFlow". Ignored unless waiting at the plaza. */
  enter(): void;
  /** Straight to the highway. */
  skip(): void;
  /** Back to the plaza. */
  replay(): void;
  setMotion(on: boolean): void;
  setLights(cue: LightsCue): void;
  dispose(): void;
};

export type SceneCallbacks = {
  onState(s: SceneState): void;
  onFail(reason: unknown): void;
  onReady(): void;
};

/* Navie drives toward the reader while the camera tracks back, so the road runs away from the reader, toward
   the horizon, exactly as the plaza does. The brief's "from the horizon toward the foreground" would be Navie
   reversing, and would flip direction the moment the plaza left. To see that instead, set this to -1. */
const ROAD_FLOW: 1 | -1 = 1;

const ART_W = 1672;
const ART_H = 941;
const VP = { x: 642, y: 561 };
const FOCAL = 917;
/* The painted dashes bow and are unevenly spaced, so they are not a straight-perspective pattern on a plane: each
   moving dash follows the painted path instead, through DASH.y (the height of the painted dashes, 0 being the
   third entry) with its line DASH.half from the road's middle. At rest the moving dashes are the painted ones. */
const DASH = {
  cx: 642,
  y: [1318, 1034, 856.5, 734.2, 654.7, 620.2, 602.5, 590, 582],
  half: [866, 562, 374, 247, 153.5, 106.6, 80.6, 62, 50],
  first: -2,
};
const DASH_PERIOD = 6.6; // world distance between dashes
const DASH_LEN = 0.3; // half a dash, in dash spacings
const DASH_WIDTH = 0.025; // half its width, as a share of DASH.half
/* The guardrails: the painted band, flattened to a tile of RAIL_POSTS spacings by scripts/build-login-layers.py.
   curve is 1 / distance from vp as a quadratic in post number, through the painted posts. Must match the script. */
const RAIL_POSTS = 3;
const RAIL_PERIOD = 7; // world distance between posts
const RAIL = {
  left: { vp: { x: 589, y: 563 }, top: 0.0584, bot: 0.1544, sign: -1, curve: [8.077e-5, 0.00052103, 0.00217016] },
  right: { vp: { x: 723, y: 564 }, top: 0.044, bot: 0.1226, sign: 1, curve: [3.552e-5, 0.00026352, 0.00114087] },
};

const NAVIE_X = -0.1; // the middle of the painted toll lane, which is also inside the highway's centre lane
const NAVIE_H = 1.25; // height on the road, in units
/* The toll painting is the same frame as the highway's, with the same sky, so it simply dissolves into it. */
const TOLL_FADE = [0.4, 20]; // the scroll over which it does
/* Street lamps on the grass in front of the guardrails. They travel on the rail's own path, in post numbers, so they
   keep their place along the rail as it scrolls rather than sliding against it. foot is the slope, from RAIL's
   vanishing point, of the line they stand on, between the rail's foot and the road's edge. */
const LAMP_POSTS = 4; // posts between lamps
const LAMP_SIDES = [
  { rail: RAIL.right, foot: 0.111, offset: 0 },
  { rail: RAIL.left, foot: 0.139, offset: 2 },
];
const LAMP_NEAR = -4.5; // post number where a lamp, long past the camera and out of frame, goes round again
const LAMPS = 4; // on each side
/* The plaza's road, as a textured ground that recedes with the canopy: without it the 3D would slide off the painted
   islands. Above this line, the road's edge in the painting, the rest stays put and dissolves (public/login/toll-top-*).
   Must match the script. */
const TOLL_EDGE = { lx: 625, ls: 0.105, ry: 562, rs: 0.0665, rx: 680, feather: 10 };
const NAVIE_D_PLAZA = 9.6; // distance from the camera: waiting
const NAVIE_D_ROAD = 4.05; // and driving
const PLAZA_D = 13.7; // the canopy's distance from the camera at rest
const DRIVE_SPEED = 11;
const PEAK_SPEED = 20;
const OPENING_S = 1.15; // signal, then the barrier all the way up
const PASSING_S = 2.75;

const WHEEL_SPIN_MAX = 12; // radians a second
const TREAD_BLOCKS = 10;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** RAIL's curve, carried on straight past the nearest post it was fitted to, where the quadratic would turn back. */
const lampCurve = ([a, b, c]: number[], p: number) => {
  const near = -1;
  const v = a * near * near + b * near + c;
  return p >= near ? a * p * p + b * p + c : v + (2 * a * near + b) * (p - near);
};
/** Catmull-Rom through evenly spaced values. */
const spline = (v: number[], x: number) => {
  const i = Math.min(v.length - 2, Math.floor(x));
  const t = x - i;
  const a = v[Math.max(0, i - 1)];
  const b = v[i];
  const c = v[i + 1];
  const d = v[Math.min(v.length - 1, i + 2)];
  return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
};
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const ROAD_VERT = /* glsl */ `
  attribute float dash;
  attribute float across;
  varying float vK;
  varying float vA;
  void main() {
    vK = dash;
    vA = across;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const ROAD_FRAG = /* glsl */ `
  uniform float uScroll, uNight, uFade;
  varying float vK;
  varying float vA;
  float line(float x, float cx, float w) {
    float d = abs(x - cx);
    float aa = fwidth(x) * 0.8;
    return 1.0 - smoothstep(w - aa, w + aa, d);
  }
  void main() {
    float k = vK - uScroll;
    float d = abs(fract(k + 0.5) - 0.5);
    float aaK = fwidth(k) * 0.9;
    float along = 1.0 - smoothstep(${DASH_LEN.toFixed(2)} - aaK, ${DASH_LEN.toFixed(2)} + aaK, d);
    float aaA = fwidth(vA) * 0.9;
    float a = 1.0 - smoothstep(1.0 - aaA, 1.0, abs(vA));
    float fade = 1.0 - smoothstep(3.4, 4.6, vK);
    vec3 day = vec3(0.97, 0.985, 1.0);
    vec3 night = vec3(0.80, 0.80, 0.93);
    gl_FragColor = vec4(mix(day, night, uNight), a * along * fade * uFade * mix(0.93, 0.86, uNight));
  }`;
const RAIL_VERT = /* glsl */ `
  attribute float post;
  varying float vP;
  varying float vV;
  void main() {
    vP = post;
    vV = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const RAIL_FRAG = /* glsl */ `
  uniform sampler2D uDay, uNightTex;
  uniform float uNight, uScroll, uFade;
  varying float vP;
  varying float vV;
  void main() {
    vec2 st = vec2((vP + 0.5 - uScroll) / ${RAIL_POSTS.toFixed(1)}, vV);
    vec4 d = texture2D(uDay, st);
    vec4 n = texture2D(uNightTex, st);
    float fade = 1.0 - smoothstep(9.0, 13.0, vP);
    float edge = smoothstep(0.0, 0.012, 1.0 - vV) * smoothstep(0.0, 0.03, vV);
    gl_FragColor = vec4(mix(d.rgb, n.rgb, uNight), fade * edge * uFade);
    #include <colorspace_fragment>
  }`;

const GROUND_VERT = /* glsl */ `
  varying vec3 vL;
  void main() {
    vL = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const GROUND_FRAG = /* glsl */ `
  uniform sampler2D uDay, uNightTex;
  uniform float uNight, uAlpha, uNear;
  varying vec3 vL;
  void main() {
    float d = -vL.z;
    vec2 art = vec2(${VP.x.toFixed(1)} + ${FOCAL.toFixed(1)} * vL.x / d, ${VP.y.toFixed(1)} + ${FOCAL.toFixed(1)} / d);
    if (art.x < 0.0 || art.x > ${ART_W.toFixed(1)}) discard;
    float sides = smoothstep(0.0, uNear * 1.6 + 1.0, art.x) * (1.0 - smoothstep(${ART_W.toFixed(1)} - uNear * 1.6 - 1.0, ${ART_W.toFixed(1)}, art.x));
    float edge = max(${TOLL_EDGE.lx.toFixed(1)} - ${TOLL_EDGE.ls.toFixed(4)} * art.x, ${TOLL_EDGE.ry.toFixed(1)} + ${TOLL_EDGE.rs.toFixed(4)} * (art.x - ${TOLL_EDGE.rx.toFixed(1)}));
    float a = smoothstep(edge, edge + ${TOLL_EDGE.feather.toFixed(1)}, art.y);
    a *= 1.0 - smoothstep(${ART_H.toFixed(1)} - uNear - 1.0, ${ART_H.toFixed(1)}, art.y);
    vec2 st = vec2(art.x / ${ART_W.toFixed(1)}, 1.0 - art.y / ${ART_H.toFixed(1)});
    vec4 c = mix(texture2D(uDay, st), texture2D(uNightTex, st), uNight);
    gl_FragColor = vec4(c.rgb, a * sides * uAlpha);
    #include <colorspace_fragment>
  }`;

function softSprite(stops: [number, string][]): THREE.CanvasTexture {
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

export function createLoginScene(host: HTMLElement, artEl: HTMLElement, canvas: HTMLCanvasElement, cb: SceneCallbacks): LoginScene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) {
    cb.onFail(e);
    return null;
  }
  if (!renderer.getContext()) {
    cb.onFail(new Error("no webgl"));
    return null;
  }
  // As the dashboard's stage: the same tone mapping and exposure, so Navie's paint matches.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  const narrow = () => host.clientWidth < 861;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  camera.position.set(0, 1, 0);
  const world = new THREE.Scene();
  const actor = new THREE.Scene();
  world.fog = new THREE.Fog(0xdcebfa, 16, 150);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();

  // ---- the world's light -------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xdfeeff, 0x8aa2c4, 1.25);
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(-6, 9, 8);
  world.add(hemi, sun, sun.target);

  // ---- the road's dashes ---------------------------------------------------------------------
  const roadUniforms = { uScroll: { value: 0 }, uNight: { value: 0 }, uFade: { value: 0 } };
  // A ribbon along each painted dash line, drawn in art px on a plane in front of the camera.
  const artAt = (ax: number, ay: number) => new THREE.Vector3(((ax - VP.x) / FOCAL) * 8, 1 - ((ay - VP.y) / FOCAL) * 8, -8);
  const roadGeo = (() => {
    const pos: number[] = [];
    const dash: number[] = [];
    const across: number[] = [];
    const idx: number[] = [];
    const logY = DASH.y.map((y) => Math.log(y - 560));
    const N = 180;
    [-1, 1].forEach((side, line) => {
      const base = line * (N + 1) * 2;
      for (let i = 0; i <= N; i++) {
        const k = (i / N) * (DASH.y.length - 1);
        const y = 560 + Math.exp(spline(logY, k));
        const h = spline(DASH.half, k);
        const w = h * DASH_WIDTH;
        const x = DASH.cx + side * h;
        const a = artAt(x - w, y);
        const b = artAt(x + w, y);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        dash.push(k + DASH.first, k + DASH.first);
        across.push(-1, 1);
        if (i < N) {
          const v = base + i * 2;
          idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("dash", new THREE.Float32BufferAttribute(dash, 1));
    g.setAttribute("across", new THREE.Float32BufferAttribute(across, 1));
    g.setIndex(idx);
    return g;
  })();
  const roadMat = new THREE.ShaderMaterial({ vertexShader: ROAD_VERT, fragmentShader: ROAD_FRAG, uniforms: roadUniforms, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.frustumCulled = false;
  road.renderOrder = 0;
  world.add(road);

  // ---- the guardrails: the painting, scrolled ----------------------------------------------
  const textures = new THREE.TextureLoader();
  const tex = (file: string, done: () => void, fail: (e: unknown) => void) => {
    const t = textures.load(file, done, undefined, fail);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  };
  let pendingTex = 6;
  let assetsFailed = false;
  const texDone = () => {
    pendingTex -= 1;
    maybeReady();
  };
  const texFail = (e: unknown) => {
    assetsFailed = true;
    fail(e);
  };
  const railTex = {
    ld: tex("/login/rail-l-day.webp", texDone, texFail),
    ln: tex("/login/rail-l-night.webp", texDone, texFail),
    rd: tex("/login/rail-r-day.webp", texDone, texFail),
    rn: tex("/login/rail-r-night.webp", texDone, texFail),
  };
  const railStrip = (s: typeof RAIL.left, day: THREE.Texture, night: THREE.Texture) => {
    const N = 90;
    const pos: number[] = [];
    const uv: number[] = [];
    const post: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= N; i++) {
      const p = -2 + (i / N) * 16;
      const dx = 1 / (s.curve[0] * p * p + s.curve[1] * p + s.curve[2]);
      const ax = s.vp.x + s.sign * dx;
      const t = artAt(ax, s.vp.y + dx * s.top);
      const b = artAt(ax, s.vp.y + dx * s.bot);
      pos.push(t.x, t.y, t.z, b.x, b.y, b.z);
      uv.push(0, 1, 0, 0);
      post.push(p, p);
      if (i < N) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("post", new THREE.Float32BufferAttribute(post, 1));
    g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      vertexShader: RAIL_VERT,
      fragmentShader: RAIL_FRAG,
      uniforms: { uDay: { value: day }, uNightTex: { value: night }, uNight: { value: 0 }, uScroll: { value: 0 }, uFade: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const o = new THREE.Mesh(g, m);
    o.frustumCulled = false;
    o.renderOrder = 0;
    world.add(o);
    return { geo: g, mat: m };
  };
  const rails = [railStrip(RAIL.left, railTex.ld, railTex.ln), railStrip(RAIL.right, railTex.rd, railTex.rn)];

  // ---- street lamps on the verges --------------------------------------------------------------
  const poleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 9.4, 0),
    new THREE.Vector3(-0.15, 10.3, 0),
    new THREE.Vector3(-0.8, 10.75, 0),
    new THREE.Vector3(-2.2, 11.0, 0),
  ]);
  // A tapered mast: the tube's rings drawn in toward their centres as it climbs.
  const POLE_RINGS = 48;
  const POLE_SIDES = 12;
  const poleGeo = new THREE.TubeGeometry(poleCurve, POLE_RINGS, 0.078, POLE_SIDES, false);
  {
    const pos = poleGeo.getAttribute("position") as THREE.BufferAttribute;
    const c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const ring = Math.floor(i / (POLE_SIDES + 1));
      const u = ring / POLE_RINGS;
      poleCurve.getPointAt(u, c);
      const k = 1 - 0.56 * u;
      pos.setXYZ(i, c.x + (pos.getX(i) - c.x) * k, c.y + (pos.getY(i) - c.y) * k, c.z + (pos.getZ(i) - c.z) * k);
    }
    pos.needsUpdate = true;
  }
  const collarGeo = new THREE.CylinderGeometry(0.088, 0.105, 0.46, 14);
  collarGeo.translate(0, 0.23, 0);
  const jointGeo = new THREE.CylinderGeometry(0.075, 0.09, 0.2, 14);
  jointGeo.translate(0, 7, 0);
  const headGeo = new RoundedBoxGeometry(1.05, 0.13, 0.36, 3, 0.05);
  const lensGeo = new RoundedBoxGeometry(0.72, 0.03, 0.24, 2, 0.012);
  const lampSprite = softSprite([[0, "rgba(214,232,255,1)"], [0.18, "rgba(160,200,255,0.42)"], [1, "rgba(120,170,255,0)"]]);
  const lampMats: THREE.Material[] = [];
  const lamps = LAMP_SIDES.flatMap((side) =>
    Array.from({ length: LAMPS }, (_, i) => {
      const g = new THREE.Group();
      const pm = new THREE.MeshStandardMaterial({ color: 0xc3d3ea, emissive: 0x4f7fd0, emissiveIntensity: 0, roughness: 0.32, metalness: 0.55, envMap, envMapIntensity: 0.8, transparent: true });
      const hm = new THREE.MeshStandardMaterial({ color: 0xdfe8f4, roughness: 0.4, metalness: 0.3, envMap, envMapIntensity: 0.5, transparent: true });
      const lm = new THREE.MeshStandardMaterial({ color: 0xf2f7ff, emissive: 0xd6e8ff, emissiveIntensity: 0.1, roughness: 0.3, transparent: true });
      const sm = new THREE.SpriteMaterial({ map: lampSprite, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false });
      lampMats.push(pm, hm, lm, sm);
      const head = new THREE.Mesh(headGeo, hm);
      head.position.set(-2.55, 10.98, 0);
      head.rotation.z = 0.1;
      const lens = new THREE.Mesh(lensGeo, lm);
      lens.position.set(0, -0.07, 0);
      head.add(lens);
      const halo = new THREE.Sprite(sm);
      halo.position.set(-2.55, 10.8, 0.1);
      halo.scale.setScalar(3.2);
      g.add(new THREE.Mesh(poleGeo, pm), new THREE.Mesh(collarGeo, pm), new THREE.Mesh(jointGeo, pm), head, halo);
      g.traverse((o) => (o.renderOrder = 0.25)); // after the rail strips, which ignore depth
      if (side.rail.sign < 0) g.rotation.y = Math.PI; // arm over the road
      world.add(g);
      return { g, pm, hm, lm, sm, side, start: i * LAMP_POSTS + side.offset };
    }),
  );

  // ---- the plaza's road, which recedes with the canopy ------------------------------------------
  const groundUniforms = {
    uDay: { value: tex("/login/toll-day.webp", texDone, texFail) },
    uNightTex: { value: tex("/login/toll-night.webp", texDone, texFail) },
    uNight: { value: 0 },
    uAlpha: { value: 1 },
    uNear: { value: 0 },
  };
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-90, 0, -2.2, 90, 0, -2.2, 90, 0, -120, -90, 0, -120]), 3));
  groundGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const groundMat = new THREE.ShaderMaterial({ vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, uniforms: groundUniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.frustumCulled = false;
  ground.renderOrder = 0.5;
  world.add(ground);

  // ---- the plaza, Navie's shadow and its light on the road ---------------------------------------
  let plaza: Plaza | null = null;
  const shadowTex = softSprite([[0, "rgba(6,16,44,0.9)"], [0.6, "rgba(6,16,44,0.42)"], [1, "rgba(6,16,44,0)"]]);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false });
  const plane = new THREE.PlaneGeometry(1, 1);
  const shadow = new THREE.Mesh(plane, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = 2;
  world.add(shadow);
  const pool = softSprite([[0, "rgba(255,255,255,1)"], [0.4, "rgba(255,255,255,0.4)"], [1, "rgba(255,255,255,0)"]]);
  const glowMats: THREE.MeshBasicMaterial[] = [];
  const reflect = (w: number, d: number, color: number) => {
    const m = new THREE.MeshBasicMaterial({ map: pool, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 });
    glowMats.push(m);
    const o = new THREE.Mesh(plane, m);
    o.rotation.x = -Math.PI / 2;
    o.scale.set(w, d, 1);
    o.renderOrder = 3;
    world.add(o);
    return o;
  };
  const beamL = reflect(0.46, 1.9, 0xfff2d8);
  const beamR = reflect(0.46, 1.9, 0xfff2d8);
  const paint = reflect(1.5, 1.1, 0x3f86ff); // the blue of the car, on the wet road

  // A soft patch where each lamp meets the grass.
  const footMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false });
  for (const l of lamps) {
    const foot = new THREE.Mesh(plane, footMat);
    foot.rotation.x = -Math.PI / 2;
    foot.scale.set(0.8, 0.5, 1);
    foot.position.y = 0.01;
    foot.renderOrder = 0.2;
    l.g.add(foot);
  }

  const traffic = createTraffic(envMap, shadowTex, pool);
  world.add(traffic.group);

  // ---- Navie: the dashboard's model, normalised and lit exactly as there ------------------------
  const navie = new THREE.Group(); // on the road: x, distance, facing the camera
  navie.visible = false;
  actor.add(navie);
  const rig = new THREE.Group();
  navie.add(rig);
  let handles: NlexMascotHandles | null = null;
  const key = new THREE.SpotLight(0xffffff, 18, 0, Math.PI / 5, 0.6, 1.2);
  key.position.set(4, 6, 3);
  const rim = new THREE.DirectionalLight(0x6fa8ff, 5);
  rim.position.set(-5, 3, -4);
  const fill = new THREE.DirectionalLight(0xfff3e6, 0.8);
  fill.position.set(-2, -4, 2);
  const lightTarget = new THREE.Object3D();
  rig.add(key, rim, fill, lightTarget);
  key.target = rim.target = fill.target = lightTarget;
  const ENV_INTENSITY: Record<string, number> = {
    "body-paint": 0.12, chrome: 1.0, "trim-white": 0.3, "face-white": 0.2, "window-glass": 0.15, "window-frame": 0.14,
    "taillight-lens": 0.4, "tyre-rubber": 0.12, "cap-fabric-blue": 0.12, "cap-fabric-white": 0.12,
  };
  let wheelR = 0.31;
  let unitScale = 1;
  const keyBase = { i: 18 };

  // ---- state ----------------------------------------------------------------------------------
  let state: SceneState = "plaza";
  let motion = true;
  let ready = false;
  let disposed = false;
  let failed = false;
  let enterQueued = false;
  let t = 0; // seconds into the current state
  let scroll = 0; // how far the world has moved
  let speed = 0;
  let navieD = NAVIE_D_PLAZA;
  let barrier = 0;
  let signal = 0;
  let plazaFade = 1;
  let tollShown = -1;
  let moved = false;
  let sway = 0;
  let treadDispose: (() => void) | null = null;
  let night = isDark() ? 1 : 0;
  let nightTarget = night;
  let flash = 0;
  let cue: LightsCue = "";
  let raf = 0;
  let last = 0;
  let needsFrame = true;
  let viewW = 0;
  let viewH = 0;

  function isDark() {
    const a = document.documentElement.getAttribute("data-theme");
    if (a === "dark") return true;
    if (a === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function setState(s: SceneState) {
    if (s === state) return;
    state = s;
    t = 0;
    cb.onState(s);
    wake();
  }

  function fail(e: unknown) {
    if (failed || disposed) return;
    failed = true;
    cb.onFail(e);
  }

  function maybeReady() {
    if (ready || disposed || assetsFailed || pendingTex > 0 || !handles) return;
    ready = true;
    resize();
    applyPose();
    frame(performance.now());
    cb.onReady();
    if (enterQueued) {
      enterQueued = false;
      api.enter();
    }
    wake();
  }

  /** The tyres are near-black and round, so a turning wheel looks like a still one: chunky blocks show it turning. */
  function addTread(h: NlexMascotHandles) {
    const box = new THREE.Box3();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x5b6170, roughness: 0.75 });
    const placed: THREE.InstancedMesh[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3(1, 0, 0);
    for (const wheel of h.wheels) {
      const tyre = wheel.getObjectByName("tyre") as THREE.Mesh | undefined;
      if (!tyre) continue;
      tyre.geometry.computeBoundingBox();
      box.copy(tyre.geometry.boundingBox!);
      const r = box.max.y;
      const cx = (box.min.x + box.max.x) / 2;
      const w = (box.max.x - box.min.x) * 0.62;
      const blocks = new THREE.InstancedMesh(geo, mat, TREAD_BLOCKS);
      for (let i = 0; i < TREAD_BLOCKS; i++) {
        const a = (i / TREAD_BLOCKS) * Math.PI * 2;
        q.setFromAxisAngle(axis, a);
        m.compose(new THREE.Vector3(cx, Math.cos(a) * r, Math.sin(a) * r), q, new THREE.Vector3(w, r * 0.05, r * 0.24));
        blocks.setMatrixAt(i, m);
      }
      wheel.add(blocks);
      placed.push(blocks);
    }
    treadDispose = () => {
      placed.forEach((b) => b.dispose());
      geo.dispose();
      mat.dispose();
    };
  }

  // ---- layout: follow wherever CSS has put the painting ---------------------------------------
  function resize() {
    const hr = host.getBoundingClientRect();
    const ar = artEl.getBoundingClientRect();
    if (hr.width < 2 || hr.height < 2) return;
    viewW = hr.width;
    viewH = hr.height;
    const dpr = Math.min(window.devicePixelRatio || 1, narrow() ? 1 : 1.5);
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewW, viewH, false);
    const k = ar.width / ART_W; // CSS px per art px
    // A virtual frame centred on the vanishing point, so the camera can look dead level.
    const halfW = Math.max(VP.x, ART_W - VP.x);
    const halfH = Math.max(VP.y, ART_H - VP.y);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfH / FOCAL));
    camera.aspect = halfW / halfH;
    const fullW = 2 * halfW * k;
    const fullH = 2 * halfH * k;
    const artLeftInFrame = (halfW - VP.x) * k;
    const artTopInFrame = (halfH - VP.y) * k;
    const ox = artLeftInFrame + (hr.left - ar.left);
    const oy = artTopInFrame + (hr.top - ar.top);
    camera.setViewOffset(fullW, fullH, ox, oy, viewW, viewH);
    camera.updateProjectionMatrix();
    needsFrame = true;
    wake();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ---- one frame --------------------------------------------------------------------------------
  function applyPose() {
    const flow = ROAD_FLOW;
    // Each pattern gets the distance modulo its own repeat, so a page left open for days keeps its precision.
    roadUniforms.uScroll.value = ((flow * scroll) / DASH_PERIOD) % 1;
    for (const r of rails) {
      r.mat.uniforms.uScroll.value = ((flow * scroll) / RAIL_PERIOD) % RAIL_POSTS;
      r.mat.uniforms.uNight.value = night;
    }
    roadUniforms.uNight.value = night;

    const isStatic = state === "static";
    road.visible = !isStatic;
    rails.forEach((r) => (r.mat.visible = !isStatic));

    // At rest the whole toll painting shows. Once the road moves, its ground is the receding one drawn here, its upper
    // half stays and dissolves, and the highway's road is what the receding ground uncovers.
    moved = moved || scroll > 0.001;
    const toll = isStatic ? 0 : 1 - smooth(TOLL_FADE[0], TOLL_FADE[1], scroll);
    const whole = isStatic || moved ? 0 : 1;
    const tollKey = toll * 2 + whole;
    if (tollKey !== tollShown) {
      tollShown = tollKey;
      artEl.style.setProperty("--ls-toll", String(whole));
      artEl.style.setProperty("--ls-toll-top", toll.toFixed(3));
    }
    const roadIn = 1 - toll;
    roadUniforms.uFade.value = moved && !isStatic ? 1 : 0;
    for (const r of rails) r.mat.uniforms.uFade.value = roadIn;

    ground.visible = !isStatic && plazaFade > 0.002;
    ground.position.z = -scroll;
    groundUniforms.uNight.value = night;
    groundUniforms.uAlpha.value = plazaFade;
    groundUniforms.uNear.value = 190 * smooth(0, 3, scroll);

    // Lamps come round on a loop; they wrap off-screen beside the camera. The plaza's own are in its painting.
    const span = LAMP_POSTS * LAMPS;
    const travelled = (flow * scroll) / RAIL_PERIOD;
    lamps.forEach((l) => {
      const p = LAMP_NEAR + ((((l.start + travelled - LAMP_NEAR) % span) + span) % span); // away, as the rail goes
      const { rail, foot } = l.side;
      const dx = 1 / lampCurve(rail.curve, p);
      const y = rail.vp.y + dx * foot;
      const d = FOCAL / (y - VP.y);
      l.g.position.set(((rail.vp.x + rail.sign * dx - VP.x) / FOCAL) * d, 0, -d);
      const fade = (1 - smooth(7.5, LAMP_NEAR + span, p)) * roadIn;
      l.g.visible = fade > 0.01;
      l.pm.opacity = l.hm.opacity = l.lm.opacity = fade;
      l.sm.opacity = fade * night * 0.75;
      // Cool steel by day; at night it sits in the blue of the painting, not the studio reflections.
      l.pm.color.setRGB(0.66 - 0.5 * night, 0.73 - 0.47 * night, 0.86 - 0.42 * night, THREE.SRGBColorSpace);
      l.pm.envMapIntensity = l.hm.envMapIntensity = 0.8 * (1 - 0.8 * night);
      l.pm.emissiveIntensity = 0.42 * night;
      l.lm.emissiveIntensity = 0.1 + 3.4 * night;
    });

    if (plaza) {
      plaza.group.position.set(0, 0, -(PLAZA_D + scroll));
      plaza.setBarrier(barrier);
      plaza.setSignal(signal);
      plaza.setNight(night);
      plaza.setOpacity(isStatic ? 0 : plazaFade);
    }

    // Navie stands on the road and looks at the camera.
    navie.position.set(NAVIE_X, 0, -navieD);
    navie.rotation.y = Math.atan2(-NAVIE_X, navieD) + Math.sin(sway * 1.1) * 0.014 * clamp01(speed); // a driver's small corrections
    shadow.position.set(NAVIE_X, 0.02, -navieD);
    shadow.scale.set(NAVIE_H * 1.62, NAVIE_H * 2.1, 1);
    shadowMat.opacity = 0.62 + 0.2 * night;
    const noseD = navieD - NAVIE_H * 0.74;
    beamL.position.set(NAVIE_X - 0.3, 0.021, -(noseD - 0.95));
    beamR.position.set(NAVIE_X + 0.3, 0.021, -(noseD - 0.95));
    paint.position.set(NAVIE_X, 0.019, -(noseD - 0.42));
    const lit = 0.3 + 0.7 * night;
    (beamL.material as THREE.MeshBasicMaterial).opacity = (beamR.material as THREE.MeshBasicMaterial).opacity = lit * 0.62 + flash * 0.3;
    (paint.material as THREE.MeshBasicMaterial).opacity = 0.14 + 0.2 * night;

    // Day and night, on the same geometry.
    hemi.intensity = 1.25 - 0.97 * night;
    hemi.color.setRGB(0.87 - 0.52 * night, 0.93 - 0.53 * night, 1, THREE.SRGBColorSpace);
    sun.intensity = 1.6 - 1.38 * night;
    (world.fog as THREE.Fog).color.setRGB(0.86 - 0.62 * night, 0.92 - 0.68 * night, 0.98 - 0.48 * night, THREE.SRGBColorSpace);

    key.intensity = keyBase.i * (1 - 0.46 * night);
    rim.intensity = 5 * (1 - 0.15 * night);
    fill.intensity = 0.8 * (1 - 0.3 * night);
    if (handles) handles.setHeadlights(0.62 + 0.38 * night + flash * 0.5);
  }

  function step(dt: number) {
    t += dt;
    if (state === "opening") {
      signal = smooth(0, 0.22, t);
      barrier = clamp01((t - 0.18) / (OPENING_S - 0.18));
      if (t >= OPENING_S) {
        barrier = 1;
        setState("passing");
      }
    } else if (state === "passing") {
      const u = clamp01(t / PASSING_S);
      // Up to speed, then settling to the cruising speed: one continuous curve into the driving loop.
      speed = u < 0.5 ? PEAK_SPEED * smooth(0, 0.5, u) : DRIVE_SPEED + (PEAK_SPEED - DRIVE_SPEED) * (1 - smooth(0.5, 1, u));
      navieD = NAVIE_D_PLAZA + (NAVIE_D_ROAD - NAVIE_D_PLAZA) * smooth(0.08, 0.92, u);
      scroll += speed * dt;
      if (t >= PASSING_S) {
        speed = DRIVE_SPEED;
        navieD = NAVIE_D_ROAD;
        setState("driving");
      }
    } else if (state === "driving") {
      speed = DRIVE_SPEED;
      scroll += speed * dt;
    }
    // The plaza goes into the haze, then out.
    const plazaDepth = PLAZA_D + scroll;
    plazaFade = 1 - smooth(20, 46, plazaDepth);

    if (handles) {
      // Slower than the road would turn them, or the tread blocks strobe and the wheel looks still.
      const spin = Math.min(WHEEL_SPIN_MAX, speed * 0.86) * dt;
      if (spin) handles.wheels.forEach((w) => (w.rotation.x += spin));
      sway += dt;
      handles.face?.update(dt, !motion);
    }
    // Only once the plaza has gone from the road. The cars then drive into view by themselves.
    traffic.update(dt, speed, state === "static" || plazaFade > 0.002 ? 0 : 1, night);
    flash = Math.max(0, flash - dt * 1.4);
    if (cue === "pending") flash = 0.55 + 0.35 * Math.sin(performance.now() / 180);
    const dn = nightTarget - night;
    if (Math.abs(dn) > 1e-3) night += Math.sign(dn) * Math.min(Math.abs(dn), dt / 0.7);
    else night = nightTarget;
  }

  function frame(now: number) {
    const dt = Math.min(0.12, (now - last) / 1000 || 0); // a slow frame takes a longer step, so the journey keeps its length
    last = now;
    step(dt);
    applyPose();
    renderer.clear();
    renderer.render(world, camera);
    renderer.render(actor, camera);
    needsFrame = false;
  }

  function animates() {
    if (!ready || disposed || document.hidden) return false;
    if (needsFrame || flash > 0.002 || cue === "pending" || Math.abs(nightTarget - night) > 1e-3) return true;
    return motion && state !== "static";
  }

  function loop(now: number) {
    raf = 0;
    if (!animates()) return;
    frame(now);
    if (!raf) raf = requestAnimationFrame(loop);
  }
  /** Only ever one loop: it stops itself when there is nothing to draw, and this restarts it. */
  function wake() {
    if (raf || !ready || disposed || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }

  const onVisibility = () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else wake();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const syncTheme = () => {
    nightTarget = isDark() ? 1 : 0;
    needsFrame = true;
    wake();
  };
  const themeWatch = new MutationObserver(syncTheme);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", syncTheme);

  function toHighway() {
    barrier = 1;
    signal = 1;
    navieD = NAVIE_D_ROAD;
    speed = DRIVE_SPEED;
    scroll = Math.max(scroll, 90); // the plaza is long gone
    plazaFade = 0;
    moved = true;
  }

  const api: LoginScene = {
    state: () => state,
    enter() {
      if (!ready) {
        enterQueued = true;
        return;
      }
      if (state === "plaza" && motion) setState("opening");
    },
    skip() {
      enterQueued = false;
      if (!motion) return;
      toHighway();
      needsFrame = true;
      setState("driving");
      wake();
    },
    replay() {
      if (!motion) return;
      scroll = 0;
      speed = 0;
      barrier = 0;
      signal = 0;
      plazaFade = 1;
      moved = false;
      traffic.reset();
      navieD = NAVIE_D_PLAZA;
      needsFrame = true;
      setState("plaza");
      wake();
    },
    setMotion(on) {
      if (on === motion) return;
      motion = on;
      enterQueued = false;
      if (!on) {
        speed = 0;
        navieD = NAVIE_D_ROAD;
        setState("static");
      } else {
        toHighway();
        setState("driving");
      }
      needsFrame = true;
      wake();
    },
    setLights(next) {
      cue = next;
      if (next === "flash") flash = 1;
      if (next === "error") {
        flash = 1;
        handles?.face?.play("surprised", 1.2);
      }
      wake();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      themeWatch.disconnect();
      mq.removeEventListener("change", syncTheme);
      document.removeEventListener("visibilitychange", onVisibility);
      plaza?.dispose();
      handles?.dispose();
      roadGeo.dispose();
      roadMat.dispose();
      rails.forEach((r) => {
        r.geo.dispose();
        r.mat.dispose();
      });
      Object.values(railTex).forEach((x) => x.dispose());
      treadDispose?.();
      traffic.dispose();
      [poleGeo, collarGeo, jointGeo, headGeo, lensGeo].forEach((g) => g.dispose());
      lampMats.forEach((m) => m.dispose());
      lampSprite.dispose();
      footMat.dispose();
      groundGeo.dispose();
      groundMat.dispose();
      groundUniforms.uDay.value.dispose();
      groundUniforms.uNightTex.value.dispose();
      plane.dispose();
      shadowTex.dispose();
      shadowMat.dispose();
      pool.dispose();
      glowMats.forEach((m) => m.dispose());
      envMap.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };

  // ---- load the plaza's logo and Navie ------------------------------------------------------------
  const logo = new Image();
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const buildPlaza = () => {
    if (disposed) return;
    plaza = createPlaza(envMap, anisotropy, logo.complete && logo.naturalWidth ? logo : null);
    world.add(plaza.group);
    needsFrame = true;
    renderer.compileAsync(world, camera).catch(() => undefined);
  };
  logo.onload = logo.onerror = () => void document.fonts.ready.then(buildPlaza);
  logo.src = "/logo_with_bg.png";

  import("../stage/mascot/createNlexMascotModel")
    .then(async ({ createNlexMascotModel }) => {
      if (disposed) return;
      const m = createNlexMascotModel({ assetBase: "/brand/mascot/", anisotropy: narrow() ? 2 : 4 });
      const h = m.userData.mascot as NlexMascotHandles;
      await h.ready;
      if (disposed) {
        h.dispose();
        return;
      }
      m.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const mm of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const s = mm as THREE.MeshStandardMaterial;
          if (!s.isMeshStandardMaterial) continue;
          s.envMap = envMap;
          s.envMapIntensity = ENV_INTENSITY[s.name] ?? (s.name.startsWith("headlight") ? 0.3 : 0.2);
          s.needsUpdate = true;
        }
      });
      // As the dashboard: largest dimension 3.5. The rig is built for that size, so the whole rig is scaled.
      const box = new THREE.Box3().setFromObject(m);
      const size = box.getSize(new THREE.Vector3());
      const k = 3.5 / Math.max(size.x, size.y, size.z, 1e-6);
      m.scale.setScalar(k);
      const box2 = new THREE.Box3().setFromObject(m);
      const c = box2.getCenter(new THREE.Vector3());
      m.position.set(-c.x, -box2.min.y, -c.z);
      const s2 = box2.getSize(new THREE.Vector3());
      wheelR = (h.wheels[0]?.parent?.position.y ?? 0.31) * k;
      rig.add(m);
      unitScale = NAVIE_H / s2.y;
      rig.scale.setScalar(unitScale);
      addTread(h);
      lightTarget.position.set(0, s2.y * 0.45, 0);
      // A spot's fall-off depends on real distance, and the rig shrank: keep the same light on the paint.
      keyBase.i = 18 * Math.pow(unitScale, 1.2);
      h.setHeadlights(1);
      h.face?.setBase("happy");
      handles = h;
      navie.visible = true;
      await renderer.compileAsync(actor, camera).catch(() => undefined);
      if (disposed) return;
      maybeReady();
    })
    .catch(fail);

  resize();
  return api;
}
