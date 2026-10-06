import { createHash } from 'node:crypto';

function walk(components = []) {
  return components.flatMap(c => [c, ...walk(c.components ?? []), ...(c.accessory ? walk([c.accessory]) : [])]);
}
function species(label) {
  const match = label.match(/<(?:a)?:([\w]+):(\d+)>|:([\w]+):/);
  return match ? { name: match[1] ?? match[3], emojiId: match[2] ?? null, instanceId: null } : null;
}
function stat(text, key) {
  const match = text.match(new RegExp('<a?:' + key + ':\\d+>\\s*`?([\\d,]+)(%)?'));
  return match ? Number(match[1].replaceAll(',','')) : null;
}
export function parseFormation(message) {
  const embed = (message.embeds ?? []).find(e => (e.fields ?? []).some(f => /^\[\d+\]/.test(f.name)));
  if (!embed) return null;
  const slots = (embed.fields ?? []).filter(f => /^\[\d+\]/.test(f.name)).map(f => {
    const weapon = f.value.match(/(?:^|\n)`([A-Z0-9]{3,10})`\s+<a?:/);
    return { position: Number(f.name.match(/^\[(\d+)\]/)[1]), species: species(f.name), label: f.name,
      level: Number(f.value.match(/\bLvl\.?\s*(\d+)/i)?.[1]) || null,
      stats: { hp: stat(f.value,'hp'), wp: stat(f.value,'wp'), str: stat(f.value,'att'), mag: stat(f.value,'mag'), prPercent: stat(f.value,'pr'), mrPercent: stat(f.value,'mr') },
      weaponId: weapon?.[1] ?? null,
      equipmentDisplay: weapon ? f.value.slice(weapon.index).trim() : null,
      detailCoverage: 'team-display; exact weapon coefficients may be missing' };
  }).sort((a,b) => a.position-b.position);
  const pageLabel = walk(message.components).find(c => c.custom_id === 'noop' && /^\d+\/\d+$/.test(c.label ?? ''))?.label;
  const page = (pageLabel ?? embed.footer?.text ?? '').match(/(?:Page\s+)?(\d+)\/(\d+)/i);
  const form = { presetPage: page ? Number(page[1]) : null, presetTotal: page ? Number(page[2]) : null,
    displayedName: embed.author?.name ?? null, active: null, activeMarkerObserved: (embed.footer?.text ?? '').includes('⭐'),
    slots, completeSlots: slots.length === 3 && slots.every((s,i) => s.position === i+1),
    note: 'Displayed preset is not proof of the currently selected team. Species is not a unique pet instance ID.' };
  form.compositionKey = createHash('sha256').update(JSON.stringify(slots.map(s => ({position:s.position,species:s.species,weaponId:s.weaponId})))).digest('hex').slice(0,16);
  form.stateKey = createHash('sha256').update(JSON.stringify(slots)).digest('hex').slice(0,16);
  return form;
}

export function formationChanges(before, after) {
  if (!before) return [{ type:'first-observation', note:'Not a confirmed equip/change action.' }];
  const changes=[];
  for (const slot of after.slots) {
    const old=before.slots.find(s=>s.position===slot.position);
    if (!old) { changes.push({position:slot.position,type:'slot-observed'}); continue; }
    for (const field of ['species','label','weaponId','level','stats','equipmentDisplay']) {
      if (JSON.stringify(old[field]) !== JSON.stringify(slot[field])) changes.push({position:slot.position,field,before:old[field],after:slot[field]});
    }
  }
  for (const old of before.slots) if (!after.slots.some(s=>s.position===old.position)) changes.push({position:old.position,type:'slot-not-visible',note:'Not proof of removal.'});
  return changes;
}
