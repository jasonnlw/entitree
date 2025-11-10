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

  // Geometry helpers based on real card dimensions
  const halfH = cardH / 2;
  const topY      = (n) => n.y - halfH;
  const bottomY   = (n) => n.y + halfH;
  const midX      = (a, b) => (a.x + b.x) / 2;
  const barBelow  = (n, offset = 16) => bottomY(n) + offset;
  const barAbove  = (n, offset = 16) => topY(n)    - offset;

  // Draw a horizontal bar between two nodes at y, with short down-stems from each parent
  function coupleUnionBar(nA, nB, y) {
    const leftX  = Math.min(nA.x, nB.x);
    const rightX = Math.max(nA.x, nB.x);
    return [
      { kind: "parent-link", d: `M ${nA.x} ${bottomY(nA)} V ${y}` },
      { kind: "parent-link", d: `M ${nB.x} ${bottomY(nB)} V ${y}` },
      { kind: "union",       d: `M ${leftX} ${y} H ${rightX}` }
    ];
  }

  // Draw child drop from a junction at (jx, jy) to the top of child card
  function dropToChild(jx, jy, child) {
    const top = topY(child);
    return { kind: "child", d: `M ${jx} ${jy} V ${top - 6} H ${child.x} V ${top}` };
  }

  // Find node by id quickly
  const byId = Object.create(null);
  nodes.forEach(n => { byId[n.id] = n; });

  // --------- 6a) Ancestor block: Grandparents -> Parents (lane -2 to -1) ----------
  // For each parent, if their father/mother exist in nodes, make a couple union (if both) or single-parent drop.
  parentIds.forEach(pid => {
    const parentNode = byId[pid];
    if (!parentNode) return;

    const pf = parentsOf[pid]?.father ? byId[parentsOf[pid].father] : null;
    const pm = parentsOf[pid]?.mother ? byId[parentsOf[pid].mother] : null;

    if (pf && pm) {
      const y = barBelow(pf) + 8;                       // union bar just below grandparents
      connectors.push(...coupleUnionBar(pf, pm, y));
      connectors.push({                                   // drop to this parent
        kind: "ancestor",
        d: `M ${midX(pf, pm)} ${y} V ${topY(parentNode)}`
      });
    } else if (pf || pm) {
      const p = pf || pm;
      connectors.push({
        kind: "ancestor",
        d: `M ${p.x} ${bottomY(p)} V ${topY(parentNode)}`
      });
    }
  });

  // --------- 6b) Parents -> Subject + Siblings (lane -1 to 0) ----------
  // If both subject parents exist, draw a shared union bar and drop to all children of that couple
  const fNode = fatherId ? byId[fatherId] : null;
  const mNode = motherId ? byId[motherId] : null;

  const sibNodes = siblingIds.map(id => byId[id]).filter(Boolean);

  if (fNode && mNode) {
    const y = barBelow(fNode) + 8;                       // union bar just below parents
    connectors.push(...coupleUnionBar(fNode, mNode, y));

    // children of THIS couple on lane 0 (subject + those siblings that also share these two parents)
    const lane0kids = [subjectNode, ...sibNodes].filter(n => {
      const p = parentsOf[n.id] || {};
      return p.father === fatherId && p.mother === motherId;
    });

    lane0kids.forEach(ch => {
      connectors.push({ kind: "child", d: `M ${midX(fNode, mNode)} ${y} V ${topY(ch)}` });
    });

    // If some siblings exist but are NOT of the same two parents, connect them from whichever parent is known
    const oddSibs = sibNodes.filter(n => !lane0kids.includes(n));
    oddSibs.forEach(n => {
      const p = parentsOf[n.id] || {};
      const fp = p.father && byId[p.father];
      const mp = p.mother && byId[p.mother];
      if (fp && mp) {
        const y2 = barBelow(fp) + 8;
        connectors.push(...coupleUnionBar(fp, mp, y2));
        connectors.push({ kind: "child", d: `M ${midX(fp, mp)} ${y2} V ${topY(n)}` });
      } else if (fp || mp) {
        const one = fp || mp;
        connectors.push({ kind: "child", d: `M ${one.x} ${bottomY(one)} V ${topY(n)}` });
      }
    });

  } else if (fNode || mNode) {
    // Single known parent to subject and siblings
    const p = fNode || mNode;
    [subjectNode, ...sibNodes].forEach(n => {
      connectors.push({ kind: "child", d: `M ${p.x} ${bottomY(p)} V ${topY(n)}` });
    });

  } else if (sibNodes.length > 0) {
    // No parents known: draw a sibling bar above siblings+subject
    const allLane0 = [subjectNode, ...sibNodes].sort((a,b) => a.x - b.x);
    const left = allLane0[0], right = allLane0[allLane0.length - 1];
    const y = barAbove(subjectNode, 14);
    connectors.push({ kind: "sibling", d: `M ${left.x - 40} ${y} H ${right.x + 40}` });
    allLane0.forEach(n => {
      connectors.push({ kind: "sibling", d: `M ${n.x} ${y} V ${topY(n)}` });
    });
  }

  // --------- 6c) Subject & spouses (lane 0) ----------
  // Draw marriage bars; we’ll store their junction (midpoint) to attach the correct children.
  const spouseNodes = spouseIds.map(id => byId[id]).filter(Boolean);
  const marriageHubs = []; // {parents:[idA,idB], x, y}

  spouseNodes.forEach(sp => {
    if (!subjectNode || !sp) return;
    const y = Math.max(bottomY(subjectNode), bottomY(sp)) + 12;
    connectors.push({ kind: "marriage", d: `M ${subjectNode.x} ${y} H ${sp.x}` });
    marriageHubs.push({ parents: [subjId, sp.id], x: midX(subjectNode, sp), y });
  });

  // --------- 6d) Children (lane +1) ----------
  // Route each child from the correct parents:
  // - If both of a child's parents are present and match one marriage hub, drop from that hub
  // - Else if one parent is present, drop from that parent
  // - Else fallback from subject
  const childNodes = childIds.map(id => byId[id]).filter(Boolean);

  childNodes.forEach(ch => {
    const p = parentsOf[ch.id] || {};
    const fp = p.father && byId[p.father];
    const mp = p.mother && byId[p.mother];

    // Try to match a marriage hub
    let hub = null;
    if (fp && mp) {
      hub = marriageHubs.find(h =>
        (h.parents.includes(fp.id) && h.parents.includes(mp.id))
      );
    } else if (fp && fp.id === subjId) {
      const sp2 = mp ? mp.id : null;
      hub = marriageHubs.find(h => h.parents.includes(subjId) && (sp2 ? h.parents.includes(sp2) : false));
    } else if (mp && mp.id === subjId) {
      const sp2 = fp ? fp.id : null;
      hub = marriageHubs.find(h => h.parents.includes(subjId) && (sp2 ? h.parents.includes(sp2) : false));
    }

    if (hub) {
      connectors.push(dropToChild(hub.x, hub.y, ch));
    } else if (fp || mp) {
      const one = fp || mp;
      connectors.push({ kind: "child", d: `M ${one.x} ${bottomY(one)} V ${topY(ch)}` });
    } else if (subjectNode) {
      connectors.push({ kind: "child", d: `M ${subjectNode.x} ${bottomY(subjectNode)} V ${topY(ch)}` });
    }
  });

  // --------- 6e) Grandchildren (lane +2) ----------
  // Attach grandchildren to their real parents in lane +1 where possible; otherwise route via subject’s child, else subject.
  const grandchildNodes = grandchildIds.map(id => byId[id]).filter(Boolean);

  grandchildNodes.forEach(gc => {
    const p = parentsOf[gc.id] || {};
    const fp = p.father && byId[p.father];
    const mp = p.mother && byId[p.mother];

    // Prefer a lane +1 parent node if present
    const lane1Parent = [fp, mp].find(pp => pp && pp.lane === +1);
    if (lane1Parent) {
      connectors.push({ kind: "descendant", d: `M ${lane1Parent.x} ${bottomY(lane1Parent)} V ${topY(gc)}` });
      return;
    }

    // Else, if one of the parents is the subject’s child and present, connect from that
    const viaChild = [fp, mp].find(pp => pp && childIds.includes(pp.id));
    if (viaChild) {
      connectors.push({ kind: "descendant", d: `M ${viaChild.x} ${bottomY(viaChild)} V ${topY(gc)}` });
      return;
    }

    // Fallback
    if (subjectNode) {
      connectors.push({ kind: "descendant", d: `M ${subjectNode.x} ${bottomY(subjectNode)} V ${topY(gc)}` });
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
