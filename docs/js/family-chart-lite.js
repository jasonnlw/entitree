// Family Chart Lite (vertical layout, CSP-safe, no external deps except local d3)
// Features: bilingual labels, years (YYYY–YYYY), SNARC link (P12749), auto-center on root,
// parents above, subject with spouses / siblings, children below.
// NOTE: This focuses on robust, immediate family rendering suitable for embedded profile pages.

export async function drawFamilyTree(el, qid, opts = {}) {
  const langPref = (opts.lang === "cy" ? "cy,en" : "en,cy");
  const endpoint = "https://query.wikidata.org/sparql";

  // ------ Helpers ------
  const sparql = async (q) => {
    const url = `${endpoint}?query=${encodeURIComponent(q)}&format=json`;
    const res = await fetch(url, { headers: { "Accept": "application/sparql-results+json" }});
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    return res.json();
  };
  const y4 = (iso) => (iso && /^\d{4}/.test(iso)) ? iso.slice(0,4) : null;
  const years = (b,d) => {
    const B = y4(b), D = y4(d);
    return (B && D) ? `(${B}–${D})` : "";
  };
  const qidFromIRI = (iri) => {
    const m = /entity\/(Q\d+)/.exec(iri) || /www.wikidata.org\/(Q\d+)/.exec(iri);
    return m ? m[1] : iri;
  };

  // ------ 1) Fetch core relations for subject ------
  // We get subject label/dates, spouses, parents, children (+ P12749)
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
  if (!j1.results.bindings.length) {
    mountEmpty(el, "No data for this QID.");
    return;
  }

  const subjRow = j1.results.bindings[0];
  const subjId = qidFromIRI(subjRow.person.value);
  const subj = {
    id: subjId,
    label: subjRow.personLabel?.value || subjId,
    dob: subjRow.dob?.value || null,
    dod: subjRow.dod?.value || null,
    snarc: subjRow.snarc?.value || null
  };

  const spouseIds = dedup(j1.results.bindings.filter(b=>b.spouse).map(b => qidFromIRI(b.spouse.value)));
  const childIds  = dedup(j1.results.bindings.filter(b=>b.child ).map(b => qidFromIRI(b.child.value)));
  const fatherId  = subjRow.father ? qidFromIRI(subjRow.father.value) : null;
  const motherId  = subjRow.mother ? qidFromIRI(subjRow.mother.value) : null;
  const parentIds = dedup([fatherId, motherId].filter(Boolean));

  // ------ 2) Fetch siblings by parents (children of parents minus subject) ------
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

  // ------ 3) Gather everyone we will render + fetch labels/dates/P12749 for all ------
  const allIds = dedup([subjId, ...spouseIds, ...childIds, ...parentIds, ...siblingIds]);
  if (!allIds.length) {
    mountEmpty(el, "No family relations to render.");
    return;
  }
  const values = allIds.map(id => `wd:${id}`).join(" ");
  const q3 = `
SELECT ?e ?eLabel ?dob ?dod ?snarc WHERE {
  VALUES ?e { ${values} }
  OPTIONAL { ?e wdt:P569 ?dob. }
  OPTIONAL { ?e wdt:P570 ?dod. }
  OPTIONAL { ?e wdt:P12749 ?snarc. }
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
      snarc: b.snarc?.value || null
    };
  });

  // ------ 4) Build nodes with layout lanes (vertical) ------
  // Lanes (rows): -1 = parents, 0 = subject / spouses / siblings, +1 = children
  // Within lane 0: spouses LEFT of subject, siblings RIGHT of subject.
  const nodes = [];
  const addNode = (id, lane, sideOrder) => {
    const m = meta[id] || { id, label:id };
    nodes.push({
      id,
      lane,
      order: sideOrder,
      name: m.label,
      yrs: years(m.dob, m.dod),
      snarc: m.snarc || null
    });
  };

  // parents
  parentIds.forEach((id, i) => addNode(id, -1, i)); // father ~0, mother ~1 (original order preserved)

  // center row
  spouseIds.forEach((id, i) => addNode(id, 0, -(i+1))); // left side (negative order)
  addNode(subjId, 0, 0);                                 // subject center
  siblingIds.forEach((id, i) => addNode(id, 0, +(i+1))); // right side (positive order)

  // children
  childIds.forEach((id, i) => addNode(id, +1, i));

  // ------ 5) Compute coordinates ------
  // Simple vertical layout with equal row heights and card width.
  const rowH = 140, colW = 200, gapX = 18;
  // Normalize columns: sort by lane then order
  const lanes = groupBy(nodes, n => n.lane);
  Object.keys(lanes).forEach(k => lanes[k].sort((a,b)=>a.order-b.order));

  // Assign x positions per lane
  const laneWidths = {};
  Object.keys(lanes).forEach(k => {
    laneWidths[k] = lanes[k].length;
    lanes[k].forEach((n, idx) => n.xi = idx);
  });

  // Establish a global “center” column at subject.xi
  const subjectNode = nodes.find(n => n.id === subjId);
  const centerXi = subjectNode ? subjectNode.xi : 0;

  // Compute absolute pixel coords (subject centered)
  const cardW = 180, cardH = 64;
  const laneY = (lane) => (lane + 1) * rowH; // parents at ~rowH, center at ~2*rowH, children at ~3*rowH

  // Determine center offset so subject is visually centered
  const centerX = 600; // viewport logical center; SVG will scale to container
  nodes.forEach(n => {
    // relative position from subject
    const dx = (n.xi - centerXi) * (colW + gapX);
    n.x = centerX + dx;
    n.y = laneY(n.lane);
  });

  // ------ 6) Build connectors ------
  const connectors = [];
  // Marriage lines: subject to each spouse
  spouseIds.forEach(sp => {
    const a = nodes.find(n=>n.id===subjId), b = nodes.find(n=>n.id===sp);
    if (a && b) connectors.push(lineSegment(midBottom(a), midBottom(b), "marriage"));
  });

  // Parent→child (from father if exists, else mother)
  childIds.forEach(cid => {
    const child = nodes.find(n=>n.id===cid);
    if (!child) return;
    const fromId = fatherId || motherId || subjId; // fallback: if no parents on file, connect from subject
    const parent = nodes.find(n=>n.id===fromId);
    if (parent) connectors.push(elbow(parent, child));
  });

  // Sibling “sibling bar” (single line across siblings when no parents)
  if (!parentIds.length && siblingIds.length > 1) {
    const sibs = siblingIds.map(id => nodes.find(n=>n.id===id)).filter(Boolean);
    const left = sibs[0], right = sibs[sibs.length-1];
    if (left && right) connectors.push(horizontal(midTop(left), midTop(right)));
  }

  // ------ 7) Mount SVG and draw ------
  const { svg, g } = mountSvg(el);
  // Draw connectors
  connectors.forEach(c => drawConnector(g, c));

  // Draw nodes (cards)
  nodes.forEach(n => drawCard(g, n, { cardW, cardH }));

  // Auto-fit viewport
  autofit(svg, nodes, { pad: 60 });
}

/* ================== Utilities ================== */

function dedup(arr){ return [...new Set(arr)]; }
function groupBy(arr, fn){
  const m = Object.create(null);
  arr.forEach(x => {
    const k = fn(x);
    (m[k]||(m[k]=[])).push(x);
  });
  return m;
}

function mountEmpty(el, msg){
  el.innerHTML = `<div style="padding:1rem;color:#555">${msg}</div>`;
}

function mountSvg(el){
  el.innerHTML = "";
  const svg = d3.select(el).append("svg")
    .attr("class","fcl-svg")
    .attr("viewBox", `0 0 1200 800`)
    .attr("preserveAspectRatio","xMidYMid meet");
  const g = svg.append("g");
  return { svg, g };
}

function midTop(n){ return { x:n.x, y:n.y - 32 }; }
function midBottom(n){ return { x:n.x, y:n.y + 32 }; }
function elbow(from, to){
  // vertical elbow: down from parent, across, down/up to child
  const midY = (from.y + to.y)/2;
  return {
    kind:"elbow",
    d: `M ${from.x} ${from.y+32}
        V ${midY}
        H ${to.x}
        V ${to.y-32}`
  };
}
function horizontal(a, b){
  return { kind:"marriage", d: `M ${a.x} ${a.y-10} H ${b.x}` };
}
function lineSegment(a, b, kind="marriage"){
  return { kind, d: `M ${a.x} ${a.y+10} L ${b.x} ${b.y+10}` };
}
function drawConnector(g, seg){
  g.append("path")
    .attr("class", seg.kind==="marriage" ? "fcl-marriage" : "fcl-connector")
    .attr("d", seg.d);
}

function drawCard(g, n, { cardW, cardH }) {
  const grp = g.append("g")
    .attr("transform", `translate(${n.x - cardW/2}, ${n.y - cardH/2})`);

  // Draw outer card
  grp.append("rect")
    .attr("class", "fcl-card")
    .attr("width", cardW)
    .attr("height", cardH)
    .attr("rx", 12).attr("ry", 12);

  // If image exists, render thumbnail from Commons
  if (n.image) {
    grp.append("image")
      .attr("href", commonsThumb(n.image, 200))
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", cardW)
      .attr("height", 80)
      .attr("preserveAspectRatio", "xMidYMid slice");
  }

  // Text placement depends on image presence
  const textYBase = n.image ? 95 : 28;

  const name = grp.append("text")
    .attr("class", "fcl-name")
    .attr("x", 12)
    .attr("y", textYBase)
    .text(n.name);

  if (n.yrs) {
    grp.append("text")
      .attr("class", "fcl-years")
      .attr("x", 12)
      .attr("y", textYBase + 16)
      .text(n.yrs);
  }

  // Link click: navigate to SNARC
  if (n.snarc) {
    name.attr("class", "fcl-name fcl-link")
      .style("text-decoration", "underline")
      .on("click", () => {
        const url = `https://jasonnlw.github.io/SNARC-explorer/#/item/${n.snarc}`;
        window.top.location.href = url;
      });
  }
}

