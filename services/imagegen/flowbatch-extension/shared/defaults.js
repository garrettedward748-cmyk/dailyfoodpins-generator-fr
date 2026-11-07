// Shared by the content scripts and the side panel: the selector map, the
// per-batch settings, and the lists the side panel offers.
//
// Only `promptTextarea` and `submitButton` are measured against the live page
// (see services/imagegen/extension/background.js). Everything else is a guess
// at Flow's labels. Use "Scan page" in the side panel on a signed-in project
// with the relevant menu open, then correct whichever keys miss.
//
// A selector is plain CSS, or one of:
//   text:/regex/i      a clickable whose aria-label or text matches
//   contains:/regex/i  the innermost element whose text or alt matches
//   scope >> selector  `selector` (any form above) inside elements matching CSS `scope`
// `{name}` in a template is replaced by the escaped value before matching.
self.FlowBatch = self.FlowBatch || {};

FlowBatch.DEFAULT_SELECTORS = {
  // composer
  promptTextarea: 'div.ProseMirror',
  submitButton: 'button[aria-label="Start generation"]',
  stopButton: 'text:/^(stop|cancel generation)/i',

  // settings menu. Measured from scans: the chip in the prompt box shows the
  // current setup ("Nano Banana 2.1 crop_16_9 x2") and opens an overlay of
  // role=radio buttons (mode, ratio, count) that report aria-checked, plus the
  // model-family picker. The chip has no aria-expanded, so Escape closes it.
  configButton: 'button[aria-label="Settings trigger"]',
  selectVideoMode: 'text:/^videocam\\s+Video$/i',
  selectImageMode: 'text:/^image\\s+Image$/i',
  // Video has two sub-modes, measured live: Frames and Ingredients. There is no
  // separate text-to-video; text alone is Ingredients with none attached.
  textToVideoModeOption: 'text:/^chrome_extension\\s*Ingredients$/i',
  imageToVideoModeOption: 'text:/^crop_free\\s*Frames$/i',
  componentToVideoModeOption: 'text:/^chrome_extension\\s*Ingredients$/i',
  aspectRatioTemplate: 'text:/(^|\\s){aspectRatio}$/i',
  outputCountTemplate: 'text:/^x{outputCount}$/i',
  modelSelectButton: 'button[aria-label="Select model family"]',
  // Measured: the list is role=menuitem buttons ("volume_up Veo 3.1 - Fast").
  modelTemplate: 'text:/{model}/i',
  // Not measured: no clip-length control showed in the menu (the chip reads
  // "Video · 720p · 8s ..."), so leave videoLength empty unless this is set.
  videoLengthTemplate: 'text:/^{videoLength}\\s*s/i',

  // reference media. Measured: the "+" button opens a popover with category
  // tabs (All, Images, Videos, Voices, Characters, Avatars, Uploads) and a
  // search box. The result items and the upload button are not measured yet.
  addImageButton: 'button[aria-label="Add ingredients to the prompt box"]',
  selectUploadImageType: 'div.add-menu-popover-container >> text:/^drive_folder_upload\\s+Uploads$/i',
  selectUploadVideoType: 'div.add-menu-popover-container >> text:/^drive_folder_upload\\s+Uploads$/i',
  sortOptionsButton: '',
  sortLatestOption: '',
  searchUploadedImage: 'input[aria-label="Search assets"]',
  // Measured: rows are div.asset-item-container in flow-add-menu-asset-list, and
  // clicking a row attaches it. Scoped to the list: an unscoped match finds the
  // same name on the grid captions behind the picker.
  firstFoundedItemSelector: 'flow-add-menu-asset-list >> contains:/{filename}/i',
  ingredientChip: 'flow-ingredient-chip',
  // Measured: a selected mention becomes <span class="mention-chip"> in the editor.
  mentionChip: 'div.ProseMirror .mention-chip',
  uploadMediaButton: 'text:/upload media/i',
  agreeTermUploadedVideoButton: 'text:/^(i agree|agree|accept)/i',
  // Ingredients stay in the prompt box between prompts; this empties it.
  clearPromptButton: 'button[aria-label="Clear prompt"]',

  // characters
  charactersTabButton: 'mat-nav-list[aria-label="Project navigation"] >> text:/characters/i',
  charactersNameSelector: "[role='tabpanel'] img[alt], [role='tabpanel'] [data-name]",
  selectUploadCharacterType: 'div.add-menu-popover-container >> text:/^accessibility_new\\s+Characters$/i',

  // results grid. Measured: each result is a <flow-tile-container> holding a
  // <flow-image-tile> (img.image) or a <flow-video-tile> (img.thumbnail, and a
  // <video> once it is loaded). Empty outputItems derives tiles from media.
  outputItems: 'flow-tile-container',
  outputVideo: 'flow-video-tile video, flow-video-tile img.thumbnail',
  outputImage: 'flow-image-tile img.image',
  tileOnQueue: 'contains:/queue|waiting/i',
  tileOnGenerating: 'contains:/^\\d{1,3}%$/',
  progressText: '^\\d{1,3}%$',

  // hover menu on a finished tile (wide layout only; the narrow "mobile" layout
  // has no hover overlay, so the runner zooms the tab out). Measured: hovering
  // shows a hotbar whose "More options" opens a menu with "Download", which opens
  //   image: 1K Original size / 2K Upscaled / 4K Upscaled
  //   video: 270p Animated GIF / 360p Original size / 720p Upscaled (1080p, 4K on newer clips)
  moreOptionsButtonInHoverTile: 'flow-hotbar-container button[aria-label="More options"]',
  downloadButtonInHoverTile: 'text:/^download\\s+Download$/i',
  qualityOriginalOption: 'text:/original size/i',
  quality720Option: 'text:/^720p/i',
  quality1080Option: 'text:/^(1080p?|1K)\\b/i',
  quality2KOption: 'text:/^2K\\b/i',
  quality4KOption: 'text:/^4K\\b/i',

  // failures
  errorContainer: "[role='alert'], [role='status']",
  errorText: 'something went wrong|failed|violat|not allowed|try again',
};

