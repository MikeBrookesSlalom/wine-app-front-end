import { getJSON, setJSON } from "./store.js";

/* Luke Flunder's monthly list. We extract facts only (wine name, retailer,
   style, buy link, NEW / STAR PICK / PRICE DROP tags) and link each section
   back to his post for the tasting notes, which stay on his site. */
export const WINE_LIST_URL = "https://lukeflunder.substack.com/p/the-list";
const LIST_FRESH_MS = 3 * 24 * 60 * 60 * 1000; // refetch every 3 days

const RETAILER_CANON = [
  ["waitrose", "Waitrose"], ["majestic", "Majestic"], ["tesco", "Tesco"],
  ["m&s", "M&S / Ocado"], ["ocado", "M&S / Ocado"], ["marks", "M&S / Ocado"],
  ["sainsbury", "Sainsbury's"], ["morrisons", "Morrisons"], ["aldi", "Aldi"],
  ["asda", "ASDA"], ["co-op", "Co-op"], ["coop", "Co-op"], ["lidl", "Lidl"],
  ["costco", "Costco"], ["low & no", "Low & No"], ["low and no", "Low & No"],
];
function canonicalRetailer(line) {
  const t = line.trim().toLowerCase().replace(/[^a-z0-9&,\s|]/g, "");
  if (!t || t.length > 40) return null;
  for (const [needle, canon] of RETAILER_CANON) if (t.includes(needle)) return canon;
  return null;
}

export function htmlToLines(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, inner) => {
    return `${inner.replace(/<[^>]+>/g, "")}⟦${url}⟧`;
  });
  s = s.replace(/<\/(h1|h2|h3|h4|h5|h6|li|p|div)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;/g, "'")
       .replace(/&rdquo;|&ldquo;/g, '"').replace(/&nbsp;/g, " ");
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

const TAG_WORDS = ["STAR PICK", "PRICE DROP", "TOP PICK", "NEW"]; // longer phrases first
function stripLeadingTag(line) {
  const upper = line.toUpperCase();
  for (const tw of TAG_WORDS) {
    if (upper.startsWith(tw)) return { tag: tw, rest: line.slice(tw.length).replace(/^\s+/, "") };
  }
  return { tag: null, rest: line };
}

// Stop at Substack's comments/footer so commenters and copyright text never become "wines".
const STOP_MARKERS = [
  /^discussion about this post$/i, /^comments$/i, /^restacks$/i, /^top$/i, /^latest$/i,
  /^discussions$/i, /^ready for more\?$/i, /^subscribe$/i, /^©\s*\d{4}/i,
  /^start your substack$/i, /^no posts$/i,
];
const isStopMarker = (line) => STOP_MARKERS.some((re) => re.test(line.trim()));

function extractSectionLinks(lines) {
  // His "jump to where you shop" links near the top -> per-retailer anchors in the post.
  const map = {};
  for (const raw of lines.slice(0, 20)) {
    if (!raw.includes("⟦")) continue;
    const linkRe = /([^⟦]*)⟦([^⟧]+)⟧/g;
    let lm;
    while ((lm = linkRe.exec(raw)) !== null) {
      const canon = canonicalRetailer(lm[1].trim());
      if (canon && !map[canon]) map[canon] = lm[2];
    }
  }
  return map;
}

export function parseWineListLines(lines) {
  let month = null;
  const head = lines.slice(0, 15).join(" ");
  let m = head.match(/THE\s+L.ST\s*-\s*([A-Za-z]+)\s+(\d{4})/i);
  if (!m) m = head.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\D{0,10}(20\d{2})/i);
  if (m) month = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;

  const sectionLinks = extractSectionLinks(lines);
  const sections = [];
  let current = null;

  for (const raw of lines) {
    if (isStopMarker(raw)) break;

    const retailer = canonicalRetailer(raw);
    if (retailer) {
      current = sections.find((s) => s.retailer === retailer);
      if (!current) { current = { retailer, sourceUrl: sectionLinks[retailer] || null, wines: [] }; sections.push(current); }
      continue;
    }
    if (!current || !raw.includes("⟦")) continue;

    const { tag, rest: line } = stripLeadingTag(raw);
    const linkRe = /([^⟦]*)⟦([^⟧]+)⟧/g;
    let lm, chosen = null;
    const spans = [];
    while ((lm = linkRe.exec(line)) !== null) {
      spans.push({ full: lm[0], name: lm[1].trim(), url: lm[2] });
      if (!chosen && lm[1].trim() && !/^https?:\/\//i.test(lm[1].trim())) chosen = { name: lm[1].trim(), url: lm[2] };
    }
    if (!chosen && spans.length) chosen = spans[spans.length - 1];
    if (!chosen) continue;

    let remainder = line;
    for (const sp of spans) remainder = remainder.replace(sp.full, " ");

    let style = null, offerCode = null;
    const sm = remainder.match(/(?:(CC|NP|MC|AR)\s*)?\(\s*(S|W|R|Ro)\s*\)/i);
    if (sm) {
      offerCode = sm[1] ? sm[1].toUpperCase() : null;
      style = sm[2][0].toUpperCase() + sm[2].slice(1).toLowerCase();
    }
    current.wines.push({ tag, name: chosen.name, url: chosen.url, style, offerCode });
  }
  return { month, sections };
}

async function fetchWineListHtml() {
  const res = await fetch(WINE_LIST_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching wine list`);
  return res.text();
}

export async function getWineList({ debug = false } = {}) {
  const cached = await getJSON("winelist");
  if (!debug && cached && Date.now() - cached.at < LIST_FRESH_MS) return { ...cached.data, cached: true };
  try {
    const lines = htmlToLines(await fetchWineListHtml());
    const parsed = parseWineListLines(lines);
    if (parsed.sections.length) await setJSON("winelist", { data: parsed, at: Date.now() }); // no expiry: kept as a fallback
    if (debug) {
      return {
        month: parsed.month,
        lineCount: lines.length,
        sectionsFound: parsed.sections.map((s) => ({ retailer: s.retailer, wineCount: s.wines.length })),
        firstLines: lines.slice(0, 30),
      };
    }
    return { ...parsed, cached: false };
  } catch (e) {
    if (cached) return { ...cached.data, cached: true, stale: true, error: e.message };
    throw e;
  }
}
