const map = L.map('map', {
  preferCanvas: true,
  zoomSnap: 0.25,
  scrollWheelZoom: true
}).setView([-14.2, -51.9], 4.3);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> colaboradores'
}).addTo(map);

const ufSelect = document.getElementById('ufSelect');
const roadSelect = document.getElementById('roadSelect');
const searchInput = document.getElementById('searchInput');
const resetButton = document.getElementById('resetFilters');
const summaryEl = document.getElementById('summary');
const legendEl = document.getElementById('legend');
const toggleHeat = document.getElementById('toggleHeat');

let allFeatures = [];
let kmByUf = new Map();
let geoLayer;
let totalKm = 0;
let colorMode = 'road';
let kmMin = 0;
let kmMax = 0;

const palette = [
  '#f97316',
  '#facc15',
  '#34d399',
  '#22d3ee',
  '#4f46e5',
  '#ec4899',
  '#a855f7',
  '#60a5fa',
  '#fb7185'
];

const roadColorCache = new Map();
const getRoadColor = (road) => {
  if (roadColorCache.has(road)) return roadColorCache.get(road);
  let hash = 0;
  for (let i = 0; i < road.length; i += 1) {
    hash = (hash * 31 + road.charCodeAt(i)) % palette.length;
  }
  const color = palette[hash];
  roadColorCache.set(road, color);
  return color;
};

const lerp = (a, b, t) => a + (b - a) * t;
const heatColor = (value, min, max) => {
  if (max === min) return '#facc15';
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const h = lerp(30, 0, ratio);
  const s = lerp(80, 100, ratio);
  const l = lerp(45, 55, ratio);
  return `hsl(${h}deg ${s}% ${l}%)`;
};

const formatNumber = (num) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(num);
const formatKm = (num) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(num);

const updateLegend = () => {
  legendEl.innerHTML = '';
  const legendTitle = document.createElement('h4');
  legendTitle.textContent = colorMode === 'heat' ? 'Km fiscalizados por UF' : 'Legenda (cores por rodovia)';
  legendEl.appendChild(legendTitle);

  if (colorMode === 'heat') {
    const values = Array.from(kmByUf.values());
    const steps = 5;
    for (let i = 0; i < steps; i += 1) {
      const value = lerp(kmMin, kmMax, i / (steps - 1));
      const item = document.createElement('div');
      item.className = 'legend__item';
      const indicator = document.createElement('span');
      indicator.style.background = heatColor(value, kmMin, kmMax);
      const label = document.createElement('div');
      label.textContent = `${formatNumber(value)} km`;
      item.append(indicator, label);
      legendEl.appendChild(item);
    }
  } else {
    const sampleRoads = Array.from(new Set(allFeatures.map((f) => f.properties.road))).slice(0, 6);
    sampleRoads.forEach((road) => {
      const item = document.createElement('div');
      item.className = 'legend__item';
      const indicator = document.createElement('span');
      indicator.style.background = getRoadColor(road);
      const label = document.createElement('div');
      label.textContent = road;
      item.append(indicator, label);
      legendEl.appendChild(item);
    });
    if (sampleRoads.length === 6) {
      const note = document.createElement('div');
      note.textContent = 'Demais BRs seguem a mesma lógica.';
      note.style.fontSize = '0.8rem';
      note.style.color = '#9ca3af';
      legendEl.appendChild(note);
    }
  }
};

const styleFeature = (feature) => {
  const kmTotal = kmByUf.get(feature.properties.uf) ?? 0;
  const color =
    colorMode === 'heat'
      ? heatColor(kmTotal, kmMin, kmMax)
      : getRoadColor(feature.properties.road);
  return {
    color,
    weight: 3.5,
    opacity: 0.85
  };
};

const buildPopupContent = (props) => {
  return `
    <strong>${props.road}</strong><br />
    UF: ${props.uf}<br />
    Km ${props.kmStart} – ${props.kmEnd}<br />
    Extensão fiscalizada: ${formatKm(props.lengthKm)} km
  `;
};

