# Bot API (Server-to-Server)

Status: Draft
Owner: TBD
Date: 2026-01-30

## Auth
- Set `BOT_API_KEY` as a Cloudflare Workers secret.
- Send `Authorization: Bearer <BOT_API_KEY>` or `X-Bot-Api-Key: <BOT_API_KEY>`.

If `BOT_API_KEY` is not set, endpoints return `401 { "error": "bot_api_key_missing" }`.

## Endpoints

### GET /api/bot/health
Returns cache freshness for the bot to gauge data quality.

Response:
```json
{
  "ok": true,
  "now": 1738195200,
  "cacheFreshness": {
    "total": 120,
    "missingHistory": 4,
    "staleHistory": 6,
    "oldestHistory": 1738194400,
    "newestHistory": 1738195100,
    "cutoff": 1738194300
  }
}
```

### GET /api/bot/cache
Query params:
- `limit` (default 200, max 500)
- `windowHours` (default 24)
- `sportSeriesId` (optional)

Response:
```json
{ "entries": [/* SharpMoneyCacheEntry */] }
```

### GET /api/bot/candidates
Server-side filtering for imminent markets and minimum grade.

Query params:
- `windowMinutes` (default 5)
- `minGrade` (default A; accepts A+, A, B, C, D)
- `limit` (default 200, max 500)
- `requireReady` (default true)
- `includeStarted` (default false)

Response:
```json
{
  "candidates": [
    {
      "entry": {
        "conditionId": "...",
        "marketTitle": "...",
        "marketSlug": "...",
        "eventSlug": "...",
        "sportSeriesId": 10346,
        "eventTime": "2026-01-31T19:30:00Z",
        "sharpSide": "A",
        "marketType": "total",
        "sideA": { "label": "Capitals", "price": 0.52 },
        "sideB": { "label": "Red Wings", "price": 0.48 },
        "sharpSidePrice": 0.52,
        "edgeRating": 78,
        "scoreDifferential": 24
      },
      "grade": {
        "grade": "A",
        "signalScore": 88.2,
        "edgeRating": 78,
        "scoreDifferential": 24,
        "isReady": true,
        "warnings": [],
        "computedAt": 1738195200,
        "historyUpdatedAt": 1738194900
      }
    }
  ],
  "requested": 12,
  "returned": 2,
  "truncated": false,
  "computedAt": 1738195200
}
```

### POST /api/bot/grades
Request:
```json
{
  "conditionIds": ["..."],
  "historyWindowMinutes": 60,
  "staleThresholdMinutes": 15
}
```

Response:
```json
{
  "results": [
    {
      "conditionId": "...",
      "grade": "A+",
      "signalScore": 95.2,
      "edgeRating": 88,
      "scoreDifferential": 34,
      "isReady": true,
      "warnings": ["low_conviction"],
      "computedAt": 1738195200,
      "historyUpdatedAt": 1738194900
    }
  ],
  "requested": 120,
  "returned": 120,
  "truncated": false,
  "computedAt": 1738195200
}
```

### POST /api/bot/picks
Log a bot (paper) pick into the app so `/stats` can display it.

Request:
```json
{
  "conditionId": "...",
  "marketTitle": "...",
  "eventTime": "2026-01-31T19:30:00Z",
  "grade": "A",
  "signalScore": 88.2,
  "edgeRating": 78,
  "scoreDifferential": 24,
  "sharpSide": "A",
  "price": 0.52
}
```

Response:
```json
{ "pick": { /* ManualPickEntry */ } }
```

## Error codes
- `401 unauthorized` for missing/invalid auth
- `400 conditionIds_required` when request payload is invalid
- `404 not_found` for unknown route

## Quick curl examples

```bash
curl -H "Authorization: Bearer $BOT_API_KEY" \
  https://<your-domain>/api/bot/health
```

```bash
curl -H "Authorization: Bearer $BOT_API_KEY" \
  "https://<your-domain>/api/bot/cache?limit=100&windowHours=12"
```

```bash
curl -H "Authorization: Bearer $BOT_API_KEY" \
  "https://<your-domain>/api/bot/candidates?windowMinutes=5&minGrade=A"
```

```bash
curl -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"conditionIds":["...","..."]}' \
  https://<your-domain>/api/bot/grades
```

```bash
curl -H "Authorization: Bearer $BOT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"conditionId":"...","marketTitle":"..."}' \
  https://<your-domain>/api/bot/picks
```

## Verification checklist
- BOT_API_KEY secret set in Cloudflare.
- Bot can call `/api/bot/health` and receive cache freshness.
- Bot can fetch cache entries and then grade condition IDs.
