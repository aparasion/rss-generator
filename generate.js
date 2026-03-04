const axios = require("axios");
const cheerio = require("cheerio");
const RSS = require("rss");
const fs = require("fs");

const config = require("./config.json");

(async () => {
  for (const site of config) {
    console.log(`Generating feed for ${site.name}`);

    const { data } = await axios.get(site.url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);

    const feed = new RSS({
      title: `${site.name} Feed`,
      site_url: site.url,
      feed_url: `https://aparasion.github.io/rss-generator/rss/${site.name}.xml`,
    });

    $(site.articleSelector).each((i, el) => {
      const title = $(el).find(site.titleSelector).text().trim();
      const link = $(el).find(site.linkSelector).attr("href");

      if (title && link) {
        feed.item({
          title,
          url: link.startsWith("http") ? link : site.url + link,
          date: new Date(),
        });
      }
    });

    if (!fs.existsSync("rss")) {
      fs.mkdirSync("rss");
    }

    fs.writeFileSync(`rss/${site.name}.xml`, feed.xml({ indent: true }));
  }
})();
