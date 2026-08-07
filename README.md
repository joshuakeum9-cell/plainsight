# Plainsight

**Fundamentals. In plain sight.** — a free, open, live company-fundamentals terminal for the S&P 500.

Live site: https://joshuakeum9-cell.github.io/plainsight/

Plainsight turns official SEC filings and live market data into clean one-page company reports: price, valuation metrics, and ten years of audited financials — no login, no paywall, no ads.

## What's inside

| Page | What it does |
|---|---|
| `index.html` | Marketing landing page (live index chips, ticker tape, real AAPL mini-report) |
| `app.html` | The terminal: indices, top movers, sector performance, full sortable 503-company screener |
| `company.html?t=TICKER` | The report: live price + chart, valuation metrics, 10 years of fundamentals, recent quarters, profile |

## How the data works (all free, no API keys)

- **Quotes & price history** — Yahoo Finance public endpoints (batch `spark` for quotes, `chart` for candles).
- **Fundamentals** — [SEC EDGAR companyfacts](https://www.sec.gov/edgar/sec-api-documentation): revenue, income, margins, EPS, cash flow, balance sheet, buybacks, dividends — straight from each company's 10-K/10-Q XBRL filings.
- **Universe** — S&P 500 constituents (with GICS sectors and CIK numbers) parsed from Wikipedia.

Two GitHub Actions keep it live:

- `.github/workflows/quotes.yml` — refreshes `data/quotes.json` and the intraday series (1D/5D, on the single-commit `data-intraday` branch) every 15 minutes during US market hours.
- `.github/workflows/daily.yml` — nightly refresh of the universe, per-ticker price history, and EDGAR fundamentals.

Each run commits the updated JSON to `data/`, and GitHub Pages redeploys automatically. Every page shows its "last updated" stamp.

## Pipeline scripts

```bash
node scripts/build-universe.mjs        # S&P 500 list -> data/universe.json
node scripts/refresh-quotes.mjs        # all quotes + indices -> data/quotes.json
node scripts/refresh-history.mjs       # 1y daily + 10y monthly candles -> data/history/*.json
node scripts/refresh-fundamentals.mjs  # EDGAR facts + ratios -> data/fundamentals/*.json
```

No dependencies — plain Node 18+ (`fetch` built in). `ONLY=AAPL,MSFT` or `LIMIT=25` narrow the fundamentals run for testing.

## Run locally

```bash
python -m http.server 8140 --directory plainsight
```

Then open http://localhost:8140.

## Data notes & honest limitations

- Quotes can be up to ~15 minutes old plus CDN cache (the refresh cadence); the stamp on every page tells you exactly.
- TTM cash-flow metrics use YTD arithmetic (last FY + current YTD − prior-year YTD) because 10-Q cash flow statements are cumulative.
- Q4 values are derived (FY minus the three reported quarters) and flagged in tooltips.
- Multi-class share structures with unequal classes (e.g. BRK.B) get per-share metrics suppressed rather than shown wrong.
- Banks and insurers report cash flow differently; some metrics are legitimately "—" for them.
- This is an informational tool, not investment advice.

## Design

Clay-inspired design system (`DESIGN-clay.md`): cream canvas, near-black ink, saturated feature cards (pink/teal/lavender/peach/ochre), Inter with negative display tracking, generous radii, cream footer with the signature mountain horizon. Charts are hand-rolled SVG with a colorblind-validated categorical palette.

---

Built by [Joshua Keum](https://joshuakeum9-cell.github.io/joshua-keum-site/) with Claude Code.
