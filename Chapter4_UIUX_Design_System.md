# 4.2 System Implementation

*DRAFTING NOTE: Section 4.1 presents the analytical results. This section documents the
implementation of the system that produces and delivers them, beginning with the interface
layer through which every figure in Section 4.1 was captured. Placement follows the same
reasoning as Note 3 in the Notes for the Group: the outline did not provide for it, but
Section 3.7 (Mock-ups) and Section 3.13 both describe an interface that Chapter 4 does not
currently report on. If the group prefers to reserve 4.2 for the Unit, Stress, and
User-Acceptance Test results anticipated in Note 6, this section becomes 4.3 and the
numbering below shifts accordingly.*

*Figure numbers continue the running sequence described in Note 4 (Figure 4.1.31 is the last
currently assigned). If the group moves to per-section numbering, these become Figures 4.2.1
and 4.2.2.*

---

## 4.2.1 Global UI/UX Design System

The Decision-Intelligence dashboard through which the results in Section 4.1 are
rendered was implemented on a centralized design system rather than through
per-component styling. All visual constants — colour, typography, spacing,
elevation, corner radius, and transition timing — were declared once as CSS
custom properties on the document root and consumed by reference throughout the
application. The proponents adopted this arrangement so that a change to the
visual identity would propagate across every page without editing the components
themselves, and so that the same declarations could be redefined under an
alternative theme without duplicating the component layer.

### 4.2.1.1 Design Tokens

Fifty-six design tokens were declared, organized into eleven families. Table
4.2.1 summarizes each family and its role in the interface.

**Table 4.2.1** *Design Token Families Implemented in the Global Stylesheet*

