'use client';

import dynamic from 'next/dynamic';

// Lazy: the canvas and its simulation only load on this tab
const Swarm = dynamic(() => import('@/components/swarm/Swarm'), {
  ssr: false,
  loading: () => <div className="swarm-wrap rounded-xl border border-(--border) bg-(--input) animate-pulse" />,
});

/** Swarm: a light picture of everything Claude knows, as the first tab of Geheugen. */
export default function SwarmPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-(--text)">Swarm</h1>
        <p className="text-sm text-(--muted)">Alles wat Claude weet in één beeld: feiten per onderwerp, gedeelde lessen, skills, terugkerende taken en de gesprekken waar iets uit is geleerd. Vastgezette feiten liggen in het midden, gearchiveerde aan de rand.</p>
      </div>
      <Swarm />
    </div>
  );
}
