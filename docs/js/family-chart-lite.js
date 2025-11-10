// Family Chart Lite – Smooth Junctions v2.1
// Fixes:
// - Parents→(subject + siblings): always fan from a single junction to *each* child on the centre row
// - Removes mixed logic that drew a separate subject-only drop
// - Keeps high marriage arches and per‑spouse children fans
// Requires: d3 v7+

export async function drawFamilyTree(el, qid, opts = {}) {
  const langPref = (opts.lang === "cy" ? "cy,en" : "en,cy");
  const endpoint = "https://query.wikidata.org/sparql";

  // ---------- helpers ----------
  const sparql = async (q) => {
    const url = `${endpoint}?query=${encodeURIComponent(q)}&format=json`;
    const res = await fetch(url, { headers: { "Accept": "application/sparql-results+json" }});
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    return res.json();
  };
  const y4 = (iso) => (iso && /^\d{4}/.test(iso)) ? iso.slice(0,4) : null;
  const years = (b,d) => {
    const B = y4(b), D = y4(d);
    return (B && D) ? `(${B}–${D})` : (B ? `(${B}–)` : (D ? `(–${D})` : ""));
  };
  const qidFromIRI = (iri) => {
    const m = /entity\/(Q\d+)/.exec(iri) || /www.wikidata.org\/(Q\d+)/.exec(iri);
    return m ? m[1] : iri;
  };

  // ---------- 1) subject core ----------
  const q1 = `
SELECT ?person ?personLabel ?dob ?dod ?father ?mother ?spouse ?child ?snarc WHERE {
  VALUES ?person { wd:${qid} }
  OPTIONAL { ?person wdt:P569 ?dob. }
  OPTIONAL { ?person wdt:P570 ?dod. }
  OPTIONAL { ?person wdt:P22 ?father. }
  OPTIONAL { ?person wdt:P25 ?mother. }
  OPTIONAL { ?person wdt:P26 ?spouse. }
  OPTIONAL { ?person wdt:P40 ?child. }
  OPTIONAL { ?person wdt:P12749 ?snarc. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${langPref}". }
}`;
  const j1 = await sparql(q1);
  if (!j1.results.bindings.length) { mountEmpty(el, "No data for this QID."); return; }
  const subjRow = j1.results.bindings[0];
  const subjId = qidFromIRI(subjRow.person.value);

  const spouseIds = dedup(j1.results.bindings.filter(b => b.spouse).map(b => qidFromIRI(b.spouse.value)));
  const childIds  = dedup(j1.results.bindings.filter(b => b.child ).map(b => qidFromIRI(b.child.value)));
  const fatherId  = subjRow.father ? qidFromIRI(subjRow.father.value) : null;
  const motherId  = subjRow.mother ? qidFromIRI(subjRow.mother.value) : null;
  const parentIds = dedup([fatherId, motherId].filter(Boolean));

  // ---------- 2) siblings ----------
  let siblingIds = [];
  if (parentIds.length) {
    const parentValues = parentIds.map(id => `wd:${id}`).join(" ");
    const q2 = `
SELECT ?sib WHERE {
  VALUES ?p { ${parentValues} }
  ?sib wdt:P22|wdt:P25 ?p.
  FILTER(?sib != wd:${subjId})
}`;
    const j2 = await sparql(q2);
    siblingIds = dedup(j2.results.bindings.map(b => qidFromIRI(b.sib.value)));
  }

  // ---------- 3) meta for all nodes ----------
  const allIds = dedup([subjId, ...spouseIds, ...childIds, ...parentIds, ...siblingIds]);
  if (!allIds.length) { mountEmpty(el, "No family relations to render."); return; }
  const values = allIds.map(id => `wd:${id}`).join(" ");
  const q3 = `
SELECT ?e ?eLabel ?dob ?dod ?snarc ?image WHERE {
  VALUES ?e { ${values} }
  OPTIONAL { ?e wdt:P569 ?dob. }
  OPTIONAL { ?e wdt:P570 ?dod. }
  OPTIONAL { ?e wdt:P12749 ?snarc. }
  OPTIONAL { ?e wdt:P18 ?image. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${langPref}". }
}`;
  const j3 = await sparql(q3);
  const meta = Object.create(null);
  j3.results.bindings.forEach(b => {
    const id = qidFromIRI(b.e.value);
    meta[id] = {
      id,
      label: b.eLabel?.value || id,
      dob: b.dob?.value || null,
      dod: b.dod?.value || null,
      snarc: b.snarc?.value || null,
      image: b.image?.value || null
    };
  });

  // ---------- 4) parents of each child ----------
  let childParents = Object.create(null);
  if (childIds.length) {
    const cvals = childIds.map(id => `wd:${id}`).join(" ");
    const q4 = `
SELECT ?c ?father ?mother WHERE {
  VALUES ?c { ${cvals} }
  OPTIONAL { ?c wdt:P22 ?father. }
  OPTIONAL { ?c wdt:P25 ?mother. }
}`;
    const j4 = await sparql(q4);
    j4.results.bindings.forEach(b => {
      const cid = qidFromIRI(b.c.value);
      const f = b.father ? qidFromIRI(b.father.value) : null;
      const m = b.mother ? qidFromIRI(b.mother.value) : null;
      childParents[cid] = [f, m].filter(Boolean);
    });
  }

  // ---------- 5) build nodes ----------
  const nodes = [];
  const addNode = (id, lane, order) => {
    const m = meta[id] || { id, label: id };
    nodes.push({
      id, lane, order,
      name: m.label,
      yrs: (m.dob || m.dod) ? `${years(m.dob, m.dod)}` : "",
      snarc: m.snarc || null,
      image: m.image || null
    });
  };
  parentIds.forEach((id, i) => addNode(id, -1, i));
  spouseIds.forEach((id, i) => addNode(id, 0, -(i + 1)));
  addNode(subjId, 0, 0);
  siblingIds.forEach((id, i) => addNode(id, 0, +(i + 1)));
  childIds.forEach((id, i) => addNode(id, +1, i));

  // ---------- 6) coordinates ----------
  const rowH = 180, colW = 260, gapX = 30;
  const lanes = groupBy(nodes, n => n.lane);
  Object.keys(lanes).forEach(k => lanes[k].sort((a,b)=>a.order-b.order));
  Object.keys(lanes).forEach(k => lanes[k].forEach((n, i) => n.xi = i));
  const subjectNode = nodes.find(n => n.id === subjId);
  const centerXi = subjectNode ? subjectNode.xi : 0;
  const cardW = 220, cardH = 100;
  const laneY = (lane) => (lane + 1) * rowH;
  const centerX = 600;
  nodes.forEach(n => {
    const dx = (n.xi - centerXi) * (colW + gapX);
    n.x = centerX + dx;
    n.y = laneY(n.lane);
  });

  // ---------- 7) svg layers ----------
  const { svg, g, gKin, gSpouse, gCards } = mountSvg(el);

  // ---------- 8) path helpers ----------
  const PARENT_LIFT = 26;
  const CHILD_BAR_PAD = 60;
  const ARCH_LIFT = 100;
  const ARCH_TIGHT = 0.25;

  const center = (n) => ({ x: n.x, y: n.y });

  function vCurve(a, b) {
    const midY = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
  }
  function marriageArch(a, b, lift = ARCH_LIFT, tight = ARCH_TIGHT) {
    const minY = Math.min(a.y, b.y);
    const c1x = a.x + (b.x - a.x) * tight;
    const c2x = b.x - (b.x - a.x) * tight;
    const topY = minY - lift;
    return `M ${a.x} ${a.y} C ${c1x} ${topY}, ${c2x} ${topY}, ${b.x} ${b.y}`;
  }
  function drawPath(g, d, klass) { g.append("path").attr("class", klass).attr("d", d); }
  function dot(g, x, y, klass = "fcl-junction") { g.append("circle").attr("class", klass).attr("cx", x).attr("cy", y).attr("r", 3); }

  // ---------- 9) connectors ----------

  // 9a) Marriage arches (red)
  spouseIds.forEach(spId => {
    const a = nodes.find(n => n.id === subjId);
    const b = nodes.find(n => n.id === spId);
    if (!a || !b) return;
    drawPath(gSpouse, marriageArch(center(a), center(b)), "fcl-spouse");
  });

  // 9b) Parents → (subject + siblings): always fan to EACH child on centre row
  (function() {
    const parentNodes = [fatherId, motherId]
      .map(id => id ? nodes.find(n => n.id === id) : null)
      .filter(Boolean);
    const midRowChildren = [subjId, ...siblingIds]
      .map(id => id ? nodes.find(n => n.id === id) : null)
      .filter(Boolean);
    if (!parentNodes.length || !midRowChildren.length) return;

    const parentsBottomY = Math.min(...parentNodes.map(p => p.y)) + 32;
    const groupTopY     = Math.min(...midRowChildren.map(s => s.y)) - 32;
    const jx = parentNodes.reduce((s,p)=>s+p.x,0) / parentNodes.length;
    const jy = parentsBottomY + (groupTopY - parentsBottomY) * 0.45;

    parentNodes.forEach(p => {
      drawPath(gKin, vCurve({ x: p.x, y: p.y + PARENT_LIFT }, { x: jx, y: jy }), "fcl-kin");
    });
    dot(gKin, jx, jy);

    const barY = Math.min(...midRowChildren.map(c => c.y)) - CHILD_BAR_PAD;
    drawPath(gKin, vCurve({ x: jx, y: jy }, { x: jx, y: barY }), "fcl-kin");

    const leftX  = Math.min(...midRowChildren.map(c => c.x));
    const rightX = Math.max(...midRowChildren.map(c => c.x));
    drawPath(gKin, `M ${leftX} ${barY} H ${rightX}`, "fcl-kin");

    midRowChildren.forEach(c => {
      drawPath(gKin, vCurve({ x: c.x, y: barY }, { x: c.x, y: c.y - 32 }), "fcl-kin");
    });
  })();

  // 9c) Subject(+spouses) → children (per spouse group, smooth fan)
  (function () {
    const subject = nodes.find(n => n.id === subjId);
    if (!subject || !childIds.length) return;
    const childNodes = childIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
    if (!childNodes.length) return;

    const groups = new Map(); // spouseId or 'unknown'
    const ensure = k => { if (!groups.has(k)) groups.set(k, []); return groups.get(k); };

    childNodes.forEach(c => {
      const parents = childParents[c.id] || [];
      const spouse = spouseIds.find(sid => parents.includes(sid));
      const includesSubject = parents.includes(subjId) || !parents.length;
      if (includesSubject) ensure(spouse || "unknown").push(c);
    });

    groups.forEach((kids, key) => {
      if (!kids.length) return;
      const spouse = key === "unknown" ? null : nodes.find(n => n.id === key);
      const parents = spouse ? [subject, spouse] : [subject];

      const topY   = subject.y + 32;
      const jx     = parents.reduce((s, p) => s + p.x, 0) / parents.length;
      const minChildTop = Math.min(...kids.map(k => k.y)) - 32;
      const jy     = topY + (minChildTop - topY) * 0.35;

      parents.forEach(p => {
        drawPath(gKin, vCurve({ x: p.x, y: topY }, { x: jx, y: jy }), "fcl-kin");
      });
      dot(gKin, jx, jy);

      const barY = Math.min(...kids.map(k => k.y)) - CHILD_BAR_PAD;
      drawPath(gKin, vCurve({ x: jx, y: jy }, { x: jx, y: barY }), "fcl-kin");

      const leftX  = Math.min(...kids.map(k => k.x));
      const rightX = Math.max(...kids.map(k => k.x));
      drawPath(gKin, `M ${leftX} ${barY} H ${rightX}`, "fcl-kin");
      kids.forEach(k => {
        drawPath(gKin, vCurve({ x: k.x, y: barY }, { x: k.x, y: k.y - 32 }), "fcl-kin");
      });
    });
  })();

  // ---------- 10) draw cards ----------
  nodes.forEach(n => drawCard(gCards, n, { cardW, cardH }));

  // ---------- 11) fit view ----------
  autofit(svg, nodes, { pad: 60 });
}

