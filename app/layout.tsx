import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'Gemini Reflection Journal',
  description: 'A private, user-authenticated journaling and reflection app powered by Gemini 3.6 Flash and Cloud Firestore with Google Authentication.',
  openGraph: {
    title: 'Gemini Reflection Journal',
    description: 'A private, user-authenticated journaling and reflection app powered by Gemini 3.6 Flash and Cloud Firestore with Google Authentication.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Gemini Reflection Journal',
    description: 'A private, user-authenticated journaling and reflection app powered by Gemini 3.6 Flash and Cloud Firestore with Google Authentication.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
