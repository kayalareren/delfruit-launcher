(() => {
  const directions = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const padNames = ['A / ×', 'B / ○', 'X / □', 'Y / △', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2',
    'View / Share', 'Menu / Options', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →'];
  const pointer = window.virtualPointer;
  let capture;
  const heldArrows = new Set();
  let keyboardExpiresAt = 0;
  const browserArrows = new Map();
  const arrowBits = { ArrowLeft: 1, ArrowUp: 2, ArrowRight: 4, ArrowDown: 8 };
  let physicalArrows = null;
  let browserMotionUntil = 0;
  const site = document.querySelector('#site');

  function stopKeyboardMotion() {
    heldArrows.clear();
    browserArrows.clear();
    keyboardExpiresAt = 0;
    browserMotionUntil = 0;
    pointer.move(0, 0, 0);
  }
  let windowFocused = document.hasFocus();
  let focusEventReceived = false;
  window.launcher.on('window-focus', (focused) => {
    focusEventReceived = true;
    windowFocused = focused;
    if (!focused) {
      stopKeyboardMotion();
      pointer.hide();
    }
  });
  void window.launcher.windowFocused().then((focused) => {
    if (!focusEventReceived) windowFocused = focused;
  }).catch(console.error);

  function focusSidebar() {
    stopKeyboardMotion();
    pointer.hide();
    const dialog = document.querySelector('dialog[open]');
    const target = dialog?.querySelector('input, select, button:not([hidden])') ??
      document.querySelector('.nav .active');
    target?.focus({ preventScroll: true });
  }

  function cancel() {
    if (pointer.dismiss()) return true;
    const details = document.activeElement.closest('details[open]') ??
      document.querySelector('.game-options[open], .tag-filter[open]');
    if (details) {
      details.open = false;
      details.querySelector('summary').focus();
      return true;
    }
    return false;
  }

  function keyboardDirection(keys) {
    let x = 0;
    let y = 0;
    for (const key of keys) {
      const [horizontal, vertical] = directions[key];
      if (horizontal) x = horizontal;
      if (vertical) y = vertical;
    }
    return [x, y];
  }

  function handlePointerKey(key, repeat, allowClick = true) {
    if (!windowFocused) return false;
    if (Object.hasOwn(directions, key)) {
      browserArrows.clear();
      browserMotionUntil = 0;
      if (!repeat) {
        const now = performance.now();
        if (now >= keyboardExpiresAt) heldArrows.clear();
        heldArrows.delete(key);
        heldArrows.add(key);
        keyboardExpiresAt = now + 600;
        const [x, y] = keyboardDirection(heldArrows);
        pointer.move(x, y, 16);
      } else if (heldArrows.has(key)) keyboardExpiresAt = performance.now() + 450;
    } else if (key === 'Enter' && allowClick) {
      if (!repeat) pointer.click();
    } else if (key === 'PageUp' || key === 'PageDown') {
      pointer.scroll(key === 'PageDown' ? 220 : -220);
    } else return false;
    return true;
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.target.closest?.('[data-listening]')) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const textInput = event.target.matches?.('textarea, input:not([type=checkbox]):not([type=radio]), [contenteditable=true]');
    if (handlePointerKey(event.key, event.repeat, !textInput || pointer.visible())) {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === 'Escape' && cancel()) {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === 'F6') {
      event.preventDefault();
      focusSidebar();
    } else if (event.key === 'Tab' || (textInput && event.key.length === 1)) {
      pointer.hide();
    }
  }, true);
  function releaseArrow(key) {
    if (heldArrows.delete(key) && !heldArrows.size) pointer.move(0, 0, 0);
  }

  document.addEventListener('keyup', (event) => releaseArrow(event.key), true);
  window.addEventListener('blur', stopKeyboardMotion);
  window.addEventListener('virtual-browser-click', stopKeyboardMotion);
  site.addEventListener('did-start-navigation', (event) => {
    if (event.isMainFrame) stopKeyboardMotion();
  });
  document.addEventListener('input', (event) => {
    if (event.isTrusted && event.target.matches('textarea, input:not([type=checkbox]):not([type=radio])')) pointer.hide();
  });
  window.launcher.on('focus-navigation', focusSidebar);
  window.launcher.on('browser-arrow-state', (state) => {
    if (state !== null && physicalArrows !== null) {
      for (const key of browserArrows.keys()) {
        if ((physicalArrows & arrowBits[key]) && !(state & arrowBits[key])) browserArrows.delete(key);
      }
    }
    if (state === null) {
      browserArrows.clear();
      browserMotionUntil = 0;
    }
    physicalArrows = state;
  });
  window.launcher.on('browser-pointer-key', ({ key, down, repeat }) => {
    if (!down) {
      releaseArrow(key);
      if (browserArrows.delete(key) && !browserArrows.size) {
        browserMotionUntil = 0;
        pointer.move(0, 0, 0);
      }
      return;
    }
    if (!windowFocused || !document.querySelector('#browserPage.active')) return;
    if (!Object.hasOwn(directions, key)) {
      handlePointerKey(key, repeat);
      return;
    }
    heldArrows.clear();
    keyboardExpiresAt = 0;
    const now = performance.now();
    if (physicalArrows === null) {
      for (const [arrow, until] of browserArrows) {
        if (now >= until) browserArrows.delete(arrow);
      }
      if (repeat) browserMotionUntil = now + 34;
    }
    browserArrows.set(key, now + 70);
    if (!repeat) {
      const pressed = [...browserArrows.keys()].filter((arrow) =>
        arrow === key || physicalArrows === null || (physicalArrows & arrowBits[arrow]));
      pointer.move(...keyboardDirection(pressed), 16);
    }
  });

  function browserShortcut(button) {
    const browser = document.querySelector('#browserPage.active');
    if (!browser || document.querySelector('dialog[open]')) return false;
    const site = browser.querySelector('webview');
    try {
      if (button === 'reload') {
        site.reload();
        return true;
      }
      const url = new URL(site.getURL());
      const home = ['delicious-fruit.com', 'www.delicious-fruit.com'].includes(url.hostname) &&
        url.pathname === '/';
      if (!home && site.canGoBack()) {
        site.goBack();
        return true;
      }
    } catch {
      // The webview has no navigation history before its first page is ready.
    }
    return false;
  }

  let oldButtons = [];
  let lastFrame = 0;
  function poll(now) {
    requestAnimationFrame(poll);
    const elapsed = Math.min(35, lastFrame ? now - lastFrame : 16);
    lastFrame = now;
    if (!windowFocused) { oldButtons = []; return; }
    let pads = [];
    try { pads = [...(navigator.getGamepads?.() ?? [])].filter((pad) => pad?.mapping === 'standard'); }
    catch {}
    const pressed = padNames.map((_, index) => pads.some((pad) => pad.buttons[index]?.pressed));
    const fresh = (index) => pressed[index] && !oldButtons[index];
    const newlyPressed = pressed.findIndex((button, index) => button && fresh(index));
    const axis = (index) => {
      const value = pads.map((pad) => pad.axes[index] ?? 0).sort((a, b) => Math.abs(b) - Math.abs(a))[0] ?? 0;
      return Math.abs(value) > 0.2 ? Math.sign(value) * (Math.abs(value) - 0.2) / 0.8 : 0;
    };
    const browserKeys = [...browserArrows].filter(([key, until]) => physicalArrows === null
      ? now < browserMotionUntil && now < until
      : (physicalArrows & arrowBits[key]) !== 0).map(([key]) => key);
    const [keyX, keyY] = browserKeys.length
      ? keyboardDirection(browserKeys)
      : now < keyboardExpiresAt ? keyboardDirection(heldArrows) : [0, 0];
    const x = keyX || Number(pressed[15]) - Number(pressed[14]) || axis(0);
    const y = keyY || Number(pressed[13]) - Number(pressed[12]) || axis(1);
    if (capture && newlyPressed !== -1) {
      const setButton = capture;
      capture = undefined;
      setButton(newlyPressed);
    } else if (!capture) {
      pointer.move(x, y, elapsed);
      const scroll = axis(3);
      if (scroll) pointer.scroll(scroll * elapsed * 0.65);
      if (fresh(0)) pointer.click();
      if (fresh(1) && !cancel() && !browserShortcut('back')) {
        const dialog = document.querySelector('dialog[open]');
        if (!dialog) focusSidebar();
        else if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
      }
      if (fresh(3)) browserShortcut('reload');
    } else pointer.move(0, 0, elapsed);
    oldButtons = pressed;
  }
  requestAnimationFrame(poll);
  window.gamepadNavigation = {
    names: padNames,
    capture(callback) { capture = callback; },
    stopCapture() { capture = undefined; }
  };
})();
