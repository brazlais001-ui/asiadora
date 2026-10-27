#!/usr/bin/env node

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const RPDB_API_KEY = process.env.RPDB_API_KEY;
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
  version: '1.5.0',
  name: 'Doramas Ásia',
  description: 'Catálogos de doramas chineses, coreanos e japoneses. Títulos em inglês, sinopses em pt-BR.',
  logo: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg',
  resources: ['catalog', 'meta'],
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
  if (!res.ok) throw new Error('TMDB error ' + res.status);
  return res.json();
}

function buildPoster(path) {
  return path ? IMAGE_BASE + path : undefined;
}

function buildBackdrop(path) {
  return path ? BACKDROP_BASE + path : undefined;
}

function buildRpdbPoster(mediaType, mediaId) {
  if (!RPDB_API_KEY || !mediaId) return undefined;
  return RPDB_BASE + '/' + RPDB_API_KEY + '/' + mediaType + '/poster-default/' + mediaId + '.jpg?fallback=true';
}

async function translateToPtBR(text) {
  if (!text || text.length < 10 || !OPENROUTER_API_KEY) return text;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://stremio.com',
        'X-Title': 'Doramas Addon',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-exp:free',
        messages: [
          { role: 'system', content: 'Traduza para português brasileiro (pt-BR). Responda APENAS com a tradução, sem aspas ou explicações.' },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return text;
    const data = await res.json();
    const translated = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return translated ? translated.trim() : text;
  } catch (e) {
    return text;
  }
}

async function getSeriesVideos(tmdbId) {
  try {
    const show = await tmdbFetch('/tv/' + tmdbId, { language: 'en-US' });
    const videos = [];
    const seasons = show.seasons || [];

    for (const season of seasons) {
      if (season.season_number === 0) continue;
      try {
        const seasonData = await tmdbFetch('/tv/' + tmdbId + '/season/' + season.season_number, { language: 'en-US' });
        const episodes = seasonData.episodes || [];
        for (const ep of episodes) {
          let overview = ep.overview || '';
          if (overview.length > 15) {
            overview = await translateToPtBR(overview);
          }
          videos.push({
            id: 'tmdb:series:' + tmdbId + ':' + season.season_number + ':' + ep.episode_number,
            title: ep.name || ('Episode ' + ep.episode_number),
            season: season.season_number,
            episode: ep.episode_number,
            released: ep.air_date ? new Date(ep.air_date + 'T00:00:00Z') : undefined,
            overview: overview,
            thumbnail: ep.still_path ? 'https://image.tmdb.org/t/p/w300' + ep.still_path : undefined,
          });
        }
      } catch (e) {}
    }
    return videos;
  } catch (e) {
    return [];
  }
}

builder.defineCatalogHandler(async (args) => {
  const cfg = CATALOGS_CONFIG[args.id];
  if (!cfg) return { metas: [] };

  const skip = parseInt((args.extra && args.extra.skip) || '0', 10);
  const page = Math.floor(skip / 20) + 1;
  const search = args.extra && args.extra.search;

  let data;
  if (search) {
    const endpoint = cfg.media === 'tv' ? '/search/tv' : '/search/movie';
    data = await tmdbFetch(endpoint, {
      query: search,
      language: 'en-US',
      page: String(page),
      include_adult: 'false',
    });
    data.results = (data.results || []).filter(item => {
      const origins = item.origin_country || [];
      return origins.includes(cfg.country);
    });
  } else {
    data = await tmdbFetch('/discover/' + cfg.media, {
      with_origin_country: cfg.country,
      with_genres: cfg.genre,
      language: 'en-US',
      sort_by: 'popularity.desc',
      page: String(page),
      include_adult: 'false',
    });
  }

  const metas = [];
  for (const item of (data.results || [])) {
    const title = cfg.media === 'tv' ? item.name : item.title;
    const year = (cfg.media === 'tv' ? item.first_air_date : item.release_date || '').slice(0, 4);
    const tmdbId = String(item.id);
    const mediaType = cfg.type === 'series' ? 'series' : 'movie';

    let description = item.overview || '';
    if (description.length > 15) {
      description = await translateToPtBR(description);
    }

    metas.push({
      id: 'tmdb:' + cfg.type + ':' + tmdbId,
      type: cfg.type,
      name: title || 'Unknown',
      poster: buildRpdbPoster('tmdb', mediaType + '-' + tmdbId) || buildPoster(item.poster_path),
      background: buildBackdrop(item.backdrop_path),
      description: description,
      releaseInfo: year || undefined,
      genres: item.genre_ids ? item.genre_ids.map(String) : [],
      posterShape: 'poster',
    });
  }

  return { metas };
});

builder.defineMetaHandler(async (args) => {
  const parts = args.id.split(':');
  if (parts[0] !== 'tmdb' || parts.length < 3) return { meta: null };

  const type = parts[1];
  const tmdbId = parts[2];
  const media = type === 'series' ? 'tv' : 'movie';

  try {
    const en = await tmdbFetch('/' + media + '/' + tmdbId, {
      language: 'en-US',
      append_to_response: 'external_ids,credits',
    });
    const pt = await tmdbFetch('/' + media + '/' + tmdbId, { language: 'pt-BR' });

    const title = media === 'tv' ? en.name : en.title;
    let overview = (pt.overview && pt.overview.length > 30) ? pt.overview : (en.overview || '');

    // Força tradução se a versão pt-BR for curta ou inexistente
    if (!pt.overview || pt.overview.length < 30) {
      if (en.overview && en.overview.length > 15) {
        overview = await translateToPtBR(en.overview);
      }
    }

    const year = (media === 'tv' ? en.first_air_date : en.release_date || '').slice(0, 4);
    const imdbId = en.external_ids && en.external_ids.imdb_id;
    const runtime = media === 'tv'
      ? (en.episode_run_time && en.episode_run_time[0] ? en.episode_run_time[0] + ' min' : undefined)
      : (en.runtime ? en.runtime + ' min' : undefined);

    const mediaType = type === 'series' ? 'series' : 'movie';
    const poster = imdbId
      ? buildRpdbPoster('imdb', imdbId)
      : buildRpdbPoster('tmdb', mediaType + '-' + tmdbId);

    const meta = {
      id: imdbId || args.id,
      type: type,
      name: title || 'Unknown',
      poster: poster || buildPoster(en.poster_path),
      background: buildBackdrop(en.backdrop_path),
      description: overview,
      releaseInfo: year || undefined,
      genres: (en.genres || []).map(function (g) { return g.name; }),
      cast: (en.credits && en.credits.cast ? en.credits.cast.slice(0, 12).map(function (c) { return c.name; }) : []),
      runtime: runtime,
      imdbRating: en.vote_average ? en.vote_average.toFixed(1) : undefined,
    };

    if (type === 'series') {
      meta.videos = await getSeriesVideos(tmdbId);
    }

    return { meta };
  } catch (err) {
    console.error('Meta error:', err.message);
    return { meta: null };
  }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: Number(port) });

console.log('Doramas Ásia addon v1.5 running on port ' + port);