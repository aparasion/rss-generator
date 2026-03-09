"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");
const fs = require("fs");
const path = require("path");

// ─── Constants ───────────────────────────────────────────────────────────────

const config = require("./config.json");
const MAX_ITEMS = 20;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_DESCRIPTION_LENGTH = 500;
const FEED_BASE_URL =
  process.env.FEED_BASE_URL ||
  "https://aparasion.github.io/rss-generator";

const rssDir = path.join(__dirname, "rss");
const cacheFilePath = path.join(rssDir, "cache.json");
const seenCacheFilePath = path.join(rssDir, "seen.json");
const statusFilePath = path.join(rssDir, "status.json");
const manifestFilePath = path.join(rssDir, "feeds.json");

// Realistic browser User-Agent strings rotated per request to reduce
// the chance of being blocked by simple bot-detection heuristics.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Resolve a possibly-relative URL against a base, returning null on failure. */
function normalizeUrl(url, baseUrl) {
  if (!url) return null;
  url = url.trim();
  if (!url || url.startsWith("#") || url.startsWith("javascript:")) return null;
  try {
    return url.startsWith("http") ? url : new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

/** Strip HTML tags and collapse whitespace. */
function stripHtml(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate text at a word boundary up to maxLen, appending "…" when cut. */
function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.75 ? cut.slice(0, lastSpace) : cut) + "…";
}

// ─── Config validation ────────────────────────────────────────────────────────

function validateConfig(sites) {
  if (!Array.isArray(sites) || sites.length === 0) {
    throw new Error("config.json must be a non-empty array");
  }
  const required = ["name", "url", "articleSelector", "titleSelector", "linkSelector"];
  sites.forEach((site, i) => {
    for (const field of required) {
      if (site[field] == null) {
        throw new Error(`config[${i}] is missing required field "${field}"`);
      }
    }
    try {
      new URL(site.url);
    } catch {
      throw new Error(`config[${i}].url is not a valid URL: "${site.url}"`);
    }
  });
}

// ─── HTTP cache (ETag / Last-Modified) ───────────────────────────────────────

function loadHttpCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
  } catch {
    return {};
  }
}

function saveHttpCache(cache) {
  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("Warning: could not save HTTP cache:", err.message);
  }
}

// ─── Seen cache (tracks article URLs already classified for content filtering) ─

/**
 * Seen cache structure:
 * {
 *   "SiteName": {
 *     "https://article-url": { relevant: true/false, checkedAt: "ISO date" }
 *   }
 * }
 */
function loadSeenCache() {
  try {
    return JSON.parse(fs.readFileSync(seenCacheFilePath, "utf8"));
  } catch {
    return {};
  }
}

