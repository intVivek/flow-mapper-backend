# Flow Mapper Backend

Backend server for Flow Mapper's web crawling functionality using Playwright.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Install Playwright browsers:**
   ```bash
   npx playwright install chromium
   ```

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Then edit `.env` and add your GROQ API key:
   ```
   GROQ_API_KEY=your_actual_groq_api_key
   ```

## Running the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on `http://localhost:3001` by default.

## API Endpoints

### `POST /api/crawl`

Crawls a website and returns results as a streaming NDJSON response with live status updates.

**Request body:**
```json
{
  "url": "https://example.com",
  "email": "optional@email.com",
  "password": "optional-password",
  "maxPages": 10,
  "maxTime": 120
}
```

**Response:** NDJSON stream with events:
- `{ type: "progress", page: "...", routes: [...] }` - Live crawl progress
- `{ type: "extracting", message: "..." }` - AI extraction started
- `{ type: "result", data: {...}, flowExtractError?: "..." }` - Final results
- `{ type: "error", error: "..." }` - Error occurred

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `GROQ_API_KEY` | Groq API key for flow extraction | (required) |
| `FRONTEND_URL` | Frontend URL for CORS | `http://localhost:3000` |
