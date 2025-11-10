// Family Chart Lite – v2.4
// Includes:
// - Responsive centered layout
// - Smooth curved connectors
// - Gender-based colouring
// - ⊕ expansion symbol for related generations

export async function drawFamilyTree(el, qid, opts = {}) {
  const langPref = (opts.lang === "cy" ? "cy,en" : "en,cy");
  const endpoint = "https://query.wikidata.org/sparql";

  // ---------- helpers ----------
  const sparql = async (q) => {
    const url = `${endpoint}?query=${encodeURIComponent(q)}&format=json`;
    const res = await fetch(url, { headers: { "Accept": "application/sparql-results+json" } });
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

  // ---------- 1) subject ----------
  const q1 = `
SELECT ?person ?personLabel ?dob ?dod ?father ?mother ?spouse ?child WHERE {
  VALUES ?person { wd:${qid} }
  OPTIONAL { ?person wdt:P569 ?dob. }
  OPTIONAL { ?person wdt:P570 ?dod. }
  OPTIONAL { ?person wdt:P22 ?father. }
  OPTIONAL { ?person wdt:P25 ?mother. }
  OPTIONAL { ?person wdt:P26 ?spouse. }
  OPTIONAL { ?person wdt:P40 ?child. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${langPref}". }
}`;
  const j1 = await sparql(q1);
  if (!j1.results.bindings.length) {
    el.innerHTML = "<div style='padding:1rem'>No data for this QID</div>";
    return;
  }

  const subjRow = j1.results.bindings[0];
  const subjId = qidFromIRI(subjRow.person.value);
  const spouseIds = dedup(j1.results.bindings.filter(b=>b.spouse).map(b=>qidFromIRI(b.spouse.value)));
  const childIds  = dedup(j1.results.bindings.filter(b=>b.child).map(b=>qidFromIRI(b.child.value)));
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

  // ---------- 3) meta ----------
  const allIds = dedup([subjId, ...spouseIds, ...childIds, ...parentIds, ...siblingIds]);
  const values = allIds.map(id => `wd:${id}`).join(" ");
  const q3 = `
SELECT ?e ?eLabel ?dob ?dod ?image ?gender ?genderLabel WHERE {
  VALUES ?e { ${values} }
  OPTIONAL { ?e wdt:P569 ?dob. }
  OPTIONAL { ?e wdt:P570 ?dod. }
  OPTIONAL { ?e wdt:P18 ?image. }
  OPTIONAL { ?e wdt:P21 ?gender. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${langPref}". }
}`;
  const j3 = await sparql(q3);
  const meta = {};
  j3.results.bindings.forEach(b => {
    const id = qidFromIRI(b.e.value);
    meta[id] = {
      id,
      label: b.eLabel?.value || id,
      dob: b.dob?.value || null,
      dod: b.dod?.value || null,
      image: b.image?.value || null,
      gender: b.genderLabel?.value || null,
      hasParents: false,
      hasChildren: false
    };
  });

  // ---------- 4) second check for generation availability ----------
  const relatedIds = dedup([...parentIds, ...spouseIds, ...childIds]);
  if (relatedIds.length) {
    const valuesRel = relatedIds.map(id => `wd:${id}`).join(" ");
    const qCheck = `
SELECT ?person
       (EXISTS { ?person wdt:P22|wdt:P25 ?p } AS ?hasParents)
       (EXISTS { ?person wdt:P40 ?c } AS ?hasChildren)
WHERE { VALUES ?person { ${valuesRel} } }`;
    const jCheck = await sparql(qCheck);
    jCheck.results.bindings.forEach(b => {
      const id = qidFromIRI(b.person.value);
      if (meta[id]) {
        meta[id].hasParents = b.hasParents?.value === "true";
        meta[id].hasChildren = b.hasChildren?.value === "true";
      }
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
      image: m.image || null,
      gender: m.gender || null,
      hasParents: m.hasParents,
      hasChildren: m.hasChildren
    });
  };
  parentIds.forEach((id, i) => addNode(id, -1, i));
  spouseIds.forEach((id, i) => addNode(id, 0, -(i + 1)));
  addNode(subjId, 0, 0);
  siblingIds.forEach((id, i) => addNode(id, 0, i + 1));
  childIds.forEach((id, i) => addNode(id, 1, i));

  // ---------- 6) coordinates (centered & responsive) ----------
  const rowH = 180, colW = 260, gapX = 30;
  const cardW = 220, cardH = 100;
  const laneY = (lane) => (lane + 1) * rowH;

  function getCenterX() {
    const w = el.getBoundingClientRect().width;
    return w > 0 ? w / 2 : 600;
  }
  const lanes = groupBy(nodes, n => n.lane);
  Object.keys(lanes).forEach(k => lanes[k].sort((a,b)=>a.order-b.order));

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
  await new Promise(requestAnimationFrame);
  positionNodes();

  // ---------- 7) svg ----------
  const { svg, g, gKin, gSpouse, gCards } = mountSvg(el);

  // ---------- 8) helper paths ----------
  const PARENT_LIFT = 26, ARCH_LIFT = 100, ARCH_TIGHT = 0.25, JUNCTION_RATIO = 0.35, FAN_LIFT = 30;
  const center = (n) => ({ x: n.x, y: n.y });
  const vCurve = (a,b)=>`M${a.x} ${a.y} C${a.x} ${(a.y+b.y)/2},${b.x} ${(a.y+b.y)/2},${b.x} ${b.y}`;
  const fanCurveUp = (a,b,lift=FAN_LIFT)=>`M${a.x} ${a.y} C${a.x} ${(a.y+b.y)/2-lift},${b.x} ${(a.y+b.y)/2-lift},${b.x} ${b.y}`;
  const marriageArch=(a,b,lift=ARCH_LIFT,tight=ARCH_TIGHT)=>{
    const minY=Math.min(a.y,b.y);
    const c1x=a.x+(b.x-a.x)*tight;
    const c2x=b.x-(b.x-a.x)*tight;
    const topY=minY-lift;
    return `M${a.x} ${a.y} C${c1x} ${topY},${c2x} ${topY},${b.x} ${b.y}`;
  };
  const drawPath=(g,d,cls)=>g.append("path").attr("class",cls).attr("d",d);
  const dot=(g,x,y,cls="fcl-junction")=>g.append("circle").attr("class",cls).attr("cx",x).attr("cy",y).attr("r",3);

  // ---------- 9) connectors ----------
  spouseIds.forEach(spId=>{
    const a=nodes.find(n=>n.id===subjId), b=nodes.find(n=>n.id===spId);
    if(a&&b) drawPath(gSpouse, marriageArch(center(a), center(b)), "fcl-spouse");
  });

  // (Parent→children and Subject→children IIFEs omitted here for brevity — unchanged from your working version)

  // ---------- 10) draw cards ----------
  nodes.forEach(n => drawCard(gCards, n, { cardW, cardH }));

  // ---------- 11) fit & resize ----------
  autofit(svg, nodes, { pad: 60 });
  window.addEventListener("resize", positionNodes);
}

/* ---------- drawCard() ---------- */
function drawCard(g, n, { cardW, cardH }) {
  const grp = g.append("g")
    .attr("transform", `translate(${n.x - cardW/2}, ${n.y - cardH/2})`);

  const fillColor =
    n.gender?.toLowerCase().includes("female") ? "#ffd6e7" :
    n.gender?.toLowerCase().includes("male") ? "#cce5ff" : "#f5f5f5";

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
    grp.append("image")
      .attr("href", n.image)
      .attr("x", 10)
      .attr("y", (cardH - imgSize)/2)
      .attr("width", imgSize)
      .attr("height", imgSize)
      .attr("preserveAspectRatio", "xMidYMid slice");
  }

  const textX = n.image ? 10 + imgSize + 12 : 14;
  const textY = cardH/2 - 6;

  const name = grp.append("text")
    .attr("class", "fcl-name")
    .attr("x", textX)
    .attr("y", textY)
    .text(n.name);

  if (n.yrs) grp.append("text")
    .attr("class", "fcl-years")
    .attr("x", textX)
    .attr("y", textY + 18)
    .text(n.yrs);

  // ⊕ symbol for expandable generations
  if (n.hasParents || n.hasChildren) {
    grp.append("text")
      .attr("x", cardW - 16)
      .attr("y", 18)
      .attr("class", "fcl-plus")
      .attr("text-anchor", "middle")
      .attr("font-size", 18)
      .attr("cursor", "pointer")
      .text("⊕")
      .on("click", () => {
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set("item", n.id);
        window.top.location.href = newUrl.toString();
      });
  }
}

/* ---------- utilities ---------- */
function dedup(a){ return [...new Set(a)]; }
function groupBy(a,fn){ const m={}; a.forEach(x=>{const k=fn(x);(m[k]||(m[k]=[])).push(x);}); return m;}
function mountSvg(el){
  el.innerHTML="";
  const svg=d3.select(el).append("svg").attr("viewBox","0 0 1200 800").style("cursor","grab");
  const g=svg.append("g");
  const zoomed=e=>g.attr("transform",e.transform);
  svg.call(d3.zoom().scaleExtent([0.3,3]).on("zoom",zoomed));
  const gKin=g.append("g"), gSpouse=g.append("g"), gCards=g.append("g");
  return {svg,g,gKin,gSpouse,gCards};
}
function autofit(svg,nodes,{pad=40}={}){
  const xs=nodes.map(n=>n.x), ys=nodes.map(n=>n.y);
  const minX=Math.min(...xs)-pad, maxX=Math.max(...xs)+pad;
  const minY=Math.min(...ys)-pad, maxY=Math.max(...ys)+pad;
  svg.attr("viewBox",`${minX} ${minY} ${maxX-minX} ${maxY-minY}`);
}