function saveSeenCache(cache) {
  try {
    fs.writeFileSync(seenCacheFilePath, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("Warning: could not save seen cache:", err.message);
  }
}

// ─── HTTP fetch with retry + ETag support ────────────────────────────────────

/**
 * Fetch a URL with:
 *   - ETag / Last-Modified conditional GET (skip re-parsing unchanged pages)
 *   - Exponential-backoff retry (up to MAX_RETRIES attempts)
 *   - 429 Rate-Limit handling via Retry-After header
 *
 * Returns { notModified: true } when the server responds 304,
 * or { html: string } on success.
 * Throws on permanent failure.
 */
async function fetchPage(url, httpCache) {
  const cached = httpCache[url] || {};
  const reqHeaders = {
    "User-Agent": getRandomUserAgent(),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  };
  if (cached.etag) reqHeaders["If-None-Match"] = cached.etag;
  if (cached.lastModified) reqHeaders["If-Modified-Since"] = cached.lastModified;

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: reqHeaders,
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 5,
        // Treat 4xx/5xx as errors ourselves so we can handle 304 and 429 specially.
        validateStatus: (s) => s < 600,
      });

      if (response.status === 304) {
        return { notModified: true };
      }

      if (response.status === 429) {
        const retryAfter = parseInt(
          response.headers["retry-after"] || "60",
          10
        );
        const waitMs = Math.min(retryAfter * 1000, 60_000);
        console.log(`  Rate-limited by ${url}; waiting ${waitMs / 1000}s…`);
        await sleep(waitMs);
        continue; // retry without counting this as a failed attempt
      }

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // Update cache headers for next run.
      if (response.headers.etag) cached.etag = response.headers.etag;
      if (response.headers["last-modified"])
        cached.lastModified = response.headers["last-modified"];
      httpCache[url] = cached;

      const contentType = response.headers["content-type"] || "";
      if (
        !contentType.includes("html") &&
        !contentType.includes("xml") &&
        !contentType.includes("text")
      ) {
        throw new Error(`Unexpected Content-Type: ${contentType}`);
      }

      return { html: response.data };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.log(
          `  Attempt ${attempt}/${MAX_RETRIES} failed (${err.message}); retrying in ${delay}ms…`
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ─── Article extraction ───────────────────────────────────────────────────────

function extractArticlesFromJsonLd($, pageUrl) {
  const articles = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;

    try {
      const payload = JSON.parse(raw);
      const queue = Array.isArray(payload) ? [...payload] : [payload];

      while (queue.length) {
        const node = queue.shift();
        if (!node) continue;
        if (Array.isArray(node)) { queue.push(...node); continue; }
        if (typeof node !== "object") continue;

        if (node["@graph"]) queue.push(node["@graph"]);
        if (node.itemListElement) queue.push(node.itemListElement);

        const type = node["@type"];
        const typeList = Array.isArray(type) ? type : [type];
        const isArticleType = typeList.some(
          (t) =>
            typeof t === "string" &&
            /article|blogposting|newsarticle/i.test(t)
        );
        if (!isArticleType) continue;

        const title = stripHtml((node.headline || node.name || "").trim());
        const link = normalizeUrl(node.url, pageUrl);
        if (!title || !link) continue;

        articles.push({
          title,
          link,
          description: stripHtml((node.description || "").trim()),
          rawDate: node.datePublished || node.dateCreated || "",
        });
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  });

  return articles;
}

function extractArticlesFromAnchors($, site) {
  const articles = [];
  let siteOrigin = null;
  try { siteOrigin = new URL(site.url).origin; } catch { /* ignore */ }

  const listingPathname = (() => {
    try { return new URL(site.url).pathname; } catch { return null; }
  })();

  $("a[href]").each((_, el) => {
    const rawHref = ($(el).attr("href") || "").trim();
    const title = stripHtml($(el).attr("aria-label") || $(el).text());

    if (!rawHref || !title || title.length < 8) return;

    const link = normalizeUrl(rawHref, site.url);
    if (!link) return;

    try {
      const parsed = new URL(link);
      if (siteOrigin && parsed.origin !== siteOrigin) return;
      if (link === site.url) return;
      if (listingPathname && parsed.pathname === listingPathname) return;
      if (site.linkPathPrefix && !parsed.pathname.startsWith(site.linkPathPrefix)) return;
    } catch {
      return;
    }

    articles.push({ title, link, description: "", rawDate: "" });
  });

  return articles;
}

function getFallbackArticles($, site) {
  const fromJsonLd = extractArticlesFromJsonLd($, site.url);
  const fromAnchors = extractArticlesFromAnchors($, site);

  const deduped = new Map();
  [...fromJsonLd, ...fromAnchors].forEach((a) => {
    if (!deduped.has(a.link)) deduped.set(a.link, a);
  });

  return [...deduped.values()].slice(0, MAX_ITEMS);
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

function parseArticleDate(rawDate) {
  if (!rawDate) return null;
  const normalized = rawDate.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const nativeParsed = new Date(normalized);
  if (!Number.isNaN(nativeParsed.getTime())) return nativeParsed;

  // Numeric dates with dots or slashes: "DD.MM.YYYY" or "M/D/YYYY"
  const numericMatch = normalized.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (numericMatch) {
    const first = parseInt(numericMatch[1], 10);
    const second = parseInt(numericMatch[2], 10);
    const year = parseInt(numericMatch[3], 10);
    const month = first > 12 ? second - 1 : first - 1;
    const day = first > 12 ? first : second;
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month, day));
      if (
        d.getUTCFullYear() === year &&
        d.getUTCMonth() === month &&
        d.getUTCDate() === day
      ) return d;
    }
  }

  return null;
}

