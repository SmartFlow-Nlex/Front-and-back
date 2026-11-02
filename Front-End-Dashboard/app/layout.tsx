import type { Metadata } from 'next';
import './globals.css';
// Night Corridor page styles, one file per area, after the shared layer.
import './styles/nc-traffic.css';
import './styles/nc-incident.css';
import './styles/nc-emissions.css';
import './styles/nc-livemap.css';
import './styles/nc-ops.css';
import './styles/nc-sandbox.css';
import './styles/nc-admin.css';
import './styles/nc-forecast.css';
import './styles/nc-settings.css';
// The NLEX daylight theme and its environment (7 Oct 2026) load last, over the layers above.
import './styles/nlex-environment.css';
import './styles/nlex-daylight.css';
import './styles/nlex-signin.css';
import { ThemeProvider, THEME_INIT_SCRIPT } from '../lib/theme';

// Also decides, before first paint, whether the sign-in page opens at the toll plaza (components/login/LoginStage.tsx):
// once per browser session, never with Effects off or reduced motion, or when arriving by a reset link or idle sign-out.
const EFFECTS_INIT_SCRIPT = `(function(){var d=document.documentElement,off=false;try{off=localStorage.getItem('smartflow-effects')==='off';if(off)d.setAttribute('data-effects','off');}catch(e){}try{var l=location,p=l.pathname;if(!off&&p.indexOf('/dashboard')<0&&/(^|\\/)(index\\.html)?$/.test(p)&&!/reset=|signedOut=/.test(l.search)&&!/type=recovery/.test(l.hash)&&!sessionStorage.getItem('smartflow-intro-seen')&&!matchMedia('(prefers-reduced-motion: reduce)').matches)d.setAttribute('data-login-intro','plaza');}catch(e){}})();`;
import { ToastProvider } from '../lib/toast';

// The type (Inter for the interface, wide Saira for brand moments) is
// self-hosted through @font-face in globals.css from app/fonts. next/font was
// tried first, as the brief asked, but it refuses the production assetPrefix
// ('./') that the Electron build depends on.

export const metadata: Metadata = {
  title: 'SmartFlow NLEX — Decision Intelligence Dashboard',
  description: 'SmartFlow NLEX Decision-Intelligence dashboard for traffic monitoring, incident analysis, and AI-powered predictions.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // data-scroll-behavior declares the smooth scrolling that globals.css sets on
  // <html>. Next.js suspends it during route changes so a navigation does not
  // animate the scroll position, and warns that a future version will stop
  // doing that unless the attribute is present. Declaring it keeps today's
  // behaviour and clears the warning.
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <head>
        {/* Stamps the stored theme before first paint so a dark-theme reload
            never flashes the light palette. Must stay ahead of the stylesheet. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* The reader's "background effects" switch, before first paint (lib/effects.ts). */}
        <script dangerouslySetInnerHTML={{ __html: EFFECTS_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
