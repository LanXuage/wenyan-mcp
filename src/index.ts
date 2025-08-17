#!/usr/bin/env node

import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Theme, themes } from "./theme.js";
// @ts-ignore
import { initMarkdownRenderer, renderMarkdown, handleFrontMatter } from "./main.js";
import { publishToDraft } from "./publish.js";
import fs from "fs";
import util from "util";

// 日志工具
function log(...args: any[]) {
    const msg = `[${new Date().toISOString()}] ${args.map(a => (typeof a === "string" ? a : util.inspect(a, { depth: 5 }))).join(" ")}`;
    console.log(msg);
    try {
        fs.appendFileSync("wenyan-mcp.log", msg + "\n");
    } catch (e) {}
}

initMarkdownRenderer();
log("Markdown renderer initialized");

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: Server } = {};

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
    log("POST /mcp", { headers: req.headers, body: req.body });
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    let server: Server;

    if (sessionId && transports[sessionId]) {
        log("Reusing session", sessionId);
        transport = transports[sessionId];
        server = servers[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
        log("Initializing new session");
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
                log("Session initialized", sid);
                transports[sid] = transport;
                servers[sid] = server;
            },
        });
        server = new Server(
            {
                name: "wenyan-mcp",
                version: "0.1.0",
            },
            {
                capabilities: {
                    resources: {},
                    tools: {},
                    prompts: {},
                },
            }
        );
        log("Server instance created");

        server.setRequestHandler(ListToolsRequestSchema, async () => {
            log("ListToolsRequestSchema called");
            return {
                tools: [
                    {
                        name: "publish_article",
                        description:
                            "Format a Markdown article using a selected theme and publish it to '微信公众号'.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                content: {
                                    type: "string",
                                    description: "The original Markdown content to publish, preserving its frontmatter (if present).",
                                },
                                theme_id: {
                                    type: "string",
                                    description:
                                        "ID of the theme to use (e.g., default, orangeheart, rainbow, lapis, pie, maize, purple, phycat).",
                                },
                                appid: {
                                    type: "string",
                                    description: "The AppID for the WeChat Official Account.",
                                },
                                appsecret: {
                                    type: "string",
                                    description: "The AppSecret for the WeChat Official Account.",
                                },
                            },
                            required: ["content"],
                        },
                    },
                    {
                        name: "list_themes",
                        description:
                            "List the themes compatible with the 'publish_article' tool to publish an article to '微信公众号'.",
                        inputSchema: {
                            type: "object",
                            properties: {}
                        },
                    },
                ],
            };
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            log("CallToolRequestSchema called", request.params?.name, request.params?.arguments);
            if (request.params.name === "publish_article") {
                const content = String(request.params.arguments?.content || "");
                const themeId = String(request.params.arguments?.theme_id || "");
                const appid = request.params.arguments?.appid as string | undefined;
                const appsecret = request.params.arguments?.appsecret as string | undefined;
                let theme: Theme | undefined = themes["default"];
                if (themeId) {
                    theme = themes[themeId];
                    if (!theme) {
                        theme = Object.values(themes).find(
                            theme => theme.name.toLowerCase() === themeId.toLowerCase()
                        );
                    }
                }
                if (!theme) {
                    log("Invalid theme ID", themeId);
                    throw new Error("Invalid theme ID");
                }
                const preHandlerContent = handleFrontMatter(content);
                log("FrontMatter handled", preHandlerContent);
                const html = await renderMarkdown(preHandlerContent.body, theme.id);
                log("Markdown rendered", { theme: theme.id, htmlLength: html.length });
                const title = preHandlerContent.title ?? "this is title";
                const cover = preHandlerContent.cover ?? "";
                try {
                    const response = await publishToDraft(title, html, cover, appid, appsecret);
                    log("Article published", { title, media_id: response.media_id });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Your article was successfully published to '公众号草稿箱'. The media ID is ${response.media_id}.`,
                            },
                        ],
                    };
                } catch (err) {
                    log("Publish error", err);
                    throw err;
                }
            } else if (request.params.name === "list_themes") {
                log("Listing themes");
                const themeResources = Object.entries(themes).map(([id, theme]) => ({
                    type: "text",
                    text: JSON.stringify({
                        id: id,
                        name: theme.name,
                        description: theme.description
                    }),
                }));
                return {
                    content: themeResources,
                };
            }
            log("Unknown tool", request.params.name);
            throw new Error("Unknown tool");
        });

        await server.connect(transport);
        log("Server connected to transport");

        transport.onclose = () => {
            log("Session closed", transport.sessionId);
            if (transport.sessionId) {
                delete transports[transport.sessionId];
                delete servers[transport.sessionId];
            }
        };
    } else {
        log("Bad Request: No valid session ID provided", { headers: req.headers, body: req.body });
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
            },
            id: null,
        });
        return;
    }

    try {
        await transport.handleRequest(req, res, req.body);
        log("Request handled successfully");
    } catch (err) {
        log("Request handling error", err);
        res.status(500).json({
            jsonrpc: '2.0',
            error: {
                code: -32001,
                message: 'Internal server error',
                data: String(err)
            },
            id: req.body?.id ?? null,
        });
    }
});

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    log(`${req.method} /mcp`, { headers: req.headers });
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        log("Invalid or missing session ID", sessionId);
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const transport = transports[sessionId];
    try {
        await transport.handleRequest(req, res);
        log("Session request handled successfully");
    } catch (err) {
        log("Session request handling error", err);
        res.status(500).send('Internal server error');
    }
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

app.listen(3000, () => {
    log("MCP Server (HTTP+SSE) listening on port 3000");
});
