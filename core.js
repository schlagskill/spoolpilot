export const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'Sonstiges'];
export function number(value, label, min = 0, max = 100000) {
  if (value === '' || value === null || value === undefined) throw new Error(`${label} fehlt.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${label} muss zwischen ${min} und ${max} liegen.`);
  return result;
}
export function createSpool(input, id) {
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('Bitte eine Bezeichnung mit höchstens 80 Zeichen angeben.');
  if (!MATERIALS.includes(input.material)) throw new Error('Unbekanntes Material.');
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('Ungültige Farbe.');
  const initialGrams = number(input.initialGrams, 'Ursprüngliches Gewicht', 1);
  const remainingGrams = number(input.remainingGrams, 'Verbleibendes Filament');
  if (remainingGrams > initialGrams) throw new Error('Restgewicht darf nicht größer als das ursprüngliche Gewicht sein.');
  return { id, name, material: input.material, color: input.color, initialGrams, remainingGrams, price: number(input.price, 'Preis') };
}
export function estimate(spool, input) {
  const grams = number(input.grams, 'Verbrauch', 0.1);
  const hours = number(input.hours, 'Druckzeit', 0, 10000);
  const watts = number(input.watts, 'Leistung');
  const electricityRate = number(input.electricityRate, 'Strompreis', 0, 100);
  const materialCost = spool.price * grams / spool.initialGrams;
  const powerCost = hours * watts / 1000 * electricityRate;
  return { grams, hours, watts, electricityRate, materialCost, powerCost, total: materialCost + powerCost, enough: grams <= spool.remainingGrams, remainingGrams: Math.max(0, spool.remainingGrams - grams) };
}
export function bookPrint(state, input, id, date) {
  if (state.prints.some(p => p.id === id)) throw new Error('Dieser Druck wurde bereits verbucht.');
  const spool = state.spools.find(s => s.id === input.spoolId);
  if (!spool) throw new Error('Bitte eine vorhandene Rolle auswählen.');
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('Bitte einen Drucknamen mit höchstens 80 Zeichen angeben.');
  const result = estimate(spool, input);
  if (!result.enough) throw new Error('Für diesen Druck reicht das Filament nicht.');
  return { version: 1, spools: state.spools.map(s => s.id === spool.id ? { ...s, remainingGrams: Math.round(result.remainingGrams * 1000000) / 1000000 } : s), prints: [{ id, name, date, spoolName: spool.name, material: spool.material, ...result }, ...state.prints] };
}
export function parseState(raw) {
  if (raw === null) return { version: 1, spools: [], prints: [] };
  const state = JSON.parse(raw);
  if (state?.version !== 1 || !Array.isArray(state.spools) || !Array.isArray(state.prints)) throw new Error('Gespeicherte Daten sind ungültig.');
  const ids = new Set();
  const spools = state.spools.map(s => {
    if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) throw new Error('Ungültige Rollen-ID.');
    ids.add(s.id); return createSpool(s, s.id);
  });
  for (const p of state.prints) {
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.spoolName !== 'string' || !Number.isFinite(Date.parse(p.date))) throw new Error('Ungültiger Druckverlauf.');
    number(p.grams, 'Verbrauch', 0.1); number(p.total, 'Druckkosten', 0, 1e12);
  }
  return { version: 1, spools, prints: state.prints };
}
