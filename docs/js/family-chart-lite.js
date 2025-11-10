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

  // Base geometry
  const cardHalfH = cardH / 2;
  const verticalGap = 40; // gap between card bottom and connector junction

  // Marriage connectors (subject ↔ spouses)
  const marriageJunctions = [];
  spouseIds.forEach(sp => {
    const a = nodes.find(n => n.id === subjId);
    const b = nodes.find(n => n.id === sp);
    if (a && b) {
      const midX = (a.x + b.x) / 2;
      const y = a.y + cardHalfH + verticalGap / 2;

      // marriage bar
      connectors.push({
        kind: "marriage",
        d: `M ${a.x} ${y} H ${b.x}`
      });

      // junction for children of this marriage
      marriageJunctions.push({ x: midX, y: y + 6 });
    }
  });

  // Parent → child connectors
  const parents = parentIds.map(pid => nodes.find(n => n.id === pid)).filter(Boolean);
  const children = childIds.map(cid => nodes.find(n => n.id === cid)).filter(Boolean);

  if (children.length) {
    if (parents.length === 2) {
      const [p1, p2] = parents;
      const unionY = Math.max(p1.y, p2.y) + cardHalfH + 20;
      const barLeft = Math.min(p1.x, p2.x);
      const barRight = Math.max(p1.x, p2.x);
      const barMid = (barLeft + barRight) / 2;

      // down from each parent
      connectors.push({
        kind: "parent-link",
        d: `M ${p1.x} ${p1.y + cardHalfH} V ${unionY}
            M ${p2.x} ${p2.y + cardHalfH} V ${unionY}
            M ${barLeft} ${unionY} H ${barRight}`
      });

      // down to each child
      children.forEach(ch => {
        connectors.push({
          kind: "child",
          d: `M ${barMid} ${unionY} V ${ch.y - cardHalfH - 20}
              H ${ch.x}
              V ${ch.y - cardHalfH}`
        });
      });
    } else if (parents.length === 1) {
      const p = parents[0];
      children.forEach(ch => {
        connectors.push({
          kind: "child",
          d: `M ${p.x} ${p.y + cardHalfH} V ${ch.y - cardHalfH}`
        });
      });
    } else {
      // no parents, children of subject
      const p = nodes.find(n => n.id === subjId);
      if (p) {
        children.forEach(ch => {
          connectors.push({
            kind: "child",
            d: `M ${p.x} ${p.y + cardHalfH} V ${ch.y - cardHalfH}`
          });
        });
      }
    }
  }

  // Sibling bar if no parents
  if (!parentIds.length && siblingIds.length > 1) {
    const sibs = siblingIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
    const left = sibs[0], right = sibs[sibs.length - 1];
    if (left && right) {
      const y = left.y - cardHalfH - 10;
      connectors.push({
        kind: "sibling",
        d: `M ${left.x - 60} ${y} H ${right.x + 60}`
      });
    }
  }

  // Grandparent → parent
  const grandparents = grandparentIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
  if (grandparents.length && parents.length) {
    const unionY = Math.min(...parents.map(p => p.y)) - verticalGap;
    grandparents.forEach(gp => {
      parents.forEach(pr => {
        connectors.push({
          kind: "ancestor",
          d: `M ${gp.x} ${gp.y + cardHalfH} V ${unionY}
              H ${pr.x} V ${pr.y - cardHalfH}`
        });
      });
    });
  }

  // Grandparent/descendant fallback (if no parents)
  const grandchildren = grandchildIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
  if (grandchildren.length && !children.length) {
    const subj = nodes.find(n => n.id === subjId);
    grandchildren.forEach(gc => {
      connectors.push({
        kind: "descendant",
        d: `M ${subj.x} ${subj.y + cardHalfH} V ${gc.y - cardHalfH}`
      });
    });
  }

  // --- Draw phase ---
  const { svg, g } = mountSvg(el);
  connectors.forEach(c => drawConnector(g, c));
  nodes.forEach(n => drawCard(g, n, { cardW, cardH }));
  autofit(svg, nodes, { pad: 60 });
}



/* ================== Updated drawConnector ================== */

function drawConnector(g, seg) {
  const colorMap = {
    marriage: "#333",
    union: "#444",
    child: "#444",
    ancestor: "#444",
    descendant: "#444",
    sibling: "#666"
  };
  const widthMap = {
    marriage: 2.5,
    union: 2.2,
    child: 2.2,
    ancestor: 2.2,
    descendant: 2.2,
    sibling: 2
  };
  const dashMap = {
    sibling: "4 2"
  };

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
