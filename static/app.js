let allRows = [];
let sortState = { key: 'char_code', dir: 1 }; // 1 asc, -1 desc

function qs(sel){ return document.querySelector(sel) }
function qsa(sel){ return Array.from(document.querySelectorAll(sel)) }

function showToast(text, error=false) {
  const t = qs('#toast');
  t.textContent = text;
  t.className = 'toast ' + (error ? 'error' : 'ok');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3200);
}

function setLoading(v){ qs('#loader').classList.toggle('hidden', !v); }

function csvHref(currentISO){
  const url = new URL('/cbr/daily.csv', window.location.origin);
  if (currentISO) url.searchParams.set('date', currentISO);
  return url.toString();
}

function cmp(a,b){
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/* ---------- Таблица (ровные числа) ---------- */
function fmt(v, digits = 6) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}

function renderTable(rows){
  const tbody = qs('#rates-table tbody');
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="code">${r.char_code}</td>
      <td class="num">${fmt(r.nominal, 0)}</td>
      <td class="num">${fmt(r.value, 6)}</td>
      <td class="num">${fmt(r.per1, 6)}</td>
      <td class="name">${r.name}</td>
    `;
    tbody.appendChild(tr);
  });
  qs('#count-label').textContent = `Показано: ${rows.length}`;
}

function applyFilterSort(){
  const f = qs('#filter').value.trim().toLowerCase();
  let rows = allRows.filter(r => !f || r.char_code.toLowerCase().includes(f) || r.name.toLowerCase().includes(f));
  rows.sort((x, y) => {
    const k = sortState.key;
    const dx = (k === 'per1') ? x.per1 : x[k];
    const dy = (k === 'per1') ? y.per1 : y[k];
    return sortState.dir * cmp(dx, dy);
  });
  renderTable(rows);
}

/* ---------- Загрузка курсов (показываем обе даты) ---------- */
async function loadRates(){
  const date = qs('#date-input').value || '';
  setLoading(true);
  try {
    const resp = await fetch(`/cbr/daily${date ? `?date=${date}` : ''}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    const reqIso = data.requested_date_iso || date || '';
    const cbrDateStr = data.date || '';                // DD.MM.YYYY
    const cbrIso = cbrDateStr ? cbrDateStr.split('.').reverse().join('-') : '';
    const same = reqIso && cbrIso ? (cbrIso === reqIso) : true;

    qs('#date-label').textContent = same
      ? (cbrDateStr ? `Дата ЦБ: ${cbrDateStr}` : '')
      : `Дата ЦБ: ${cbrDateStr} (запрошено: ${reqIso})`;

    const items = data.items || [];
    allRows = items.map(it => ({
      char_code: it.char_code,
      nominal: it.nominal,
      value: it.value,
      per1: (it.value && it.nominal) ? (it.value / it.nominal) : 0,
      name: it.name,
    }));
    qs('#btn-export').setAttribute('href', csvHref(date));
    applyFilterSort();

    if (!same) {
      showToast('Для запрошенной даты курсы недоступны (выходной/ещё не опубликовано). Показана последняя дата ЦБ.');
    }
  } catch (e){
    renderTable([]);
    showToast(`Ошибка: ${e.message}`, true);
  } finally {
    setLoading(false);
  }
}

