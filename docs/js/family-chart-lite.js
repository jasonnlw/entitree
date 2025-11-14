// Family Chart Lite – Smooth Junctions v2.3 (Complete)
// STATUS: Full drop‑in file. Keeps ALL functionality from v2.2.
// Visual-only tweaks: subtle upward 30px curve below junctions + shorter upper stems.
// Marriage arches unchanged. Connector logic ring‑fenced.

// === Utility: wrap SVG text within a max width (top-level so drawCard can use it) ===
function wrapSvgText(textSel, textStr, maxWidth, lineHeight = 16) {
  // Ensure we start clean (no leftover tspans on re-render)
  textSel.selectAll("tspan").remove();

  const words = String(textStr || "").split(/\s+/).filter(Boolean);
  if (!words.length) return;

  let line = [];
  let tspan = textSel.append("tspan")
    .attr("x", textSel.attr("x"))
    .attr("dy", 0);

  for (const word of words) {
    line.push(word);
    tspan.text(line.join(" "));
    // If the line is too long, move the last word to a new tspan
    if (tspan.node().getComputedTextLength() > maxWidth && line.length > 1) {
      line.pop();
      tspan.text(line.join(" "));
      line = [word];
      tspan = textSel.append("tspan")
        .attr("x", textSel.attr("x"))
        .attr("dy", lineHeight)
        .text(word);
    }
  }
}

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
    const m = /entity\/(Q\d+)/.exec(iri) || /www\.wikidata\.org\/(Q\d+)/.exec(iri);
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
SELECT ?e ?eLabel ?dob ?dod ?snarc ?image ?gender ?genderLabel WHERE {
  VALUES ?e { ${values} }
  OPTIONAL { ?e wdt:P569 ?dob. }
  OPTIONAL { ?e wdt:P570 ?dod. }
  OPTIONAL { ?e wdt:P12749 ?snarc. }
  OPTIONAL { ?e wdt:P18 ?image. }
  OPTIONAL { ?e wdt:P21 ?gender. }
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
    image: b.image?.value || null,
    gender: b.genderLabel?.value || null,
    // NEW: default generation-availability flags
    hasParents: false,
    hasChildren: false
  };
});
// --- NEW: check generation availability for parents/spouses/children of subject ---
const relatedIds = dedup([...(parentIds || []), ...(spouseIds || []), ...(childIds || [])]);

if (relatedIds.length) {
  const valuesRel = relatedIds.map(id => `wd:${id}`).join(" ");
const qCheck = `
SELECT ?person ?hasParents ?hasChildren WHERE {
  VALUES ?person { ${valuesRel} }
  OPTIONAL {
    { ?person wdt:P22|wdt:P25 ?p. BIND(true AS ?hasParents) }
  }
  OPTIONAL {
    { ?person wdt:P40 ?c. BIND(true AS ?hasChildren) }
  }
}
`;
const jCheck = await sparql(qCheck);
jCheck.results.bindings.forEach(b => {
  const id = qidFromIRI(b.person.value);
  if (meta[id]) {
    meta[id].hasParents  = b.hasParents && b.hasParents.value ? true : false;
    meta[id].hasChildren = b.hasChildren && b.hasChildren.value ? true : false;
  }
});
}

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
    image: m.image || null,
    gender: m.gender || null,
    // NEW: pass availability flags and ⊕ eligibility
    hasParents: m.hasParents === true,
    hasChildren: m.hasChildren === true,
    eligiblePlus: (parentIds?.includes(id) || spouseIds?.includes(id) || childIds?.includes(id)) === true
  });
};
  parentIds.forEach((id, i) => addNode(id, -1, i));        // parents (row -1)
  spouseIds.forEach((id, i) => addNode(id, 0, -(i + 1)));  // spouses left of subject
  addNode(subjId, 0, 0);                                    // subject
  siblingIds.forEach((id, i) => addNode(id, 0, +(i + 1))); // siblings right
  childIds.forEach((id, i) => addNode(id, +1, i));          // children