/**
 * Try to extract a publication date from the article element itself using
 * <time datetime> elements or Open Graph meta tags, falling back to the
 * configured dateSelector.
 */
function extractItemDate($, articleEl, site) {
  // 1. Configured selector
  if (site.dateSelector) {
    const el = $(articleEl).find(site.dateSelector).first();
    if (el.length) {
      const d = parseArticleDate(el.attr("datetime") || el.text().trim());
      if (d) return d;
    }
  }

  // 2. Any <time> element inside the article card
  const timeEl = $(articleEl).find("time").first();
  if (timeEl.length) {
    const d = parseArticleDate(timeEl.attr("datetime") || timeEl.text().trim());
    if (d) return d;
  }

  return null;
}

// ─── Content-filter helpers ───────────────────────────────────────────────────

/**
 * Returns true when `text` contains at least `minMatches` of the configured
 * keywords (case-insensitive, substring match).
 */
function isContentRelevant(text, contentFilter) {
  if (!contentFilter || !Array.isArray(contentFilter.keywords)) return true;
  if (!text) return false;
  const lower = text.toLowerCase();
  const minMatches = contentFilter.minMatches || 1;
  let matches = 0;
  for (const kw of contentFilter.keywords) {
    if (lower.includes(kw.toLowerCase())) {
      matches++;
      if (matches >= minMatches) return true;
    }
  }
  return false;
}

/**
 * Decide whether an article is relevant.
 *
 * Fast path: check title + listing-page description against keywords.
 * If still inconclusive and `contentFilter.checkFullContent` is true,
 * fetch the article page and check the body text.
 *
 * Results are memoised in `seenForSite` so each URL is only processed once
 * across runs. URLs that could not be fetched are NOT persisted so they
 * will be retried next run.
 *
 * @param {string}  url
 * @param {string}  title
 * @param {string}  description  - summary already available on the listing page
 * @param {object}  contentFilter
 * @param {object}  httpCache
 * @param {object}  seenForSite  - mutable reference to the per-site seen map
 * @returns {Promise<boolean>}
 */
async function classifyArticle(url, title, description, contentFilter, httpCache, seenForSite) {
  // Already decided in a previous run.
  if (url in seenForSite) {
    return seenForSite[url].relevant;
  }

  // Check whatever text is already available on the listing page.
  const listingText = [title, description].filter(Boolean).join(" ");
  if (isContentRelevant(listingText, contentFilter)) {
    seenForSite[url] = { relevant: true, checkedAt: new Date().toISOString() };
    return true;
  }

  // Optionally fetch the full article and check its body.
  if (contentFilter.checkFullContent) {
    try {
      const result = await fetchPage(url, httpCache);
      if (!result.notModified && result.html) {
        const $ = cheerio.load(result.html);
        $("script, style, nav, header, footer, aside").remove();
        const bodyText = $("body").text();
        const relevant = isContentRelevant(bodyText, contentFilter);
        seenForSite[url] = { relevant, checkedAt: new Date().toISOString() };
        return relevant;
      }
    } catch (err) {
      // Network / HTTP error — skip and leave unseen so the next run retries.
      console.warn(`  Could not fetch article for classification: ${url} (${err.message})`);
      return false;
    }
  }

  // Conclusively irrelevant (title + description checked, no full-fetch needed).
  seenForSite[url] = { relevant: false, checkedAt: new Date().toISOString() };
  return false;
}

// ─── Per-site feed generation ─────────────────────────────────────────────────

