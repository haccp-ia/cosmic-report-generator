/**
 * Cosmic Reviews — Gerador de Relatórios de Reputação Digital
 * Node.js + Express + Google Places API (New) + Brave Search + SerpAPI + AnyMailFinder
 */
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_PLACES_KEY  = process.env.GOOGLE_PLACES_API_KEY  || '';
const BRAVE_TOKEN         = process.env.BRAVE_SEARCH_TOKEN     || '';
const SERP_API_KEY        = process.env.SERP_API_KEY           || '';
const ANYMAILFINDER_KEY   = process.env.ANYMAILFINDER_KEY      || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function calcScore(rating, reviewCount) {
  if (!rating || !reviewCount) return 0;
  const ratingScore = (rating / 5) * 5;
  const volumeScore = (Math.min(reviewCount, 1000) / 1000) * 5;
  return Math.round((ratingScore + volumeScore) * 10) / 10;
}

function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

const PLACE_FIELDS = [
  'id','displayName','formattedAddress','rating','userRatingCount',
  'primaryTypeDisplayName','primaryType','location',
  'regularOpeningHours','websiteUri','internationalPhoneNumber',
  'businessStatus','googleMapsUri','types'
].join(',');

async function braveSearch(query, count = 3) {
  if (!BRAVE_TOKEN) return [];
  try {
    const resp = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_TOKEN },
      params: { q: query, count, country: 'PT', lang: 'pt', safesearch: 'moderate' }
    });
    return (resp.data.web?.results || []).map(r => ({ title: r.title, snippet: r.description, url: r.url }));
  } catch (e) { console.warn('[Brave] Search failed:', e.message); return []; }
}

async function serpGoogleReviews(placeId, count = 5) {
  if (!SERP_API_KEY) return [];
  try {
    const resp = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_maps_reviews', place_id: placeId, api_key: SERP_API_KEY, hl: 'pt', sort_by: 'newestFirst', num: count }
    });
    return (resp.data.reviews || []).slice(0, count).map(r => ({
      author: r.username || r.user?.name || 'Anonimo', avatar: r.user?.thumbnail || null,
      rating: r.rating || 0, date: r.date || r.iso_date || '', text: r.snippet || r.text || '', source: 'google'
    }));
  } catch (e) { console.warn('[SerpAPI] Reviews failed:', e.message); return []; }
}

async function serpMapsSearch(query) {
  if (!SERP_API_KEY) return null;
  try {
    const resp = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_maps', q: query, api_key: SERP_API_KEY, hl: 'pt', gl: 'pt', type: 'search' }
    });
    const results = resp.data.local_results || [];
    if (!results.length) return null;
    const r = results[0];
    return { placeId: r.place_id || '', name: r.title || '', address: r.address || '',
      rating: r.rating || 0, reviewCount: r.reviews || 0, category: r.type || '',
      phone: r.phone || '', website: r.website || '', mapsUrl: r.links?.directions || '',
      lat: r.gps_coordinates?.latitude || null, lng: r.gps_coordinates?.longitude || null,
      isOpen: r.hours ? !r.hours.includes('Fechado') : true, source: 'serpapi' };
  } catch (e) { console.warn('[SerpAPI] Maps search failed:', e.message); return null; }
}

async function findEmails(domain) {
  if (!ANYMAILFINDER_KEY || !domain) return [];
  try {
    const resp = await axios.get('https://api.anymailfinder.com/v5.0/search/company.json', {
      params: { domain },
      headers: { 'Authorization': 'Bearer ' + ANYMAILFINDER_KEY, 'Accept': 'application/json' },
      timeout: 8000
    });
    const emails = resp.data?.emails || resp.data?.data?.emails || [];
    return emails.filter(e => e.status === 'valid' || e.confidence === 'high' || e.confidence === 'medium')
      .slice(0, 5).map(e => ({ email: typeof e === 'string' ? e : (e.email || e.value || ''), confidence: typeof e === 'string' ? 'found' : (e.confidence || e.status || 'found') }))
      .filter(e => e.email.includes('@'));
  } catch (e) { console.warn('[AnyMailFinder] Failed:', e.response?.data?.message || e.message); return []; }
}

