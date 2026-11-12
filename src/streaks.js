// Streak evidence from OwO's own displays. Counting consecutive observed wins alone
// undercounts: battles in other channels or before collection started are invisible.
const number = (value) => value == null ? null : Number(String(value).replaceAll(',', ''));

export function parseBattleResult(footer = '') {
  const result = footer.match(/You (won|lost) in (\d+) turns?|It's a tie(?: in (\d+) turns?)?/i);
  const outcome = result ? result[1]?.toLowerCase() ?? 'tie' : 'unknown';
  const lost = footer.match(/lost your streak(?: of\s*\**([\d,]+))?/i);
  const shown = footer.match(/(?<!highest\s)\bstreak\s*[:：]\s*\**([\d,]+)/i);
  const xp = footer.match(/gained\s+\**([\d,]+)\**(?:\s*\+\s*\**([\d,]+)\**)?\s*xp/i);
  return {
    outcome,
    turns: result ? Number(result[2] ?? result[3]) || null : null,
    // The value OwO printed after this battle. A loss without a printed value stays null here.
    streak: shown ? number(shown[1]) : null,
    lostStreak: lost?.[1] ? number(lost[1]) : null,
    xp: xp ? number(xp[1]) : null,
    bonusXp: xp?.[2] ? number(xp[2]) : null,
  };
}

export function parseTeamStreak(text = '') {
  const match = text.match(/Current Streak:\s*\**([\d,]+)\**[^\n\d]{0,40}Highest Streak:\s*\**([\d,]+)/i);
  return match ? { current: number(match[1]), highest: number(match[2]) } : null;
}

// events: chronological [{type:'battle',outcome,streak,lostStreak,xp,bonusXp,at,source} | {type:'team',current,highest,at,source}]
export function summarizeStreak(events) {
  // basis: reported = printed by OwO; estimated = printed value plus later observed wins;
  // observed-lower-bound = only wins seen here, the real streak can be longer.
  let value = 0, basis = 'observed-lower-bound', asOf = null;
  let peak = { value: 0, basis, source: null }, reportedHighest = null;
  const breaks = [], bonuses = [];
  const xp = { won: { battles: 0, total: 0 }, lost: { battles: 0, total: 0 }, tie: { battles: 0, total: 0 }, bonusTotal: 0 };
  const rise = (source) => { if (value > peak.value || (value === peak.value && basis === 'reported')) peak = { value, basis, source }; };
  for (const e of events) {
    if (e.type === 'team') {
      value = e.current; basis = 'reported'; asOf = e.source;
      if (!reportedHighest || e.highest >= reportedHighest.value) reportedHighest = { value: e.highest, source: e.source };
      rise(e.source);
      continue;
    }
    if (e.outcome === 'unknown') continue;
    if (xp[e.outcome] && e.xp != null) {
      xp[e.outcome].battles++; xp[e.outcome].total += e.xp + (e.bonusXp ?? 0); xp.bonusTotal += e.bonusXp ?? 0;
    }
    if (e.outcome === 'lost') {
      const before = e.lostStreak ?? value;
      breaks.push({ streak: before, basis: e.lostStreak != null ? 'reported' : basis, turns: e.turns ?? null, source: e.source });
      value = e.streak ?? 0; basis = 'reported'; asOf = e.source;
      continue;
    }
    if (e.streak != null) { value = e.streak; basis = 'reported'; }
    else if (e.outcome === 'won') { value += 1; if (basis === 'reported') basis = 'estimated'; }
    asOf = e.source;
    rise(e.source);
    if (e.bonusXp) bonuses.push({ streak: e.streak ?? value, streakBasis: e.streak != null ? 'reported' : basis, xp: e.xp, bonusXp: e.bonusXp, source: e.source });
  }
  const mean = (g) => g.battles ? Math.round(g.total / g.battles) : null;
  const totalXp = xp.won.total + xp.lost.total + xp.tie.total;
  const highest = reportedHighest && reportedHighest.value >= peak.value
    ? { value: reportedHighest.value, basis: 'reported', source: reportedHighest.source } : peak;
  return {
    current: { value, basis, asOf },
    highest,
    breaks: { count: breaks.length, largest: breaks.reduce((best, b) => !best || b.streak > best.streak ? b : best, null), recent: breaks.slice(-10).reverse() },
    xp: { meanPerWin: mean(xp.won), meanPerLoss: mean(xp.lost), meanPerTie: mean(xp.tie), battlesWithXp: xp.won.battles + xp.lost.battles + xp.tie.battles,
      bonusTotal: xp.bonusTotal, bonusShare: totalXp ? Number((xp.bonusTotal / totalXp).toFixed(4)) : null },
    bonuses: bonuses.slice(-10).reverse(),
  };
}
