import { createSpool, estimate, bookPrint, parseState } from './core.js';
const $ = selector => document.querySelector(selector);
const key = 'spoolpilot.v1';
const euro = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const grams = value => `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value)} g`;
let state, storageHealthy = true;
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').className = error ? 'error' : ''; }
try { state = parseState(localStorage.getItem(key)); }
catch { state = parseState(null); storageHealthy = false; notice('Gespeicherte Daten konnten nicht geladen werden. Exportiere die Rohdaten zur Sicherung; dieser Speicher wird nicht überschrieben.', true); }
function commit(next) {
  if (!storageHealthy) throw new Error('Speicher nicht verfügbar. Sichere zunächst die vorhandenen Daten.');
  try { localStorage.setItem(key, JSON.stringify(next)); }
  catch { throw new Error('Speichern fehlgeschlagen. Der Bestand wurde nicht geändert.'); }
  state = next; render();
}
function text(tag, value, className) { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; }
function inputData(form) { return Object.fromEntries(new FormData(form)); }
function render() {
  $('#total').textContent = grams(state.spools.reduce((sum, s) => sum + s.remainingGrams, 0));
  $('#count').textContent = state.spools.length; $('#jobs').textContent = state.prints.length;
  const selected = $('#spool-select').value;
  $('#rolls').replaceChildren(); $('#spool-select').replaceChildren();
  if (!state.spools.length) $('#rolls').append(text('p', 'Noch keine Rollen. Füge deine erste Rolle hinzu und plane deinen Druck.', 'empty'));
  for (const spool of state.spools) {
    const card = text('article', '', 'roll');
    const swatch = text('div', '◉', 'swatch'); swatch.style.color = spool.color;
    const info = text('div', '', 'roll-info'); info.append(text('h3', spool.name), text('p', `${spool.material} · ${grams(spool.remainingGrams)} von ${grams(spool.initialGrams)}`));
    const bar = document.createElement('progress'); bar.max = spool.initialGrams; bar.value = spool.remainingGrams; bar.setAttribute('aria-label', `Restbestand ${spool.name}`); info.append(bar);
    card.append(swatch, info); $('#rolls').append(card);
    const option = text('option', `${spool.name} · ${grams(spool.remainingGrams)}`); option.value = spool.id; $('#spool-select').append(option);
  }
  if (state.spools.some(s => s.id === selected)) $('#spool-select').value = selected;
  $('#history').replaceChildren();
  if (!state.prints.length) $('#history').append(text('p', 'Hier erscheinen deine abgeschlossenen Drucke.', 'empty'));
  for (const print of state.prints) {
    const row = text('article', '', 'history-row');
    const info = text('div', ''); info.append(text('h3', print.name), text('p', `${new Date(print.date).toLocaleDateString('de-DE')} · ${print.spoolName} · ${grams(print.grams)}`));
    row.append(info, text('strong', euro(print.total))); $('#history').append(row);
  }
  updateEstimate();
}
function updateEstimate() {
  const spool = state.spools.find(s => s.id === $('#spool-select').value);
  $('#book').disabled = true;
  if (!spool) { $('#cost').textContent = '—'; $('#availability').textContent = 'Füge zuerst eine Filamentrolle hinzu.'; return; }
  try {
    const result = estimate(spool, inputData($('#print-form')));
    $('#cost').textContent = euro(result.total); $('#material-cost').textContent = `Material ${euro(result.materialCost)}`; $('#power-cost').textContent = `Strom ${euro(result.powerCost)}`;
    $('#availability').textContent = result.enough ? `✓ Filament reicht · Danach bleiben ${grams(result.remainingGrams)}.` : `Zu wenig Filament · Es fehlen ${grams(result.grams - spool.remainingGrams)}.`;
    $('#availability').className = result.enough ? 'available' : 'error'; $('#book').disabled = !result.enough || !storageHealthy;
  } catch (error) { $('#cost').textContent = '—'; $('#material-cost').textContent = 'Material —'; $('#power-cost').textContent = 'Strom —'; $('#availability').textContent = error.message; }
}
$('#roll-form').addEventListener('submit', event => {
  event.preventDefault();
  try { const spool = createSpool(inputData(event.target), crypto.randomUUID()); commit({ ...state, spools: [...state.spools, spool] }); event.target.reset(); $('#add-details').open = false; notice('Rolle gespeichert. Bereit für deine nächste Idee.'); }
  catch (error) { notice(error.message, true); }
});
$('#print-form').addEventListener('input', updateEstimate);
$('#print-form').addEventListener('change', updateEstimate);
$('#print-form').addEventListener('submit', event => {
  event.preventDefault();
  try { const input = inputData(event.target); commit(bookPrint(state, input, crypto.randomUUID(), new Date().toISOString())); notice('Druck verbucht. Dein Filamentbestand wurde aktualisiert.'); }
  catch (error) { notice(error.message, true); }
});
$('#export').addEventListener('click', () => {
  try {
    const raw = storageHealthy ? JSON.stringify(state, null, 2) : localStorage.getItem(key);
    const url = URL.createObjectURL(new Blob([raw ?? ''], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `spoolpilot-${new Date().toISOString().slice(0,10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('Datensicherung exportiert.');
  } catch { notice('Der Browser erlaubt keinen Zugriff auf die gespeicherten Daten.', true); }
});
render();
