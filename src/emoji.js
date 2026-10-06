import { readFileSync } from 'node:fs';

export function loadEmojiMap(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return new Map((data.items ?? [])
      .filter((item) => /^(?:fa|fb|s\d{3})$/.test(item.name) && /^\d{17,20}$/.test(item.id))
      .map((item) => [item.name, item.id]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

export function countdownDisplay(remainingMs, emojis) {
  if (remainingMs <= 0) return '0';
  if (remainingMs > 15_000) return String(Math.ceil(remainingMs / 1000));

  const halfSteps = Math.max(1, Math.min(30, Math.ceil(remainingMs / 500)));
  const numberName = `s${String(halfSteps * 5).padStart(3, '0')}`;
  const fractionName = halfSteps % 2 ? 'fa' : 'fb';
  const numberId = emojis.get(numberName);
  const fractionId = emojis.get(fractionName);
  if (numberId && fractionId) {
    return `<a:${numberName}:${numberId}><a:${fractionName}:${fractionId}>`;
  }
  return String(halfSteps / 2);
}

export function emojiList(emojis) {
  const names = Array.from({ length: 30 }, (_, index) => `s${String((index + 1) * 5).padStart(3, '0')}`);
  names.push('fa', 'fb');
  const entries = names.filter((name) => emojis.has(name))
    .map((name) => `<a:${name}:${emojis.get(name)}>`);
  if (!entries.length) return '絵文字一覧がありません。`aa.txt` を確認してください。';
  const rows = [];
  for (let i = 0; i < entries.length; i += 6) rows.push(entries.slice(i, i + 6).join(' '));
  return `**カウントダウン絵文字（${entries.length}個）**\n${rows.join('\n')}`;
}