FlowBatch.DEFAULT_SETTINGS = {
  mode: 'textToVideo',
  model: '',
  aspectRatio: '',
  outputCount: 1,
  videoLength: '', // empty: leave Flow's clip length alone
  quality: 'original', // original | 720 | 1080 | 2k | 4k | none
  folder: 'flow-batch',
  prefix: '',
  autoRename: true,
  split: 'line',
  maxInFlight: 1,
  retries: 2,
  delayMin: 5,
  delayMax: 15,
  timeoutMinutes: 15,
  maxImagesPerPrompt: 3,
  attachAll: false,
  chain: false,
  zoomOut: true, // zoom the tab out so Flow keeps its wide layout (needed for the hover menu)
};

FlowBatch.MODES = [
  ['textToVideo', 'Text → Video (Ingredients)'],
  ['imageToVideo', 'Frames → Video'],
  ['componentsToVideo', 'Ingredients → Video'],
  ['textToImage', 'Text → Image'],
  ['imageToImage', 'Image → Image'],
];

FlowBatch.MODELS = ['Nano Banana 2.1', 'Veo 3.1 - Fast', 'Veo 3.1 - Lite', 'Veo 3.1 - Lite [Lower Priority]', 'Veo 3.1 - Quality', 'Omni 1.1 Flash'];
FlowBatch.RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
FlowBatch.LENGTHS = ['4', '6', '8'];
FlowBatch.QUALITIES = [
  ['original', 'Original size'],
  ['720', '720p upscaled (video)'],
  ['1080', '1K image / 1080p video'],
  ['2k', '2K'],
  ['4k', '4K'],
  ['none', 'Do not download'],
];

FlowBatch.isVideoMode = (mode) => /ToVideo$/.test(mode);
