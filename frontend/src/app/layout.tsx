import type { Metadata } from 'next';
import './globals.css';
import Providers from '@/components/Providers';
import Header from '@/components/Header';
import BackgroundArt from '@/components/BackgroundArt';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: 'Ufama — Smart Swap Aggregator on Stellar',
  description:
    'Peer-to-peer swaps, TWAP execution, and smart DEX routing. The cheapest way to swap on Stellar.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <BackgroundArt />
        <Providers>
          <Header />
          <main style={{ position: 'relative', zIndex: 1 }}>{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
