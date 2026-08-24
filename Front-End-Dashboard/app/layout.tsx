import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider, THEME_INIT_SCRIPT } from '../lib/theme';
import { ToastProvider } from '../lib/toast';

export const metadata: Metadata = {
  title: 'SmartFlow NLEX — Decision Intelligence Dashboard',
  description: 'SmartFlow NLEX Decision-Intelligence dashboard for traffic monitoring, incident analysis, and AI-powered predictions.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Stamps the stored theme before first paint so a dark-theme reload
            never flashes the light palette. Must stay ahead of the stylesheet. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
      </head>
      <body>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
