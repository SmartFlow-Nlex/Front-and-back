import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Shared title block for every dashboard tab. Styles live in globals.css
    (`.ds-page-header`) so both layout families — the CSS-grid analytics pages
    and the plain `.ds-content` pages — render an identical header. */
export default function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  accent,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Which analytics domain this page belongs to. Sets --page-accent, which
   *  the header icon and the mode tabs colour themselves from, so Traffic,
   *  Incidents and Emissions are identifiable before a word is read. */
  accent?: "traffic" | "incident" | "emissions";
}) {
  return (
    <header className="ds-page-header" data-accent={accent}>
      <span className="ds-page-header-icon">
        <Icon size={20} strokeWidth={2.2} />
      </span>
      <div className="ds-page-header-text">
        <h1 className="ds-page-title">{title}</h1>
        {subtitle ? <p className="ds-page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ds-page-header-actions">{actions}</div> : null}
    </header>
  );
}
