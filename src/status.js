import { countdownDisplay } from './emoji.js';
import { cycleStart } from './tracker.js';

export function statusText(snapshot, emojis, now = Date.now()) {
  const line = (label, value) => {
    const remaining = Math.max(0, (value?.until ?? 0) - now);
    if (!remaining) return `- **${label}**: ready!`;
    const display = countdownDisplay(remaining, emojis);
    return `- **${label}**: ${display} <t:${Math.floor(value.until / 1000)}:R>`;
  };
  const resetRemaining = cycleStart(now) + 86_400_000 - now;
  const hours = Math.floor(resetRemaining / 3_600_000);
  const minutes = Math.ceil((resetRemaining % 3_600_000) / 60_000);
  const resetText = `${hours + Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return [
    line('owo', snapshot.cooldowns.owo),
    line('hunt', snapshot.cooldowns.hunt),
    line('pray/curse', snapshot.cooldowns.pray),
    '',
    `-# daily resets in ${resetText}`,
  ].join('\n');
}
