import Image from "next/image";
import { ChevronDown, Home } from "lucide-react";
import InteractiveRoadMap from "./components/InteractiveRoadMap";
import PageHeader from "../../components/dashboard/PageHeader";

/**
 * Home tab.
 *
 * The hero is the original artwork, shown as its own composition. It already
 * carries the wordmark, the tagline and the brand graphic, so nothing is drawn
 * over it — an earlier pass set the wordmark in type as well and ended up with
 * "SmartFlow NLEX" twice on the same panel. The improvements here are all in how
 * the image is framed and how the scroll cue sits on it.
 */
export default function DashboardHomePage() {
  return (
    <section className="ds-content">
      <PageHeader icon={Home} title="Home Overview" subtitle="Live NLEX network status at a glance" />

      <article className="ds-hero-card">
        <Image src="/smartflow-hero.png" alt="SmartFlow NLEX" fill className="ds-hero-image" unoptimized priority />

        {/* Light scrim at the foot of the image only. The artwork is pale down
            there, so this lifts the cue off the tollbooths without touching the
            logo above it — the previous approach was a white glow painted around
            the letters themselves. */}
        <div className="ds-hero-fade" />

        <a href="#nlex-roadmap" className="ds-scroll-down">
          <span>Live Corridor Status</span>
          <ChevronDown size={20} aria-hidden="true" />
        </a>
      </article>

      <InteractiveRoadMap />
    </section>
  );
}
