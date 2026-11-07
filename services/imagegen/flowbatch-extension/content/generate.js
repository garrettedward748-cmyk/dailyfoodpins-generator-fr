// One prompt, up to the point Flow has accepted it: configure the menu, attach
// references, type the prompt (with inline @mentions), press Generate, and work
// out which tiles are this prompt's.
(() => {
  const FB = self.FlowBatch;
  const C = FB.core;

  const editorBox = () => {
    const editor = C.find(C.selectors().promptTextarea);
    const button = C.find(C.selectors().submitButton);
    return { editor, button, text: editor ? editor.innerText.trim() : null };
  };

  async function focusComposer() {
    const { editor } = editorBox();
    if (!editor) throw new Error('No prompt box on this page. Open a Flow project first');
    // Clicked, not focus()ed: ProseMirror takes its caret from the pointer.
    await C.click(editor, 'the prompt box');
  }

  async function typeText(text, replace) {
    const reply = await C.ask({ type: 'TYPE_TEXT', text, replace });
    if (reply.error) throw new Error(reply.error);
    return reply.text;
  }

  async function fillPrompt(item) {
    await focusComposer();
    const names = item.images.map((image) => FB.media.baseName(image.name));
    const characters = item.characters;

    const spans = [
      ...FB.media.findMentions(item.prompt, names).map((s) => ({ ...s, kind: 'image' })),
      ...FB.media.findMentions(item.prompt, characters).map((s) => ({ ...s, kind: 'character' })),
    ].sort((a, b) => a.index - b.index || b.length - a.length);

    const kept = [];
    let end = 0;
    for (const span of spans) {
      if (span.index < end) continue;
      kept.push(span);
      end = span.index + span.length;
    }

    if (!kept.length) {
      const typed = await typeText(item.prompt, true);
      if (typed !== item.prompt.trim()) throw new Error(`The prompt box holds ${JSON.stringify((typed || '').slice(0, 60))}`);
      return;
    }

    await typeText('', true);
    let cursor = 0;
    for (const span of kept) {
      const lead = item.prompt.slice(cursor, span.index);
      if (lead) await typeText(lead, false);
      const name = span.kind === 'image' ? names[span.nameIndex] : characters[span.nameIndex];
      await FB.media.mention(name, span.kind);
      cursor = span.index + span.length;
    }
    if (cursor < item.prompt.length) await typeText(item.prompt.slice(cursor), false);
  }

  // The images a prompt gets: those named in its text, then (if asked) the rest,
  // capped by the per-prompt limit.
  function imagesFor(item, library) {
    const named = item.imageNames.map((name) => library.find((image) => FB.media.baseName(image.name).toLowerCase() === FB.media.baseName(name).toLowerCase())).filter(Boolean);
    const extra = item.attachAll ? library.filter((image) => !named.includes(image)) : [];
    return [...(item.extraImages || []), ...named, ...extra].slice(0, Math.max(1, item.maxImages));
  }

  async function submit() {
    const s = C.selectors();
    let box = editorBox();
    // The button turns on a frame or two after the editor's own change event.
    for (let i = 0; i < 30 && !(box.button && !C.isDisabled(box.button)); i++) {
      await C.sleep(100);
      box = editorBox();
    }
    if (!box.button || C.isDisabled(box.button)) throw new Error(`Generate stayed disabled (${s.submitButton})`);

    await C.click(box.button, 'Generate');

    // Accepted is the composer going empty again.
    for (let i = 0; i < 40; i++) {
      await C.sleep(200);
      if (editorBox().text === '') return;
    }
    throw new Error('Flow did not accept the prompt (it is still in the box)');
  }

  // Run one prompt up to submission. Returns the tiles it created.
  async function startPrompt(item) {
    const known = new Set(FB.tiles.listTiles());

    await FB.configure(item);

    // Ingredients stay in the prompt box after a submit; start each prompt clean.
    if (await C.clickIfPresent(C.selectors().clearPromptButton, 'Clear prompt')) await C.wait(400);

    const attach = item.images;
    for (let i = 0; i < attach.length; i++) {
      C.log('info', `Uploading ${attach[i].name} (${i + 1}/${attach.length})`);
      if (!(await FB.media.attachImage(attach[i]))) C.log('warn', `Could not attach ${attach[i].name}; continuing`);
    }

    await FB.fillPrompt(item);
    await C.wait(C.between(500, 1500));
    await submit();

    // Placeholders appear right away; they are this prompt's tiles.
    const want = Math.max(1, item.outputCount);
    for (let i = 0; i < 120; i++) {
      await C.wait(500);
      const fresh = FB.tiles.listTiles().filter((tile) => !known.has(tile));
      if (fresh.length >= want) return fresh.slice(0, want);
      if (i > 20 && fresh.length) return fresh;
    }
    throw new Error('Flow accepted the prompt but no tiles appeared');
  }

  FB.fillPrompt = fillPrompt;
  FB.generate = { startPrompt, imagesFor };
})();
