import "dotenv/config";
import express from "express";
import cors from "cors";
import { crawl } from "./lib/crawler.js";
import { extractFlowsWithLLM } from "./lib/extractFlows.js";

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Middleware
app.use(cors({
    origin: FRONTEND_URL,
    credentials: true,
}));
app.use(express.json());

// Health check endpoint
app.get("/", (req, res) => {
    res.json({ status: "ok", message: "Flow Mapper Backend API" });
});

// Wake-up endpoint for handling cold starts
app.get("/api/wakeup", (req, res) => {
    res.json({ status: "ok", message: "Backend is awake" });
});

// Crawl endpoint with streaming response
app.post("/api/crawl", async (req, res) => {
    const { url, email, password, maxPages: bodyMaxPages, maxTime: bodyMaxTime } = req.body;

    if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "URL is required" });
    }

    const maxPages = Math.min(
        200,
        Math.max(1, typeof bodyMaxPages === "number" ? bodyMaxPages : 10)
    );
    const maxTimeSec =
        typeof bodyMaxTime === "number" ? Math.max(10, Math.min(3600, bodyMaxTime)) : undefined;
    const maxTimeMs = maxTimeSec != null ? maxTimeSec * 1000 : undefined;

    // Set headers for streaming NDJSON response
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (obj) => {
        res.write(JSON.stringify(obj) + "\n");
    };

    try {
        const result = await crawl(url, {
            email: email?.trim() || undefined,
            password: password?.trim() || undefined,
            maxPages,
            maxTimeMs,
            onProgress(page, routes) {
                send({ type: "progress", page, routes });
            },
        });

        send({ type: "extracting", message: "Extracting user flows with AI…" });

        const extraction = await extractFlowsWithLLM(result, { startUrl: url });
        const hasExtraction = extraction != null && !("error" in extraction);
        const finalResult = {
            ...result,
            flows: hasExtraction ? extraction.flows ?? [] : [],
            globalNavUrls: hasExtraction ? extraction.globalNavUrls ?? [] : [],
            denoisedEdges: hasExtraction ? extraction.denoisedEdges ?? result.edges : result.edges,
        };
        const flowExtractError =
            extraction == null
                ? "Flow extraction failed (missing API key or no data)"
                : "error" in extraction
                    ? extraction.error
                    : undefined;
        send({ type: "result", data: finalResult, flowExtractError });
    } catch (err) {
        console.error("Crawl error:", err);
        send({
            type: "error",
            error: err instanceof Error ? err.message : "Crawl failed",
        });
    } finally {
        res.end();
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Backend server running on http://localhost:${PORT}`);
    console.log(`📡 Accepting requests from: ${FRONTEND_URL}`);
    console.log(`🔑 GROQ API Key configured: ${process.env.GROQ_API_KEY ? "✓" : "✗"}`);
});
