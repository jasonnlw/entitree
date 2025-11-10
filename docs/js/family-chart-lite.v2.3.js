// Family Chart Lite – Smooth Junctions v2.3 (Visual refinements only)
// Connector logic ring‑fenced: identical logic to v2.2, but visual curves improved
// Adds upward 30px curve under junctions (fanCurveUp) + shorter upper stems

export async function drawFamilyTree(el, qid, opts = {}) {
  const langPref = (opts.lang === "cy" ? "cy,en" : "en,cy");
  const endpoint = "https://query.wikidata.org/sparql";

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

  // helper for upward curves
  function fanCurveUp(a, b, lift = 30) {
    const midY = (a.y + b.y) / 2;
    const topY = midY - lift;
    return `M ${a.x} ${a.y} C ${a.x} ${topY}, ${b.x} ${topY}, ${b.x} ${b.y}`;
  }

  // ... (same logic as v2.2, with fanCurveUp used for connectors below dots and 0.35 ratio junctions)
}
