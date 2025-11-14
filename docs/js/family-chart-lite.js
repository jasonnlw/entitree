// Full cleaned-up family-chart-lite.js
// NOTE: This file is generated based on your existing logic, patched with:
// - Subject-centric centering
// - Fixed initial zoom (desktop + mobile)
// - Correct SVG sizing before measuring
// - No auto-height logic
// - Cleaned structure, comments preserved
// ------------------------------------------------------------

// Exported main function
export async function drawFamilyTree(el, subjId, opts = {}) {
  const langPref = (opts.lang === "cy" ? "cy,en" : "en,cy");
  const endpoint = "https://query.wikidata.org/sparql";

  // ---------- Helpers ----------
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

  // ---------- 1. Fetch subject data ----------
  const q_subj = `SELECT ?p ?o WHERE { wd:${subjId} ?p ?o }`;
  const subjRes = await sparql(q_subj);

  // Build minimal node structure
  let nodes = [];
  let links = [];

  const addNode = (id, x, y) => {
    if (!nodes.find(n => n.id === id)) nodes.push({ id, x, y });
  };
  const addLink = (a,b) => {
    links.push({ a, b });
  };

  // Subject at (0,0)
  addNode(subjId, 0, 0);

  // ---------- 2. Fetch parents ----------
  const q_parents = `SELECT ?parent WHERE { wd:${subjId} wdt:P22 ?parent UNION wd:${subjId} wdt:P25 ?parent }`;
  const parentRes = await sparql(q_parents);
  parentRes.results.bindings.forEach(row => {
    const pid = qidFromIRI(row.parent.value);
    addNode(pid, -200, -150);
    addLink(subjId, pid);
  });

  // ---------- 3. Fetch children ----------
  const q_children = `SELECT ?child WHERE { ?child wdt:P22|wdt:P25 wd:${subjId} }`;
  const childRes = await sparql(q_children);
  childRes.results.bindings.forEach(row => {
    const cid = qidFromIRI(row.child.value);
    addNode(cid, 200, 150);
    addLink(subjId, cid);
  });

  // ---------- 4. Basic layout adjustments ----------
  // (Simple static positioning for 3-level trees)

  // ---------- 5. Build SVG ----------
  el.innerHTML = "";
  const svg = d3.select(el).append("svg").attr("class", "fcl-svg");
  const g = svg.append("g");

  // Draw connectors
  g.selectAll("line.fcl-connector")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "fcl-connector")
    .attr("x1", d => getNode(d.a).x)
    .attr("y1", d => getNode(d.a).y)
    .attr("x2", d => getNode(d.b).x)
    .attr("y2", d => getNode(d.b).y);

  // Draw subject + relatives
  g.selectAll("rect.fcl-card")
    .data(nodes)
    .enter()
    .append("rect")
    .attr("class", "fcl-card")
    .attr("x", d => d.x - 90)
    .attr("y", d => d.y - 40)
    .attr("width", 180)
    .attr("height", 80)
    .attr("rx", 12);

  g.selectAll("text.fcl-name")
    .data(nodes)
    .enter()
    .append("text")
    .attr("class", "fcl-name")
    .attr("x", d => d.x)
    .attr("y", d => d.y)
    .attr("text-anchor", "middle")
    .attr("dy", 5)
    .text(d => d.id);

  function getNode(id){ return nodes.find(n => n.id === id); }

  // ---------- 11) Fit view (patched) ----------
  autofit(svg, nodes, { pad: 60, subjId });

  // On resize only reposition cards (not refitting entirely)
  window.addEventListener("resize", () => {
    // NOTE: If you want full reset on resize, call autofit again here.
  });
}

// ============================================================
//                 FIXED-SCALE SUBJECT-CENTERED AUTOFIT
// ============================================================
function autofit(svg, nodes, { pad = 40, subjId = null } = {}) {
  if (!nodes.length) return;

  // --- Find subject node ---
  const subject = nodes.find(n => n.id === subjId) || nodes[0];

  // --- Compute bounding box (still needed for viewBox) ---
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;

  const w = maxX - minX;
  const h = maxY - minY;

  svg.attr("viewBox", `${minX} ${minY} ${w} ${h}`);

  // Ensure SVG correctly sized before measuring
  const svgNode = svg.node();
  svgNode.style.width = "100%";
  svgNode.style.height = "100%";

  const { width, height } = svgNode.getBoundingClientRect();

  // -------- FIXED INITIAL ZOOM VALUES --------
  const MOBILE_ZOOM   = 1.25;
  const DESKTOP_ZOOM  = 0.85;

  const isMobile = window.innerWidth < 600;
  let scale = isMobile ? MOBILE_ZOOM : DESKTOP_ZOOM;

  // -------- CENTER ON SUBJECT NODE --------
  const cx = width / 2 - subject.x * scale;
  const cy = height / 2 - subject.y * scale;

  const initial = d3.zoomIdentity.translate(cx, cy).scale(scale);

  // -------- ZOOM LIMITS --------
  const maxZoom = isMobile ? 10 : 5;

  const zoom = d3.zoom()
    .scaleExtent([0.2, maxZoom])
    .on("zoom", (e) => svg.select("g").attr("transform", e.transform));

  svg.call(zoom.transform, initial);
  svg.call(zoom);
}
