const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");
const fs = require("fs");
const path = require("path");

const config = require("./config.json");

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
        const isArticleType = typeList.some((t) =>
          typeof t === "string" && t.toLowerCase().includes("article")
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
  const fromJsonLd = extractArticlesFromJsonLd($, site.url);
  const fromAnchors = extractArticlesFromAnchors($, site.url);

  const deduped = new Map();

  [...fromJsonLd, ...fromAnchors].forEach((article) => {
    if (!deduped.has(article.link)) {
      deduped.set(article.link, article);
    }
  });

  return [...deduped.values()].slice(0, 20);
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
  if (numericDateMatch) {
    const first = parseInt(numericDateMatch[1], 10);
    const second = parseInt(numericDateMatch[2], 10);
    const year = parseInt(numericDateMatch[3], 10);

    // Prefer M/D/YYYY by default; flip when first part cannot be month.
    const month = first > 12 ? second - 1 : first - 1;
    const day = first > 12 ? first : second;
@@ -69,66 +173,88 @@ function parseArticleDate(rawDate) {
            description: `RSS feed generated for ${site.name}`,
            site_url: site.url,
            feed_url: `https://aparasion.github.io/rss-generator/rss/${site.name}.xml`,
            language: "en",
            pubDate: new Date(), // channel build date (correct behavior)
          });

          let count = 0;

          $(site.articleSelector).each((i, el) => {
            if (count >= 20) return;

            const title = $(el).find(site.titleSelector).text().trim();
            let link = $(el).find(site.linkSelector).attr("href");

            const description = site.descriptionSelector
              ? $(el).find(site.descriptionSelector).text().trim()
              : "";

            const rawDateEl = site.dateSelector ? $(el).find(site.dateSelector).first() : null;
            const rawDate = rawDateEl
              ? rawDateEl.attr("datetime") || rawDateEl.text().trim()
              : "";

            if (title && link) {
              const fullLink = normalizeUrl(link, site.url);
              if (!fullLink) return;

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

              count++;
            }
          });

          if (count === 0) {
            const fallbackArticles = getFallbackArticles($, site);

            fallbackArticles.forEach((article) => {
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
            });

            count = fallbackArticles.length;
            console.warn(
              `No articles matched configured selectors for ${site.name}; used fallback discovery (${count} items).`
            );
          }

          const outputPath = path.join(rssDir, `${site.name}.xml`);
          fs.writeFileSync(outputPath, feed.xml({ indent: true }));

          console.log(`Finished ${site.name} (${count} items)`);

        } catch (err) {
          console.error(`Failed for ${site.name}: ${err.message}`);
        }
      })
    );

    console.log("All feeds generated successfully.");

  } catch (err) {
    console.error("Fatal error:", err.message);
    process.exit(1);
  }
})();
