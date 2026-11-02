"use client";

import { useEffect, useRef } from "react";
import { useEffectsOn } from "../../lib/effects";
import type { LightsCue, LoginScene, SceneState } from "./login-scene";

/**
 * The sign-in page's stage: the two approved paintings, in one box, with the 3D scene (login-scene.ts) on a
 * transparent canvas over them. Styles: app/styles/nlex-signin.css ("ls-" rules).
 *
 * The journey never touches React state, so it cannot re-render the form. Where the page is in the journey lives
 * on <html>, where the head script in app/layout.tsx can decide it before first paint:
 *   data-login-intro  "plaza" (the welcome panel shows) or "journey" (nothing shows); absent, the form shows.
 *                     The form stays mounted throughout, so a replay cannot clear what has been typed.
 *   data-login-scene  the scene's state, for CSS and for tests.
 *   data-login-live   the canvas has its first frame.
 *   data-login-fallback  no WebGL or the model failed: the still painting with a picture of Navie.
 *
 * The intro plays once per browser session. Effects off, reduced motion, a returning visit, or arriving by a
 * reset link or after an idle sign-out go straight to the form.
 */

export const LOGIN_INTRO_SEEN = "smartflow-intro-seen";
/** The form must never wait on the scene: a stalled download falls back to the still painting after this. */
const SCENE_WATCHDOG_MS = 8000;

let scene: LoginScene | null = null;
let queued: "enter" | null = null;
let replayNotice: ((canReplay: boolean) => void) | null = null;

const root = () => document.documentElement;
const clearIntro = () => root().removeAttribute("data-login-intro");
function markSeen() {
  try {
    sessionStorage.setItem(LOGIN_INTRO_SEEN, "1");
  } catch {
    /* storage blocked: the intro may play again, which is harmless */
  }
}

/** What the page's controls ask of the stage. */
export const loginStage = {
  enter() {
    root().setAttribute("data-login-intro", "journey");
    // The button is about to vanish: keep keyboard focus on the page until the form takes it.
    const main = document.querySelector<HTMLElement>("main");
    main?.setAttribute("tabindex", "-1");
    main?.focus({ preventScroll: true });
    if (scene) scene.enter();
    else queued = "enter";
  },
  skip() {
    queued = null;
    markSeen();
    clearIntro();
    scene?.skip();
  },
  replay() {
    if (!scene || scene.state() !== "driving") return;
    root().setAttribute("data-login-intro", "plaza");
    scene.replay();
  },
  lights(cue: LightsCue) {
    scene?.setLights(cue);
  },
  /** Called with whether "Replay intro" can be offered, now and whenever that changes. */
  onReplayable(fn: ((can: boolean) => void) | null) {
    replayNotice = fn;
  },
};

export default function LoginStage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const [effects] = useEffectsOn();
  const effectsRef = useRef(effects);
  effectsRef.current = effects;

  useEffect(() => {
    const host = hostRef.current;
    const art = artRef.current;
    if (!host || !art) return;
    let cancelled = false;
    let made: LoginScene | null = null;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motionNow = () => effectsRef.current && !mq.matches;

    // A canvas of its own each time: a context that has been lost cannot be taken up again.
    const canvas = document.createElement("canvas");
    canvas.className = "ls-canvas";
    host.appendChild(canvas);

    let watchdog = 0;
    const fallBack = () => {
      window.clearTimeout(watchdog);
      queued = null;
      // After the callback returns: the scene may be reporting this from inside its own constructor.
      window.setTimeout(() => {
        if (scene === made) scene = null;
        made?.dispose();
        made = null;
      }, 0);
      root().setAttribute("data-login-fallback", "");
      root().removeAttribute("data-login-live");
      clearIntro();
      markSeen();
      replayNotice?.(false);
    };

    const onState = (s: SceneState) => {
      root().setAttribute("data-login-scene", s);
      if (s === "plaza") root().setAttribute("data-login-intro", "plaza");
      if (s === "opening" || s === "passing") root().setAttribute("data-login-intro", "journey");
      if (s === "driving" || s === "static") {
        const wasIntro = root().hasAttribute("data-login-intro");
        markSeen();
        clearIntro();
        // Keyboard users land in the form; on a phone this would throw up the keyboard unasked.
        if (wasIntro && window.matchMedia("(min-width: 861px)").matches) {
          document.querySelector<HTMLInputElement>('.login-card input[name="email"]')?.focus({ preventScroll: true });
        }
      }
      replayNotice?.(s === "driving");
    };

    watchdog = window.setTimeout(fallBack, SCENE_WATCHDOG_MS);

    import("./login-scene")
      .then(({ createLoginScene }) => {
        if (cancelled) return;
        made = createLoginScene(host, art, canvas, {
          onState,
          onFail: fallBack,
          onReady: () => {
            window.clearTimeout(watchdog);
            root().setAttribute("data-login-live", "");
            scene = made;
            const playing = root().hasAttribute("data-login-intro");
            if (!motionNow()) made?.setMotion(false);
            else if (playing) {
              root().setAttribute("data-login-scene", made?.state() ?? "plaza");
              if (queued === "enter") made?.enter();
            } else made?.skip();
            queued = null;
          },
        });
        if (!made) fallBack();
      })
      .catch(fallBack);

    const onMotionChange = () => scene?.setMotion(motionNow());
    mq.addEventListener("change", onMotionChange);

    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      mq.removeEventListener("change", onMotionChange);
      made?.dispose();
      if (scene === made) scene = null;
      canvas.remove();
      for (const a of ["data-login-scene", "data-login-live", "data-login-fallback", "data-login-intro"]) root().removeAttribute(a);
    };
  }, []);

  // The Effects switch, while the page is open.
  useEffect(() => {
    if (!scene) return;
    scene.setMotion(effects && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, [effects]);

  return (
    <div ref={hostRef} className="ls-stage" aria-hidden="true">
      <div ref={artRef} className="ls-art">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ls-layer" src="/login/road-day.webp" alt="" width={3344} height={1882} draggable={false} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ls-layer ls-patch" src="/login/patch-day.webp" alt="" width={3344} height={1882} draggable={false} />
        {/* Night over day, each painting with its own patch, so neither patch's soft edge shows on the other. */}
        <div className="ls-layer is-night">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ls-layer" src="/login/road-night.webp" alt="" width={3344} height={1882} draggable={false} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ls-layer ls-patch" src="/login/patch-night.webp" alt="" width={3344} height={1882} draggable={false} />
        </div>
        {/* The plaza's upper half, which stays and dissolves while its road recedes in the 3D. */}
        <div className="ls-layer ls-toll-top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ls-layer" src="/login/toll-top-day.webp" alt="" width={1672} height={941} draggable={false} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ls-layer is-night" src="/login/toll-top-night.webp" alt="" width={1672} height={941} draggable={false} />
        </div>
        {/* The whole plaza painting, at rest; login-scene.ts drives both. */}
        <div className="ls-layer ls-toll">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ls-layer" src="/login/toll-day.webp" alt="" width={1672} height={940} draggable={false} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="ls-layer is-night" src="/login/toll-night.webp" alt="" width={1672} height={940} draggable={false} />
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ls-navie" src="/brand/navie.webp" alt="" width={644} height={640} draggable={false} />
      </div>
    </div>
  );
}
