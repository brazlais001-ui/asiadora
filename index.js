#!/usr/bin/env node

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

// Keys only from environment variables
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const RPDB_API_KEY = process.env.RPDB_API_KEY;
const TORBOX_API_KEY = process.env.TORBOX_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!TMDB_API_KEY) {
  console.error('ERROR: TMDB_API_KEY is required');
  process.exit(1);
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280';
const RPDB_BASE = 'https://api.ratingposterdb.com';

const CATALOGS_CONFIG = {
  'k-series': { country: 'KR', media: 'tv', type: 'series', name: 'K-Dramas (Séries)', genre: '18' },
  'k-movies': { country: 'KR', media: 'movie', type: 'movie', name: 'K-Dramas (Filmes)', genre: '18' },
  'c-series': { country: 'CN', media: 'tv', type: 'series', name: 'C-Dramas (Séries)', genre: '18' },
  'c-movies': { country: 'CN', media: 'movie', type: 'movie', name: 'C-Dramas (Filmes)', genre: '18' },
  'j-series': { country: 'JP', media: 'tv', type: 'series', name: 'J-Dramas (Séries)', genre: '18' },
  'j-movies': { country: 'JP', media: 'movie', type: 'movie', name: 'J-Dramas (Filmes)', genre: '18' },
};

const catalogs = Object.entries(CATALOGS_CONFIG).map(([id, cfg]) => ({
  id,
  type: cfg.type,
  name: cfg.name,
  extra: [
    { name: 'skip', isRequired: false },
    { name: 'search', isRequired: false },
  ],
}));

const manifest = {
  id: 'com.grok.doramas',
  version: '1.1.0',
  name: 'Doramas Ásia',
  description: 'Catálogos de doramas chineses, coreanos e japoneses. Títulos em inglês, sinopses em pt-BR. Posters com ratings (RPDB) e streams via Torbox.',
  logo: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tmdb', 'tt'],
  catalogs,
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: false,
  },
};

const builder = new addonBuilder(manifest);

async function tmdbFetch(path, params = {}) {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', TMDB_API_KEY);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`TMDB error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function buildPoster(path) {
  return path ? IMAGE_BASE + path : undefined;
}

function buildBackdrop(path) {
  return path ? BACKDROP_BASE + path : undefined;
}

function buildRpdbPoster(mediaType, mediaId) {
  if (!RPDB_API_KEY) return undefined;
  return `\( {RPDB_BASE}/ \){RPDB_API_KEY}/\( {mediaType}/poster-default/ \){mediaId}.jpg?fallback=true`;
}