app.post('/api/search', async (req, res) => {
  const { query, apiKey: userKey } = req.body;
  const apiKey = userKey || DEFAULT_PLACES_KEY;
  if (!query) return res.status(400).json({ error: 'Pesquisa em falta.' });
  const usePlaces = !!apiKey;
  const useSerp   = !!SERP_API_KEY;
  if (!usePlaces && !useSerp) return res.status(400).json({ error: 'Nenhuma API configurada.' });
  try {
    let placeData;
    if (usePlaces) {
      const searchResp = await axios.post('https://places.googleapis.com/v1/places:searchText',
        { textQuery: query, languageCode: 'pt', regionCode: 'PT' },
        { headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.location' } }
      );
      const places = searchResp.data.places || [];
      if (!places.length) return res.status(404).json({ error: 'Negocio nao encontrado.' });
      const placeId = places[0].id;
      const detailResp = await axios.get('https://places.googleapis.com/v1/places/' + placeId,
        { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACE_FIELDS }, params: { languageCode: 'pt' } }
      );
      const place = detailResp.data;
      placeData = { placeId, name: place.displayName?.text || 'Sem nome', address: place.formattedAddress || '',
        category: place.primaryTypeDisplayName?.text || place.primaryType || '', primaryType: place.primaryType || 'establishment',
        rating: place.rating || 0, reviewCount: place.userRatingCount || 0, phone: place.internationalPhoneNumber || '',
        website: place.websiteUri || '', mapsUrl: place.googleMapsUri || '', isOpen: place.businessStatus === 'OPERATIONAL',
        lat: place.location?.latitude || null, lng: place.location?.longitude || null, source: 'google_places' };
    } else {
      const serpResult = await serpMapsSearch(query);
      if (!serpResult) return res.status(404).json({ error: 'Negocio nao encontrado via SerpAPI.' });
      placeData = { ...serpResult, primaryType: 'establishment' };
    }
    const { placeId, name, lat, lng, primaryType, website } = placeData;
    let competitors = [];
    if (usePlaces && lat && lng) {
      try {
        const nearbyResp = await axios.post('https://places.googleapis.com/v1/places:searchNearby',
          { includedTypes: [primaryType], maxResultCount: 12, locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 3000 } }, rankPreference: 'POPULARITY', languageCode: 'pt', regionCode: 'PT' },
          { headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.primaryTypeDisplayName,places.googleMapsUri' } }
        );
        competitors = (nearbyResp.data.places || []).filter(p => p.id !== placeId).slice(0, 8)
          .map(p => ({ name: p.displayName?.text || 'Sem nome', address: p.formattedAddress || '', rating: p.rating || 0, reviewCount: p.userRatingCount || 0, score: calcScore(p.rating, p.userRatingCount), mapsUrl: p.googleMapsUri || '' }));
      } catch (e) { console.warn('[Places] Nearby search failed:', e.message); }
    }
    const domain = extractDomain(website);
    const [webMentions, googleReviews, contactEmails] = await Promise.all([
      braveSearch('"' + name + '" avaliacoes opinioes'),
      serpGoogleReviews(placeId),
      findEmails(domain)
    ]);
    const businessScore = calcScore(placeData.rating, placeData.reviewCount);
    const rankPosition  = competitors.filter(c => c.score > businessScore).length + 1;
    res.json({ ...placeData, score: businessScore, rankPosition, totalInArea: competitors.length + 1,
      competitors: competitors.sort((a, b) => b.score - a.score), webMentions, googleReviews, contactEmails, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[API Error]', err.response?.data || err.message);
    const apiMsg = err.response?.data?.error?.message || '';
    if (apiMsg.includes('API_KEY') || apiMsg.includes('not authorized') || err.response?.status === 403)
      return res.status(403).json({ error: 'API Key invalida ou sem permissao.' });
    res.status(500).json({ error: apiMsg || err.message });
  }
});

app.get('/api/config', (_, res) => res.json({
  hasDefaultKey: !!DEFAULT_PLACES_KEY, hasBrave: !!BRAVE_TOKEN, hasSerpApi: !!SERP_API_KEY, hasAnyMailFinder: !!ANYMAILFINDER_KEY
}));
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date() }));
app.listen(PORT, () => {
  console.log('Cosmic Report Generator a correr em http://localhost:' + PORT);
  if (!DEFAULT_PLACES_KEY) console.warn('GOOGLE_PLACES_API_KEY nao configurada');
  if (!BRAVE_TOKEN)        console.warn('BRAVE_SEARCH_TOKEN nao configurado');
  if (!SERP_API_KEY)       console.warn('SERP_API_KEY nao configurada');
  if (!ANYMAILFINDER_KEY)  console.warn('ANYMAILFINDER_KEY nao configurada');
});
