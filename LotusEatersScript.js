// Lotus Eaters Grayjay Plugin

const PLATFORM = 'LotusEaters';
const PLATFORM_CLAIMTYPE = 31;

const BASE_URL = 'https://www.lotuseaters.com';
const API_BASE = 'https://www.lotuseaters.com/api';
const RUMBLE_EMBED_JS = 'https://rumble.com/embedJS/u6xvg1.{videoId}/?request=video&ver=2';

// Inertia.js SPA headers required for JSON responses
const INERTIA_HEADERS = {
  'Accept': 'text/html, application/xhtml+xml',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Inertia': 'true',
  'X-Inertia-Version': 'c292ca9b787d666ad4cc246cf4560579',
};

const REGEX = {
  AUTHOR_URL: /lotuseaters\.com\/author\/([a-zA-Z0-9_-]+)/,
  CATEGORY_URL: /lotuseaters\.com\/category\/([a-zA-Z0-9_-]+)/,
  POST_URL: /^https?:\/\/(?:www\.)?lotuseaters\.com\/([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)(?:\?.*)?$/,
  RUMBLE_EMBED: /rumble\.com\/embed\/([a-zA-Z0-9]+)/,
  RUMBLE_VIDEO_ID: /rumble\.com\/embedJS\/u[^.]+\.([a-zA-Z0-9]+)\//,
};

// Paths that are not post slugs
const RESERVED_PATHS = new Set([
  'author', 'category', 'login', 'register', 'account', 'premium',
  'about', 'contact', 'privacy', 'terms', 'search', 'api', 'feed',
]);

let _config = {};
let _settings = {};


source.enable = function (conf, settings) {
  _config = conf ?? {};
  _settings = settings ?? {};
};

source.getHome = function () {
  // Discover the "Latest" listing entryId from the home page
  const homeData = inertiaGet(BASE_URL + '/');
  const contentBlocks = homeData?.props?.page?.content ?? [];
  const latestBlock = contentBlocks.find(b => b.contentTypeId === 'listing' && b.reference === 'latest-content')
    ?? contentBlocks.find(b => b.contentTypeId === 'listing');

  if (!latestBlock?.entryId) {
    // Fallback to search if listing structure changes
    return new LotusEatersSearchPager(`${API_BASE}/search?q=`);
  }

  return new LotusEatersListingPager(`${API_BASE}/listing/${latestBlock.entryId}/posts`, 1);
};

source.getSearchCapabilities = function () {
  return {
    types: [Type.Feed.Mixed],
    sorts: [Type.Order.Chronological],
    filters: [],
  };
};

source.search = function (query) {
  return new LotusEatersSearchPager(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
};

source.getSearchChannelContentsCapabilities = function () {
  return {
    types: [Type.Feed.Mixed],
    sorts: [Type.Order.Chronological],
    filters: [],
  };
};

source.isChannelUrl = function (url) {
  return REGEX.AUTHOR_URL.test(url) || REGEX.CATEGORY_URL.test(url);
};

source.getChannel = function (url) {
  if (REGEX.AUTHOR_URL.test(url)) {
    const resp = inertiaGet(url);
    const author = resp.props?.author;
    if (!author) throw new ScriptException('Author not found');

    return new PlatformChannel({
      id: new PlatformID(PLATFORM, author.entryId, _config.id, PLATFORM_CLAIMTYPE),
      name: author.fullName ?? '',
      thumbnail: imageUrl(author.profilePicture?.file?.url) ?? '',
      banner: '',
      subscribers: 0,
      description: author.bio ?? '',
      url: url,
    });
  }

  if (REGEX.CATEGORY_URL.test(url)) {
    const resp = inertiaGet(url);
    const category = resp.props?.category;
    if (!category) throw new ScriptException('Category not found');
    const image = resp.props?.categoryImage;

    return new PlatformChannel({
      id: new PlatformID(PLATFORM, category.entryId, _config.id, PLATFORM_CLAIMTYPE),
      name: category.name ?? '',
      thumbnail: imageUrl(image?.file?.url) ?? '',
      banner: '',
      subscribers: 0,
      description: '',
      url: url,
    });
  }

  throw new ScriptException('Not a valid channel URL');
};

source.getChannelContents = function (url) {
  if (REGEX.AUTHOR_URL.test(url)) {
    const resp = inertiaGet(url);
    const author = resp.props?.author;
    if (!author) throw new ScriptException('Author not found');
    const apiUrl = `${API_BASE}/posts/referencing/author/${author.entryId}`;
    return new LotusEatersSearchPager(apiUrl);
  }

  if (REGEX.CATEGORY_URL.test(url)) {
    const resp = inertiaGet(url);
    const category = resp.props?.category;
    if (!category) throw new ScriptException('Category not found');
    const apiUrl = `${API_BASE}/posts/referencing/category/${category.entryId}`;
    return new LotusEatersSearchPager(apiUrl);
  }

  throw new ScriptException('Not a valid channel URL');
};

source.isContentDetailsUrl = function (url) {
  if (!REGEX.POST_URL.test(url)) return false;
  const match = REGEX.POST_URL.exec(url);
  const firstSegment = match[1].split('/')[0];
  return !RESERVED_PATHS.has(firstSegment);
};

source.getContentDetails = function (url) {
  const resp = inertiaGet(url, true);
  const post = resp.props?.post;
  if (!post) throw new ScriptException('Post not found at: ' + url);

  const videos = post.videos ?? [];
  const rumbleVideo = videos.find(v => v.type === 'Rumble' && v.embedUrl);
  const odyseeVideo = videos.find(v => v.type === 'Odysee' && v.embedUrl);

  // Fall back to specialBlock HTML embed if top-level videos are absent (older posts)
  let embedUrl = rumbleVideo?.embedUrl ?? odyseeVideo?.embedUrl ?? findEmbedInContent(post.content);

  if (!embedUrl) {
    if (post.premiumContent && !post.hasPremiumAccess) {
      throw new ScriptException('This is premium content. Please log in with a premium account.');
    }
    throw new ScriptException('No playable video found for: ' + url);
  }

  const sources = [];

  if (rumbleVideo?.embedUrl || (embedUrl && REGEX.RUMBLE_EMBED.test(embedUrl))) {
    const rumbleEmbedUrl = rumbleVideo?.embedUrl ?? embedUrl;
    const rumbleMatch = REGEX.RUMBLE_EMBED.exec(rumbleEmbedUrl);
    const rumbleId = rumbleMatch?.[1];

    if (rumbleId) {
      try {
        const hlsUrl = getRumbleHLS(rumbleId);
        if (hlsUrl) {
          sources.push(new HLSSource({
            name: 'HLS',
            url: hlsUrl,
            duration: 0,
            priority: true,
          }));
        }
      } catch (e) {
        log('Failed to fetch Rumble HLS: ' + e);
      }
    }
  }

  if (sources.length === 0 && embedUrl) {
    sources.push(new VideoUrlSource({
      name: 'Embed',
      url: embedUrl,
      container: 'application/x-mpegURL',
      duration: 0,
    }));
  }

  const primaryAuthor = post.authors?.[0];
  const thumbnail = imageUrl(post.thumbnailImage?.file?.url ?? post.image?.file?.url);
  const publishDate = post.publishDate ? Math.floor(new Date(post.publishDate).getTime() / 1000) : 0;

  return new PlatformVideoDetails({
    id: new PlatformID(PLATFORM, post.entryId, _config.id, PLATFORM_CLAIMTYPE),
    name: post.title ?? '',
    url: url,
    shareUrl: url,
    datetime: publishDate,
    description: post.introExcerpt || post.excerpt || '',
    author: primaryAuthor
      ? new PlatformAuthorLink(
          new PlatformID(PLATFORM, primaryAuthor.entryId, _config.id, PLATFORM_CLAIMTYPE),
          primaryAuthor.fullName ?? '',
          `${BASE_URL}/author/${primaryAuthor.slug}`,
          imageUrl(primaryAuthor.profilePicture?.file?.url) ?? '',
        )
      : new PlatformAuthorLink(
          new PlatformID(PLATFORM, 'lotuseaters', _config.id, PLATFORM_CLAIMTYPE),
          'Lotus Eaters',
          BASE_URL,
          '',
        ),
    thumbnails: thumbnail ? new Thumbnails([new Thumbnail(thumbnail, 0)]) : new Thumbnails([]),
    video: new VideoSourceDescriptor(sources),
    viewCount: post.viewCount ?? 0,
    isLive: false,
    duration: 0,
  });
};


// Pager for search and referencing APIs: returns {currentPage, total, items, hasMore}
class LotusEatersSearchPager extends VideoPager {
  constructor(baseUrl, page) {
    page = page ?? 1;
    const data = fetchJsonPage(pageUrl(baseUrl, page));
    super((data.items ?? []).map(postToplatformVideo), data.hasMore ?? false, { baseUrl, page });
  }

  nextPage() {
    const page = this.context.page + 1;
    const data = fetchJsonPage(pageUrl(this.context.baseUrl, page));
    this.results = (data.items ?? []).map(postToplatformVideo);
    this.hasMore = data.hasMore ?? false;
    this.context = { baseUrl: this.context.baseUrl, page };
    return this;
  }
}

// Pager for listing API: returns {posts: {currentPage, total, items, hasMore}}
class LotusEatersListingPager extends VideoPager {
  constructor(baseUrl, page) {
    page = page ?? 1;
    const data = fetchJsonPage(pageUrl(baseUrl, page));
    const posts = data.posts ?? {};
    super((posts.items ?? []).map(postToplatformVideo), posts.hasMore ?? false, { baseUrl, page });
  }

  nextPage() {
    const page = this.context.page + 1;
    const data = fetchJsonPage(pageUrl(this.context.baseUrl, page));
    const posts = data.posts ?? {};
    this.results = (posts.items ?? []).map(postToplatformVideo);
    this.hasMore = posts.hasMore ?? false;
    this.context = { baseUrl: this.context.baseUrl, page };
    return this;
  }
}

function pageUrl(baseUrl, page) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}page=${page}`;
}

function fetchJsonPage(url) {
  const resp = http.GET(url, {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36',
  }, false);

  if (!resp.isOk) {
    throw new ScriptException(`API request failed (${resp.code}): ${url}`);
  }

  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new ScriptException('Failed to parse JSON: ' + e);
  }
}

function postToplatformVideo(post) {
  const primaryAuthor = post.authors?.[0];
  const thumbnail = imageUrl(post.thumbnailImage?.file?.url ?? post.image?.file?.url);
  const publishDate = post.publishDate ? Math.floor(new Date(post.publishDate).getTime() / 1000) : 0;

  return new PlatformVideo({
    id: new PlatformID(PLATFORM, post.entryId, _config.id, PLATFORM_CLAIMTYPE),
    name: post.title ?? '',
    url: `${BASE_URL}/${post.slug}`,
    shareUrl: `${BASE_URL}/${post.slug}`,
    datetime: publishDate,
    author: primaryAuthor
      ? new PlatformAuthorLink(
          new PlatformID(PLATFORM, primaryAuthor.entryId, _config.id, PLATFORM_CLAIMTYPE),
          primaryAuthor.fullName ?? '',
          `${BASE_URL}/author/${primaryAuthor.slug}`,
          imageUrl(primaryAuthor.profilePicture?.file?.url) ?? '',
        )
      : new PlatformAuthorLink(
          new PlatformID(PLATFORM, 'lotuseaters', _config.id, PLATFORM_CLAIMTYPE),
          'Lotus Eaters',
          BASE_URL,
          '',
        ),
    thumbnails: thumbnail ? new Thumbnails([new Thumbnail(thumbnail, 0)]) : new Thumbnails([]),
    viewCount: post.viewCount ?? 0,
    isLive: false,
    duration: 0,
  });
}

function getRumbleHLS(videoId) {
  const jsUrl = RUMBLE_EMBED_JS.replace('{videoId}', videoId);
  const resp = http.GET(jsUrl, {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36',
  }, false);

  if (!resp.isOk) return null;

  try {
    // ?request=video&ver=2 returns raw JSON
    const data = JSON.parse(resp.body);
    return data?.u?.hls?.url ?? null;
  } catch (e) {
    log('Failed to parse Rumble embedJS: ' + e);
    return null;
  }
}

function findEmbedInContent(content) {
  if (!content?.content) return null;

  function walk(nodes) {
    for (const node of nodes) {
      if (node.nodeType === 'embedded-entry-block') {
        const target = node.data?.target;
        if (target?.contentTypeId === 'specialBlock' && target?.type === 'HTML') {
          const html = extractTextFromRichText(target.content);
          // Look for Rumble iframe src
          const rumbleMatch = html.match(/rumble\.com\/embed\/([a-zA-Z0-9]+)/);
          if (rumbleMatch) return `https://rumble.com/embed/${rumbleMatch[1]}/?pub=6xvg1`;
          // Look for Odysee iframe src
          const odyseeMatch = html.match(/odysee\.com\/\$\/embed\/[^\s"']+/);
          if (odyseeMatch) return `https://${odyseeMatch[0]}`;
        }
      }
      if (node.content) {
        const found = walk(node.content);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(content.content);
}

function extractTextFromRichText(richText) {
  if (!richText?.content) return '';
  let text = '';
  function walk(nodes) {
    for (const node of nodes) {
      if (node.nodeType === 'text') text += node.value ?? '';
      if (node.content) walk(node.content);
    }
  }
  walk(richText.content);
  return text;
}

function inertiaGet(url, useAuth) {
  const resp = http.GET(url, INERTIA_HEADERS, useAuth === true);
  if (!resp.isOk) throw new ScriptException(`Request failed (${resp.code}): ${url}`);
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new ScriptException('Failed to parse Inertia JSON: ' + e);
  }
}

function imageUrl(raw) {
  if (!raw) return null;
  if (raw.startsWith('//')) return 'https:' + raw;
  return raw;
}

log('LOADED');