async function translateToPtBR(text) {
  if (!text || text.length < 20 || !OPENROUTER_API_KEY) return text;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://stremio.com',
        'X-Title': 'Doramas Addon',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-exp:free',
        messages: [
          { role: 'system', content: 'Traduza o texto abaixo para português brasileiro (pt-BR). Mantenha o tom natural de sinopse de filme/série. Responda APENAS com a tradução, sem explicações.' },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return text;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}

builder.defineCatalogHandler(async (args) => {
  const cfg = CATALOGS_CONFIG[args.id];
  if (!cfg) return { metas: [] };

  const skip = parseInt(args.extra?.skip || '0', 10);
  const page = Math.floor(skip / 20) + 1;
  const search = args.extra?.search;

  let data;
  if (search) {
    const endpoint = cfg.media === 'tv' ? '/search/tv' : '/search/movie';
    data = await tmdbFetch(endpoint, {
      query: search,
      language: 'en-US',
      page,
      include_adult: 'false',
    });
    data.results = (data.results || []).filter(item => {
      const origins = item.origin_country || [];
      return origins.includes(cfg.country);
    });
  } else {
    const endpoint = `/discover/${cfg.media}`;
    data = await tmdbFetch(endpoint, {
      with_origin_country: cfg.country,
      with_genres: cfg.genre,
      language: 'en-US',
      sort_by: 'popularity.desc',
      page,
      include_adult: 'false',
    });
  }

  const metas = (data.results || []).map(item => {
    const title = cfg.media === 'tv' ? item.name : item.title;
    const year = (cfg.media === 'tv' ? item.first_air_date : item.release_date || '').slice(0, 4);
    const tmdbId = item.id;
    const mediaType = cfg.type === 'series' ? 'series' : 'movie';
    const rpdbId = `\( {mediaType}- \){tmdbId}`;

    return {
      id: `tmdb:\( {cfg.type}: \){tmdbId}`,
      type: cfg.type,
      name: title || 'Unknown',
      poster: buildRpdbPoster('tmdb', rpdbId) || buildPoster(item.poster_path),
      background: buildBackdrop(item.backdrop_path),
      description: item.overview || '',
      releaseInfo: year || undefined,
      genres: item.genre_ids?.map(String) || [],
      posterShape: 'poster',
    };
  });

  return { metas };
});

builder.defineMetaHandler(async (args) => {
  const parts = args.id.split(':');
  let type, tmdbId, media;

  if (parts[0] === 'tmdb' && parts.length >= 3) {
    type = parts[1];
    tmdbId = parts[2];
    media = type === 'series' ? 'tv' : 'movie';
  } else if (args.id.startsWith('tt')) {
    try {
      const find = await tmdbFetch('/find/' + args.id, { external_source: 'imdb_id' });
      const result = find.movie_results?.[0] || find.tv_results?.[0];
      if (!result) return { meta: null };
      tmdbId = result.id;
      media = result.media_type || (find.movie_results?.length ? 'movie' : 'tv');
      type = media === 'tv' ? 'series' : 'movie';
    } catch {
      return { meta: null };
    }
  } else {
    return { meta: null };
  }

  try {
    const en = await tmdbFetch(`/\( {media}/ \){tmdbId}`, {
      language: 'en-US',
      append_to_response: 'external_ids,credits',
    });
    const pt = await tmdbFetch(`/\( {media}/ \){tmdbId}`, { language: 'pt-BR' });

    const title = media === 'tv' ? en.name : en.title;
    let overview = pt.overview || en.overview || '';
    if (!pt.overview && en.overview) {
      overview = await translateToPtBR(en.overview);
    }

    const year = (media === 'tv' ? en.first_air_date : en.release_date || '').slice(0, 4);
    const imdbId = en.external_ids?.imdb_id;
    const runtime = media === 'tv'
      ? (en.episode_run_time?.[0] ? `${en.episode_run_time[0]} min` : undefined)
      : (en.runtime ? `${en.runtime} min` : undefined);

    const mediaType = type === 'series' ? 'series' : 'movie';
    const poster = imdbId
      ? buildRpdbPoster('imdb', imdbId)
      : buildRpdbPoster('tmdb', `\( {mediaType}- \){tmdbId}`);

    const meta = {
      id: imdbId || `tmdb:\( {type}: \){tmdbId}`,
      type,
      name: title || 'Unknown',
      poster: poster || buildPoster(en.poster_path),
      background: buildBackdrop(en.backdrop_path),
      description: overview,
      releaseInfo: year || undefined,
      genres: (en.genres || []).map(g => g.name),
      cast: (en.credits?.cast || []).slice(0, 12).map(c => c.name),
      runtime,
      imdbRating: en.vote_average ? en.vote_average.toFixed(1) : undefined,
    };

    return { meta };
  } catch (err) {
    console.error('Meta error:', err.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async (args) => {
  if (!TORBOX_API_KEY) return { streams: [] };

  const id = args.id;
  let imdbId = null;
  let searchQuery = null;

  if (id.startsWith('tt')) {
    imdbId = id;
  } else if (id.startsWith('tmdb:')) {
    const parts = id.split(':');
    const type = parts[1];
    const tmdbId = parts[2];
    const media = type === 'series' ? 'tv' : 'movie';
    try {
      const data = await tmdbFetch(`/\( {media}/ \){tmdbId}`, { language: 'en-US' });
      searchQuery = media === 'tv' ? data.name : data.title;
    } catch (e) {
      searchQuery = id;
    }
  } else {
    return { streams: [] };
  }

  try {
    const searchUrl = imdbId
      ? `https://search-api.torbox.app/torrents/imdb:${imdbId}?check_cache=true`
      : `https://search-api.torbox.app/torrents/search/${encodeURIComponent(searchQuery)}?check_cache=true`;

    const searchRes = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${TORBOX_API_KEY}` },
    });
    if (!searchRes.ok) {
      console.error('Torbox search error:', await searchRes.text());
      return { streams: [] };
    }
    const searchData = await searchRes.json();
    const torrents = (searchData.data?.torrents || []).filter(t => t.cached).slice(0, 5);

    const streams = [];
    for (const torrent of torrents) {
      if (!torrent.magnet) continue;
      const createRes = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TORBOX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ magnet: torrent.magnet }),
      });
      if (!createRes.ok) continue;
      const createData = await createRes.json();
      const torrentId = createData.data?.id || createData.data?.torrent_id;
      if (!torrentId) continue;

      const dlUrl = `https://api.torbox.app/v1/api/torrents/requestdl?token=\( {TORBOX_API_KEY}&torrent_id= \){torrentId}&redirect=true`;
      streams.push({
        name: 'Torbox',
        title: torrent.raw_title || torrent.title || 'Cached',
        url: dlUrl,
        behaviorHints: { bingeGroup: `torbox-${torrent.hash || torrentId}` },
      });
    }

    return { streams };
  } catch (err) {
    console.error('Stream error:', err.message);
    return { streams: [] };
  }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });

console.log(`Doramas Ásia addon running on port ${port}`);