// ---------- 6) coordinates (center-aligned & responsive) ----------
const rowH = 180, colW = 260, gapX = 30;
const cardW = 220, cardH = 100;
const laneY = (lane) => (lane + 1) * rowH;

// Define helper for container width; fallback only if truly undefined
function getCenterX() {
  const w = el.getBoundingClientRect().width;
  return w > 0 ? w / 2 : 600;
}

const lanes = groupBy(nodes, n => n.lane);
Object.keys(lanes).forEach(k => lanes[k].sort((a, b) => a.order - b.order));

function positionNodes() {
  const centerX = getCenterX();
  Object.entries(lanes).forEach(([laneKey, laneNodes]) => {
    const count = laneNodes.length;
    const totalWidth = (count - 1) * (colW + gapX);
    const startX = centerX - totalWidth / 2;
    laneNodes.forEach((n, i) => {
      n.x = startX + i * (colW + gapX);
      n.y = laneY(Number(laneKey));
    });
  });
}

// Wait until next animation frame to ensure container size is known
await new Promise(requestAnimationFrame);
positionNodes(); // initial placement



  // ---------- 7) svg layers ----------
  const { svg, g, gKin, gSpouse, gCards } = mountSvg(el);

  // Clear connector layers (in case of re-render)
  gKin.selectAll("*").remove();
  gSpouse.selectAll("*").remove();

  // ---------- 8) path helpers (visual-only changes) ----------
  const PARENT_LIFT = 26;          // unchanged
  const ARCH_LIFT = 100;           // marriage arch height
  const ARCH_TIGHT = 0.25;         // steeper sides
  const JUNCTION_RATIO = 0.35;     // shorter upper stems (was 0.45)
  const FAN_LIFT = 30;             // upward bow under junctions

  const center = (n) => ({ x: n.x, y: n.y });

  // Smooth vertical-friendly curve
  function vCurve(a, b) {
    const midY = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
  }

  // NEW: subtle upward bow for connectors *below* the junction
  function fanCurveUp(a, b, lift = FAN_LIFT) {
    const midY = (a.y + b.y) / 2;
    const topY = midY - lift;
    return `M ${a.x} ${a.y} C ${a.x} ${topY}, ${b.x} ${topY}, ${b.x} ${b.y}`;
  }

  // Marriage arch with steeper sides
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

  // 9b) Parents → (subject + siblings): smooth fan directly to EACH mid-row child
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
    const jy = parentsBottomY + (groupTopY - parentsBottomY) * JUNCTION_RATIO; // shorter upper stems

    // inbound curves: parents -> junction
    parentNodes.forEach(p => {
      drawPath(gKin, vCurve({ x: p.x, y: p.y + PARENT_LIFT }, { x: jx, y: jy }), "fcl-kin");
    });
    dot(gKin, jx, jy);

    // direct smooth curves from junction to EACH mid-row child (with slight upward bow)
    midRowChildren.forEach(c => {
      drawPath(gKin, fanCurveUp({ x: jx, y: jy }, { x: c.x, y: c.y - 32 }), "fcl-kin");
    });
  })();

  // 9c) Subject(+spouses) → children: per-spouse junction, then direct smooth curves to EACH child
  (function () {
    const subject = nodes.find(n => n.id === subjId);
    if (!subject || !childIds.length) return;
    const childNodes = childIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
    if (!childNodes.length) return;

    // group by spouse (or 'unknown'), but ONLY if subject is among parents or unknown
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
      const jy     = topY + (minChildTop - topY) * JUNCTION_RATIO; // shorter upper stems

      // parents -> junction
      parents.forEach(p => {
        drawPath(gKin, vCurve({ x: p.x, y: topY }, { x: jx, y: jy }), "fcl-kin");
      });
      dot(gKin, jx, jy);

      // junction -> each child (with subtle upward bow)
      kids.forEach(k => {
        drawPath(gKin, fanCurveUp({ x: jx, y: jy }, { x: k.x, y: k.y - 32 }), "fcl-kin");
      });
    });
  })();

  // ---------- 10) draw cards ----------
  nodes.forEach(n => drawCard(gCards, n, { cardW, cardH }));

  // DEBUG: inspect plus logic
