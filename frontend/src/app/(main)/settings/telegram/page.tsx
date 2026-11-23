'use client';

import TelegramAgentBots from '@/components/settings/TelegramAgentBots';

/** Telegram: one list of bots, all handled the same way (options per bot under Geavanceerd). */
export default function TelegramSettingsPage() {
  return (
    <div className="w-full">
      <TelegramAgentBots />
    </div>
  );
}
