(() => {
  const cursor = document.createElement('div');
  cursor.className = 'virtual-gamepad-pointer';
  cursor.hidden = true;
  cursor.setAttribute('aria-hidden', 'true');
  let x = 0;
  let y = 0;
  let menu;
  let hovered;
  let movingFor = 0;
  let previousX = 0;
  let previousY = 0;
  let browserEdge = 0;
  let browserWheel = 0;
  let browserWheelTime = 0;

  function resetBrowserEdge() {
    browserEdge = 0;
    browserWheel = 0;
    browserWheelTime = 0;
  }

  function resetMotion() {
    movingFor = 0;
    previousX = 0;
    previousY = 0;
    resetBrowserEdge();
  }

  function layer() {
    return document.querySelector('dialog[open]') ?? document.body;
  }

  function target() {
    return document.elementFromPoint(x, y);
  }

  function paint() {
    x = Math.max(0, Math.min(innerWidth - 1, x));
    y = Math.max(0, Math.min(innerHeight - 1, y));
    const surface = layer();
    if (cursor.parentElement !== surface) surface.append(cursor);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    const hit = target();
    const next = hit?.closest('button, select, input, a[href], summary, label');
    if (hovered !== next) {
      hovered?.classList.remove('gamepad-hover');
      hovered = next;
      hovered?.classList.add('gamepad-hover');
    }
  }

  function show() {
    if (!cursor.hidden) return;
    const focused = document.activeElement;
    const rect = focused !== document.body ? focused.getBoundingClientRect() : null;
    x = rect?.width ? (rect.left + rect.right) / 2 : innerWidth / 2;
    y = rect?.height ? (rect.top + rect.bottom) / 2 : innerHeight / 2;
    cursor.hidden = false;
    window.launcher.pointerVisible(true);
    paint();
  }

  function dismiss() {
    if (!menu) return false;
    menu.remove();
    menu = undefined;
    return true;
  }

  function hide() {
    resetMotion();
    if (!cursor.hidden) window.launcher.pointerVisible(false);
    cursor.hidden = true;
    hovered?.classList.remove('gamepad-hover');
    hovered = undefined;
    dismiss();
  }

  function openOptions(select) {
    dismiss();
    menu = document.createElement('div');
    menu.className = 'virtual-select-menu';
    menu.setAttribute('role', 'listbox');
    for (const [index, option] of [...select.options].entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.disabled = option.disabled || option.parentElement?.disabled === true;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === select.selectedIndex));
      button.addEventListener('click', () => {
        dismiss();
        select.focus({ preventScroll: true });
        if (select.selectedIndex === index) return;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      menu.append(button);
    }
    const rect = select.getBoundingClientRect();
    const width = Math.min(innerWidth - 16, Math.max(160, rect.width));
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    const below = innerHeight - rect.bottom - 8;
    if (below >= 120 || below >= rect.top - 8) {
      menu.style.top = `${rect.bottom}px`;
      menu.style.maxHeight = `${Math.max(20, Math.min(250, below))}px`;
    } else {
      menu.style.bottom = `${innerHeight - rect.top}px`;
      menu.style.maxHeight = `${Math.max(20, Math.min(250, rect.top - 8))}px`;
    }
    layer().append(menu);
    menu.children[select.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function guestInput(guest, event) {
    const rect = guest.getBoundingClientRect();
    const input = { ...event, x: Math.round(x - rect.left), y: Math.round(y - rect.top) };
    try { Promise.resolve(guest.sendInputEvent(input)).catch(() => {}); }
    catch {}
  }

  function click() {
    show();
    const hit = target();
    if (!hit) return;
    if (menu && !menu.contains(hit)) {
      dismiss();
      return;
    }
    const guest = hit.closest('webview');
    if (guest) {
      window.dispatchEvent(new Event('virtual-browser-click'));
      guest.focus();
      guestInput(guest, { type: 'mouseDown', button: 'left', clickCount: 1 });
      guestInput(guest, { type: 'mouseUp', button: 'left', clickCount: 1 });
      return;
    }
    const control = hit.closest('button, input, textarea, select, summary, a[href], label');
    if (!control || control.matches(':disabled')) return;
    const pointer = { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true };
    control.dispatchEvent(new PointerEvent('pointerdown', pointer));
    control.focus({ preventScroll: true });
    control.dispatchEvent(new PointerEvent('pointerup', pointer));
    if (control.tagName === 'SELECT') openOptions(control);
    else if (control.matches('input[type="range"]')) {
      const rect = control.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      const minimum = Number(control.min || 0);
      const maximum = Number(control.max || 100);
      const step = Number(control.step) || 1;
      control.value = String(Math.min(maximum, minimum + Math.round(ratio * (maximum - minimum) / step) * step));
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    } else control.click();
    paint();
  }

  function scroll(amount) {
    show();
    const hit = target();
    const guest = hit?.closest('webview');
    if (guest) {
      guestInput(guest, { type: 'mouseWheel', deltaY: -Math.round(amount) });
      return;
    }
    const area = scrollArea(hit);
    if (area) {
      area.scrollTop += amount;
      paint();
    }
  }

  function scrollArea(hit) {
    for (let element = hit; element; element = element.parentElement) {
      if (element.scrollHeight > element.clientHeight + 1 &&
          ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)) {
        return element;
      }
    }
    return null;
  }

  function scrollBrowserEdge(guest, oldY, direction, distance, elapsed) {
    const bounds = guest.getBoundingClientRect();
    const top = Math.max(0, bounds.top) + 5;
    const bottom = Math.min(innerHeight, bounds.bottom) - 5;
    if (x < bounds.left || x >= bounds.right || bottom <= top) {
      resetBrowserEdge();
      return;
    }
    const edge = direction < 0 ? top : bottom;
    const reached = direction < 0 ? oldY > edge && y <= edge : y >= edge;
    if (!reached && browserEdge !== direction) {
      resetBrowserEdge();
      return;
    }
    if (browserEdge !== direction) resetBrowserEdge();
    browserEdge = direction;
    y = edge;
    browserWheel += distance;
    browserWheelTime += elapsed;
    if (browserWheelTime >= 32) {
      guestInput(guest, { type: 'mouseWheel', deltaY: -Math.round(browserWheel) });
      browserWheel = 0;
      browserWheelTime = 0;
    }
  }

  document.addEventListener('pointermove', (event) => {
    if (event.isTrusted && (event.movementX || event.movementY)) hide();
  });
  window.virtualPointer = {
    move(horizontal, vertical, elapsed) {
      if (!horizontal && !vertical) return resetMotion();
      const magnitude = Math.max(1, Math.hypot(horizontal, vertical));
      const dx = horizontal / magnitude;
      const dy = vertical / magnitude;
      if (dx * previousX + dy * previousY < 0) movingFor = 0;
      movingFor = Math.min(1400, movingFor + elapsed);
      previousX = dx;
      previousY = dy;
      const ramp = Math.max(0, movingFor - 420) / 980;
      const speed = 0.38 + ramp * ramp * 0.47;
      show();
      const hit = vertical ? target() : null;
      const guest = hit?.closest('webview');
      // Only a page or a virtual select menu can hold the pointer at a scroll edge.
      const area = guest ? null : hit?.closest('#libraryPage, .scroll-page, .settings-page, .virtual-select-menu');
      const oldY = y;
      x += dx * elapsed * speed;
      y += dy * elapsed * speed;
      if (guest) scrollBrowserEdge(guest, oldY, Math.sign(dy), dy * elapsed * speed, elapsed);
      else resetBrowserEdge();
      if (area) {
        const bounds = area.getBoundingClientRect();
        const top = Math.max(0, bounds.top);
        const bottom = Math.min(innerHeight, bounds.bottom);
        const maxScroll = area.scrollHeight - area.clientHeight;
        if (x >= bounds.left && x < bounds.right && bottom - top > 24) {
          const before = area.scrollTop;
          if (vertical < 0 && oldY >= top + 8 && y <= top + 8 && before > 0) {
            area.scrollTop -= Math.abs(dy) * elapsed * speed;
            if (area.scrollTop < before) y = top + 8;
          } else if (vertical > 0 && oldY <= bottom - 8 && y >= bottom - 8 && before < maxScroll - 1) {
            area.scrollTop += Math.abs(dy) * elapsed * speed;
            if (area.scrollTop > before) y = bottom - 8;
          }
        }
      }
      paint();
    },
    click, scroll, dismiss, hide,
    visible: () => !cursor.hidden
  };
})();
