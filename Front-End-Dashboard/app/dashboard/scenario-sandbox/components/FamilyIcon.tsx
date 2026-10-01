import type { FamilyKey } from "../scenarios/catalogue";
import { assertNever } from "../scenarios/catalogue";

/**
 * A small pictogram for each scenario family, so the Add panel's chips read at a glance instead of being
 * nine similar lines of text. Plain inline SVG in currentColor: it follows the chip's text colour in the
 * light and dark themes, and needs no image files.
 */
export default function FamilyIcon({ family }: { family: FamilyKey }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, className: "fam-ico" } as const;
  switch (family) {
    case "breakdown_in_lane":
      return (
        <svg {...common}>
          <rect x="3" y="9" width="13" height="7" rx="2.5" />
          <path d="M6 9V7.5A1.5 1.5 0 0 1 7.5 6h4A1.5 1.5 0 0 1 13 7.5V9" />
          <circle cx="6.5" cy="17" r="1.3" />
          <circle cx="12.5" cy="17" r="1.3" />
          <path d="M20 5l2.2 4h-4.4z" />
        </svg>
      );
    case "breakdown_shoulder":
      return (
        <svg {...common}>
          <path d="M3 4v16" strokeDasharray="2 2.5" />
          <rect x="7" y="9" width="13" height="7" rx="2.5" />
          <path d="M10 9V7.5A1.5 1.5 0 0 1 11.500 6h4A1.5 1.5 0 0 1 17 7.5V9" />
          <circle cx="10.500" cy="17" r="1.3" />
          <circle cx="16.500" cy="17" r="1.3" />
        </svg>
      );
    case "minor_collision":
      return (
        <svg {...common}>
          <rect x="2.500" y="10" width="9" height="5.500" rx="2" />
          <rect x="12.500" y="8" width="9" height="5.500" rx="2" transform="rotate(8 17 10.750)" />
          <path d="M12 4l.8 2.200L15 5.500l-1.400 1.800" />
        </svg>
      );
    case "multi_vehicle_collision":
      return (
        <svg {...common}>
          <rect x="1.500" y="12" width="8" height="5" rx="2" />
          <rect x="8" y="7.500" width="8" height="5" rx="2" transform="rotate(-14 12 10)" />
          <rect x="14.500" y="13" width="8" height="5" rx="2" transform="rotate(12 18.500 15.500)" />
          <path d="M12 3l.7 2M16 4l-1 1.800M8 4l1 1.800" />
        </svg>
      );
    case "self_accident":
      return (
        <svg {...common}>
          <rect x="7" y="8" width="13" height="7" rx="2.500" transform="rotate(-28 13.500 11.500)" />
          <path d="M2 19c3-1 5-3 6.500-6M2 22c4-1 7-4 8.500-8" strokeDasharray="1.500 2.500" />
        </svg>
      );
    case "overturned_vehicle":
      return (
        <svg {...common}>
          <rect x="6" y="2.500" width="7" height="16" rx="2" transform="rotate(72 9.500 10.500)" />
          <circle cx="5" cy="18" r="1.400" />
          <circle cx="10" cy="19.500" r="1.400" />
          <circle cx="15" cy="21" r="1.400" />
        </svg>
      );
    case "flood":
      return (
        <svg {...common}>
          <path d="M2 8c2.500-2.500 4.500 2.500 7 0s4.500-2.500 7 0 4.500 2.500 6 0" />
          <path d="M2 13c2.500-2.500 4.500 2.500 7 0s4.500-2.500 7 0 4.500 2.500 6 0" />
          <path d="M2 18c2.500-2.500 4.500 2.500 7 0s4.500-2.500 7 0 4.500 2.500 6 0" />
        </svg>
      );
    case "scheduled_roadworks":
      return (
        <svg {...common}>
          <path d="M12 3l6 15H6z" />
          <path d="M9.200 11h5.600M7.800 15h8.400" />
          <path d="M3 21h18" />
        </svg>
      );
    case "rain":
      return (
        <svg {...common}>
          <path d="M6.500 15A4 4 0 0 1 7 7a5 5 0 0 1 9.500 1A3.500 3.500 0 0 1 17 15z" />
          <path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3" />
        </svg>
      );
    default:
      return assertNever(family);
  }
}
