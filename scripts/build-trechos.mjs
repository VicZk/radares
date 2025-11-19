#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { lineString, point } from '@turf/helpers';
import length from '@turf/length';
import lineSliceAlong from '@turf/line-slice-along';
import along from '@turf/along';
import distance from '@turf/distance';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ROAD_CACHE_DIR = path.join(DATA_DIR, 'roads');
const OUTPUT_DIR = path.join(ROOT_DIR, 'public', 'data');
const CSV_PATH = path.join(DATA_DIR, 'radar_trechos.csv');
const MIN_DOWNLOAD_DELAY_MS = 6000;
const ROAD_CACHE_VERSION = 4;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
console.log(`Usando versão de cache ${ROAD_CACHE_VERSION}`);

await fs.mkdir(ROAD_CACHE_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

const csvRaw = await fs.readFile(CSV_PATH, 'utf8');
const parsed = parse(csvRaw, { skip_empty_lines: true });
const headerIndex = parsed.findIndex((row) => row[0]?.includes('ESTADO'));
if (headerIndex === -1) {
  throw new Error('Cabeçalho da planilha não encontrado.');
}

const segmentRows = parsed.slice(headerIndex + 1).filter((row) => row[0] && row[1]);

const normalizeRoad = (value) => {
  const digits = value.replace(/[^\d]/g, '');
  const cleaned = digits.length ? digits : value.trim();
  return cleaned.padStart(3, '0');
};

const parseKm = (value) => {
  if (!value) return null;
  const cleaned = value
    .toString()
    .trim()
    .replace(/[oO]/g, '0')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/\s+/g, '');
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
};

const segments = segmentRows
  .map(([uf, road, startKm, endKm]) => {
    const kmStart = parseKm(startKm);
    const kmEnd = parseKm(endKm);
    if (kmStart === null || kmEnd === null) return null;
    return {
      uf: uf.trim(),
      road: normalizeRoad(road),
      kmStart,
      kmEnd,
    };
  })
  .filter(Boolean);

const uniqueRoads = [...new Set(segments.map((seg) => seg.road))].sort();
console.log(`Total de trechos: ${segments.length}`);
console.log(`Rodovias únicas: ${uniqueRoads.length}`);

const roadCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toKey = ([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`;
const approxEqual = (a, b) => toKey(a) === toKey(b);

const coordsFromWay = (way) =>
  way.geometry
    ?.map((pt) => [pt.lon, pt.lat])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));

const buildComponentsFromWays = (segmentsCoords) => {
  const adjacency = new Map();
  const addAdjacency = (coord, idx, atStart) => {
    const key = toKey(coord);
    if (!adjacency.has(key)) adjacency.set(key, []);
    adjacency.get(key).push({ idx, atStart });
  };

  segmentsCoords.forEach((coords, idx) => {
    addAdjacency(coords[0], idx, true);
    addAdjacency(coords[coords.length - 1], idx, false);
  });

  const used = new Array(segmentsCoords.length).fill(false);
  const assembledLines = [];

  const takeNext = (coord) => {
    const key = toKey(coord);
    const entries = adjacency.get(key);
    if (!entries) return undefined;
    while (entries.length) {
      const entry = entries.pop();
      if (used[entry.idx]) continue;
      return entry;
    }
    return undefined;
  };

  const extendLine = (coords, direction) => {
    while (true) {
      const anchor = direction === 'forward' ? coords[coords.length - 1] : coords[0];
      const next = takeNext(anchor);
      if (!next) break;
      const nextCoords = segmentsCoords[next.idx].slice();
      used[next.idx] = true;
      if (direction === 'forward') {
        if (!next.atStart) nextCoords.reverse();
        nextCoords.shift();
        coords.push(...nextCoords);
      } else {
        if (next.atStart) nextCoords.reverse();
        nextCoords.pop();
        coords.unshift(...nextCoords);
      }
    }
  };

  for (let i = 0; i < segmentsCoords.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const coords = segmentsCoords[i].slice();
    extendLine(coords, 'forward');
    extendLine(coords, 'backward');
    assembledLines.push(coords);
  }

  return assembledLines;
};

const MAX_STITCH_GAP_KM = 15;

const stitchComponents = (components) => {
  if (!components.length) return null;
  const stitched = components
    .map((coords) => ({
      coords: coords.slice(),
      lengthKm: length(lineString(coords), { units: 'kilometers' }),
    }))
    .sort((a, b) => b.lengthKm - a.lengthKm);

  const merged = stitched.shift();
  const remaining = stitched.slice();

  const endpointDistance = (a, b) => distance(point(a), point(b), { units: 'kilometers' });

  while (remaining.length) {
    const tail = merged.coords[merged.coords.length - 1];
    const head = merged.coords[0];
    let best = null;
    let bestIdx = -1;

    remaining.forEach((segment, idx) => {
      const start = segment.coords[0];
      const end = segment.coords[segment.coords.length - 1];
      const candidates = [
        { dist: endpointDistance(tail, start), flip: false, attachHead: false },
        { dist: endpointDistance(tail, end), flip: true, attachHead: false },
        { dist: endpointDistance(head, end), flip: false, attachHead: true },
        { dist: endpointDistance(head, start), flip: true, attachHead: true },
      ];
      const bestCandidate = candidates.reduce((acc, candidate) => {
        if (!acc || candidate.dist < acc.dist) return candidate;
        return acc;
      }, null);
      if (!best || bestCandidate.dist < best.dist) {
        best = { ...bestCandidate, segment: segment };
        bestIdx = idx;
      }
    });

    if (!best || best.dist > MAX_STITCH_GAP_KM || bestIdx === -1) {
      break;
    }

    const [nextSegment] = remaining.splice(bestIdx, 1);
    let coords = nextSegment.coords.slice();
    if (best.flip) coords = coords.reverse();

    if (best.attachHead) {
      if (approxEqual(merged.coords[0], coords[coords.length - 1])) {
        coords.pop();
      }
      merged.coords = coords.concat(merged.coords);
    } else {
      if (approxEqual(merged.coords[merged.coords.length - 1], coords[0])) {
        coords.shift();
      }
      merged.coords = merged.coords.concat(coords);
    }
  }

  return {
    coords: merged.coords,
    lengthKm: length(lineString(merged.coords), { units: 'kilometers' }),
  };
};

const buildLineFromSegments = (segmentsCoords) => {
  if (!segmentsCoords.length) return null;
  const components = buildComponentsFromWays(segmentsCoords);
  if (!components.length) return null;
  return stitchComponents(components);
};

const buildLineFromWays = (ways) => {
  const segmentsCoords = ways.map(coordsFromWay).filter((coords) => coords && coords.length >= 2);
  return buildLineFromSegments(segmentsCoords);
};

const buildLineFromRelation = (relation, waysById) => {
  if (!relation) return null;
  const coords = [];
  const seenWays = new Set();
  for (const member of relation.members ?? []) {
    if (member.type !== 'way' || seenWays.has(member.ref)) continue;
    const wayCoords = waysById.get(member.ref);
    if (!wayCoords || wayCoords.length < 2) continue;
    seenWays.add(member.ref);
    let segment = wayCoords.slice();
    if (member.role === 'backward') segment = segment.reverse();
    if (!coords.length) {
      coords.push(...segment);
      continue;
    }
    const prev = coords[coords.length - 1];
    const startDist = distance(prev, segment[0], { units: 'kilometers' });
    const endDist = distance(prev, segment[segment.length - 1], { units: 'kilometers' });
    if (endDist < startDist) {
      segment = segment.reverse();
    }
    if (approxEqual(prev, segment[0])) {
      coords.push(...segment.slice(1));
    } else {
      coords.push(...segment);
    }
  }
  if (coords.length < 2) return null;
  return {
    coords,
    lengthKm: length(lineString(coords), { units: 'kilometers' }),
  };
};

const fetchOverpass = async (query, attempt = 1, endpointIndex = 0) => {
  const endpoint = OVERPASS_ENDPOINTS[endpointIndex % OVERPASS_ENDPOINTS.length];
  const url = `${endpoint}?data=${encodeURIComponent(query)}`;
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (endpointIndex < OVERPASS_ENDPOINTS.length - 1) {
      console.warn(`Erro de rede (${error.message}) usando ${endpoint}. Tentando endpoint alternativo...`);
      return fetchOverpass(query, attempt, endpointIndex + 1);
    }
    if (attempt >= 5) {
      throw new Error(`Erro de rede ao consultar Overpass: ${error.message}`);
    }
    const waitMs = Math.min(30000, attempt * 4000);
    console.warn(`Erro de rede (${error.message}) no Overpass. Retentando em ${Math.round(waitMs / 1000)}s...`);
    await sleep(waitMs);
    return fetchOverpass(query, attempt + 1, 0);
  }
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retrySeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 10;
    const backoffMs = Math.min(60000, (retrySeconds || 10) * 1000 * attempt);
    console.warn(`Overpass limit atingido. Nova tentativa em ${Math.round(backoffMs / 1000)}s...`);
    await sleep(backoffMs);
    return fetchOverpass(query, attempt + 1, endpointIndex + 1);
  }
  if (response.status >= 500 && attempt < 5) {
    const waitMs = Math.min(30000, attempt * 5000);
    console.warn(`Erro ${response.status} do Overpass. Tentando novamente em ${Math.round(waitMs / 1000)}s...`);
    await sleep(waitMs);
    return fetchOverpass(query, attempt + 1, endpointIndex + 1);
  }
  if (!response.ok) {
    throw new Error(`Falha no Overpass: ${response.status} ${response.statusText}`);
  }
  try {
    return await response.json();
  } catch (error) {
    if (attempt >= 5 && endpointIndex >= OVERPASS_ENDPOINTS.length - 1) {
      throw new Error(`Resposta inválida do Overpass: ${error.message}`);
    }
    const waitMs = Math.min(30000, attempt * 4000);
    console.warn(`Resposta inválida do Overpass (${error.message}). Tentando novamente em ${Math.round(waitMs / 1000)}s...`);
    await sleep(waitMs);
    return fetchOverpass(query, attempt + 1, endpointIndex + 1);
  }
};

const readRoadCache = async (roadId) => {
  const filePath = path.join(ROAD_CACHE_DIR, `BR-${roadId}.geojson`);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed?.properties?.cacheVersion !== ROAD_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
};

const saveRoadCache = async (roadId, feature) => {
  const filePath = path.join(ROAD_CACHE_DIR, `BR-${roadId}.geojson`);
  await fs.writeFile(filePath, JSON.stringify(feature));
};

const fetchRoad = async (roadId, attempt = 1) => {
  const segments = [];
  const seenWayIds = new Set();
  const relationQuery = `[out:json][timeout:900];rel["route"="road"]["ref"="BR-${roadId}"];out body;way(r);out geom;`;
  try {
    const relationPayload = await fetchOverpass(relationQuery, attempt);
    const ways = relationPayload.elements?.filter((el) => el.type === 'way' && el.geometry) ?? [];
    ways.forEach((way) => {
      const coords = coordsFromWay(way);
      if (!coords || coords.length < 2) return;
      const id = way.id ?? `rel-${roadId}-${segments.length}`;
      if (seenWayIds.has(id)) return;
      seenWayIds.add(id);
      segments.push(coords);
    });
  } catch (error) {
    console.warn(`Falha ao montar geometria da BR-${roadId} via relação: ${error.message}`);
  }

  const fallbackQuery = `[out:json][timeout:900];way["highway"]["ref"="BR-${roadId}"];out geom;`;
  try {
    const fallbackPayload = await fetchOverpass(fallbackQuery, attempt);
    const ways = fallbackPayload.elements?.filter((el) => el.type === 'way' && el.geometry) ?? [];
    ways.forEach((way) => {
      const coords = coordsFromWay(way);
      if (!coords || coords.length < 2) return;
      const id = way.id ?? `way-${roadId}-${segments.length}`;
      if (seenWayIds.has(id)) return;
      seenWayIds.add(id);
      segments.push(coords);
    });
  } catch (error) {
    console.warn(`Fallback via ways falhou para BR-${roadId}: ${error.message}`);
  }

  const geometryResult = buildLineFromSegments(segments);
  if (!geometryResult || geometryResult.coords.length < 2) {
    throw new Error(`Geometria inválida para BR-${roadId}`);
  }

  return {
    type: 'Feature',
    properties: {
      road: `BR-${roadId}`,
      lengthKm: Number(geometryResult.lengthKm.toFixed(2)),
      source: 'OpenStreetMap / Overpass API',
      updatedAt: new Date().toISOString(),
      cacheVersion: ROAD_CACHE_VERSION,
    },
    geometry: {
      type: 'LineString',
      coordinates: geometryResult.coords,
    },
  };
};

let lastDownloadAt = 0;
for (let index = 0; index < uniqueRoads.length; index += 1) {
  const roadId = uniqueRoads[index];
  if (roadCache.has(roadId)) continue;
  let feature = await readRoadCache(roadId);
  if (!feature) {
    console.log(`Baixando geometria da BR-${roadId} (${index + 1}/${uniqueRoads.length})...`);
    const elapsed = Date.now() - lastDownloadAt;
    if (lastDownloadAt && elapsed < MIN_DOWNLOAD_DELAY_MS) {
      await sleep(MIN_DOWNLOAD_DELAY_MS - elapsed);
    }
    feature = await fetchRoad(roadId);
    lastDownloadAt = Date.now();
    feature.properties.cacheVersion = ROAD_CACHE_VERSION;
    await saveRoadCache(roadId, feature);
  } else {
    console.log(`BR-${roadId} em cache.`);
  }
  roadCache.set(roadId, feature);
}

const lineLengthCache = new Map(
  Array.from(roadCache.entries()).map(([roadId, feature]) => [
    roadId,
    length(feature, { units: 'kilometers' }),
  ])
);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const MAX_GAP_KM = 8;

const splitByGap = (coords) => {
  if (!coords || coords.length < 2) return [];
  const chunks = [];
  let current = [coords[0]];
  for (let i = 1; i < coords.length; i += 1) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const gap = distance(point(prev), point(curr), { units: 'kilometers' });
    if (gap > MAX_GAP_KM) {
      if (current.length > 1) chunks.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length > 1) chunks.push(current);
  return chunks;
};

const buildGeometryFromChunks = (chunks) => {
  if (!chunks.length) return null;
  if (chunks.length === 1) {
    return {
      type: 'LineString',
      coordinates: chunks[0],
    };
  }
  return {
    type: 'MultiLineString',
    coordinates: chunks,
  };
};

const features = segments.map((segment) => {
  const lineFeature = roadCache.get(segment.road);
  if (!lineFeature) {
    throw new Error(`Geometria da BR-${segment.road} não carregada.`);
  }
  const totalLength = lineLengthCache.get(segment.road) ?? length(lineFeature, { units: 'kilometers' });
  const start = clamp(Math.min(segment.kmStart, segment.kmEnd), 0, totalLength);
  const end = clamp(Math.max(segment.kmStart, segment.kmEnd), 0, totalLength);
  const sliced = lineSliceAlong(lineFeature, start, end, { units: 'kilometers' });
  let geometry = sliced.geometry;
  if (!geometry.coordinates || geometry.coordinates.length < 2) {
    const delta = Math.max(0.05, Math.min(1, totalLength * 0.01));
    let fallbackStart = clamp(start - delta / 2, 0, totalLength);
    let fallbackEnd = clamp(end + delta / 2, 0, totalLength);
    if (fallbackStart === fallbackEnd) {
      if (fallbackEnd >= totalLength) {
        fallbackStart = Math.max(0, totalLength - delta);
      } else {
        fallbackEnd = Math.min(totalLength, fallbackEnd + delta);
      }
    }
    const startPoint = along(lineFeature, fallbackStart, { units: 'kilometers' });
    const endPoint = along(lineFeature, fallbackEnd, { units: 'kilometers' });
    geometry = lineString([startPoint.geometry.coordinates, endPoint.geometry.coordinates]).geometry;
  }
  const cleanedChunks = splitByGap(geometry.coordinates);
  if (cleanedChunks.length) {
    const newGeometry = buildGeometryFromChunks(cleanedChunks);
    if (newGeometry) {
      geometry = newGeometry;
    }
  }
  return {
    type: 'Feature',
    geometry,
    properties: {
      uf: segment.uf,
      road: `BR-${segment.road}`,
      roadNumber: segment.road,
      kmStart: Number(start.toFixed(2)),
      kmEnd: Number(end.toFixed(2)),
      lengthKm: Number((end - start).toFixed(2)),
    },
  };
});

const outputPath = path.join(OUTPUT_DIR, 'trechos.geojson');
await fs.writeFile(
  outputPath,
  JSON.stringify(
    {
      type: 'FeatureCollection',
      features,
    },
    null,
    2
  )
);

console.log(`GeoJSON gerado em ${outputPath}`);
