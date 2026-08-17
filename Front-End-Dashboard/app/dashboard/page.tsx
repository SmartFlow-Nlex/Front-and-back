import Image from "next/image";
import { Home, MapPin, Route, ToggleLeft } from "lucide-react";
import InteractiveRoadMap from "./components/InteractiveRoadMap";
import PageHeader from "../../components/dashboard/PageHeader";
import NetworkPulse from "../../components/dashboard/NetworkPulse";

/**
 * Home tab.
 *
 * The hero used to be a 500px logo splash, which meant the landing page of a
 * decision dashboard showed nothing at all above the fold. It is now a compact
 * band that keeps the brand but carries the corridor's facts, and the space it
 * gave back goes to real figures.
 */
export default function DashboardHomePage() {
  return (
    <section className="ds-content">
      <PageHeader icon={Home} title="Network Overview" subtitle="NLEX corridor status and headline figures" />

      <article className="ds-hero-band">
        <Image src="/smartflow-hero.png" alt="" fill className="ds-hero-image" unoptimized priority />
        <div className="ds-hero-scrim" />

        <div className="ds-hero-content">
          <div className="ds-hero-brand">
            <h1>
              SmartFlow <span>NLEX</span>
            </h1>
            <p>Where traffic meets intelligence</p>
          </div>

          {/* Corridor constants, not metrics — they belong with the identity
              rather than in the tiles below, which all carry a trend. */}
          <dl className="ds-hero-facts">
            <div>
              <dt><Route size={14} aria-hidden="true" /> Corridor</dt>
              <dd>76.25 km</dd>
            </div>
            <div>
              <dt><MapPin size={14} aria-hidden="true" /> Exits</dt>
              <dd>20</dd>
            </div>
            <div>
              <dt><ToggleLeft size={14} aria-hidden="true" /> Directions</dt>
              <dd>NB &amp; SB</dd>
            </div>
          </dl>
        </div>
      </article>

      <NetworkPulse />

      <InteractiveRoadMap />
    </section>
  );
}