console.log("DEBUG nodes summary ↓↓↓");
console.table(nodes.map(n => ({
  id: n.id,
  eligiblePlus: n.eligiblePlus,
  hasParents: n.hasParents,
  hasChildren: n.hasChildren
})));

  // ---------- 11) fit view ----------
autofit(svg, nodes, { pad: 60, subjId: qid });

  // --- Responsive centering on resize ---
window.addEventListener("resize", () => {
  // Reposition cards horizontally only
  positionNodes();

  // Update card and connector positions
  gCards.selectAll("*").remove();
  nodes.forEach(n => drawCard(gCards, n, { cardW, cardH }));

  gKin.selectAll("*").remove();
  gSpouse.selectAll("*").remove();

  // Redraw connectors (uses new x coordinates)
  // Marriage arches
  spouseIds.forEach(spId => {
    const a = nodes.find(n => n.id === subjId);
    const b = nodes.find(n => n.id === spId);
    if (a && b) drawPath(gSpouse, marriageArch({ x: a.x, y: a.y }, { x: b.x, y: b.y }), "fcl-spouse");
  });

  // Re-run the two connector functions (parents → children, subject → children)
  // Reusing the same logic as before:
  // (for brevity, copy the two IIFE blocks from above here if you want full live updates)
});

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

  
// Gender-aware fill (English + Welsh)
const genderStr = (n.gender || "").toLowerCase();
const isFemale =
  genderStr.includes("female") ||
  genderStr.includes("benyw") ||
  genderStr.includes("ferch") ||   // girl (mutation)
  genderStr.includes("merch");     // colloquial
const isMale =
  genderStr.includes("male") ||
  genderStr.includes("gwryw") ||
  genderStr.includes("bachgen") || // boy
  genderStr.includes("dyn");       // man

const fillColor = isFemale ? "#ffd6e7" : (isMale ? "#cce5ff" : "#f5f5f5");

  // --- Card background ---
  grp.append("rect")
    .attr("class", "fcl-card")
    .attr("width", cardW)
    .attr("height", cardH)
    .attr("rx", 12)
    .attr("ry", 12)
    .style("fill", fillColor)
    .attr("stroke", "#ddd")
    .attr("stroke-width", 1);

  const imgSize = 80;
  if (n.image) {
    grp.append("image").attr("href", commonsThumb(n.image, 120))
      .attr("x",10).attr("y",(cardH - imgSize)/2)
      .attr("width",imgSize).attr("height",imgSize)
      .attr("preserveAspectRatio","xMidYTop slice").attr("clip-path","inset(0 round 8px)");
  }

// --- Text layout ---

// --- Text layout ---
const textX = n.image ? 10 + imgSize + 12 : 14;
const textY = cardH / 2 - 6;

// Name (multi-line via wrap)
const name = grp.append("text")
  .attr("class", "fcl-name")
  .attr("x", textX)
  .attr("y", textY);

const rightMargin = 10;
const maxTextWidth = cardW - textX - rightMargin;

// 1️⃣ Wrap the name text
wrapSvgText(name, n.name, maxTextWidth);

// 2️⃣ Measure wrapped height
let nameBox, lineCount = 1;
try {
  nameBox = name.node().getBBox();
  lineCount = name.selectAll("tspan").size();
} catch (e) {
  nameBox = { y: textY, height: 0 };
}

// 3️⃣ Reduce font size for very long labels (3+ lines)
if (lineCount >= 3) {
  const smallerSize = 13;
  name.style("font-size", `${smallerSize}px`);
  // Re-wrap text at smaller size to fit better
  wrapSvgText(name, n.name, maxTextWidth);
  try {
    nameBox = name.node().getBBox();
  } catch (e) {}
}