const updateSummary = (features) => {
  if (!features.length) {
    summaryEl.textContent = 'Nenhum trecho encontrado com os filtros aplicados.';
    return;
  }
  const km = features.reduce((acc, feature) => acc + (feature.properties.lengthKm ?? 0), 0);
  summaryEl.innerHTML = `
    <strong>${formatNumber(features.length)}</strong> trechos visíveis &middot;
    <strong>${formatKm(km)}</strong> km monitorados &middot;
    Total Brasil: ${formatNumber(allFeatures.length)} trechos / ${formatKm(totalKm)} km
  `;
};

const getFilters = () => {
  const uf = ufSelect.value;
  const road = roadSelect.value;
  const term = searchInput.value.trim().toLowerCase();
  return { uf, road, term };
};

const applyFilters = () => {
  const { uf, road, term } = getFilters();
  let filtered = allFeatures;
  if (uf) filtered = filtered.filter((feature) => feature.properties.uf === uf);
  if (road) filtered = filtered.filter((feature) => feature.properties.road === road);
  if (term) {
    filtered = filtered.filter((feature) => {
      const props = feature.properties;
      const haystack = `${props.road} ${props.uf} km${props.kmStart}-${props.kmEnd}`.toLowerCase();
      return haystack.includes(term);
    });
  }

  if (geoLayer) {
    geoLayer.remove();
  }

  geoLayer = L.geoJSON(filtered, {
    style: styleFeature,
    onEachFeature: (feature, layer) => {
      const defaultStyle = styleFeature(feature);
      layer.bindPopup(buildPopupContent(feature.properties));
      layer.on({
        mouseover: () => layer.setStyle({ weight: defaultStyle.weight + 1, opacity: 1 }),
        mouseout: () => layer.setStyle(defaultStyle),
        click: () => {
          const bounds = layer.getBounds();
          if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
          }
        }
      });
    }
  }).addTo(map);

  if (filtered.length) {
    const bounds = geoLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24] });
    }
  }

  updateSummary(filtered);
  updateLegend();
};

const populateSelect = (select, values) => {
  const frag = document.createDocumentFragment();
  values.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    frag.appendChild(option);
  });
  select.appendChild(frag);
};

const loadData = async () => {
  summaryEl.textContent = 'Baixando GeoJSON com os trechos monitorados...';
  const response = await fetch('data/trechos.geojson');
  if (!response.ok) {
    summaryEl.textContent = 'Erro ao carregar dados, tente novamente.';
    return;
  }
  const data = await response.json();
  allFeatures = data.features ?? [];
  totalKm = allFeatures.reduce((acc, feature) => acc + (feature.properties.lengthKm ?? 0), 0);

  kmByUf = allFeatures.reduce((acc, feature) => {
    const { uf, lengthKm = 0 } = feature.properties;
    acc.set(uf, (acc.get(uf) ?? 0) + lengthKm);
    return acc;
  }, new Map());
  const kmValues = Array.from(kmByUf.values());
  kmMin = Math.min(...kmValues);
  kmMax = Math.max(...kmValues);

  const ufValues = Array.from(new Set(allFeatures.map((f) => f.properties.uf))).sort();
  const roadValues = Array.from(new Set(allFeatures.map((f) => f.properties.road))).sort();
  populateSelect(ufSelect, ufValues);
  populateSelect(roadSelect, roadValues);

  applyFilters();
};

[ufSelect, roadSelect, searchInput].forEach((input) => input.addEventListener('input', applyFilters));
toggleHeat.addEventListener('change', () => {
  colorMode = toggleHeat.checked ? 'heat' : 'road';
  applyFilters();
});

resetButton.addEventListener('click', () => {
  ufSelect.value = '';
  roadSelect.value = '';
  searchInput.value = '';
  toggleHeat.checked = false;
  colorMode = 'road';
  applyFilters();
});

loadData();
