'use client';

import ErrorScreen from '@/components/ErrorScreen';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="h-full flex">
      <ErrorScreen title="Er ging iets mis" text="Deze pagina kon niet worden geladen. Probeer het opnieuw of ga terug naar je chats." onRetry={reset} digest={error.digest} />
    </div>
  );
}
