#!/usr/bin/env node

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');

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
  version: '1.1.1',
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
  if (!res.ok) throw new Error(`TMDB error ${res.status}`);
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

builder.defineCatalogHandler(async (args) => {
  const cfg = CATALOGS_CONFIG[args.id];
  if (!cfg) return { metas: [] };

  const skip = parseInt(args.extra && args.extra.skip ? args.extra.skip : '0', 10);
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

  const metas = (data.results || []).map(item => {
    const title = cfg.media === 'tv' ? item.name : item.title;
    const year = (cfg.media === 'tv' ? item.first_air_date : item.release_date || '').slice(0, 4);
    const tmdbId = item.id;
    const mediaType = cfg.type === 'series' ? 'series' : 'movie';

    return {
      id: 'tmdb:' + cfg.type + ':' + tmdbId,
      type: cfg.type,
      name: title || 'Unknown',
      poster: buildRpdbPoster('tmdb', mediaType + '-' + tmdbId) || buildPoster(item.poster_path),
      background: buildBackdrop(