async function processSite(site, httpCache, seenCache) {
  const t0 = Date.now();
  console.log(`\nProcessing: ${site.name} (${site.url})`);
  // Per-site seen map — mutated in place and persisted by the caller.
  if (site.contentFilter && !seenCache[site.name]) seenCache[site.name] = {};

  let fetchResult = await fetchPage(site.url, httpCache);

  if (fetchResult.notModified) {
    const outputPath = path.join(rssDir, `${site.name}.xml`);
    if (fs.existsSync(outputPath)) {
      console.log(`  ${site.name}: page unchanged (304); skipping re-parse.`);
      return {
        name: site.name,
        url: site.url,
        feedUrl: `${FEED_BASE_URL}/rss/${site.name}.xml`,
        status: "not_modified",
        items: null,
        durationMs: Date.now() - t0,
      };
    }
    // Output file is missing despite a 304 — clear conditional headers and re-fetch
    console.log(`  ${site.name}: output file missing despite 304; forcing unconditional re-fetch.`);
    if (httpCache[site.url]) {
      delete httpCache[site.url].etag;
      delete httpCache[site.url].lastModified;
    }
    fetchResult = await fetchPage(site.url, httpCache);
  }

  const $ = cheerio.load(fetchResult.html);
  const feedUrl = `${FEED_BASE_URL}/rss/${site.name}.xml`;

  const feed = new RSS({
    title: `${site.name} Feed`,
    description: `RSS feed generated for ${site.name}`,
    site_url: site.url,
    feed_url: feedUrl,
    language: "en",
    pubDate: new Date(),
    ttl: 60, // hint to consumers: re-check every 60 minutes
  });

  const addedLinks = new Set();
  const contentFilter = site.contentFilter || null;
  const seenForSite = contentFilter ? seenCache[site.name] : null;
  // How many unseen articles we are willing to classify per run (avoids
  // excessive HTTP requests when a site has thousands of articles).
  const maxScan = (contentFilter && contentFilter.maxScan) || 50;
  let scanned = 0; // unseen articles classified this run

  // ── Primary extraction via configured CSS selectors ──
  const primaryArticles = [];
  $(site.articleSelector).each((_, el) => {
    const $el = $(el);
    const titleRaw = $el.find(site.titleSelector).text().trim();

    // Support cards where the article element itself is the link (e.g. <a class="card">)
    let $linkEl = $el.find(site.linkSelector);
    if (!$linkEl.length && $el.is(site.linkSelector)) $linkEl = $el;
    const linkRaw = ($linkEl.attr("href") || "").trim();

    if (!titleRaw || !linkRaw) return;

    const title = stripHtml(titleRaw);
    const fullLink = normalizeUrl(linkRaw, site.url);
    if (!fullLink || addedLinks.has(fullLink)) return;

    if (site.linkPathPrefix) {
      try { if (!new URL(fullLink).pathname.startsWith(site.linkPathPrefix)) return; }
      catch { return; }
    }

    const description = truncate(
      stripHtml(
        site.descriptionSelector
          ? $el.find(site.descriptionSelector).text().trim()
          : ""
      ),
      MAX_DESCRIPTION_LENGTH
    );

    const date = extractItemDate($, el, site);
    primaryArticles.push({ title, link: fullLink, description, date });
  });

  // ── Apply content filter (if configured) then add to feed ──
  for (const article of primaryArticles) {
    if (addedLinks.size >= MAX_ITEMS) break;
    if (addedLinks.has(article.link)) continue;

    if (contentFilter) {
      const alreadySeen = article.link in seenForSite;
      if (!alreadySeen && scanned >= maxScan) {
        // Hit the per-run scan budget — skip remaining unseen articles.
        continue;
      }
      if (!alreadySeen) scanned++;

      const relevant = await classifyArticle(
        article.link, article.title, article.description,
        contentFilter, httpCache, seenForSite
      );
      if (!relevant) continue;
    }

    const item = { title: article.title, url: article.link, description: article.description };
    if (article.date) item.date = article.date;
    feed.item(item);
    addedLinks.add(article.link);
  }

  // ── Fallback extraction when selectors yield nothing ──
  if (addedLinks.size === 0) {
    const fallback = getFallbackArticles($, site);
    console.warn(
      `  No articles matched selectors for ${site.name}; fallback found ${fallback.length} item(s).`
    );

    for (const article of fallback) {
      if (addedLinks.size >= MAX_ITEMS) break;
      if (addedLinks.has(article.link)) continue;

      if (contentFilter) {
        const alreadySeen = article.link in seenForSite;
        if (!alreadySeen && scanned >= maxScan) continue;
        if (!alreadySeen) scanned++;

        const relevant = await classifyArticle(
          article.link, article.title, article.description || "",
          contentFilter, httpCache, seenForSite
        );
        if (!relevant) continue;
      }

      const description = truncate(
        stripHtml(article.description || ""),
        MAX_DESCRIPTION_LENGTH
      );
      const date = parseArticleDate(article.rawDate);
      const item = { title: article.title, url: article.link, description };
      if (date) item.date = date;
      feed.item(item);
      addedLinks.add(article.link);
    }
  }

  if (contentFilter) {
    const newlySeen = Object.values(seenForSite).length;
    console.log(`  Content filter: scanned ${scanned} new article(s) this run; ${newlySeen} total in seen cache.`);
  }

  const outputPath = path.join(rssDir, `${site.name}.xml`);
  fs.writeFileSync(outputPath, feed.xml({ indent: true }));

  const count = addedLinks.size;
  console.log(`  Done: ${site.name} — ${count} item(s) in ${Date.now() - t0}ms`);

  return {
    name: site.name,
    url: site.url,
    feedUrl,
    status: "success",
    items: count,
    durationMs: Date.now() - t0,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    console.log("Starting RSS generation…");

    validateConfig(config);
    fs.mkdirSync(rssDir, { recursive: true });

    const httpCache = loadHttpCache();
    const seenCache = loadSeenCache();
    const runStart = Date.now();

    const results = await Promise.all(
      config.map(async (site) => {
        try {
          return await processSite(site, httpCache, seenCache);
        } catch (err) {
          console.error(`  ERROR — ${site.name}: ${err.message}`);
          return {
            name: site.name,
            url: site.url,
            feedUrl: `${FEED_BASE_URL}/rss/${site.name}.xml`,
            status: "error",
            error: err.message,
            items: null,
            durationMs: 0,
          };
        }
      })
    );

    // Persist ETag / Last-Modified values and seen-article classifications.
    saveHttpCache(httpCache);
    saveSeenCache(seenCache);

    // ── status.json — machine-readable run summary for downstream consumers ──
    const status = {
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - runStart,
      feeds: results,
    };
    fs.writeFileSync(statusFilePath, JSON.stringify(status, null, 2));

    // ── feeds.json — stable manifest listing every feed ──
    const manifest = {
      generatedAt: new Date().toISOString(),
      feeds: config.map((site) => ({
        name: site.name,
        sourceUrl: site.url,
        feedUrl: `${FEED_BASE_URL}/rss/${site.name}.xml`,
      })),
    };
    fs.writeFileSync(manifestFilePath, JSON.stringify(manifest, null, 2));

    // ── Exit strategy: fail only when every single feed errored ──
    const errors = results.filter((r) => r.status === "error");
    if (errors.length === config.length) {
      console.error("\nAll feeds failed — exiting with error.");
      process.exit(1);
    }
    if (errors.length > 0) {
      console.warn(
        `\nWarning: ${errors.length}/${config.length} feed(s) failed: ` +
          errors.map((e) => e.name).join(", ")
      );
    }

    console.log(
      `\nRSS generation complete (${results.filter((r) => r.status === "success").length} succeeded, ` +
        `${errors.length} failed, ${results.filter((r) => r.status === "not_modified").length} unchanged).`
    );
  } catch (err) {
    console.error("Fatal error:", err.message);
    process.exit(1);
  }
})();
