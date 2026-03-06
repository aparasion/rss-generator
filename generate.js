const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");
const fs = require("fs");
const path = require("path");

const config = require("./config.json");
const MAX_ITEMS = 20;

function normalizeUrl(url, baseUrl) {
  if (!url) return null;

  try {
    return url.startsWith("http") ? url : new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

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

        if (Array.isArray(node)) {
          queue.push(...node);
          continue;
        }

        if (typeof node !== "object") continue;

        if (node["@graph"]) queue.push(node["@graph"]);
        if (node.itemListElement) queue.push(node.itemListElement);

        const type = node["@type"];
        const typeList = Array.isArray(type) ? type : [type];
        const isArticleType = typeList.some(
          (t) => typeof t === "string" && t.toLowerCase().includes("article")
        );

        if (!isArticleType) continue;

        const title = (node.headline || node.name || "").trim();
        const link = normalizeUrl(node.url, pageUrl);

        if (!title || !link) continue;

        articles.push({
          title,
          link,
          description: (node.description || "").trim(),
          rawDate: node.datePublished || node.dateCreated || "",
        });
      }
    } catch {
      // Ignore malformed JSON-LD script tags and continue.
    }
  });

  return articles;
}

function extractArticlesFromAnchors($, pageUrl) {
  const articles = [];

  $("a[href]").each((_, el) => {
    const rawHref = ($(el).attr("href") || "").trim();
    const title = $(el).text().replace(/\s+/g, " ").trim();

    if (!rawHref || !title || title.length < 8) return;

    const link = normalizeUrl(rawHref, pageUrl);
    if (!link) return;

    // Keep only links that are likely article pages.
    if (!/\/news\//i.test(link)) return;

    articles.push({
      title,
      link,
      description: "",
      rawDate: "",
    });
  });

  return articles;
}

function getFallbackArticles($, site) {
  const fromJsonLd = extractArticlesFromJsonLd($, site.baseUrl || site.url);
  const fromAnchors = extractArticlesFromAnchors($, site.baseUrl || site.url);

  const deduped = new Map();

  [...fromJsonLd, ...fromAnchors].forEach((article) => {
    if (!deduped.has(article.link)) {
      deduped.set(article.link, article);
    }
  });

  return [...deduped.values()].slice(0, MAX_ITEMS);
}



async function fetchSiteContent(site) {
  const candidateUrls = [site.url, ...(site.fallbackUrls || [])].filter(Boolean);
  let lastError = null;

  for (let index = 0; index < candidateUrls.length; index += 1) {
    const candidateUrl = candidateUrls[index];
    try {
      const response = await axios.get(candidateUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: site.baseUrl || candidateUrl,
        },
        timeout: 15000,
      });

      return {
        data: response.data,
        sourceUrl: candidateUrl,
      };
    } catch (err) {
      lastError = err;
      const hasMoreCandidates = index < candidateUrls.length - 1;
      if (hasMoreCandidates) {
        console.warn(
          `Request failed for ${site.name} at ${candidateUrl} (${err.message}); trying fallback URL.`
        );
      }
    }
  }

  if (lastError) {
    lastError.message = `${lastError.message} (tried URLs: ${candidateUrls.join(", ")})`;
  }

  throw lastError || new Error("Unable to fetch any configured URL.");
}
function parseArticleDate(rawDate) {
  if (!rawDate) return null;

  const normalized = rawDate.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  // 1) Let JS parse common formats such as:
  //    - "March 4, 2026"
  //    - "4 March 2026"
  //    - ISO datetime strings
  const nativeParsed = new Date(normalized);
  if (!Number.isNaN(nativeParsed.getTime())) {
    return nativeParsed;
  }

  // 2) Explicit fallback for numeric dates (M/D/YYYY or D/M/YYYY)
  const numericDateMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!numericDateMatch) return null;

  const first = parseInt(numericDateMatch[1], 10);
  const second = parseInt(numericDateMatch[2], 10);
  const year = parseInt(numericDateMatch[3], 10);

  // Prefer M/D/YYYY by default; flip when first part cannot be month.
  const month = first > 12 ? second - 1 : first - 1;
  const day = first > 12 ? first : second;

  if (
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(year) ||
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const parsed = new Date(Date.UTC(year, month, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

(async () => {
  try {
    console.log("Starting RSS generation...");

    const rssDir = path.join(__dirname, "rss");
    if (!fs.existsSync(rssDir)) {
      fs.mkdirSync(rssDir);
    }

    const results = await Promise.all(
      config.map(async (site) => {
        try {
          console.log(`Generating feed for ${site.name}`);

          const { data, sourceUrl } = await fetchSiteContent(site);

          if (sourceUrl !== site.url) {
            console.warn(
              `Using fallback URL for ${site.name}: ${sourceUrl}`
            );
          }

          const $ = cheerio.load(data);

          const feed = new RSS({
            title: `${site.name} Feed`,
            description: `RSS feed generated for ${site.name}`,
            site_url: sourceUrl,
            feed_url: `https://aparasion.github.io/rss-generator/rss/${site.name}.xml`,
            language: "en",
            pubDate: new Date(),
          });

          const addedLinks = new Set();
          let count = 0;

          $(site.articleSelector).each((_, el) => {
            if (count >= MAX_ITEMS) return;

            const title = $(el).find(site.titleSelector).text().trim();
            const link = ($(el).find(site.linkSelector).attr("href") || "").trim();
            if (!title || !link) return;

            const fullLink = normalizeUrl(link, site.url);
            if (!fullLink || addedLinks.has(fullLink)) return;

            const description = site.descriptionSelector
              ? $(el).find(site.descriptionSelector).text().trim()
              : "";

            const rawDateEl = site.dateSelector
              ? $(el).find(site.dateSelector).first()
              : null;
            const rawDate = rawDateEl
              ? rawDateEl.attr("datetime") || rawDateEl.text().trim()
              : "";

            const parsedDate = parseArticleDate(rawDate);
            const item = {
              title,
              url: fullLink,
              description,
            };

            if (parsedDate) {
              item.date = parsedDate;
            }

            feed.item(item);
            addedLinks.add(fullLink);
            count++;
          });

          if (count === 0) {
            const fallbackArticles = getFallbackArticles($, site);

            fallbackArticles.forEach((article) => {
              if (addedLinks.has(article.link)) return;

              const parsedDate = parseArticleDate(article.rawDate);
              const item = {
                title: article.title,
                url: article.link,
                description: article.description,
              };

              if (parsedDate) {
                item.date = parsedDate;
              }

              feed.item(item);
              addedLinks.add(article.link);
            });

            count = addedLinks.size;
            console.warn(
              `No articles matched configured selectors for ${site.name}; used fallback discovery (${count} items).`
            );
          }

          const outputPath = path.join(rssDir, `${site.name}.xml`);
          fs.writeFileSync(outputPath, feed.xml({ indent: true }));

          console.log(`Finished ${site.name} (${count} items)`);
          return { site: site.name, status: "fulfilled", count };
        } catch (err) {
          console.error(`Failed for ${site.name}: ${err.message}`);
          return { site: site.name, status: "rejected", reason: err.message };
        }
      })
    );

    const failures = results.filter((result) => result.status === "rejected");

    if (failures.length > 0) {
      console.error(
        `RSS generation completed with ${failures.length} failure(s): ${failures
          .map((failure) => failure.site)
          .join(", ")}.`
      );
      process.exitCode = 1;
      return;
    }

    console.log("All feeds generated successfully.");
  } catch (err) {
    console.error("Fatal error:", err.message);
    process.exit(1);
  }
})();
