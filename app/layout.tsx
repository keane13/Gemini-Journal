import type { Metadata } from 'next';
import { Literata, Public_Sans } from 'next/font/google';
import './globals.css';

/**
 * Literata carries the product: everything the user writes and everything the model
 * writes back. Loaded with the optical-size axis so it tunes itself at 19px.
 */
const literata = Literata({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-literata',
  display: 'swap',
  axes: ['opsz'],
});

/** Public Sans is for the machinery around the writing: gutter, controls, rail, admin. */
const publicSans = Public_Sans({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-public-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Gemini Reflection Journal',
  description:
    'A private, user-authenticated journaling and reflection app powered by Gemini 3.6 Flash and Cloud Firestore with Google Authentication.',
  openGraph: {
    title: 'Gemini Reflection Journal',
    description:
      'A private, user-authenticated journaling and reflection app powered by Gemini 3.6 Flash and Cloud Firestore with Google Authentication.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Gemini Reflection Journal',
    description:
      'A private, user-authenticated journaling and reflection app powered by Gemini 3.6 Flash and Cloud Firestore with Google Authentication.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${literata.variable} ${publicSans.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
