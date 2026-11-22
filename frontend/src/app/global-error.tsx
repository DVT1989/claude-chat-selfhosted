'use client';

import ErrorScreen from '@/components/ErrorScreen';
import './globals.css';

/** Replaces the root layout when that itself fails, so it brings its own html and body. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="nl" data-theme="dark">
      <body className="h-full flex" style={{ color: 'var(--text)' }}>
        <ErrorScreen title="Er ging iets mis" text="De app kon niet worden geladen. Probeer het opnieuw of ga terug naar je chats." onRetry={reset} digest={error.digest} />
      </body>
    </html>
  );
}
