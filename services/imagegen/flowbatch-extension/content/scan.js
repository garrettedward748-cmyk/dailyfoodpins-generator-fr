// "Scan page": a dump of every control Flow shows right now, with enough
// attributes to write a selector from. Run it with the settings menu open,
// then again with a finished tile hovered, and paste both into the selector map.
(() => {
  const FB = self.FlowBatch;
  const { isVisible } = FB.core;

  const ATTRS = ['role', 'aria-label', 'aria-haspopup', 'aria-expanded', 'aria-selected', 'aria-checked', 'data-testid', 'data-index', 'data-value', 'title', 'placeholder', 'type', 'alt'];

  const cssPath = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const testid = node.getAttribute('data-testid');
      if (node.id && !/\d{3,}/.test(node.id)) {
        parts.unshift(`${part}#${CSS.escape(node.id)}`);
        break;
      }
      if (testid) part += `[data-testid="${testid}"]`;
      else {
        const label = node.getAttribute('aria-label');
        if (label) part += `[aria-label="${label.replace(/"/g, '\\"')}"]`;
        else if (typeof node.className === 'string' && node.className.trim()) {
          const stable = node.className.split(/\s+/).filter((c) => c && !/\d{3,}|^[a-zA-Z]{1,3}$/.test(c));
          if (stable.length) part += `.${stable.slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
        }
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  };

  function describe(el) {
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (value) attrs[name] = value.slice(0, 80);
    }
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      attrs,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      path: cssPath(el),
    };
  }

  const take = (selector, limit) => [...document.querySelectorAll(selector)].filter(isVisible).slice(0, limit).map(describe);

  FB.scanPage = () => ({
    url: location.href,
    title: document.title,
    editors: take('div.ProseMirror, [contenteditable="true"], textarea, input', 12),
    buttons: take('button, [role="button"]', 120),
    menuItems: take('[role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], li', 120),
    media: take('video, img', 40),
    dialogs: take('[role="dialog"], [role="menu"], [role="listbox"], [role="tabpanel"]', 12),
    percentLeaves: [...document.querySelectorAll('div,span')]
      .filter((el) => el.childElementCount === 0 && /^\d{1,3}%$/.test(el.textContent.trim()) && isVisible(el))
      .slice(0, 10)
      .map(describe),
  });
})();