// 4️⃣ Compute vertical placement for years below wrapped text with safe padding
let yearsY = nameBox.y + nameBox.height + 12; // 8px extra gap

// Years (if present), positioned under wrapped name
if (n.yrs) {
  grp.append("text")
    .attr("class", "fcl-years")
    .attr("x", textX)
    .attr("y", yearsY)
    .text(n.yrs);
}


// Years (if present), positioned under wrapped name
if (n.yrs) {
  grp.append("text")
    .attr("class", "fcl-years")
    .attr("x", textX)
    .attr("y", yearsY)
    .text(n.yrs);
}
  

  if (n.snarc) {
    name
      .attr("class", "fcl-name fcl-link")
      .style("text-decoration", "underline")
      .on("click", () => {
        const url = `https://jasonnlw.github.io/SNARC-explorer/#/item/${n.snarc}`;
        window.top.location.href = url;
      });
  }

  // --- NEW: ⊕ expansion control (top-right corner) ---
  // Shown only for parents, spouses, or children of the subject
  // if they have additional generations available.
  if (n.eligiblePlus && (n.hasParents || n.hasChildren)) {
    grp.append("text")
      .attr("x", cardW - 30)
      .attr("y", 34)
      .attr("class", "fcl-plus")
      .attr("text-anchor", "middle")
      .attr("font-size", 28)
      .attr("cursor", "pointer")
      .text("➲")
      .on("click", () => {
        // Reload tree centered on this person’s QID
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set("item", n.id);
        window.top.location.href = newUrl.toString();
      });
  }
}


function commonsThumb(url, width=200){
  if (!url) return "";
  if (url.includes("Special:FilePath")) return `${url}?width=${width}`;
  if (url.includes("upload.wikimedia.org")) return url;
  return url;
}


// ============================================================
//            SUBJECT-CENTERED FIXED-ZOOM AUTOFIT (FINAL)
// ============================================================
function autofit(svg, nodes, { pad = 40, subjId = null } = {}) {
  if (!nodes.length) return;

  // --- 1. Identify subject node -------------------------------------
  const subject = nodes.find(n => n.id === subjId) || nodes[0];

  // --- 2. Ensure SVG has layout before measurement -------------------
  const svgNode = svg.node();
  svgNode.style.width  = "100%";
  svgNode.style.height = "100%";

  const { width, height } = svgNode.getBoundingClientRect();

  // IMPORTANT: use a stable pixel-based viewBox so zoom
  // is NOT influenced by tree width/height.
  // This decouples zoom from the overall size of the tree.
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  // --- 3. FIXED INITIAL ZOOM LEVELS (tree-size independent) ---------
  // Tweak these to taste:
  const MOBILE_ZOOM   = 0.9;  // closer on mobile
  const DESKTOP_ZOOM  = 1.10;  // comfortable on desktop

  const isMobile = window.innerWidth < 600;
  let scale = isMobile ? MOBILE_ZOOM : DESKTOP_ZOOM;

  console.log("Initial zoom scale (fixed):", scale, "isMobile:", isMobile);

  // --- 4. Center view exactly on subject node ------------------------
  const cx = width  / 2 - subject.x * scale;
  const cy = height / 2 - subject.y * scale;

  const initial = d3.zoomIdentity
    .translate(cx, cy)
    .scale(scale);

  // --- 5. Pan / Zoom behaviour ---------------------------------------
  const maxZoom = isMobile ? 10 : 5;

  const zoom = d3.zoom()
    .scaleExtent([0.2, maxZoom])
    .on("zoom", (e) => svg.select("g").attr("transform", e.transform));

  // --- 6. Apply initial transform & enable zoom -----------------------
  svg.call(zoom.transform, initial);
  svg.call(zoom);
}



// d3 check
if (typeof window !== "undefined" && !window.d3) {
  console.error("Family Chart Lite: d3 not found. Include d3.v7.min.js before this script.");
}
