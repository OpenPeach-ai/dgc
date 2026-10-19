// How a Personal Pip sees (pip_eyes, Pips API 53), on its page. A Pip whose model can see uses its eyes and a cursor
// on its computer and sees the photos you send; one whose model reads text only asks you once (a card in its chat)
// and this row changes that answer: ask when it needs to see, let a model that can see look for it, or don't.
// Plain words, one row, the choice one click away.

export function eyesMarkup(state, {esc, busy = false, error = '', pipName = 'It', canSwitch = true}) {
  const off = busy ? ' disabled' : '';
  if (!state) return `<section class="pip-page-group" aria-label="Seeing">${error ? `<p class="error" role="alert">${esc(error)}</p>` : '<p class="muted" role="status">Loading…</p>'}</section>`;
  const model = esc(short(state.model)), vision = state.vision_model ? esc(short(state.vision_model)) : '';
  let words, control = '';
  if (state.sees === true) {
    words = `${model} sees ${esc(pipName)}'s screen and the photos you send.`;
  } else {
    const how = state.choice === 'relay' && vision ? `${vision} sees for it; ${model} does the rest.`
      : state.choice === 'off' ? 'It works without seeing.'
      : vision ? 'It asks you when it needs to see.' : 'None of your models can see images.';
    words = `${model} can’t see images. ${how}`;
    if (vision || state.choice !== 'ask') {
      const options = [['ask', 'Ask me when it needs to'], ...(vision ? [['relay', `Use ${short(state.vision_model)} to see`]] : []), ['off', 'Don’t let it see']];
      control = `<select id="pipEyes" aria-label="How ${esc(pipName)} sees"${off}>${options.map(([value, label]) => `<option value="${value}"${state.choice === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    }
  }
  const switchTo = state.sees !== true && vision && canSwitch
    ? `<button type="button" class="quiet pill" data-eyes-switch="${esc(state.vision_model)}"${off}>Switch to ${vision}</button>` : '';
  return `<section class="pip-page-group" aria-label="Seeing"><div class="pip-page-row static"><span class="row-words"><strong>Seeing</strong>`
    + `<small>${words}</small></span>${control}${switchTo}</div>`
    + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '') + '</section>';
}

export function short(model) {
  const name = String(model || '');
  return name.endsWith(':latest') ? name.slice(0, -':latest'.length) : name;
}

export function eyesNotice(choice, state) {
  const vision = short(state?.vision_model || 'that model');
  return choice === 'relay' ? `${vision} sees for it from now on.` : choice === 'off' ? 'It works without seeing from now on.' : 'It asks you when it needs to see.';
}
