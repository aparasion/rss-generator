const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");
const fs = require("fs");
const path = require("path");

const config = require("./config.json");

(async () => {
  try {
    console.log("Starting RSS generation...");

    // Ensure rss folder exists
    const rssDir = path.join(__dirname, "rss");
    if (!fs.existsSync(rssDir)) {
      fs.mkdirSync(rssDir);
    }

    await Promise.all(
      config.map(async (site) => {
        try {
          console.log(`Generating feed for ${site.name}`);

          const { data } = await axios.get(site.url, {
            headers: {
              "User-Agent": "Mozilla/5.0"
            },
            timeout: 15000
          });

          const $ = cheerio.load(data);

          const feed = new RSS({
            title: `${site.name} Feed`,
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

            const rawDate = site.dateSelector
              ? $(el).find(site.dateSelector).text().trim()
              : "";

            if (title && link) {
              // Convert relative URLs to absolute
              const fullLink = link.startsWith("http")
                ? link
                : new URL(link, site.url).href;

              // ---- FIXED DATE PARSING (MM/DD/YYYY) ----
              let parsedDate = new Date();

              if (rawDate) {
                const parts = rawDate.split("/");

                if (parts.length === 3) {
                  const month = parseInt(parts[0], 10) - 1; // MM
                  const day = parseInt(parts[1], 10);       // DD
                  const year = parseInt(parts[2], 10);      // YYYY

                  if (!isNaN(month) && !isNaN(day) && !isNaN(year)) {
                    parsedDate = new Date(Date.UTC(year, month, day));
                  }
                }
              }

              feed.item({
                title,
                url: fullLink,
                description,
                date: parsedDate,
              });

              count++;
            }
          });

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