| Token Family | Count | Representative Tokens | Role in the Interface |
| --- | --- | --- | --- |
| Brand | 4 | `--brand-primary` (#3660ff), `--brand-accent` (#ea8b0d) | Primary identity colour and the accent applied for emphasis |
| Background | 8 | `--bg-body`, `--bg-surface`, `--bg-sidebar` | Page, card, and navigation surfaces |
| Text | 5 | `--text-primary` (#071a44), `--text-secondary`, `--text-muted` | Three-level type hierarchy, with on-dark variants |
| Border | 2 | `--border-default`, `--border-strong` | Card edges and separators |
| Semantic Colour | 14 | `--color-success`, `--color-warning`, `--color-danger`, each with `-bg` and `-border` | Status communication, held constant across all modules |
| Chart | 6 | `--chart-text`, `--chart-axis`, `--chart-split`, `--chart-tooltip-bg` | Visualization chrome (see Section 4.2.1.4) |
| Spacing | 5 | `--space-xs` (4px) through `--space-xl` (28px) | Fixed spacing scale in place of arbitrary values |
| Radius | 5 | `--radius-sm` (8px) through `--radius-full` (999px) | Corner treatment by component class |
| Shadow | 4 | `--shadow-sm`, `--shadow-card`, `--shadow-lg` | Elevation hierarchy |
| Transition | 2 | `--transition-fast` (150ms), `--transition-base` (220ms) | Consistent motion timing |
| Layout | 1 | `--sidebar-width` (280px) | Navigation geometry |

The semantic colour family was deliberately excluded from the per-module accent
mechanism described in Section 4.2.1.2. Success, warning, and danger communicate
meaning rather than identity, and allowing them to vary by module would have
caused a red indicator to signify different conditions on different pages.

### 4.2.1.2 Typography and Module Identity

Typography was standardized on the Inter typeface, applied at the document body
and inherited throughout, with a system font stack (`ui-sans-serif`,
`system-ui`, `-apple-system`, `Segoe UI`, `Roboto`) specified as fallback so
that the interface degrades predictably where the web font fails to load.

Module identity is carried by a single token, `--page-accent`, declared on the
page header and inherited by every descendant element on that page. Three values
were defined, corresponding to the system's three operational modules.

**Table 4.2.2** *Per-Module Accent Values*

| Module | Class | `--page-accent` |
| --- | --- | --- |
| Traffic | `.viz-traffic` | #2a78d6 (blue) |
| Incident | `.viz-incident` | #b8760a (amber) |
| Environmental Impact | `.viz-emissions` | #0f8a4a (green) |

Because the token is declared on the header and inherits downward, a panel
authored against `var(--page-accent)` renders correctly on all three modules
without conditional logic. Components appearing on only one module reference
that module's value directly, no inheritance being available to them.

### 4.2.1.3 Theme Implementation

A dark presentation mode was implemented by redefining the token values rather
than by overriding component styles. The same custom property names are
re-declared under two selectors: `:root[data-theme="dark"]`, which serves an
explicit operator selection, and a `prefers-color-scheme: dark` media query
guarded by `:root:not([data-theme="light"])`, which serves the operating system
preference while allowing an explicit light selection to take precedence.
Forty-one explicit dark-theme declarations and twenty media-query declarations
were required.

The consequence of this approach is that a component authored against tokens
requires no theme-specific code of its own, whereas a component authored against
literal colour values does not participate in the mechanism at all. Section
4.2.1.5 reports the measured effect of that distinction.

### 4.2.1.4 Charting Layer

As stated in Section 4.1.3, the analytical outputs are rendered as Apache
ECharts visualizations and Mapbox geospatial layers. ECharts constructs its own
canvas and does not participate in CSS inheritance, so a chart configuration
object cannot reference a custom property; the declaration is passed through
uninterpreted and the chart reverts to its library defaults.

A dedicated hook was therefore implemented to bridge the two systems. It reads
the computed values of the chart token family from the document root and returns
them as literal colour strings for use within chart configuration. The hook
re-reads on both paths by which the theme can change — a mutation observer on
the theme attribute, and a listener on the colour-scheme media query — so that
charts re-theme in step with the surrounding interface rather than requiring a
page reload.

The resulting convention is that document markup references tokens directly,
while chart configuration consumes the resolved literals returned by the hook.

### 4.2.1.5 Validation of the Design System

The design system was validated by migrating a set of panels authored before its
adoption. The four panels comprising the Incident module's Predictive tab —
reported in Section 4.1.4.2 as Figures 4.1.18 through 4.1.21 — contained 186
hardcoded colour literals between them. Because those literals bypassed the token
layer, the panels retained their light-mode palette when the interface was
switched to dark presentation.

The effect was measured in two ways: by counting the literals removed from
source, and by an automated contrast audit that measures every text element
against the surface it is painted on and compares the result against the 3:1
minimum specified for large text in WCAG 2.1.

**Table 4.2.3** *Design System Migration, Incident Predictive Tab*

| Measure | Value |
| --- | --- |
| Hardcoded colour literals removed | 186, across four panels |
| Text elements below 3:1 in dark presentation, after migration | 0 |
| Light presentation after migration | Unchanged |

The severity of the pre-migration condition is best conveyed by a single case
rather than an aggregate count. A panel heading was authored as `#0f172a`, the
literal value carried by `--text-primary` under the light theme. Against the
dark theme's card surface of `#161b22`, that pairing yields a contrast ratio of
1.03:1 — text and background of near-identical relative luminance, which is to
say the heading was not legible at all. The ratio follows directly from the two
colour values and is independently recomputable.

A controlled comparison remains available within the delivered system, because
the migration was not applied uniformly. The Traffic module's Predictive tab
retains 244 hardcoded literals across two panels and continues to fail the same
audit in dark presentation, while the migrated Incident tab passes it without
exception. The two tabs differ in no other respect relevant to theming.

*[INSERT SCREENSHOT — Traffic > Predictive tab in dark presentation, showing
panels styled with hardcoded literals]*

**Figure 4.1.32** *Interface Panels Rendered Without Design Tokens in Dark Presentation*

*[INSERT SCREENSHOT — Incident > Predictive tab in dark presentation, showing the
equivalent panels after migration]*

**Figure 4.1.33** *Equivalent Panels Rendered Through the Design Token System*

Absolute failure counts are not reported in Table 4.2.3 because they vary
between measurements — the number of rendered elements depends on the data
present at the time of capture — and because the audit tool returns false
positives against elements whose background is a gradient rather than a solid
colour, which it cannot resolve. The literal counts and the 1.03:1 ratio are
stable and were preferred on that basis.

### 4.2.1.6 Deviation from the Planned Implementation

Section 3.7 specified that global design tokens would be configured through a
Tailwind CSS theme configuration file. The delivered system does not use that
file, and the deviation is recorded here rather than reconciled.

Tailwind CSS version 4 is present among the project dependencies and registered
as a PostCSS plugin, but two conditions prevent it from functioning as the design
system in practice. First, version 4 replaced the JavaScript configuration file
with CSS-based configuration, so `tailwind.config.js` is not generated by that
version and its absence is expected rather than an omission. Second, the global
stylesheet does not import the Tailwind layer and the component markup does not
employ Tailwind utility classes; the interface is styled through CSS Modules and
the custom property system documented in Sections 4.2.1.1 through 4.2.1.4.

The objective expressed in Section 3.7 — a single source of truth for brand
colour, typography, and spacing applied uniformly across every page — is met by
the implemented token system. The mechanism differs from the one specified. The
proponents recommend that the unused dependency be removed, or the configuration
completed, so that the delivered system and its documentation agree.

---

## Addition to Notes for the Group

*Proposed as item 7, following the existing six.*

7. Section 3.7 specifies a Tailwind CSS theme configuration as the design token
   mechanism. The delivered interface implements tokens as CSS custom properties
   instead, for the reasons given in Section 4.2.1.6. This follows the same
   convention already applied to Figures 4.1.9, 4.1.24, and 4.1.28, where the
   note beneath each screenshot records that the build differs from what the
   outline anticipated. The group should decide whether to record the deviation
   as written, revise Section 3.7 to match the delivered system, or complete the
   Tailwind configuration before submission.