// Build a Wikimedia Commons thumbnail URL (like Entitree)
function commonsThumb(url, width = 200) {
  if (!url) return "";
  // convert full URL to IIIF-style thumbnail path
  // Example: https://commons.wikimedia.org/wiki/Special:FilePath/Filename.jpg
  // -> https://commons.wikimedia.org/wiki/Special:FilePath/Filename.jpg?width=200
  if (url.includes("FilePath/")) return `${url}?width=${width}`;
  // Or if direct upload.wikimedia.org URL
  return url.replace(/\/(\d{1,3})px-.+/, `/${width}px-$1`);
}


  // Link click: navigate parent (outside iframe) if SNARC id exists
  if (n.snarc) {
    name.attr("class","fcl-name fcl-link")
      .style("text-decoration","underline")
      .on("click", () => {
        const url = `https://jasonnlw.github.io/SNARC-explorer/#/item/${n.snarc}`;
        window.top.location.href = url;
      });
  }
}

function autofit(svg, nodes, { pad=40 }={}){
  if (!nodes.length) return;
  const xs = nodes.map(n=>n.x), ys = nodes.map(n=>n.y);
  const minX = Math.min(...xs)-pad, maxX = Math.max(...xs)+pad;
  const minY = Math.min(...ys)-pad, maxY = Math.max(...ys)+pad;
  const w = Math.max(800, maxX-minX);
  const h = Math.max(600, maxY-minY);
  svg.attr("viewBox", `${minX} ${minY} ${w} ${h}`);
}

// ---- D3 (required) must be available global as `d3`.
if (typeof window !== "undefined" && !window.d3) {
  console.error("Family Chart Lite: d3 not found. Include docs/js/d3.v7.min.js before this script.");
}
