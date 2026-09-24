"use client";

import { useEffect, useRef } from "react";
import type { SceneMark } from "../scenarios/adapter";
import { ASSUMPTIONS, type RainIntensity } from "../scenarios/assumptions";
import type { FamilyKey, VehicleKind } from "../scenarios/catalogue";
import { drawScenes, drawWater, drawWeather, type SceneGeometry } from "../sceneArt";

/**
 * A small animated preview of the scenario the operator is about to add, drawn by the SAME scene art the
 * real road uses (sceneArt.ts) on a short three-lane stretch, so what the picker shows is what the road
 * will show. Accident families cycle through their phases (blocked, tow, clearing) so the responders
 * can be seen arriving and leaving; rain shows the chosen intensity. Pure decoration: it reads nothing
 * from the simulation and writes nothing to it. Freezes for people who ask for reduced motion.
 */

const PHASES: Readonly<Record<FamilyKey, readonly string[]>> = {
  breakdown_in_lane: ["waiting", "service"],
  breakdown_shoulder: ["waiting", "service"],
  minor_collision: ["blocked", "clearing"],
  multi_vehicle_collision: ["blocked", "tow", "clearing"],
  self_accident: ["blocked", "tow", "clearing"],
  overturned_vehicle: ["blocked", "tow", "clearing"],
  flood: ["active"],
  scheduled_roadworks: ["active"],
  rain: ["active"],
};

const PHASE_SECONDS = 3.6;
const W_M = 120; // metres across the preview

function markFor(family: FamilyKey, vehicle: VehicleKind, intensity: RainIntensity, t: number): SceneMark {
  const phases = PHASES[family];
  const idx = Math.floor(t / PHASE_SECONDS) % phases.length;
  const phaseId = phases[idx];
  const fraction = (t % PHASE_SECONDS) / PHASE_SECONDS;
  const closes = family !== "rain" && family !== "breakdown_in_lane" && family !== "breakdown_shoulder";
  const holds = closes && phaseId !== "clearing";
  return {
    eventId: "preview",
    name: "",
    kind: "closure",
    state: "active",
    xM: 84,
    lane: family === "breakdown_shoulder" || family === "rain" ? null : 1,
    text: "",
    family,
    phaseId,
    phaseFraction: fraction,
    closedLanes: holds ? [1] : [],
    stretch: holds ? { fromM: 52, toM: 104 } : null,
    intensity: family === "rain" ? intensity : null,
    capKmh: family === "rain" ? ASSUMPTIONS.RAIN_SPEED_KMH.value[intensity] : null,
    vehicle: family === "breakdown_in_lane" || family === "breakdown_shoulder" ? vehicle : null,
  };
}

export default function ScenePreview({ family, vehicle, intensity }: { family: FamilyKey; vehicle: VehicleKind; intensity: RainIntensity }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w <= 0 || h <= 0) {
        raf = requestAnimationFrame(draw);
        return;
      }
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = reduce ? 2.4 : (now - t0) / 1000;
      const pad = 6;
      const laneH = (h - pad * 2) / 3;
      const roadTop = pad;
      const roadH = laneH * 3;
      const mToPx = w / W_M;
      ctx.fillStyle = "#20293a";
      ctx.fillRect(0, roadTop, w, roadH);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([10, 10]);
      for (let l = 1; l < 3; l++) {
        ctx.beginPath();
        ctx.moveTo(0, roadTop + l * laneH);
        ctx.lineTo(w, roadTop + l * laneH);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const heroLen = Math.max(16, Math.min(laneH * 0.95, 26));
      const g: SceneGeometry = {
        ctx,
        cssW: w,
        roadTop,
        roadH,
        laneH,
        xPx: (m) => m * mToPx,
        fwd: 1,
        laneCenterY: (l) => roadTop + l * laneH + laneH / 2,
        outerEdgeY: roadTop + roadH,
        outward: 1,
        carLen: heroLen,
        carWid: Math.max(8, heroLen * 0.46),
        t,
      };
      const marks = [markFor(family, vehicle, intensity, t)];
      drawWater(g, marks);
      drawScenes(g, marks);
      drawWeather(g, marks);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [family, vehicle, intensity]);

  return <canvas ref={ref} className="sandbox-scn-preview" data-scn="preview-canvas" aria-label="Preview of the selected scenario" />;
}
