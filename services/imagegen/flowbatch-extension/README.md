# Flow Batch

A Manifest V3 extension for Brave/Chrome that runs a queue of prompts on Google Flow: it sets the
model and shape, attaches reference images, waits for each generation, and downloads the results.

It is a fresh implementation, written from a reading of how an existing Flow batch extension
behaves (REA static analysis of its content script and service worker). No code was copied, and it
does not use that extension's remote selector server.

## Install (Brave)

1. Open `brave://extensions` and turn on **Developer mode**.
2. **Load unpacked** and choose this folder.
3. Open a Flow **project**, reload the tab once, and click the extension icon.

Close DevTools on the Flow tab while a batch runs: the extension drives the page through the Chrome
debugger, which DevTools also uses. Brave shows a "debugging this browser" bar while it is attached.

## What it does

| Area        | Features                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Queue       | One prompt per line or blank-line separated; CSV/TSV import with per-row overrides; stop; retries; random delay      |
| Per prompt  | Mode (Image; Video as Frames or Ingredients), model, aspect ratio, results per prompt                                |
| References  | Image library; upload through Flow's picker, reusing an earlier upload by name; inline `@` mentions of images        |
| Characters  | Scan Flow's Characters list; a prompt that contains a character's name mentions it                                   |
| Pipelining  | Up to N prompts rendering at once; page actions are serialized by a lock so submit and download never collide        |
| Downloads   | Through the tile's own menu: Original size, 720p/1080p/1K, 2K, 4K (4K shows disabled on some plans); `NNN_prompt` names |
| Chaining    | Start the next prompt from the previous result's last frame (video) or the image itself                              |
| Recovery    | If every tile fails with no message from Flow, the page is reloaded and the remaining prompts resume                 |
| Layout      | Zooms the tab out while running (and restores your zoom) so Flow keeps its wide layout, which has the hover menu     |
| Tools       | **Scan page**, a selector editor with Test, and a log                                                                |

CSV columns: `prompt` (required), `mode`, `model`, `aspect`, `count`, `length`, `quality`,
`images` (separate with `;`), `characters`, `chain`. Empty cells use Settings.

## How it works

| File                     | Role                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| `shared/defaults.js`     | Selector map, settings, lists the panel offers                                  |
| `content/core.js`        | Finding elements, cancellation, the page lock, trusted click/hover/key          |
| `content/configure.js`   | Settings menu: only changes what differs; confirms the menu opened              |
| `content/media.js`       | Upload, picker search, `@` mentions, character scan                             |
| `content/upload-hook.js` | Runs in the page's world to feed bytes into Flow's file input                   |
| `content/tiles.js`       | Reads the results grid (`flow-tile-container`)                                  |
| `content/generate.js`    | Clear the box, fill the composer, press Generate, find the prompt's tiles       |
| `content/download.js`    | Wait for tiles, save through the tile menu, grab a frame for chaining           |
| `content/queue.js`       | The submit and watch loops, retries, chaining, recovery                         |
| `background.js`          | Debugger input, filename rules for downloads, tab zoom                          |
| `sidepanel.*`            | Queue, Settings, Library, Tools                                                 |

Facts measured on the live page and built in: the composer is `div.ProseMirror` and Generate is
`button[aria-label="Start generation"]`; a script-made click does nothing, so every click is a
debugger click; the settings chip (`Settings trigger`) opens radios that report `aria-checked`;
asset rows are `.asset-item-container` and a click attaches them; `@` opens the same picker and
inserts a `.mention-chip`; a tile's hotbar only exists in Flow's wide layout.

## Selectors

Selectors live in the side panel's **Tools** tab (CSS, `text:/regex/i`, `contains:/regex/i`, or
`scope >> selector`). The shipped defaults were checked against a signed-in Flow project, but Flow's
markup changes without notice. If something stops working: **Tools → Selectors → Test** shows how
many elements each selector finds (`0` is a miss), and **Scan page** with the relevant menu open
shows labels to write a replacement from.

## Tested against the live site

Image generation end to end, settings switching (including Frames/Ingredients and models), real file
upload and reuse by search, `@` mentions, two prompts in flight, original-size downloads with naming,
and the zoom fit/restore logic.

## Not tested, and known limits

- **Video generation** was not run (it costs credits); the video download menu was scanned, not clicked.
- **2K/4K image downloads**, **chaining**, the **character scan**, **CSV import**, **resume after a
  reload**, and the side-panel buttons themselves were not exercised against Flow.
- The narrow layout (the side panel takes width) was only checked by simulation: at zoom ≤ 0.6 Flow
  switches to its wide layout, and the extension computes the zoom needed.
- Tile detection relies on the page keeping a tile's element across placeholder → result. If Flow
  re-renders the grid, the run reports "A result tile left the page".
- Not included from the original: the node-based workflow editor, result previews in the panel,
  agent mode, and its human-style mouse simulation.
- Automating Flow may be restricted by Google's terms. Use it on your own account and at your own risk.