/* ================= utilities ================= */

function dedup(a){ return [...new Set(a)]; }
function groupBy(a,fn){ const m={}; a.forEach(x=>{ const k=fn(x); (m[k]||(m[k]=[])).push(x); }); return m; }
function mountEmpty(el,msg){ el.innerHTML = `<div style="padding:1rem;color:#555">${msg}</div>`; }

function mountSvg(el){
  el.innerHTML = "";
  const svg = d3.select(el).append("svg")
    .attr("class","fcl-svg")
    .attr("viewBox","0 0 1200 800")
    .attr("preserveAspectRatio","xMidYMid meet")
    .style("cursor","grab");
  const g = svg.append("g");
  const zoomed = e => g.attr("transform", e.transform);
  const zoom = d3.zoom().scaleExtent([0.3, 3]).on("zoom", zoomed);
  svg.call(zoom);
  svg.on("mousedown touchstart", () => svg.style("cursor","grabbing"));
  svg.on("mouseup touchend", () => svg.style("cursor","grab"));

  const gKin    = g.append("g").attr("data-layer","kin");
  const gSpouse = g.append("g").attr("data-layer","spouse");
  const gCards  = g.append("g").attr("data-layer","cards");
  return { svg, g, gKin, gSpouse, gCards };
}

function drawCard(g, n, { cardW, cardH }){
  const grp = g.append("g").attr("transform", `translate(${n.x - cardW/2}, ${n.y - cardH/2})`);
  grp.append("rect").attr("class","fcl-card").attr("width",cardW).attr("height",cardH).attr("rx",12).attr("ry",12);

  const imgSize = 80;
  if (n.image) {
    grp.append("image").attr("href", commonsThumb(n.image, 120))
      .attr("x",10).attr("y",(cardH - imgSize)/2)
      .attr("width",imgSize).attr("height",imgSize)
      .attr("preserveAspectRatio","xMidYTop slice").attr("clip-path","inset(0 round 8px)");
  }
  const textX = n.image ? 10 + imgSize + 12 : 14;
  const textY = cardH/2 - 6;
  const name = grp.append("text").attr("class","fcl-name").attr("x",textX).attr("y",textY).text(n.name);
  if (n.yrs) grp.append("text").attr("class","fcl-years").attr("x",textX).attr("y",textY+18).text(n.yrs);
  if (n.snarc) {
    name.attr("class","fcl-name fcl-link").style("text-decoration","underline")
      .on("click", () => {
        const url = `https://jasonnlw.github.io/SNARC-explorer/#/item/${n.snarc}`;
        window.top.location.href = url;
      });
  }
}

function commonsThumb(url, width=200){
  if (!url) return "";
  if (url.includes("Special:FilePath")) return `${url}?width=${width}`;
  if (url.includes("upload.wikimedia.org")) return url;
  return url;
}

function autofit(svg, nodes, { pad = 40 } = {}){
  if (!nodes.length) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const w = Math.max(800, maxX - minX), h = Math.max(600, maxY - minY);
  svg.attr("viewBox", `${minX} ${minY} ${w} ${h}`);
  const svgNode = svg.node();
  const { width, height } = svgNode.getBoundingClientRect();
  const scale = Math.min(width / w, height / h);
  const tx = (width - w * scale) / 2, ty = (height - h * scale) / 2;
  const initial = d3.zoomIdentity.translate(tx, ty).scale(scale);
  svg.call(d3.zoom().transform, initial);
}

// d3 check
if (typeof window !== "undefined" && !window.d3) {
  console.error("Family Chart Lite: d3 not found. Include d3.v7.min.js before this script.");
}
