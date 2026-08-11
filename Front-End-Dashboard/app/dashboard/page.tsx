import Image from "next/image";
import { ChevronDown, Home } from "lucide-react";
import InteractiveRoadMap from "./components/InteractiveRoadMap";
import PageHeader from "../../components/dashboard/PageHeader";

export default function DashboardHomePage() {
  return (
    <section className="ds-content">
      <PageHeader icon={Home} title="Home Overview" subtitle="Live NLEX network status at a glance" />

      <article className="ds-hero-card">
        <Image src="/smartflow-hero.png" alt="NLEX tollway" fill className="ds-hero-image" unoptimized priority />
        <div className="ds-hero-overlay" />
        
        <a href="#nlex-roadmap" className="ds-scroll-down">
          <span>Live Traffic Status</span>
          <ChevronDown size={24} />
        </a>
      </article>

      <InteractiveRoadMap />
    </section>
  );
}
