import { readFileSync } from 'node:fs';
import { getSetting, setSetting } from './db/repos.js';

/**
 * Every operator-tunable value lives here and is edited in the web UI.
 * The .env file holds only ENCRYPTION_KEY.
 */

export interface SettingSpec {
  key: string;
  label: string;
  group:
    | 'general'
    | 'reels'
    | 'collage'
    | 'llm'
    | 'images'
    | 'buffer'
    | 'facebook'
    | 'telegram'
    | 'schedule'
    | 'retry';
  secret: boolean;
  default: string;
  help?: string;
  type?: 'text' | 'number' | 'password' | 'textarea';
  /**
   * Kept out of the settings page.
   *
   * The value, its default and any environment override all still work exactly
   * as before — this only stops it being rendered. These are deployment wiring
   * rather than decisions: the image service URL is always the container next
   * door, the poll numbers are a timeout nobody has ever needed to move, and a
   * field that only ever holds its default is a question the page is asking
   * for no reason.
   *
   * The save handler skips anything the form did not submit, so a hidden
   * setting cannot be blanked by saving the page.
   */
  hidden?: boolean;
}

export const SETTING_SPECS: SettingSpec[] = [
  // -- General -------------------------------------------------------------
  {
    key: 'timezone',
    label: 'Timezone',
    group: 'general',
    secret: false,
    hidden: true,
    default: process.env.TZ?.trim() || 'Africa/Algiers',
    help: 'Determines when the publishing day rolls over. Set TZ to change it.',
  },
  {
    key: 'automation_enabled',
    label: 'Automation enabled',
    group: 'general',
    secret: false,
    default: 'false',
    help:
      'The main switch. On: the platform publishes by itself, following each ' +
      'site\'s daily target and gap between posts. Off: nothing starts on its own. ' +
      'You can still run one article by hand from Home.',
  },

  {
    key: 'public_url',
    label: 'Public address of this platform',
    group: 'general',
    secret: false,
    default: process.env.PUBLIC_URL?.trim() ?? '',
    help:
      'Only needed for social-only accounts (a site added with no domain). Their pictures and ' +
      'reels are served from here, so Buffer and Facebook can fetch them: the address you open ' +
      'this platform at, e.g. https://platform.example.com.',
  },
  {
    key: 'media_keep_days',
    label: 'Keep social-only media for (days)',
    group: 'general',
    secret: false,
    default: '7',
    type: 'number',
    help:
      'Pictures and reels of social-only accounts are deleted from the platform after this many ' +
      'days: by then the networks have published the posts and hold their own copy. Raise it only ' +
      'if your Buffer queue holds posts longer than this.',
  },

  {
    key: 'google_rest_hours',
    label: 'Google account rest after "unusual activity" (hours)',
    group: 'general',
    secret: false,
    default: '2',
    type: 'number',
    help:
      'When Google flags a Flow account for unusual activity, it rests this long ' +
      'before it is used again, and the next account takes over. 0.5 = 30 minutes. ' +
      'Shorter brings accounts back sooner but risks being flagged again.',
  },

  {
    key: 'extra_post_gap_days',
    label: 'More posts: days between posts for one recipe',
    group: 'general',
    secret: false,
    default: '7',
    type: 'number',
    help: 'Content -> More posts waits this many days after the last post of a recipe on the same network before making another.',
  },
  {
    key: 'extra_auto_enabled',
    label: 'More posts: make them automatically',
    group: 'general',
    secret: false,
    default: 'false',
    help:
      'On: each day the scheduler picks published recipes that have waited longest and makes new Pinterest, Facebook and Instagram posts ' +
      'for them (new picture, new text, a new angle), on the networks each site has switched on. Off: only by hand in Content -> More posts.',
  },
  {
    key: 'extra_auto_per_day',
    label: 'More posts: recipes per site per day (automatic)',
    group: 'general',
    secret: false,
    default: '3',
    type: 'number',
    help: 'Used when "More posts: make them automatically" is on. The most recipes the scheduler makes extra posts for, per site, each day.',
  },
  {
    key: 'blog_cluster_cap_enabled',
    label: 'Blog: limit articles per dish',
    group: 'general',
    secret: false,
    default: 'true',
    help:
      'On: a blog question about a dish that already has the allowed number of articles on the site is not written ' +
      'and not suggested, so one dish does not fill the blog. Off: no limit.',
  },
  {
    key: 'blog_cluster_cap',
    label: 'Blog: most articles per dish',
    group: 'general',
    secret: false,
    default: '3',
    type: 'number',
    help: 'Used when "Blog: limit articles per dish" is on. Counts the posts that are about the same recipe.',
  },
  {
    key: 'halal_only',
    label: 'Halal only (no alcohol, no pork)',
    group: 'general',
    secret: false,
    default: 'true',
    help:
      'Keyword research drops such searches, keywords and blog questions naming them are refused, a run whose ' +
      'keyword names one is skipped before anything is spent, and every recipe and article is written without ' +
      'alcohol or pork (halal alternatives instead).',
  },

  // -- Schedule ------------------------------------------------------------
  {
    key: 'tick_minutes',
    label: 'Check every (minutes)',
    group: 'schedule',
    secret: false,
    default: '15',
    type: 'number',
    help:
      'How often the platform looks for something to publish. 1 to 5 minutes is ' +
      'fine. A site never posts more often than its own gap between posts, ' +
      'whatever you put here.',
  },
  {
    key: 'retention_days',
    label: 'Keep logs for (days)',
    group: 'schedule',
    secret: false,
    default: '30',
    type: 'number',
    help:
      'How long to keep the decision and event history before old entries are ' +
      'deleted. This never affects what gets published.',
  },

  // -- Retries -------------------------------------------------------------
  {
    key: 'auto_retry_enabled',
    label: 'Retry failed runs automatically',
    group: 'retry',
    secret: false,
    default: 'true',
    help:
      'When a run fails because of a temporary problem (a busy service, a ' +
      'timeout, image generation restarting), try again by itself. Problems that ' +
      'would fail the same way again, like a wrong token or an article the site ' +
      'refuses, are left for you.',
  },
  {
    key: 'auto_retry_max',
    label: 'Automatic attempts',
    group: 'retry',
    secret: false,
    default: '1',
    type: 'number',
    help:
      'How many automatic tries before the run stops and waits for you. Each try ' +
      'continues from where it failed; finished steps are not repeated.',
  },
  {
    key: 'auto_retry_delay_minutes',
    label: 'Wait before retrying (minutes)',
    group: 'retry',
    secret: false,
    default: '15',
    type: 'number',
    help:
      'How long to wait before the first retry. Each further retry waits twice as ' +
      'long.',
  },

  {
    key: 'pair_failure_limit',
    label: 'Hold a keyword back after (failures on one site)',
    group: 'retry',
    secret: false,
    default: '3',
    type: 'number',
    help:
      'If the same keyword keeps failing on the same site, stop offering it after ' +
      'this many failures and flag it on the keyword page for you. Temporary ' +
      'problems do not count. 0 never holds anything back.',
  },

  // -- LLM -----------------------------------------------------------------
  {
    key: 'llm_base_url',
    label: 'LLM base URL',
    group: 'llm',
    secret: false,
    hidden: true,
    default: process.env.LLM_BASE_URL?.trim() || 'https://ollama.com',
    help: 'Shared by every API key. Requests go to {base URL}/api/chat.',
  },

  {
    key: 'gsc_service_account',
    label: 'Search Console service account key (JSON)',
    group: 'llm',
    secret: true,
    hidden: true,
    default: '',
  },
  {
    key: 'gsc_min_impressions',
    label: 'Search Console: least impressions for an idea',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '20',
  },
  {
    key: 'youtube_category',
    label: 'YouTube category for Shorts',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '26',
    help:
      'YouTube refuses a post with no category. 26 is Howto & Style, where cooking belongs; '
      + '22 is People & Blogs and 24 is Entertainment. Change it only if your channel is in another niche.',
  },
  {
    key: 'tiktok_privacy',
    label: 'TikTok privacy level',
    group: 'llm',
    secret: false,
    hidden: true,
    default: 'PUBLIC_TO_EVERYONE',
    help:
      'TikTok refuses a post with no privacy level. PUBLIC_TO_EVERYONE is the usual choice for a '
      + 'public account; MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR and SELF_ONLY are TikTok\'s other options.',
  },

  // -- Radar ---------------------------------------------------------------
  // Which service reads the watched pages, and the two numbers that decide how
  // much it costs. Shown on their own page (Setup -> Radar) rather than here.
  {
    key: 'radar_provider',
    label: 'Radar: which service reads the pages',
    group: 'llm',
    secret: false,
    hidden: true,
    default: 'brightdata',
    help: 'brightdata or apify. Bright Data gives 5,000 records a month free; Apify gives $5 of compute a month free.',
  },
  {
    key: 'brightdata_token',
    label: 'Bright Data API tokens',
    group: 'llm',
    secret: true,
    hidden: true,
    default: '',
    help:
      'One or more, separated by commas, spaces or new lines. Each account has its own free allowance; ' +
      'when one is spent the next takes over, and scanning goes on from that token.',
  },
  {
    key: 'brightdata_token_index',
    label: 'Bright Data token in use',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '0',
  },
  {
    key: 'apify_token',
    label: 'Apify API tokens',
    group: 'llm',
    secret: true,
    hidden: true,
    default: '',
    help:
      'One or more, separated by commas, spaces or new lines. Each account has its own free allowance; ' +
      'when one is spent the next takes over, and scanning goes on from that token.',
  },
  {
    key: 'apify_token_index',
    label: 'Apify token in use',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '0',
  },
  {
    key: 'radar_posts_per_page',
    label: 'Radar: posts to read per page',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '25',
    help: 'Each post read is one record against the free allowance. 25 a day per page is well inside both free tiers.',
  },
  {
    key: 'radar_min_score',
    label: 'Radar: least engagement for an idea',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '0',
    help: 'Engagement is likes + 4x comments + 10x shares. 0 lets the AI judge everything it reads.',
  },
  {
    key: 'taxo_image_prompt',
    label: 'Taxonomy: image prompt for categories and cuisines',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '',
  },
  {
    key: 'serper_api_key',
    label: 'Serper API keys (Google results for keyword research)',
    group: 'llm',
    secret: true,
    // Shown as its own list on the General page (one row per key), not as a field.
    hidden: true,
    default: '',
    help:
      'Optional. From serper.dev (2,500 free searches per account). Several keys from several accounts: ' +
      'separate them with commas or spaces. When one runs out the next takes over, and searching goes on ' +
      'from that key (the spent one is not tried first again). Adds "People also ask" and related searches.',
  },
  {
    key: 'serp_research_enabled',
    label: 'Research Google before writing each recipe',
    group: 'llm',
    secret: false,
    default: 'true',
    help:
      'Reads the top Google results for the dish (Serper, then Ollama web search) and gives the writer ' +
      'their facts: common ingredients, times, temperatures, what they cover and miss, and the questions ' +
      'people ask. If no search answers, the article waits and retries for up to 6 hours, then is written ' +
      'without it and marked "no research" in Articles.',
  },
  {
    key: 'serper_key_index',
    label: 'Serper key in use',
    group: 'llm',
    secret: false,
    hidden: true,
    default: '0',
  },

  // -- Image generation ----------------------------------------------------
  {
    key: 'image_base_url',
    label: 'Image service URL',
    group: 'images',
    secret: false,
    hidden: true,
    default: process.env.IMAGE_BASE_URL ?? 'http://imagegen:8100',
    help:
      'Base URL of the image service. The default reaches the imagegen ' +
      'container over the internal Docker network; change it only to point at ' +
      'an instance running somewhere else.',
  },
  {
    key: 'flow_project_id',
    label: 'Flow project ID',
    group: 'images',
    secret: false,
    // Set per Google account now (Setup -> Google accounts). Kept, hidden, as
    // the fallback sent with each job and to seed account 1.
    hidden: true,
    default: process.env.FLOW_PROJECT_ID ?? '',
    help:
      'The Google Flow project that images are generated into, for any site that ' +
      'has no project of its own. Copy it from the address bar of the project in ' +
      'Flow: the long code after /project/.',
  },
  {
    // Rendered by the images group's footer rather than as a plain input, so
    // the page can show what Google last said to each model beside the choice.
    // Still a setting: the form submits it under this key and the save handler
    // stores it like any other.
    key: 'image_model',
    label: 'Image model',
    group: 'images',
    secret: false,
    hidden: true,
    default: 'auto',
  },
  {
    key: 'image_gap_seconds',
    label: 'Pause between images (seconds)',
    group: 'images',
    secret: false,
    default: '30',
    type: 'number',
    help:
      'A short pause between one image and the next. Several images back to back ' +
      'can make Google treat the session as automated. 30 seconds is a safe ' +
      'default; raise it if runs keep failing at the third or fourth image.',
  },
  {
    key: 'image_poll_interval_seconds',
    label: 'Image poll interval (seconds)',
    group: 'images',
    secret: false,
    hidden: true,
    default: '5',
    type: 'number',
  },
  {
    key: 'image_poll_max_attempts',
    label: 'Image poll max attempts',
    group: 'images',
    secret: false,
    hidden: true,
    default: '120',
    type: 'number',
    help: 'Bounds the polling loop. 120 attempts at 5s is a 10 minute ceiling.',
  },

  {
    key: 'run_step_timeout_minutes',
    label: 'Step timeout (minutes)',
    group: 'schedule',
    secret: false,
    default: '8',
    type: 'number',
    help:
      'If one step (writing the article, generating an image, posting) makes no ' +
      'progress for this long, the run is stopped and marked failed so it does ' +
      'not block everything else. 8 minutes is enough for the slowest normal ' +
      'step.',
  },
  {
    key: 'run_timeout_minutes',
    label: 'Run timeout (minutes)',
    group: 'schedule',
    secret: false,
    default: '10',
    type: 'number',
    help:
      'The longest a whole run may take before it is stopped. Normal runs take 4 ' +
      'to 6 minutes.',
  },

  // -- Collage ---------------------------------------------------------------
  // Shown on its own page (Setup → Collage), same reasoning as Reels above.
  {
    key: 'collage_enabled',
    label: 'Post a step-by-step photo collage',
    group: 'collage',
    secret: false,
    default: 'false',
    help:
      'On: every published article also gets a dedicated set of step photographs, laid into one ' +
      'grid and posted to the Facebook page assigned to its site (Channels → Accounts → Facebook ' +
      'pages, tick Collage). Off: no collage is made. This generates extra images per recipe, on ' +
      'top of the four the article already uses.',
  },
  {
    key: 'collage_steps',
    label: 'Photographs in the collage',
    group: 'collage',
    secret: false,
    default: '9',
    type: 'number',
    help: '6, 9 or 12 — a 3x2, 3x3 or 4x3 grid. More steps costs more image credits per recipe.',
  },
  {
    key: 'collage_watermark',
    label: 'Stamp the site address on the collage',
    group: 'collage',
    secret: false,
    default: 'true',
    help:
      'On: the site\'s own domain is printed twice on the grid, near the top and near the bottom, ' +
      'the way the collage stays recognisably yours if it is shared further. Off: a plain grid with no text.',
  },

  // -- Buffer --------------------------------------------------------------
  {
    key: 'fb_enabled',
    label: 'Publish reels to Facebook',
    group: 'facebook',
    secret: false,
    default: 'false',
    help:
      'On: every published article becomes a reel on the Facebook page assigned ' +
      'to its site (Channels → Accounts → Facebook pages). Off: nothing is posted to Facebook.',
  },

  // -- Reels -----------------------------------------------------------------
  // Shown on their own page (Setup → Reels) rather than in the general form:
  // the formats are a set of checkboxes, not a field.
  {
    key: 'reel_mode',
    label: 'How a reel is made',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'single',
    help:
      'single: one clip from one prompt and up to three of the article\u2019s photos. ' +
      'scenes: a storyboard of ten-second scenes, filmed one by one and joined.',
  },
  {
    key: 'reel_single_references',
    label: 'Photos sent with a single-clip reel',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '["feature","topShot","textureMacro"]',
  },
  {
    key: 'reel_length_seconds',
    label: 'Reel length (seconds)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '30',
    type: 'number',
    help:
      'How long a reel is. 30 seconds is three scenes; 60 is six. Longer costs more ' +
      'video credits per article.',
  },
  {
    key: 'reel_formats',
    label: 'Formats',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '["reveal","taste-test","three-things","mistake","pov","before-after","secret","countdown","myth","asmr","time-trap","first-bite","story"]',
  },
  {
    key: 'reel_fresh_images',
    label: 'Make a fresh image for every scene',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'false',
    help:
      "Off: scenes are filmed from the article's own images, which costs nothing " +
      'extra. On: a new image is made for every scene first.',
  },
  {
    key: 'reel_cta_text',
    label: 'Call to action',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'La recette complète : {domain}',
    help:
      'The last thing every reel says and shows. Write {domain} and each site stamps its own '
      + 'address, since one setting serves them all. Naming a place instead — "in the comments" — '
      + 'is wrong on two networks out of three, because the link sits somewhere different on each.',
  },
  {
    key: 'caption_networks',
    label: 'Networks that get the written caption',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'facebook,instagram,youtube,tiktok',
    help:
      'Edited on Setup -> Caption structures. A comma-separated list, or "none". A network left ' +
      'off this list gets the recipe title and the link instead, which is what every network got ' +
      'before the caption was written.',
  },
  {
    key: 'caption_extra_link',
    label: 'More posts: the recipe link',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'setup',
    help: 'Edited on Setup -> Caption structures. "setup": Facebook and Instagram follow their own link settings; "yes": the link is always in; "no": no link in More posts on Facebook and Instagram.',
  },
  {
    key: 'caption_fb_link',
    label: 'Facebook: where the recipe link goes',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'text',
    help:
      'Edited on Setup -> Caption structures. text: in the post, under the caption (what every reel did). ' +
      'comment: as the first comment, so the post itself carries no link. none: no link at all. ' +
      'If Buffer refuses the first comment (plans without it), the reel goes out without the link.',
  },
  {
    key: 'caption_fb_recipe',
    label: 'Facebook: how much of the recipe is in the post',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'full',
    help:
      'Edited on Setup -> Caption structures. full: ingredients and steps. ingredients: the ingredient list only. ' +
      'none: the caption alone. Written by the platform from the recipe itself, never by the model.',
  },
  {
    key: 'caption_fb_post_recipe',
    label: 'Facebook photo post: how much of the recipe is in the post',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'full',
    help: 'Edited on Setup -> Caption structures. full / ingredients / none, as for the reel.',
  },
  {
    key: 'caption_fb_post_link',
    label: 'Facebook photo post: where the recipe link goes',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'text',
    help: 'Edited on Setup -> Caption structures. text / comment / none, as for the reel.',
  },
  {
    key: 'caption_ig_post_recipe',
    label: 'Instagram photo post: how much of the recipe is in the caption',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'full',
    help: 'Edited on Setup -> Caption structures. full / ingredients / none. Limit 2200 characters: a recipe that does not fit gives way to the ingredients, then to the caption.',
  },
  {
    key: 'caption_pin_recipe',
    label: 'Pinterest pin: how much of the recipe follows the description',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'full',
    help: 'Edited on Setup -> Caption structures. full / ingredients / none. Pinterest takes about 500 characters, so a recipe that does not fit gives way to the ingredients, then to the description alone.',
  },
  {
    key: 'caption_yt_recipe',
    label: 'YouTube: how much of the recipe is in the description',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'full',
    help: 'Edited on Setup -> Caption structures. full / ingredients / none, as for Facebook. The link lines come after it.',
  },
  {
    key: 'caption_ig_recipe',
    label: 'Instagram: how much of the recipe is in the reel caption',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'full',
    help:
      'Edited on Setup -> Caption structures. full / ingredients / none. Instagram allows 2200 characters: ' +
      'a recipe that does not fit gives way to the ingredients alone, then to the caption.',
  },
  {
    key: 'caption_tt_recipe',
    label: 'TikTok: how much of the recipe is in the caption',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'full',
    help:
      'Edited on Setup -> Caption structures. full / ingredients / none, as for Instagram: TikTok captions ' +
      'have no clickable links either, and allow about the same length.',
  },
  {
    key: 'caption_yt_link_recipe',
    label: 'YouTube: "Full recipe:" line in the description',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'true',
  },
  {
    key: 'caption_yt_link_site',
    label: 'YouTube: "More recipes:" line in the description',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'true',
  },
  {
    key: 'ig_link_mode',
    label: 'Where the Instagram recipe link goes',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'bio',
    help: 'bio: Buffer free plan, the caption says the link is in the bio. comment: Buffer paid plan, the link is posted as the first comment.',
  },
  {
    key: 'ig_bio_line',
    label: 'Instagram caption line (link in bio)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'La recette complète : lien en bio',
  },
  {
    key: 'ig_comment_line',
    label: 'Instagram caption line (link in the first comment)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'La recette complète dans le premier commentaire 👇',
  },
  {
    key: 'ig_comment_text',
    label: 'Instagram first comment',
    group: 'reels',
    secret: false,
    hidden: true,
    default: 'La recette complète : {url}',
  },
  {
    key: 'recipe_tools_enabled',
    label: 'Tools box (affiliate)',
    group: 'general',
    secret: false,
    default: 'true',
    help: 'After each recipe is published, list the kitchen tools it uses and send them to the site, which shows them with Amazon links once its Settings has an Amazon Associates tracking ID. One small AI call per recipe.',
  },
  {
    key: 'reel_music_urls',
    label: 'Music for clip + steps reels (box 1)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '',
    help:
      'Links to mp3 files, one per line; each reel takes one at random from every box ' +
      'combined. Empty everywhere: the clip keeps its own sound and the photos are silent.',
  },
  // Boxes 2-6: the same field, repeated, so a large pasted-in library from
  // several Pixabay downloads has somewhere to go without one box holding
  // every link anyone has ever added. See MUSIC_SLOTS in reels/compose.ts.
  {
    key: 'reel_music_urls_2',
    label: 'Music for clip + steps reels (box 2)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '',
  },
  {
    key: 'reel_music_urls_3',
    label: 'Music for clip + steps reels (box 3)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '',
  },
  {
    key: 'reel_music_urls_4',
    label: 'Music for clip + steps reels (box 4)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '',
  },
  {
    key: 'reel_music_urls_5',
    label: 'Music for clip + steps reels (box 5)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '',
  },
  {
    key: 'reel_music_urls_6',
    label: 'Music for clip + steps reels (box 6)',
    group: 'reels',
    secret: false,
    hidden: true,
    default: '',
  },
  {
    key: 'fb_comment_trigger',
    label: 'Comment keyword for posts without their own',
    group: 'reels',
    secret: false,
    default: 'banana',
    help:
      'Every new reel, photo post and collage asks for a word taken from its own dish ' +
      '("Comment CHEESECAKE and we\'ll message you the recipe"), and the reply goes to ' +
      'whoever comments that word. This word is only for posts published before that, ' +
      'and for a dish whose title gives no usable word.',
  },
  {
    key: 'fb_public_reply',
    label: 'Reply publicly after sending the recipe',
    group: 'reels',
    secret: false,
    default: 'true',
    help:
      'After the recipe link is sent by private message, also answer the commenter ' +
      'under their comment ("Sent! Check your inbox"), picking a different phrasing at ' +
      'random. A failure here never affects the private message.',
  },
  {
    key: 'reel_publisher',
    label: 'Publish reels, Facebook posts and the collage through',
    group: 'reels',
    secret: false,
    default: 'facebook',
    help:
      'Governs the reel, the article\'s Facebook post, and the photo collage alike. ' +
      'facebook: published straight to the Page with its own access token -- a reel ' +
      "waits until Facebook says the video is ready, a post or the collage gets back " +
      "Facebook's own id in the same response, which is what the comment-keyword " +
      'webhook ("banana") needs to reply the moment the post goes out, with nothing ' +
      'to wait on. buffer: scheduled through the site\'s Buffer account instead, ' +
      "which holds the Facebook connection so there is no token to mint or renew -- " +
      'but Buffer only queues it, so nothing here can confirm Facebook accepted it, ' +
      'a reel is capped at 90 seconds, and the webhook only finds the post once a ' +
      'background check matches it to its real Facebook id, up to 10 minutes later.',
  },
  {
    key: 'buffer_enabled',
    label: 'Publish to Buffer',
    group: 'buffer',
    secret: false,
    default: 'true',
    help:
      'On: after each article, a Pinterest pin is scheduled through the site\'s ' +
      'Buffer account. Off: articles are published without a pin.',
  },
  {
    key: 'buffer_hold_hours',
    label: 'Hold a site for (hours) when every Buffer account is full',
    group: 'buffer',
    secret: false,
    default: '12',
    type: 'number',
    help:
      'If every Buffer account on a site is full for the day, wait this long ' +
      'before trying that site again. The article stays published; only the pin ' +
      'waits.',
  },

  // -- Telegram ------------------------------------------------------------
  {
    key: 'telegram_bot_token',
    label: 'Telegram bot token',
    group: 'telegram',
    secret: true,
    default: '',
    type: 'password',
    help:
      'Create a bot with @BotFather in Telegram and paste the token it gives you.',
  },
  {
    key: 'telegram_chat_id',
    label: 'Telegram chat ID',
    group: 'telegram',
    secret: false,
    default: '',
    help:
      'The chat or group that receives the messages. Add the bot to it, send it a ' +
      'message, then ask @userinfobot for the id.',
  },
  {
    key: 'telegram_enabled',
    label: 'Send Telegram notifications',
    group: 'telegram',
    secret: false,
    default: 'false',
    help:
      'Get a message when something needs you: keywords running out, a site ' +
      'failing repeatedly, image generation down, an article waiting for ' +
      'approval. One message when it starts, one when it is fixed.',
  },
];

