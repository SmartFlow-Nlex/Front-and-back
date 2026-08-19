import Image from "next/image";
import { ChevronDown, Home } from "lucide-react";
import InteractiveRoadMap from "./components/InteractiveRoadMap";
import PageHeader from "../../components/dashboard/PageHeader";

/**
 * Home tab.
 *
 * The hero is a purpose-made banner that already carries the logo, wordmark and
 * tagline, so nothing is drawn over it.
 *
 * There are two of them — a light and a dark cut of the same artwork — and the
 * swap is done in CSS rather than JavaScript. Both are rendered and one is hidden,
 * which costs a second download but is the only way to honour all three theme
 * states: an explicit Light or Dark choice has to beat the OS setting in either
 * direction, and a JS swap would also flash the wrong artwork on load, which is
 * precisely what the inline theme script in the root layout exists to prevent.
 */
export default function DashboardHomePage() {
  return (
    <section className="ds-content">
      <PageHeader icon={Home} title="Home Overview" subtitle="Live NLEX network status at a glance" />

      <article className="ds-hero-card">
        <Image
          src="/smartflow-nlex-hero-light.png"
          alt="SmartFlow NLEX — where traffic meets intelligence"
          fill
          className="ds-hero-image is-light"
          sizes="100vw"
          unoptimized
          priority
        />
        <Image
          src="/smartflow-nlex-hero-dark.png"
          // Empty alt: the light cut above already carries the description, so
          // announcing the same banner twice would just be noise.
          alt=""
          fill
          className="ds-hero-image is-dark"
          sizes="100vw"
          unoptimized
          priority
        />

        <a href="#nlex-roadmap" className="ds-scroll-down">
          <span>Live Corridor Status</span>
          <ChevronDown size={20} aria-hidden="true" />
        </a>
      </article>

      <InteractiveRoadMap />
    </section>
  );
}
