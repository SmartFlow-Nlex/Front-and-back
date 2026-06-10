import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SmartFlow',
  description: 'Decision-Intelligence dashboard for SmartFlow.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
