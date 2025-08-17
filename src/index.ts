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

initMarkdownRenderer();

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: Server } = {};

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    let server: Server;

    if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
        server = servers[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
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
        // 注册工具等 handler
        server.setRequestHandler(ListToolsRequestSchema, async () => {
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
            if (request.params.name === "publish_article") {
                const content = String(request.params.arguments?.content || "");
                const themeId = String(request.params.arguments?.theme_id || "");
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
                    throw new Error("Invalid theme ID");
                }
                const preHandlerContent = handleFrontMatter(content);
                const html = await renderMarkdown(preHandlerContent.body, theme.id);
                const title = preHandlerContent.title ?? "this is title";
                const cover = preHandlerContent.cover ?? "";
                const response = await publishToDraft(title, html, cover);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Your article was successfully published to '公众号草稿箱'. The media ID is ${response.media_id}.`,
                        },
                    ],
                };
            } else if (request.params.name === "list_themes") {
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
            throw new Error("Unknown tool");
        });

        // 连接 MCP server
        await server.connect(transport);

        // 清理
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
                delete servers[transport.sessionId];
            }
        };
    } else {
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

    await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

app.listen(3000, () => {
    console.log("MCP Server (HTTP+SSE) listening on port 3000");
});