const BY_KEY = new Map(SETTING_SPECS.map((s) => [s.key, s]));

/**
 * The API key shared with the image service.
 *
 * The two containers must agree on it, and asking someone to invent a secret
 * and paste it into two places is the kind of setup step that gets skipped or
 * mistyped. So imagegen generates one on first boot into a volume mounted by
 * both, and this reads it.
 *
 * Read on each call rather than cached: the containers start together, and the
 * platform may well look before imagegen has written. Re-reading means it
 * simply starts working a moment later instead of needing a restart.
 */
const SHARED_KEY_PATH = process.env.SHARED_SECRET_PATH ?? '/run/shared/image-api-key';

function sharedImageApiKey(): string {
  try {
    return readFileSync(SHARED_KEY_PATH, 'utf8').trim();
  } catch {
    // Absent is normal: not deployed with the shared volume, or imagegen has
    // not booted yet.
    return '';
  }
}

/**
 * The key the two containers authenticate with.
 *
 * Not a setting, and no longer a field on the settings page. It was one back
 * when the image service was a separate project that had to be wired up by
 * hand; now they ship together, imagegen generates the key into a volume both
 * containers mount, and the platform reads it. Nobody types it, and a box
 * inviting them to is a way to break a working deployment.
 *
 * The environment still wins, because deploying the two halves on different
 * hosts means no shared volume and the key has to come from somewhere.
 *
 * Any stored value from when this was editable is deliberately ignored: the
 * generated one is what imagegen actually checks against, so preferring it
 * repairs a mismatch instead of preserving one.
 */
