# RSS Generator

Generate new RSS feeds from either:

- HTML listing pages (scraped with CSS selectors), or
- Existing RSS/Atom feeds (re-filtered).

## Recreate an RSS feed with keyword-only posts

To recreate `https://openai.com/news/rss.xml` but keep only items that match keywords like:

- `translat` **OR**
- `linguist` **OR**
- `localize`

add a new object to `config.json` with `type: "rss"` and a `contentFilter`.

### Example config entry

```json
{
  "name": "OpenAI-News-L10N",
  "type": "rss",
  "url": "https://openai.com/news/rss.xml",
  "feedTitle": "OpenAI News — Translation & Localization",
  "feedDescription": "OpenAI news posts filtered for translation, linguistics, and localization topics",
  "contentFilter": {
    "keywords": ["translat", "linguist", "localize"],
    "minMatches": 1,
    "checkFullContent": false,
    "maxScan": 100
  }
}
```

### Why this works

- `keywords` are matched as **case-insensitive substring** checks.
  - Example: `translat` matches `translate`, `translation`, `translating`, etc.
- `minMatches: 1` means logical **OR** across keywords.
- `checkFullContent: false` checks title + summary only (faster).
- Set `checkFullContent: true` if you want to also fetch full article pages when title/summary is inconclusive.

## Run

```bash
npm install
npm start
```

The filtered feed will be written to:

- `rss/OpenAI-News-L10N.xml`

And exposed via the manifest/status output alongside other generated feeds.
