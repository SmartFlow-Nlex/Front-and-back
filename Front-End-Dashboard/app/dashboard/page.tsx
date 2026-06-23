import Image from "next/image";
import { ChevronDown } from "lucide-react";
import InteractiveRoadMap from "./components/InteractiveRoadMap";

export default function DashboardHomePage() {
  return (
    <section className="ds-content">
      <article className="ds-hero-card">
        <Image src="/smartflow-hero.png" alt="NLEX tollway" fill className="ds-hero-image" unoptimized priority />
        <div className="ds-hero-overlay" />
        
        <a href="#nlex-roadmap" className="ds-scroll-down">
          <span>Live Traffic Map</span>
          <ChevronDown size={24} />
        </a>
      </article>

      <InteractiveRoadMap />
    </section>
  );
}
