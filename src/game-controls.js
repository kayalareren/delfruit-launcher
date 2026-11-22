const defaults = Object.freeze({
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  jump: 'ShiftLeft', shoot: 'KeyZ', restart: 'KeyR', skip: 'KeyS', pause: 'KeyP'
});
const special = {
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163,
  Space: 32, Enter: 13, Backspace: 8, Tab: 9, Escape: 27,
  Insert: 45, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221, Backslash: 220,
  Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191, Backquote: 192
};

function virtualKey(code) {
  if (typeof code !== 'string') return null;
  if (Object.hasOwn(special, code)) return special[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return 111 + Number(code.slice(1));
  return null;
}

function normalizeBindings(value) {
  const result = {};
  for (const [action, fallback] of Object.entries(defaults)) {
    result[action] = virtualKey(value?.[action]) ? value[action] : fallback;
  }
  return result;
}

function mappingArgs(bindings) {
  return Object.entries(defaults).flatMap(([action, target]) => {
    const source = bindings[action];
    if (source === target || !virtualKey(source)) return [];
    return [`${virtualKey(source)}:${virtualKey(target)}`];
  });
}

function normalizeGamepadBindings(value) {
  return Object.fromEntries(Object.keys(defaults).map((action) => {
    const button = value?.[action];
    return [action, Number.isInteger(button) && button >= 0 && button < 16 ? button : null];
  }));
}

function gamepadMappingArgs(value) {
  const buttons = normalizeGamepadBindings(value);
  return Object.entries(defaults).flatMap(([action, key]) =>
    buttons[action] === null ? [] : [`pad:${buttons[action]}:${virtualKey(key)}`]);
}

module.exports = { defaults, virtualKey, normalizeBindings, mappingArgs, normalizeGamepadBindings, gamepadMappingArgs };
