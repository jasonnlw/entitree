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
  snarc: m.snarc || null,
  image: m.image || null
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
  const rowH = 180, colW = 260, gapX = 30;
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
  const cardW = 220, cardH = 100;
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

  // --- Parent/child connectors ---
function joinParentsToChildren(fatherId, motherId, childIds) {
  if (!childIds.length) return;

  const father = nodes.find(n => n.id === fatherId);
  const mother = nodes.find(n => n.id === motherId);

  // Case 1: both parents known
  if (father && mother) {
    const midX = (father.x + mother.x) / 2;
    const topY = Math.min(father.y, mother.y) + 40;

    // horizontal line between parents
    connectors.push({
      kind: "connector",
      d: `M ${father.x} ${father.y+32} H ${mother.x}`
    });

    // vertical from midpoint down to junction
    connectors.push({
      kind: "connector",
      d: `M ${midX} ${father.y+32} V ${father.y+80}`
    });

    const junctionY = father.y + 80;
    if (childIds.length === 1) {
      const c = nodes.find(n => n.id === childIds[0]);
      connectors.push({
        kind: "connector",
        d: `M ${midX} ${junctionY} V ${c.y-32}`
      });
    } else {
      // horizontal bar above children
      const children = childIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
      const left = Math.min(...children.map(c => c.x));
      const right = Math.max(...children.map(c => c.x));
      connectors.push({
        kind: "connector",
        d: `M ${left} ${children[0].y-60} H ${right}`
      });
      children.forEach(c => {
        connectors.push({
          kind: "connector",
          d: `M ${c.x} ${children[0].y-60} V ${c.y-32}`
        });
      });
      // vertical down from parents to that horizontal
      connectors.push({
        kind: "connector",
        d: `M ${midX} ${junctionY} V ${children[0].y-60}`
      });
    }
  }

  // Case 2: single known parent
  else {
    const parent = father || mother;
    if (!parent) return;
    childIds.forEach(cid => {
      const c = nodes.find(n => n.id === cid);
      if (c) connectors.push(elbow(parent, c));
    });
  }
}
joinParentsToChildren(fatherId, motherId, childIds);

  // --- Subject’s own spouse–children junctions ---
spouseIds.forEach(spId => {
  const spouse = nodes.find(n => n.id === spId);
  const spChildren = childIds; // TODO: ideally filter by actual motherId if known

  if (spouse && spChildren.length) {
    const midX = (subjectNode.x + spouse.x) / 2;
    const topY = subjectNode.y + 32;

    // marriage line
    connectors.push({
      kind: "marriage",
      d: `M ${subjectNode.x} ${topY} H ${spouse.x}`
    });

    // down from midpoint
    connectors.push({
      kind: "connector",
      d: `M ${midX} ${topY} V ${topY + 40}`
    });

    const junctionY = topY + 40;
    if (spChildren.length === 1) {
      const c = nodes.find(n => n.id === spChildren[0]);
      if (c) connectors.push({
        kind: "connector",
        d: `M ${midX} ${junctionY} V ${c.y - 32}`
      });
    } else {
      const kids = spChildren.map(id => nodes.find(n => n.id === id)).filter(Boolean);
      const left = Math.min(...kids.map(k => k.x));
      const right = Math.max(...kids.map(k => k.x));
      connectors.push({
        kind: "connector",
        d: `M ${left} ${kids[0].y - 60} H ${right}`
      });
      kids.forEach(k => connectors.push({
        kind: "connector",
        d: `M ${k.x} ${kids[0].y - 60} V ${k.y - 32}`
      }));
      connectors.push({
        kind: "connector",
        d: `M ${midX} ${junctionY} V ${kids[0].y - 60}`
      });
    }
  }
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

function mountSvg(el) {
  el.innerHTML = "";

  const svg = d3.select(el)
    .append("svg")
    .attr("class", "fcl-svg")
    .attr("viewBox", `0 0 1200 800`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("cursor", "grab");

  const g = svg.append("g");

  // --- Enable zoom/pan ---
  const zoomed = (event) => {
    g.attr("transform", event.transform);
  };

  const zoom = d3.zoom()
    .scaleExtent([0.3, 3])   // min / max zoom factors
    .on("zoom", zoomed);

  svg.call(zoom);

  // Optional: change cursor on drag
  svg.on("mousedown touchstart", () => svg.style("cursor", "grabbing"));
  svg.on("mouseup touchend", () => svg.style("cursor", "grab"));

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
    .attr("transform", `translate(${n.x - cardW / 2}, ${n.y - cardH / 2})`);

  // Draw outer card
  grp.append("rect")
    .attr("class", "fcl-card")
    .attr("width", cardW)
    .attr("height", cardH)
    .attr("rx", 12)
    .attr("ry", 12);

  // Image area (square, cropped centre)
  const imgSize = 80;
  if (n.image) {
    grp.append("image")
      .attr("href", commonsThumb(n.image, 120))
      .attr("x", 10)
      .attr("y", (cardH - imgSize) / 2)
      .attr("width", imgSize)
      .attr("height", imgSize)
      .attr("preserveAspectRatio", "xMidYTop slice")
      .attr("clip-path", "inset(0 round 8px)");
  }

  // Text block to the right of image
  const textX = n.image ? 10 + imgSize + 12 : 14;
  const textY = cardH / 2 - 6;

  const name = grp.append("text")
    .attr("class", "fcl-name")
    .attr("x", textX)
    .attr("y", textY)
    .text(n.name);

  if (n.yrs) {
    grp.append("text")
      .attr("class", "fcl-years")
      .attr("x", textX)
      .attr("y", textY + 18)
      .text(n.yrs);
  }

  // Clickable link (SNARC)
  if (n.snarc) {
    name.attr("class", "fcl-name fcl-link")
      .style("text-decoration", "underline")
      .on("click", () => {
        const url = `https://jasonnlw.github.io/SNARC-explorer/#/item/${n.snarc}`;
        window.top.location.href = url;
      });
  }
}
function commonsThumb(url, width = 200) {
  if (!url) return "";
  // Try to construct a proper thumbnail URL from Commons file paths
  if (url.includes("Special:FilePath")) return `${url}?width=${width}`;
  if (url.includes("upload.wikimedia.org")) return url; // already direct
  return url;
}

function autofit(svg, nodes, { pad = 40 } = {}) {
  if (!nodes.length) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const w = Math.max(800, maxX - minX);
  const h = Math.max(600, maxY - minY);
  svg.attr("viewBox", `${minX} ${minY} ${w} ${h}`);

  // Initial center and scale
  const svgNode = svg.node();
  const { width, height } = svgNode.getBoundingClientRect();
  const scale = Math.min(width / w, height / h);
  const tx = (width - w * scale) / 2;
  const ty = (height - h * scale) / 2;
  const initialTransform = d3.zoomIdentity.translate(tx, ty).scale(scale);

  svg.call(d3.zoom().transform, initialTransform);
}


// ---- D3 (required) must be available global as `d3`.
if (typeof window !== "undefined" && !window.d3) {
  console.error("Family Chart Lite: d3 not found. Include docs/js/d3.v7.min.js before this script.");
}