/* ---------- Конвертер ---------- */
async function doConvert(){
  const fromCode = qs('#from-code').value.trim() || 'USD';
  const toCode   = qs('#to-code').value.trim() || 'RUB';
  const amount   = qs('#amount').value || '1';
  const date     = qs('#date-conv').value || '';

  const qsParams = new URLSearchParams({ from_code: fromCode, to_code: toCode, amount: amount });
  if (date) qsParams.append('date', date);

  try {
    const resp = await fetch(`/cbr/convert?${qsParams.toString()}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    const rateStr = (data.rate != null) ? Number(data.rate).toFixed(6) : '—';
    const resStr  = (data.result != null) ? Number(data.result).toFixed(6) : '—';
    const box = qs('#conv-result');
    box.className = 'result ok grow';
    box.textContent = `Дата: ${data.date} · Курс ${data.from} → ${data.to}: ${rateStr} · ${amount} ${data.from} = ${resStr} ${data.to}`;
  } catch (e){
    const box = qs('#conv-result');
    box.className = 'result error grow';
    box.textContent = `Ошибка: ${e.message}`;
  }
}

/* ---------- Общие утилиты ---------- */
function debounce(fn, ms=250){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms) } }
function toggleTheme(){
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme-dark', document.documentElement.classList.contains('dark') ? '1':'0');
}

/* ===================== ГРАФИК + ХОВЕР ===================== */
// --- RESPONSIVE CANVAS FIXES ---
function fitCanvas(canvas, aspect = 0.36) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 1000;
  const cssH = Math.max(240, Math.round(cssW * aspect));
  canvas.style.height = cssH + 'px';

  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  const changed = (canvas.width !== w || canvas.height !== h);
  if (changed) { canvas.width = w; canvas.height = h; }
  return changed;
}

function drawLineChart(canvas, points){
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  canvas.__pts = [];
  canvas.__lastPoints = points;

  if (!points.length){ return; }
  const pad = {l:60, r:20, t:20, b:40};
  const xs = points.map(p => new Date(p.date).getTime());
  const ys = points.map(p => p.rub_per_unit);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const x2px = x => pad.l + (W - pad.l - pad.r) * ( (x - minX) / (maxX - minX || 1) );
  const y2px = y => H - pad.b - (H - pad.t - pad.b) * ( (y - minY) / (maxY - minY || 1) );

  const styles = getComputedStyle(document.documentElement);
  const gridColor = 'rgba(148,163,184,0.35)';
  const textColor = styles.getPropertyValue('--muted').trim() || '#64748b';
  const lineColor = styles.getPropertyValue('--primary').trim() || '#2563eb';
  const ctxFont = '12px system-ui, -apple-system, Segoe UI, Roboto';

  ctx.fillStyle = textColor; ctx.font = ctxFont;
  ctx.strokeStyle = gridColor; ctx.lineWidth = 1;

  for (let i=0;i<=5;i++){
    const yy = minY + (maxY - minY) * i/5;
    const y = y2px(yy);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(yy.toFixed(4), 6, y-2);
  }
  for (let i=0;i<=5;i++){
    const xx = minX + (maxX - minX) * i/5;
    const d = new Date(xx);
    const label = d.toISOString().slice(0,10);
    const x = x2px(xx);
    ctx.save(); ctx.translate(x, H - pad.b + 14); ctx.rotate(-Math.PI/6); ctx.fillText(label, 0, 0); ctx.restore();
  }

  ctx.strokeStyle = '#94a3b8';
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();

  ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((p, i) => {
    const x = x2px(new Date(p.date).getTime());
    const y = y2px(p.rub_per_unit);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, 'rgba(37,99,235,.25)');
  grad.addColorStop(1, 'rgba(37,99,235,0)');
  ctx.fillStyle = grad;
  ctx.lineTo(x2px(new Date(points[points.length-1].date).getTime()), H - pad.b);
  ctx.lineTo(x2px(new Date(points[0].date).getTime()), H - pad.b);
  ctx.closePath(); ctx.fill();

  canvas.__pts = points.map(p => {
    const t = new Date(p.date).getTime();
    return { date: p.date, value: p.rub_per_unit, x: x2px(t), y: y2px(p.rub_per_unit) };
  });
  canvas.__bounds = { pad, minX, maxX, minY, maxY };
}

function ensureTooltip(canvas){
  let tip = document.getElementById('chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chart-tooltip';
    tip.style.position = 'absolute';
    tip.style.pointerEvents = 'none';
    tip.style.display = 'none';
    tip.style.background = '#0b1220';
    tip.style.color = '#fff';
    tip.style.padding = '6px 8px';
    tip.style.borderRadius = '8px';
    tip.style.font = '12px system-ui, -apple-system, Segoe UI, Roboto';
    tip.style.boxShadow = '0 6px 16px rgba(0,0,0,.25)';
    tip.style.zIndex = '3';
    canvas.parentElement.style.position = 'relative';
    canvas.parentElement.appendChild(tip);
  }
  return tip;
}

function attachChartHover(canvas){
  if (canvas.__hoverBound) return;
  canvas.__hoverBound = true;

  const tip = ensureTooltip(canvas);
  const wrap = canvas.parentElement;

  function redrawMarker(pt){
    if (canvas.__lastPoints) drawLineChart(canvas, canvas.__lastPoints);
    if (!pt) return;

    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = 'rgba(148,163,184,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pt.x, 20);
    ctx.lineTo(pt.x, canvas.height - 40);
    ctx.stroke();

    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI*2);
    ctx.stroke();
  }

  function onMove(e){
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    const pts = canvas.__pts || [];
    if (!pts.length){ tip.style.display='none'; redrawMarker(null); return; }

    let best = null, bestD2 = Infinity;
    for (const p of pts){
      const dx = p.x - cx, dy = p.y - cy;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2){ bestD2 = d2; best = p; }
    }
    const threshold = 14;
    if (Math.sqrt(bestD2) > threshold){
      tip.style.display='none';
      redrawMarker(null);
      return;
    }

    tip.innerHTML = `${best.date}<br><b>${best.value.toFixed(6)}</b> RUB за 1`;
    tip.style.display = 'block';

    const wrapRect = wrap.getBoundingClientRect();
    let tx = e.clientX - wrapRect.left + 10;
    let ty = e.clientY - wrapRect.top + 10;
    const maxX = wrapRect.width - tip.offsetWidth - 6;
    const maxY = wrapRect.height - tip.offsetHeight - 6;
    tip.style.left = Math.max(6, Math.min(tx, maxX)) + 'px';
    tip.style.top  = Math.max(6, Math.min(ty, maxY)) + 'px';

    redrawMarker(best);
  }

  function onLeave(){
    tip.style.display='none';
    redrawMarker(null);
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
}

async function buildHistory(){
  const code = (qs('#hist-code').value || 'USD').trim().toUpperCase();
  const from = qs('#hist-from').value;
  const to = qs('#hist-to').value;
  if (!from || !to){ showToast('Укажи период: обе даты', true); return; }
  try {
    const r = await fetch(`/cbr/history?code=${encodeURIComponent(code)}&date_from=${from}&date_to=${to}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const points = data.points || [];
    const canvas = qs('#chart');

    canvas.__lastPoints = points;
    fitCanvas(canvas);

    drawLineChart(canvas, points);
    qs('#chart-empty').style.display = points.length ? 'none' : 'block';

    attachChartHover(canvas);
  } catch(e){
    showToast('Ошибка: ' + e.message, true);
  }
}

/* ===================== INIT ===================== */
window.addEventListener('DOMContentLoaded', () => {
  qs('#btn-load').addEventListener('click', loadRates);
  qs('#btn-convert').addEventListener('click', doConvert);
  qs('#filter').addEventListener('input', debounce(applyFilterSort, 150));
  qs('#toggle-theme').addEventListener('click', toggleTheme);
  qs('#btn-swap').addEventListener('click', () => {
    const a = qs('#from-code'), b = qs('#to-code');
    const t = a.value; a.value = b.value; b.value = t;
    doConvert();
  });
  qsa('#rates-table th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (sortState.key === key) sortState.dir *= -1;
      else { sortState.key = key; sortState.dir = 1; }
      applyFilterSort();
      qsa('#rates-table th').forEach(x => x.classList.remove('sorted-asc','sorted-desc'));
      th.classList.add(sortState.dir === 1 ? 'sorted-asc' : 'sorted-desc');
    });
  });
  qs('#btn-history').addEventListener('click', buildHistory);

  if (localStorage.getItem('theme-dark') === '1') document.documentElement.classList.add('dark');

  window.addEventListener('resize', debounce(() => {
    const c = qs('#chart');
    if (!c || !c.__lastPoints) return;
    if (fitCanvas(c)) drawLineChart(c, c.__lastPoints);
  }, 150));

  loadRates();
});
