import Image from "next/image";
import { ChevronDown, Home, MapPin, Route, ToggleLeft } from "lucide-react";
import InteractiveRoadMap from "./components/InteractiveRoadMap";
import PageHeader from "../../components/dashboard/PageHeader";

/**
 * Home tab: a full-bleed brand hero, then the live corridor status.
 *
 * The hero stays large on purpose — it is the front door of the system. What
 * changed is that it is no longer a flat logo on a flat photograph: the image is
 * graded, the wordmark is set in type rather than baked into the picture, and the
 * corridor's constants sit alongside it so the panel carries information as well
 * as identity.
 */
export default function DashboardHomePage() {
  return (
    <section className="ds-content">
      <PageHeader icon={Home} title="Home Overview" subtitle="Live NLEX network status at a glance" />

      <article className="ds-hero">
        <Image src="/smartflow-hero.png" alt="" fill className="ds-hero-img" unoptimized priority />
        {/* Two layers: a graded wash for legibility, then a soft vignette so the
            edges settle instead of ending abruptly against the card border. */}
        <div className="ds-hero-wash" />
        <div className="ds-hero-vignette" />

        <div className="ds-hero-inner">
          <p className="ds-hero-eyebrow">NLEX Expressway · Metro Manila → Central Luzon</p>

          <h1 className="ds-hero-title">
            SmartFlow <span>NLEX</span>
          </h1>
          <p className="ds-hero-tagline">Where traffic meets intelligence</p>

          {/* Corridor constants — they belong with the identity, not in a metric
              card, because they do not move. */}
          <dl className="ds-hero-facts">
            <div>
              <dt><Route size={13} aria-hidden="true" /> Corridor</dt>
              <dd>76.25 km</dd>
            </div>
            <div>
              <dt><MapPin size={13} aria-hidden="true" /> Exits</dt>
              <dd>20</dd>
            </div>
            <div>
              <dt><ToggleLeft size={13} aria-hidden="true" /> Directions</dt>
              <dd>NB &amp; SB</dd>
            </div>
          </dl>
        </div>

        <a href="#nlex-roadmap" className="ds-hero-jump">
          <span>Live Corridor Status</span>
          <ChevronDown size={18} aria-hidden="true" />
        </a>
      </article>

      <InteractiveRoadMap />
    </section>
  );
}