function imageApiKey(): string {
  return (process.env.IMAGE_API_KEY ?? '').trim() || sharedImageApiKey();
}

export class Settings {
  constructor(private readonly encryptionKey: Buffer) {}

  get(key: string): string {
    // Resolved from the deployment, never from the settings table — see
    // imageApiKey above.
    if (key === 'image_api_key') return imageApiKey();

    const stored = getSetting(key, this.encryptionKey);
    if (stored !== '') return stored;

    return BY_KEY.get(key)?.default ?? '';
  }

  getNumber(key: string): number {
    const value = Number(this.get(key));
    if (Number.isFinite(value)) return value;
    const fallback = Number(BY_KEY.get(key)?.default ?? 0);
    return Number.isFinite(fallback) ? fallback : 0;
  }

  getBool(key: string): boolean {
    return this.get(key).toLowerCase() === 'true';
  }

  set(key: string, value: string): void {
    const spec = BY_KEY.get(key);
    setSetting(key, value, spec?.secret ?? false, this.encryptionKey);
  }

  /** True when the value is present, whether stored or defaulted. */
  has(key: string): boolean {
    return this.get(key).trim() !== '';
  }

  /** Configuration problems that would stop a run, in plain language. */
  validate(): string[] {
    const problems: string[] = [];

    if (!this.has('image_api_key')) {
      problems.push(
        'Image service API key is missing. The image service writes it into a volume both ' +
          'containers mount, so this normally sorts itself out within a minute of a deploy. ' +
          'If it persists, check the shared-secret volume is mounted, or set IMAGE_API_KEY ' +
          'in the deployment environment.',
      );
    }
    if (this.getBool('telegram_enabled') && !this.has('telegram_bot_token')) {
      problems.push('Telegram notifications are on but no bot token is set.');
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: this.get('timezone') });
    } catch {
      problems.push(
        `Timezone "${this.get('timezone')}" is not a valid IANA timezone. ` +
          'It comes from the TZ environment variable.',
      );
    }

    return problems;
  }
}
