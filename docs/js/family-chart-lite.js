// Family Chart Lite (vertical layout, CSP-safe, no external deps except local d3)
// Features: bilingual labels, years (YYYY–YYYY), SNARC link (P12749), auto-center on root,
// parents above, subject with spouses/siblings, children below, plus grandparents & grandchildren.
// NOTE: Robust, immediate + one extra generation rendering for embedded profile pages.
// ---- Utility helpers ----
function dedup(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function groupBy(arr, fn) {
  const map = Object.create(null);
  arr.forEach(item => {
    const key = fn(item);
    (map[key] ||= []).push(item);
  });
  return map;
}

export async function drawFamilyTree(el, qid, opts = {}) {
  const langPref = (opts.lang === "cy" ? "cy,en" : "en,cy");
  const endpoint = "https://query.wikidata.org/sparql";

  // ------ Helpers ------
  const sparql = async (q) => {
    const url = `${endpoint}?query=${encodeURIComponent(q)}&format=json`;
    const res = await fetch(url, { headers: { "Accept": "application/sparql-results+json" } });
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    return res.json();
  };
  const y4 = (iso) => (iso && /^\d{4}/.test(iso)) ? iso.slice(0, 4) : null;
  const years = (b, d) => {
    const B = y4(b), D = y4(d);
    return (B && D) ? `(${B}–${D})` : "";
  };
  const qidFromIRI = (iri) => {
    const m = /entity\/(Q\d+)/.exec(iri) || /www.wikidata.org\/(Q\d+)/.exec(iri);
    return m ? m[1] : iri;
  };

  // ------ 1) Fetch relations OUTWARD from the subject ------
  // Direct and one-step extended only:
  // - Spouses (P26)
  // - Children (P40), and grandchildren via child->P40
  // - Father (P22) and mother (P25)
  // - Grandparents via parents' parents (ff, fm, mf, mm)
  const subjectQid = qid;
  const q1 = `
SELECT ?person ?spouse ?child ?father ?mother ?ff ?fm ?mf ?mm ?grandchild WHERE {
  VALUES ?person { wd:${subjectQid} }

  OPTIONAL { ?person wdt:P26 ?spouse. }
  OPTIONAL { ?person wdt:P40 ?child. }

  OPTIONAL { ?person wdt:P22 ?father. }
  OPTIONAL { ?person wdt:P25 ?mother. }

  OPTIONAL { ?father wdt:P22 ?ff. }  # father's father
  OPTIONAL { ?father wdt:P25 ?fm. }  # father's mother
  OPTIONAL { ?mother wdt:P22 ?mf. }  # mother's father
  OPTIONAL { ?mother wdt:P25 ?mm. }  # mother's mother

  OPTIONAL { ?child  wdt:P40 ?grandchild. }
}`;

  const j1 = await sparql(q1);
  if (!j1.results.bindings.length) {
    mountEmpty(el, "No data for this QID.");
    return;
  }

  // Extract IDs along the intended edges only
  const subjId = qidFromIRI(j1.results.bindings[0].person.value);

  const spouseIds = dedup(j1.results.bindings
    .filter(b => b.spouse)
    .map(b => qidFromIRI(b.spouse.value)));

  const childIds = dedup(j1.results.bindings
    .filter(b => b.child)
    .map(b => qidFromIRI(b.child.value)));

  // Parents taken only from P22/P25 on the subject
  const fatherId = j1.results.bindings
    .map(b => b.father ? qidFromIRI(b.father.value) : null)
    .filter(Boolean)[0] || null;

  const motherId = j1.results.bindings
    .map(b => b.mother ? qidFromIRI(b.mother.value) : null)
    .filter(Boolean)[0] || null;

  const parentIds = dedup([fatherId, motherId].filter(Boolean));

  // Grandparents from parents' parents only (no inverses)
  const grandparentIds = dedup(
    j1.results.bindings.flatMap(b => {
      const ids = [];
      if (b.ff) ids.push(qidFromIRI(b.ff.value));
      if (b.fm) ids.push(qidFromIRI(b.fm.value));
      if (b.mf) ids.push(qidFromIRI(b.mf.value));
      if (b.mm) ids.push(qidFromIRI(b.mm.value));
      return ids;
    })
  );

  // Grandchildren from children->P40 only
  const grandchildIds = dedup(j1.results.bindings
    .filter(b => b.grandchild)
    .map(b => qidFromIRI(b.grandchild.value)));

  // ------ 2) Siblings determined from parents (children of P22/P25 minus subject) ------
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

  // ------ 3) Gather everyone we will render + fetch metadata ------
  const allIds = dedup([
    subjId,
    ...spouseIds,
    ...parentIds,
    ...childIds,
    ...siblingIds,
    ...grandparentIds,
    ...grandchildIds
  ]);

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
  // ------ 3b) Fetch parent facts (P22/P25) for routing connectors ------
  // We want real parentage for subject, spouses, parents, children, grandchildren, siblings.
  const idsNeedingParents = dedup([
    subjId,
    ...spouseIds,
    ...parentIds,
    ...childIds,
    ...grandchildIds,
    ...siblingIds
  ]);

  const valuesParents = idsNeedingParents.map(id => `wd:${id}`).join(" ");
  const qParents = `
SELECT ?who ?father ?mother WHERE {
  VALUES ?who { ${valuesParents} }
  OPTIONAL { ?who wdt:P22 ?father. }
  OPTIONAL { ?who wdt:P25 ?mother. }
}`;
  const jParents = await sparql(qParents);

  const parentsOf = Object.create(null); // parentsOf[id] = { father: 'Q..'|null, mother: 'Q..'|null }
  idsNeedingParents.forEach(id => { parentsOf[id] = { father: null, mother: null }; });
  jParents.results.bindings.forEach(b => {
    const id = qidFromIRI(b.who.value);
    if (!parentsOf[id]) parentsOf[id] = { father: null, mother: null };
    if (b.father) parentsOf[id].father = qidFromIRI(b.father.value);
    if (b.mother) parentsOf[id].mother = qidFromIRI(b.mother.value);
  });

  // ------ 4) Build nodes with layout lanes (vertical) ------
  // Lanes: -2 grandparents, -1 parents, 0 center (spouses left, subject, siblings right), +1 children, +2 grandchildren
  const nodes = [];
  const addNode = (id, lane, sideOrder) => {
    const m = meta[id] || { id, label: id };
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

  // grandparents (lane -2)
  grandparentIds.forEach((id, i) => addNode(id, -2, i));

  // parents (lane -1)
  parentIds.forEach((id, i) => addNode(id, -1, i));

  // center row
  spouseIds.forEach((id, i) => addNode(id, 0, -(i + 1))); // left of subject
  addNode(subjId, 0, 0);                                   // subject center
  siblingIds.forEach((id, i) => addNode(id, 0, +(i + 1))); // right of subject

  // children (lane +1)
  childIds.forEach((id, i) => addNode(id, +1, i));

  // grandchildren (lane +2)
  grandchildIds.forEach((id, i) => addNode(id, +2, i));

  // ------ 5) Compute coordinates ------
  const rowH = 160, colW = 260, gapX = 30;
  const lanes = groupBy(nodes, n => n.lane);
  Object.keys(lanes).forEach(k => lanes[k].sort((a, b) => a.order - b.order));

  Object.keys(lanes).forEach(k => {
    lanes[k].forEach((n, idx) => (n.xi = idx));
  });

  const subjectNode = nodes.find(n => n.id === subjId);
  const centerXi = subjectNode ? subjectNode.xi : 0;

  const cardW = 220, cardH = 100;
  const laneY = (lane) => (lane + 2) * rowH; // shift so top lane is visible
  const centerX = 600;

  nodes.forEach(n => {
    const dx = (n.xi - centerXi) * (colW + gapX);
    n.x = centerX + dx;
    n.y = laneY(n.lane);
  });

// ------ 6) Build connectors ------
const connectors = [];

// --- geometry helpers (strictly card-edge based) ---
const halfH  = cardH / 2;
const topY   = (n) => n.y - halfH;
const botY   = (n) => n.y + halfH;
const midX   = (a, b) => (a.x + b.x) / 2;
const below2 = (a, b, pad = 14) => Math.max(botY(a), botY(b)) + pad;  // bar just under two nodes
const above2 = (a, b, pad = 14) => Math.min(topY(a), topY(b))  - pad; // bar just above two nodes

// quick id -> node map
const byId = Object.create(null);
nodes.forEach(n => { byId[n.id] = n; });

// helper: draw a union bar under a couple and short stems from both parents
function coupleUnion(a, b, y) {
  const L = Math.min(a.x, b.x), R = Math.max(a.x, b.x);
  return [
    { kind: "union",       d: `M ${a.x} ${botY(a)} V ${y}` },
    { kind: "union",       d: `M ${b.x} ${botY(b)} V ${y}` },
    { kind: "union",       d: `M ${L} ${y} H ${R}` }
  ];
}

// helper: vertical drop from (jx,jy) to child's top anchor
function dropFrom(jx, jy, child) {
  return { kind: "child", d: `M ${jx} ${jy} V ${topY(child)}` };
}

// ---------------------------------------------------------
// 6a) GRANDPARENTS → PARENTS  (lane -2 → -1)
// ---------------------------------------------------------
parentIds.forEach(pid => {
  const parent = byId[pid];
  if (!parent) return;

  const pfId = parentsOf[pid]?.father || null;
  const pmId = parentsOf[pid]?.mother || null;
  const pf   = pfId ? byId[pfId] : null;
  const pm   = pmId ? byId[pmId] : null;

  if (pf && pm) {
    const y = below2(pf, pm, 10);                  // union under the grandparents
    connectors.push(...coupleUnion(pf, pm, y));
    connectors.push(dropFrom(midX(pf, pm), y, parent));
  } else if (pf || pm) {
    const gp = pf || pm;
    connectors.push({ kind: "ancestor", d: `M ${gp.x} ${botY(gp)} V ${topY(parent)}` });
  }
});

// ---------------------------------------------------------
// 6b) PARENTS → SUBJECT & SIBLINGS  (lane -1 → 0)
// ---------------------------------------------------------
const subjectNode = nodes.find(n => n.id === subjId); // (already exists in your file – re-used here)

const fNode = fatherId ? byId[fatherId] : null;
const mNode = motherId ? byId[motherId] : null;

const sibNodes = siblingIds.map(id => byId[id]).filter(Boolean);
const lane0Kids = [subjectNode, ...sibNodes].filter(Boolean);

if (fNode && mNode) {
  const y = below2(fNode, mNode, 10);              // union under the two parents
  connectors.push(...coupleUnion(fNode, mNode, y));

  // Children of *this* couple only (subject + siblings sharing the same two parents)
  lane0Kids.forEach(k => {
    const p = parentsOf[k.id] || {};
    if (p.father === fatherId && p.mother === motherId) {
      connectors.push(dropFrom(midX(fNode, mNode), y, k));
    }
  });

  // Siblings with different parentage: connect from whichever parent(s) we have
  lane0Kids.forEach(k => {
    const p = parentsOf[k.id] || {};
    if (p.father === fatherId && p.mother === motherId) return; // already done
    const fp = p.father && byId[p.father];
    const mp = p.mother && byId[p.mother];
    if (fp && mp) {
      const y2 = below2(fp, mp, 10);
      connectors.push(...coupleUnion(fp, mp, y2));
      connectors.push(dropFrom(midX(fp, mp), y2, k));
    } else if (fp || mp) {
      const one = fp || mp;
      connectors.push({ kind: "child", d: `M ${one.x} ${botY(one)} V ${topY(k)}` });
    }
  });

} else if (fNode || mNode) {
  const p = fNode || mNode;
  lane0Kids.forEach(k => {
    connectors.push({ kind: "child", d: `M ${p.x} ${botY(p)} V ${topY(k)}` });
  });

} else if (sibNodes.length > 0) {
  // No parents known: dashed sibling bar above the row
  const ordered = lane0Kids.slice().sort((a, b) => a.x - b.x);
  const left = ordered[0], right = ordered[ordered.length - 1];
  const y = topY(subjectNode) - 14;
  connectors.push({ kind: "sibling", d: `M ${left.x - 40} ${y} H ${right.x + 40}` });
  ordered.forEach(n => connectors.push({ kind: "sibling", d: `M ${n.x} ${y} V ${topY(n)}` }));
}

// ---------------------------------------------------------
// 6c) SUBJECT ↔ SPOUSES  (lane 0 marriage bars + hubs)
// ---------------------------------------------------------
const marriageHubs = []; // {parents:[idA,idB], x, y}
spouseIds
  .map(id => byId[id])
  .filter(Boolean)
  .forEach(sp => {
    if (!subjectNode) return;
    const y = below2(subjectNode, sp, 8);          // bar just under the lower of the two cards
    connectors.push({ kind: "marriage", d: `M ${subjectNode.x} ${y} H ${sp.x}` });
    marriageHubs.push({ parents: [subjId, sp.id], x: midX(subjectNode, sp), y });
  });

// ---------------------------------------------------------
// 6d) CHILDREN  (lane +1) – attach to the correct parents
// ---------------------------------------------------------
childIds
  .map(id => byId[id])
  .filter(Boolean)
  .forEach(ch => {
    const p = parentsOf[ch.id] || {};
    const fp = p.father && byId[p.father];
    const mp = p.mother && byId[p.mother];

    // Prefer the marriage bar of the actual parents (if present)
    let hub = null;
    if (fp && mp) {
      hub = marriageHubs.find(h => h.parents.includes(fp.id) && h.parents.includes(mp.id));
    } else if (fp && fp.id === subjId && mp) {
      hub = marriageHubs.find(h => h.parents.includes(subjId) && h.parents.includes(mp.id));
    } else if (mp && mp.id === subjId && fp) {
      hub = marriageHubs.find(h => h.parents.includes(subjId) && h.parents.includes(fp.id));
    }

    if (hub) {
      connectors.push(dropFrom(hub.x, hub.y, ch));
    } else if (fp || mp) {
      const one = fp || mp;
      connectors.push({ kind: "child", d: `M ${one.x} ${botY(one)} V ${topY(ch)}` });
    } else if (subjectNode) {
      connectors.push({ kind: "child", d: `M ${subjectNode.x} ${botY(subjectNode)} V ${topY(ch)}` });
    }
  });

// ---------------------------------------------------------
// 6e) GRANDCHILDREN  (lane +2) – attach via their real parent if shown
// ---------------------------------------------------------
grandchildIds
  .map(id => byId[id])
  .filter(Boolean)
  .forEach(gc => {
    const p = parentsOf[gc.id] || {};
    const fp = p.father && byId[p.father];
    const mp = p.mother && byId[p.mother];

    // If a lane +1 parent exists in nodes, connect from that parent
    const lane1Parent = [fp, mp].find(n => n && n.lane === +1);
    if (lane1Parent) {
      connectors.push({ kind: "descendant", d: `M ${lane1Parent.x} ${botY(lane1Parent)} V ${topY(gc)}` });
      return;
    }

    // Otherwise if one parent is present anywhere, use them
    if (fp || mp) {
      const one = fp || mp;
      connectors.push({ kind: "descendant", d: `M ${one.x} ${botY(one)} V ${topY(gc)}` });
      return;
    }

    // Fallback to subject if nothing else is present
    if (subjectNode) {
      connectors.push({ kind: "descendant", d: `M ${subjectNode.x} ${botY(subjectNode)} V ${topY(gc)}` });
    }
  });



  // --- Draw phase ---
  const { svg, g } = mountSvg(el);
  connectors.forEach(c => drawConnector(g, c));
  nodes.forEach(n => drawCard(g, n, { cardW, cardH }));
  autofit(svg, nodes, { pad: 60 });
}



/* ================== Updated drawConnector ================== */

function drawConnector(g, seg) {
  const colorMap = {
    marriage:   "#333",
    union:      "#444",
    "parent-link":" #444",
    child:      "#444",
    ancestor:   "#444",
    descendant: "#444",
    sibling:    "#666"
  };
  const widthMap = {
    marriage:   2.6,
    union:      2.2,
    "parent-link": 2.2,
    child:      2.2,
    ancestor:   2.2,
    descendant: 2.2,
    sibling:    2
  };
  const dashMap = { sibling: "4 2" };

  const path = g.append("path")
    .attr("d", seg.d)
    .attr("stroke", colorMap[seg.kind] || "#444")
    .attr("stroke-width", widthMap[seg.kind] || 2)
    .attr("fill", "none")
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round");

  if (dashMap[seg.kind]) path.attr("stroke-dasharray", dashMap[seg.kind]);
}


function drawCard(g, n, { cardW, cardH }) {
  const grp = g.append("g")
    .attr("transform", `translate(${n.x - cardW / 2}, ${n.y - cardH / 2})`);

  // Card
  grp.append("rect")
    .attr("class", "fcl-card")
    .attr("width", cardW)
    .attr("height", cardH)
    .attr("rx", 12)
    .attr("ry", 12);

  // Left square image (cropped center)
  const imgSize = 80;
  if (n.image) {
    grp.append("image")
      .attr("href", commonsThumb(n.image, 120))
      .attr("x", 10)
      .attr("y", (cardH - imgSize) / 2)
      .attr("width", imgSize)
      .attr("height", imgSize)
      .attr("preserveAspectRatio", "xMidYMid slice")
      .attr("clip-path", "inset(0 round 8px)");
  }

  // Text block to the right
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

  // Clickable link to SNARC
  if (n.snarc) {
    name.attr("class", "fcl-name fcl-link")
      .style("text-decoration", "underline")
      .on("click", () => {
        const url = `https://jasonnlw.github.io/SNARC-explorer/#/item/${n.snarc}`;
        window.top.location.href = url;
      });
  }
}

// Build a Wikimedia Commons thumbnail URL (best-effort)
function commonsThumb(url, width = 200) {
  if (!url) return "";
  if (url.includes("Special:FilePath")) return `${url}?width=${width}`;
  if (url.includes("upload.wikimedia.org")) return url; // direct thumbnail URLs often already sized
  return url;
}

function mountSvg(el) {
  el.innerHTML = "";

  const svg = d3.select(el)
    .append("svg")
    .attr("class", "fcl-svg")
    .attr("viewBox", "0 0 1200 900")
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("cursor", "grab");

  const g = svg.append("g");

  // Enable zoom and pan
  const zoomed = (event) => g.attr("transform", event.transform);
  const zoom = d3.zoom()
    .scaleExtent([0.3, 3]) // zoom limits
    .on("zoom", zoomed);

  svg.call(zoom);

  // Cursor feedback for drag
  svg.on("mousedown touchstart", () => svg.style("cursor", "grabbing"));
  svg.on("mouseup touchend", () => svg.style("cursor", "grab"));

  return { svg, g };
}


function autofit(svg, nodes, { pad = 40 } = {}) {
  if (!nodes.length) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const w = Math.max(800, maxX - minX);
  const h = Math.max(800, maxY - minY);
  svg.attr("viewBox", `${minX} ${minY} ${w} ${h}`);

  const svgNode = svg.node();
  const { width, height } = svgNode.getBoundingClientRect();
  const scale = Math.min(width / w, height / h);
  const tx = (width - w * scale) / 2;
  const ty = (height - h * scale) / 2;
  const initialTransform = d3.zoomIdentity.translate(tx, ty).scale(scale);
  svg.call(d3.zoom().transform, initialTransform);
}

// ---- D3 (required)
if (typeof window !== "undefined" && !window.d3) {
  console.error("Family Chart Lite: d3 not found. Include docs/js/d3.v7.min.js before this script.");
}
