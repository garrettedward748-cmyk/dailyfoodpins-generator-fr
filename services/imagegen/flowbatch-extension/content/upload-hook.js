// Runs in the page's own world (manifest: "world": "MAIN"), because only there
// can the file input Flow creates be reached. While a batch is uploading, a
// click on a file input is held back instead of opening the picker, and the
// bytes the extension sends are put into that input.
(() => {
  let held = null;
  const nativeClick = HTMLInputElement.prototype.click;

  HTMLInputElement.prototype.click = function (...args) {
    if (this.type !== 'file' || document.documentElement.getAttribute('data-fb-upload') !== 'true') {
      return nativeClick.apply(this, args);
    }
    held = this;
  };

  document.addEventListener('FB_UPLOAD_FILE', (event) => {
    const detail = event.detail;
    if (!detail || !held) return;
    try {
      const { dataUrl, filename, mimeType } = detail;
      const bytes = atob(String(dataUrl).split(',').pop());
      const buffer = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);

      const transfer = new DataTransfer();
      transfer.items.add(new File([buffer], filename, { type: mimeType }));
      held.files = transfer.files;
      held.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      held = null;
    }
  });
})();
