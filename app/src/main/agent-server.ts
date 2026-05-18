import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type {
  BenchLocalAgentAccess,
  BenchLocalAgentAccessState,
  BenchLocalAgentEvent,
  BenchLocalAgentCreateModelRequest,
  BenchLocalAgentCreateProviderRequest,
  BenchLocalAgentCreateTabRequest,
  BenchLocalAgentExecutionModeRequest,
  BenchLocalAgentPatchModelRequest,
  BenchLocalAgentPatchProviderRequest,
  BenchLocalAgentPatchTabRequest,
  BenchLocalAgentRetryBatchRequest,
  BenchLocalAgentRetryScenarioRequest,
  BenchLocalAgentRunRequest,
  BenchLocalAgentRunsPerTestRequest,
  BenchLocalAgentSamplingRequest,
  BenchLocalAgentSelectBenchPackRequest,
  BenchLocalAgentSelectModelsRequest,
  BenchLocalAgentResumeRunRequest,
  BenchLocalAgentAvailabilityRefreshRequest,
  BenchLocalWorkspaceTab
} from "@core";
import { getBenchLocalHome, loadOrCreateConfig } from "@core";
import { benchLocalController, type BenchLocalController } from "./controller";
import { handleBenchLocalMcpRequest } from "./agent-mcp";

type AgentSession = {
  token: string;
  createdAt: string;
};

type ConfigureAgentAccessInput = {
  enabled: boolean;
  access?: BenchLocalAgentAccess;
  port?: number;
};

type RetryBatchKind = "provider_errors" | "failed_results";

const DEFAULT_AGENT_ACCESS = "localhost" as const;
const AGENT_SESSION_PATH = path.join(getBenchLocalHome(), "agent-session.json");
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_RECENT_AGENT_EVENTS = 500;

function createToken(): string {
  return randomBytes(32).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: unknown, allowedKeys: string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new HttpError(400, "Expected a JSON object.");
  }

  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(value).filter((key) => !allowed.has(key));

  if (unknownKeys.length > 0) {
    throw new HttpError(400, `Unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`);
  }
}

function normalizePort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new HttpError(400, "Port must be an integer from 0 to 65535.");
  }

  return port === 0 ? undefined : port;
}

function normalizeAccess(value: unknown): BenchLocalAgentAccess | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "localhost" || value === "local_network") {
    return value;
  }

  throw new HttpError(400, "Access must be either localhost or local_network.");
}

function getAgentHost(access: BenchLocalAgentAccess): "127.0.0.1" | "0.0.0.0" {
  return access === "local_network" ? "0.0.0.0" : "127.0.0.1";
}

function getAgentLocalClientHost(): "127.0.0.1" {
  return "127.0.0.1";
}

function isAllowedLocalOrigin(value: string | undefined): boolean {
  if (!value) {
    return true;
  }

  try {
    const origin = new URL(value);
    const hostname = origin.hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required.`);
  }

  return value.trim();
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response: ServerResponse, statusCode: number, contentType: string, payload: string): void {
  response.writeHead(statusCode, {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store"
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Internal server error.";

  sendJson(response, statusCode, {
    error: {
      message,
      statusCode
    }
  });
}

function decodePathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

async function readJsonRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;

    if (size > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, "JSON body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

class BenchLocalAgentServer {
  private server: Server | null = null;
  private session: AgentSession | null = null;
  private connectedClients = new Set<ServerResponse>();
  private recentEvents: BenchLocalAgentEvent[] = [];
  private enabled = false;
  private access: BenchLocalAgentAccess = DEFAULT_AGENT_ACCESS;
  private configuredPort: number | undefined;
  private port: number | undefined;
  private message: string | undefined;
  private startedAt: string | undefined;

  constructor(private readonly controller: BenchLocalController) {
    this.controller.onAgentEvent((event) => {
      this.recentEvents.push(event);

      if (this.recentEvents.length > MAX_RECENT_AGENT_EVENTS) {
        this.recentEvents.splice(0, this.recentEvents.length - MAX_RECENT_AGENT_EVENTS);
      }

      this.broadcastSse(event.type, event.eventId, event);
    });
  }

  async initialize(): Promise<BenchLocalAgentAccessState> {
    const { config } = await loadOrCreateConfig();
    const envEnabled = process.env.BENCHLOCAL_AGENT_API === "1";
    const envPort = normalizePort(process.env.BENCHLOCAL_AGENT_PORT);
    const envAccess = normalizeAccess(process.env.BENCHLOCAL_AGENT_ACCESS);
    this.enabled = envEnabled || config.agent?.enabled === true;
    this.access = envAccess ?? config.agent?.access ?? DEFAULT_AGENT_ACCESS;
    this.configuredPort = envPort ?? config.agent?.port;

    if (this.enabled) {
      await this.start();
    } else {
      await this.ensureSession();
    }

    return this.getState();
  }

  getState(options?: { includeToken?: boolean }): BenchLocalAgentAccessState {
    const token = options?.includeToken === false ? undefined : this.session?.token;

    return {
      enabled: this.enabled,
      running: Boolean(this.server),
      access: this.access,
      host: getAgentHost(this.access),
      configuredPort: this.configuredPort,
      port: this.port,
      baseUrl: this.port ? `http://${getAgentLocalClientHost()}:${this.port}` : undefined,
      token,
      connectedClients: this.connectedClients.size,
      message: this.message,
      startedAt: this.startedAt
    };
  }

  async configure(input: ConfigureAgentAccessInput): Promise<BenchLocalAgentAccessState> {
    this.enabled = input.enabled;
    this.access = input.access ?? this.access ?? DEFAULT_AGENT_ACCESS;
    this.configuredPort = input.port;

    const { config } = await loadOrCreateConfig();
    await this.controller.saveConfig({
      ...config,
      agent: {
        enabled: input.enabled,
        access: this.access,
        ...(input.port ? { port: input.port } : {})
      }
    });

    if (this.enabled) {
      await this.restart();
    } else {
      await this.stop();
    }

    this.emitState();
    return this.getState();
  }

  async regenerateToken(): Promise<BenchLocalAgentAccessState> {
    this.session = {
      token: createToken(),
      createdAt: new Date().toISOString()
    };
    await this.saveSession();
    this.emitState();
    return this.getState();
  }

  async stop(): Promise<BenchLocalAgentAccessState> {
    for (const client of this.connectedClients) {
      client.end();
    }
    this.connectedClients.clear();

    const server = this.server;
    this.server = null;
    this.port = undefined;
    this.startedAt = undefined;

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    this.message = this.enabled ? "Agent API is stopped." : "Agent API is disabled.";
    this.emitState();
    return this.getState();
  }

  private async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async start(): Promise<void> {
    await this.ensureSession();

    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        sendError(response, error);
      });
    });

    const requestedPort = this.configuredPort ?? 0;
    const host = getAgentHost(this.access);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();

    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to resolve local agent API address.");
    }

    this.server = server;
    this.port = address.port;
    this.startedAt = new Date().toISOString();
    this.message = `Agent API is listening on http://${host}:${this.port}.`;
    this.emitState();
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) {
      return this.session;
    }

    try {
      const raw = await fs.readFile(AGENT_SESSION_PATH, "utf8");
      const parsed = JSON.parse(raw) as Partial<AgentSession>;

      if (typeof parsed.token === "string" && parsed.token.trim()) {
        this.session = {
          token: parsed.token,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString()
        };
        return this.session;
      }
    } catch {
      // Create a fresh token below.
    }

    this.session = {
      token: createToken(),
      createdAt: new Date().toISOString()
    };
    await this.saveSession();
    return this.session;
  }

  private async saveSession(): Promise<void> {
    if (!this.session) {
      return;
    }

    await fs.mkdir(path.dirname(AGENT_SESSION_PATH), { recursive: true });
    const tempPath = `${AGENT_SESSION_PATH}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.session, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, AGENT_SESSION_PATH);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${getAgentHost(this.access)}`);
    const segments = decodePathSegments(url.pathname);

    if (request.method === "GET" && url.pathname === "/v1/health") {
      const metadata = await this.controller.getRuntimeCompatibility();
      sendJson(response, 200, {
        ok: true,
        benchLocalVersion: metadata.benchLocalVersion,
        agent: this.getState({ includeToken: false }),
        docs: {
          agentGuide: "/v1/agent-guide",
          openapi: "/v1/openapi.json",
          mcp: "/mcp"
        }
      });
      return;
    }

    await this.requireAuth(request);

    if (url.pathname === "/mcp" || url.pathname === "/v1/mcp") {
      this.requireLocalOrigin(request);
      await handleBenchLocalMcpRequest(this.controller, {
        getAgentGuide: () => this.createAgentGuide(),
        getOpenApiDocument: () => this.createOpenApiDocument(),
        getRecentEvents: () => [...this.recentEvents]
      }, request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/events") {
      this.openSse(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/agent-guide") {
      sendText(response, 200, "text/markdown", this.createAgentGuide());
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/openapi.json") {
      sendJson(response, 200, this.createOpenApiDocument());
      return;
    }

    if (segments[0] !== "v1") {
      throw new HttpError(404, "Unknown endpoint.");
    }

    await this.routeV1(request, response, segments.slice(1));
  }

  private async requireAuth(request: IncomingMessage): Promise<void> {
    const session = await this.ensureSession();
    const authorization = request.headers.authorization ?? "";
    const expected = `Bearer ${session.token}`;

    if (authorization !== expected) {
      throw new HttpError(401, "Unauthorized.");
    }
  }

  private requireLocalOrigin(request: IncomingMessage): void {
    if (!isAllowedLocalOrigin(request.headers.origin)) {
      throw new HttpError(403, "MCP requests must use a localhost Origin header or omit Origin.");
    }
  }

  private openSse(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    response.write(": BenchLocal agent event stream\n\n");
    this.connectedClients.add(response);
    this.emitState();

    response.on("close", () => {
      this.connectedClients.delete(response);
      this.emitState();
    });
  }

  private broadcastSse(eventName: string, eventId: string, payload: unknown): void {
    const data = JSON.stringify(payload);

    for (const client of this.connectedClients) {
      client.write(`id: ${eventId}\n`);
      client.write(`event: ${eventName}\n`);
      client.write(`data: ${data}\n\n`);
    }
  }

  private emitState(): void {
    this.controller.emitAgentEvent("agent.state.updated", this.getState({ includeToken: false }));
  }

  private createAgentGuide(): string {
    const host = getAgentLocalClientHost();
    const baseUrl = this.port ? `http://${host}:${this.port}` : `http://${host}:<port>`;

    return `# BenchLocal Agent API

BenchLocal exposes local HTTP JSON commands plus Server-Sent Events for live progress.
It also exposes an MCP Streamable HTTP endpoint for agents that prefer standard tool calls.

Base URL: \`${baseUrl}\`
MCP URL: \`${baseUrl}/mcp\`

Authentication:

\`\`\`http
Authorization: Bearer <token>
\`\`\`

The token is shown in BenchLocal Settings > Agent Access. All endpoints except \`GET /v1/health\` require this bearer token.
Provider, model, Bench Pack, tab, and run IDs used in path segments must be URL-encoded. This matters for model IDs such as \`provider:Qwen/Qwen3.5-9B\`.
When Agent Access is set to Local Network, BenchLocal listens on \`0.0.0.0\`; agents on other devices should use this machine's LAN IP address with the same port and bearer token.

## MCP Endpoint

Use \`POST /mcp\` as a Streamable HTTP MCP endpoint with the same bearer token. BenchLocal exposes:

- Resources for guide, OpenAPI, config, workspace, Bench Packs, providers, models, active runs, and recent events.
- Tools named with the \`benchlocal_\` prefix for provider/model CRUD, tab setup, model availability, run start/resume/stop/retry, history reads, and verifier reads.
- Prompt \`benchlocal-run-benchpack\` for the recommended run workflow.

This MCP server is stateless. Long-running run tools return \`accepted: true\`; inspect the UI, call \`benchlocal_get_recent_events\`, or read \`benchlocal://state/events/recent\` for progress.

## Recommended Agent Workflow

1. Call \`GET /v1/health\`.
2. Call \`GET /v1/workspaces\` to find the active workspace and tabs.
3. Call \`GET /v1/benchpacks\`, \`GET /v1/providers\`, and \`GET /v1/models\`.
4. Open \`GET /v1/events\` as an SSE stream and keep it open.
5. Create or update a tab:
   - \`POST /v1/workspaces/:workspaceId/tabs\`
   - \`POST /v1/tabs/:tabId/select-benchpack\`
   - \`POST /v1/tabs/:tabId/select-models\`
6. Refresh model status with \`POST /v1/models/availability/refresh\`.
7. Tune tab run controls when needed:
   - \`POST /v1/tabs/:tabId/sampling\`
   - \`POST /v1/tabs/:tabId/execution-mode\`
   - \`POST /v1/tabs/:tabId/runs-per-test\`
8. Start, resume, stop, or retry runs:
   - \`POST /v1/tabs/:tabId/runs\`
   - \`POST /v1/tabs/:tabId/runs/:runId/resume\`
   - \`POST /v1/tabs/:tabId/runs/:runId/retry-provider-errors\`
   - \`POST /v1/tabs/:tabId/runs/:runId/retry-failed-results\`
   - \`POST /v1/tabs/:tabId/runs/stop\`
9. Watch \`benchpack.run.event\` SSE events until \`run_finished\` or \`run_error\`.

## Model Server Coordination

BenchLocal does not run arbitrary shell commands. Start and stop local model servers outside BenchLocal, then use model availability and run/resume endpoints to coordinate work.

## Important Events

- \`workspace.updated\`
- \`config.updated\`
- \`models.availability.updated\`
- \`benchpack.run.started\`
- \`benchpack.run.event\`
- \`benchpack.run.finished\`
- \`benchpack.run.error\`
- \`verifier.event\`

Every SSE event has this shape:

\`\`\`json
{
  "eventId": "evt-...",
  "createdAt": "2026-05-18T00:00:00.000Z",
  "type": "benchpack.run.event",
  "payload": {}
}
\`\`\`

## Core Endpoints

Read state:

- \`GET /v1/config\` returns redacted config.
- \`GET /v1/workspaces\` returns workspace and tab state.
- \`GET /v1/benchpacks\` returns installed Bench Packs.
- \`GET /v1/providers\` returns configured providers with secrets redacted.
- \`GET /v1/models\` returns configured models.
- \`GET /v1/models/availability\` checks model availability.
- \`GET /v1/runs/active\` returns active runs.
- \`GET /v1/benchpacks/:benchPackId/history\` returns run history.
- \`GET /v1/benchpacks/:benchPackId/history/:runId\` returns a run summary.
- \`GET /v1/verifiers\` returns verifier runtime status.

Mutate workspace:

- \`POST /v1/workspaces/:workspaceId/tabs\`
- \`PATCH /v1/tabs/:tabId\`
- \`POST /v1/tabs/:tabId/select-benchpack\`
- \`POST /v1/tabs/:tabId/select-models\`
- \`POST /v1/tabs/:tabId/sampling\`
- \`POST /v1/tabs/:tabId/execution-mode\`
- \`POST /v1/tabs/:tabId/runs-per-test\`
- \`POST /v1/tabs/:tabId/models/availability/refresh\`

Mutate providers and models:

- \`POST /v1/providers\`
- \`GET /v1/providers/:providerId\`
- \`PATCH /v1/providers/:providerId\`
- \`DELETE /v1/providers/:providerId\`
- \`POST /v1/providers/:providerId/duplicate\`
- \`GET /v1/providers/:providerId/models/discover\`
- \`POST /v1/models\`
- \`GET /v1/models/:modelId\`
- \`PATCH /v1/models/:modelId\`
- \`DELETE /v1/models/:modelId\`
- \`POST /v1/models/:modelId/duplicate\`

Run benchmarks:

- \`POST /v1/tabs/:tabId/runs\`
- \`POST /v1/tabs/:tabId/runs/:runId/resume\`
- \`POST /v1/tabs/:tabId/runs/:runId/retry-scenario\`
- \`POST /v1/tabs/:tabId/runs/:runId/retry-provider-errors\`
- \`POST /v1/tabs/:tabId/runs/:runId/retry-failed-results\`
- \`POST /v1/tabs/:tabId/runs/stop\`

Discovery:

- \`GET /v1/agent-guide\`
- \`GET /v1/openapi.json\`
- \`POST /mcp\`

## Request Examples

Create a tab:

\`\`\`json
{
  "benchPackId": "toolcall-15",
  "title": "ToolCall-15",
  "modelSelections": [{ "modelId": "ollama:qwen3.5:9b" }]
}
\`\`\`

Select models:

\`\`\`json
{
  "modelIds": ["ollama:qwen3.5:9b"]
}
\`\`\`

Start a run:

\`\`\`json
{
  "executionMode": "serial_by_model",
  "runsPerTest": 1
}
\`\`\`

Refresh selected models:

\`\`\`json
{
  "modelIds": ["ollama:qwen3.5:9b"]
}
\`\`\`
`;
  }

  private createOpenApiDocument() {
    const host = getAgentLocalClientHost();
    const serverUrl = this.port ? `http://${host}:${this.port}` : `http://${host}`;
    const bearerSecurity = [{ bearerAuth: [] }];
    const jsonContent = (schema: Record<string, unknown>) => ({
      "application/json": {
        schema
      }
    });

    return {
      openapi: "3.1.0",
      info: {
        title: "BenchLocal Agent API",
        version: "1.0.0",
        description: "Local BenchLocal control API for agents. Commands use JSON HTTP; live progress uses Server-Sent Events."
      },
      servers: [{ url: serverUrl }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer"
          }
        },
        schemas: {
          ErrorResponse: {
            type: "object",
            properties: {
              error: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  statusCode: { type: "number" }
                }
              }
            }
          }
        }
      },
      paths: {
        "/mcp": {
          post: {
            summary: "Handle MCP Streamable HTTP JSON-RPC requests.",
            description: "Standard MCP endpoint exposing BenchLocal resources, prompts, and benchlocal_* tools. Uses the same bearer token as the Agent API.",
            security: bearerSecurity,
            responses: {
              "200": { description: "MCP JSON-RPC response or event stream." }
            }
          }
        },
        "/v1/health": {
          get: {
            summary: "Check whether the local agent API is reachable.",
            security: [],
            responses: {
              "200": { description: "Health state" }
            }
          }
        },
        "/v1/agent-guide": {
          get: {
            summary: "Return agent-readable Markdown instructions.",
            security: bearerSecurity,
            responses: {
              "200": {
                description: "Markdown guide",
                content: {
                  "text/markdown": {
                    schema: { type: "string" }
                  }
                }
              }
            }
          }
        },
        "/v1/openapi.json": {
          get: {
            summary: "Return this OpenAPI document.",
            security: bearerSecurity,
            responses: {
              "200": { description: "OpenAPI document" }
            }
          }
        },
        "/v1/events": {
          get: {
            summary: "Subscribe to live BenchLocal events with Server-Sent Events.",
            security: bearerSecurity,
            responses: {
              "200": {
                description: "SSE stream",
                content: {
                  "text/event-stream": {
                    schema: { type: "string" }
                  }
                }
              }
            }
          }
        },
        "/v1/config": { get: { summary: "Return redacted BenchLocal config.", security: bearerSecurity, responses: { "200": { description: "Config" } } } },
        "/v1/workspaces": { get: { summary: "Return workspace state.", security: bearerSecurity, responses: { "200": { description: "Workspace state" } } } },
        "/v1/benchpacks": { get: { summary: "Return installed Bench Packs.", security: bearerSecurity, responses: { "200": { description: "Bench Packs" } } } },
        "/v1/benchpacks/registry": { get: { summary: "Return Bench Pack registry entries.", security: bearerSecurity, responses: { "200": { description: "Registry" } } } },
        "/v1/providers": {
          get: { summary: "Return configured providers with secrets redacted.", security: bearerSecurity, responses: { "200": { description: "Providers" } } },
          post: { summary: "Create a provider.", security: bearerSecurity, responses: { "201": { description: "Provider created" } } }
        },
        "/v1/providers/{providerId}": {
          get: { summary: "Return one provider with secrets redacted.", security: bearerSecurity, responses: { "200": { description: "Provider" } } },
          patch: { summary: "Update a provider.", security: bearerSecurity, responses: { "200": { description: "Provider updated" } } },
          delete: { summary: "Delete a provider and linked models.", security: bearerSecurity, responses: { "200": { description: "Provider deleted" } } }
        },
        "/v1/providers/{providerId}/duplicate": {
          post: { summary: "Duplicate one provider record only.", security: bearerSecurity, responses: { "201": { description: "Provider duplicated" } } }
        },
        "/v1/providers/{providerId}/models/discover": {
          get: { summary: "Discover provider models when supported.", security: bearerSecurity, responses: { "200": { description: "Discovered models" } } }
        },
        "/v1/models": {
          get: { summary: "Return configured models.", security: bearerSecurity, responses: { "200": { description: "Models" } } },
          post: { summary: "Create a model.", security: bearerSecurity, responses: { "201": { description: "Model created" } } }
        },
        "/v1/models/{modelId}": {
          get: { summary: "Return one model.", security: bearerSecurity, responses: { "200": { description: "Model" } } },
          patch: { summary: "Update a model.", security: bearerSecurity, responses: { "200": { description: "Model updated" } } },
          delete: { summary: "Delete a model and remove it from tab selections.", security: bearerSecurity, responses: { "200": { description: "Model deleted" } } }
        },
        "/v1/models/{modelId}/duplicate": {
          post: { summary: "Duplicate one model record.", security: bearerSecurity, responses: { "201": { description: "Model duplicated" } } }
        },
        "/v1/models/availability": { get: { summary: "Check model availability.", security: bearerSecurity, responses: { "200": { description: "Availability" } } } },
        "/v1/models/availability/refresh": {
          post: {
            summary: "Refresh model availability.",
            security: bearerSecurity,
            requestBody: {
              required: false,
              content: jsonContent({
                type: "object",
                additionalProperties: false,
                properties: {
                  modelIds: { type: "array", items: { type: "string" } }
                }
              })
            },
            responses: { "200": { description: "Availability" } }
          }
        },
        "/v1/runs/active": { get: { summary: "Return active runs.", security: bearerSecurity, responses: { "200": { description: "Active runs" } } } },
        "/v1/verifiers": { get: { summary: "Return verifier status.", security: bearerSecurity, responses: { "200": { description: "Verifiers" } } } },
        "/v1/workspaces/{workspaceId}/tabs": {
          post: {
            summary: "Create a workspace tab.",
            security: bearerSecurity,
            parameters: [{ name: "workspaceId", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: false,
              content: jsonContent({
                type: "object",
                additionalProperties: false,
                properties: {
                  benchPackId: { type: ["string", "null"] },
                  title: { type: "string" },
                  modelSelections: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        modelId: { type: "string" },
                        alias: { type: "string" }
                      },
                      required: ["modelId"]
                    }
                  }
                }
              })
            },
            responses: { "201": { description: "Updated workspace state" } }
          }
        },
        "/v1/tabs/{tabId}": {
          patch: {
            summary: "Patch a tab.",
            security: bearerSecurity,
            parameters: [{ name: "tabId", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "Updated workspace state" } }
          }
        },
        "/v1/tabs/{tabId}/select-benchpack": {
          post: {
            summary: "Select a Bench Pack for a tab.",
            security: bearerSecurity,
            parameters: [{ name: "tabId", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: jsonContent({
                type: "object",
                additionalProperties: false,
                properties: {
                  benchPackId: { type: ["string", "null"] },
                  title: { type: "string" }
                },
                required: ["benchPackId"]
              })
            },
            responses: { "200": { description: "Updated workspace state" } }
          }
        },
        "/v1/tabs/{tabId}/select-models": {
          post: {
            summary: "Select models for a tab.",
            security: bearerSecurity,
            parameters: [{ name: "tabId", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: jsonContent({
                type: "object",
                additionalProperties: false,
                properties: {
                  modelIds: { type: "array", items: { type: "string" } },
                  selections: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        modelId: { type: "string" },
                        alias: { type: "string" }
                      },
                      required: ["modelId"]
                    }
                  }
                }
              })
            },
            responses: { "200": { description: "Updated workspace state" } }
          }
        },
        "/v1/tabs/{tabId}/sampling": { post: { summary: "Set tab sampling overrides.", security: bearerSecurity, responses: { "200": { description: "Updated workspace state" } } } },
        "/v1/tabs/{tabId}/execution-mode": { post: { summary: "Set tab execution mode.", security: bearerSecurity, responses: { "200": { description: "Updated workspace state" } } } },
        "/v1/tabs/{tabId}/runs-per-test": { post: { summary: "Set tab runs per test.", security: bearerSecurity, responses: { "200": { description: "Updated workspace state" } } } },
        "/v1/tabs/{tabId}/models/availability/refresh": { post: { summary: "Refresh selected tab model availability.", security: bearerSecurity, responses: { "200": { description: "Availability" } } } },
        "/v1/tabs/{tabId}/runs": {
          post: {
            summary: "Start a run for a tab.",
            security: bearerSecurity,
            parameters: [{ name: "tabId", in: "path", required: true, schema: { type: "string" } }],
            responses: { "202": { description: "Run accepted; subscribe to /v1/events for progress." } }
          }
        },
        "/v1/tabs/{tabId}/runs/stop": { post: { summary: "Stop a tab run.", security: bearerSecurity, responses: { "200": { description: "Stop result" } } } },
        "/v1/tabs/{tabId}/runs/{runId}/resume": { post: { summary: "Resume a historical run.", security: bearerSecurity, responses: { "202": { description: "Resume accepted" } } } },
        "/v1/tabs/{tabId}/runs/{runId}/retry-scenario": { post: { summary: "Retry one scenario/model cell.", security: bearerSecurity, responses: { "202": { description: "Retry accepted" } } } },
        "/v1/tabs/{tabId}/runs/{runId}/retry-provider-errors": { post: { summary: "Retry provider-error cells from a saved run.", security: bearerSecurity, responses: { "202": { description: "Retry accepted" } } } },
        "/v1/tabs/{tabId}/runs/{runId}/retry-failed-results": { post: { summary: "Retry non-provider failed cells from a saved run.", security: bearerSecurity, responses: { "202": { description: "Retry accepted" } } } },
        "/v1/benchpacks/{benchPackId}/history": { get: { summary: "Return run history for a Bench Pack.", security: bearerSecurity, responses: { "200": { description: "Run history" } } } },
        "/v1/benchpacks/{benchPackId}/history/{runId}": { get: { summary: "Return a run summary.", security: bearerSecurity, responses: { "200": { description: "Run summary" } } } }
      }
    };
  }

  private async routeV1(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    if (request.method === "GET" && segments.length === 1 && segments[0] === "config") {
      sendJson(response, 200, { config: await this.controller.getSafeConfig() });
      return;
    }

    if (request.method === "GET" && segments.length === 1 && segments[0] === "workspaces") {
      sendJson(response, 200, await this.controller.loadWorkspaceState());
      return;
    }

    if (request.method === "GET" && segments.length === 1 && segments[0] === "benchpacks") {
      sendJson(response, 200, { benchPacks: await this.controller.listBenchPacks() });
      return;
    }

    if (request.method === "GET" && segments.length === 2 && segments[0] === "benchpacks" && segments[1] === "registry") {
      sendJson(response, 200, { registry: await this.controller.loadBenchPackRegistry() });
      return;
    }

    if (request.method === "GET" && segments.length === 1 && segments[0] === "providers") {
      sendJson(response, 200, { providers: await this.controller.listProviders() });
      return;
    }

    if (request.method === "POST" && segments.length === 1 && segments[0] === "providers") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["id", "kind", "name", "enabled", "base_url", "api_key", "api_key_env"]);
      sendJson(response, 201, await this.controller.createProvider(body as BenchLocalAgentCreateProviderRequest));
      return;
    }

    if (segments[0] === "providers" && segments.length >= 2) {
      await this.routeProviderCommand(request, response, segments);
      return;
    }

    if (request.method === "GET" && segments.length === 1 && segments[0] === "models") {
      const { config } = await loadOrCreateConfig();
      sendJson(response, 200, { models: config.models });
      return;
    }

    if (request.method === "POST" && segments.length === 1 && segments[0] === "models") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["id", "provider", "model", "label", "group", "enabled"]);
      sendJson(response, 201, await this.controller.createModel(body as BenchLocalAgentCreateModelRequest));
      return;
    }

    if (request.method === "GET" && segments.length === 2 && segments[0] === "models" && segments[1] === "availability") {
      const { config } = await loadOrCreateConfig();
      sendJson(response, 200, { availability: await this.controller.checkModelAvailability({ config }) });
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[0] === "models" && segments[1] === "availability" && segments[2] === "refresh") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["modelIds"]);
      const input = body as BenchLocalAgentAvailabilityRefreshRequest;
      const { config } = await loadOrCreateConfig();
      sendJson(response, 200, {
        availability: await this.controller.checkModelAvailability({
          config,
          modelIds: Array.isArray(input.modelIds) ? input.modelIds.filter((modelId): modelId is string => typeof modelId === "string") : undefined
        })
      });
      return;
    }

    if (segments[0] === "models" && segments.length >= 2) {
      await this.routeModelCommand(request, response, segments);
      return;
    }

    if (request.method === "GET" && segments.length === 2 && segments[0] === "runs" && segments[1] === "active") {
      sendJson(response, 200, { activeRuns: await this.controller.listActiveRuns() });
      return;
    }

    if (request.method === "GET" && segments.length === 1 && segments[0] === "verifiers") {
      sendJson(response, 200, { verifiers: await this.controller.listVerifiers() });
      return;
    }

    if (segments[0] === "benchpacks" && segments.length >= 3 && segments[2] === "history") {
      await this.routeHistory(request, response, segments);
      return;
    }

    if (segments[0] === "workspaces" && segments.length === 3 && segments[2] === "tabs" && request.method === "POST") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["benchPackId", "title", "modelSelections"]);
      sendJson(response, 201, await this.controller.createWorkspaceTab(segments[1], body as BenchLocalAgentCreateTabRequest));
      return;
    }

    if (segments[0] === "tabs" && segments.length >= 2) {
      await this.routeTabCommand(request, response, segments);
      return;
    }

    throw new HttpError(404, "Unknown endpoint.");
  }

  private async routeProviderCommand(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const providerId = segments[1];

    if (request.method === "GET" && segments.length === 2) {
      const providers = await this.controller.listProviders();
      const provider = providers[providerId];

      if (!provider) {
        throw new HttpError(404, `Provider "${providerId}" was not found.`);
      }

      sendJson(response, 200, { providerId, provider });
      return;
    }

    if (request.method === "PATCH" && segments.length === 2) {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["kind", "name", "enabled", "base_url", "api_key", "api_key_env"]);
      sendJson(response, 200, await this.controller.updateProvider(providerId, body as BenchLocalAgentPatchProviderRequest));
      return;
    }

    if (request.method === "DELETE" && segments.length === 2) {
      sendJson(response, 200, await this.controller.deleteProvider(providerId));
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "duplicate") {
      sendJson(response, 201, await this.controller.duplicateProvider(providerId));
      return;
    }

    if (request.method === "GET" && segments.length === 4 && segments[2] === "models" && segments[3] === "discover") {
      sendJson(response, 200, { models: await this.controller.discoverProviderModelsById(providerId) });
      return;
    }

    throw new HttpError(404, "Unknown endpoint.");
  }

  private async routeModelCommand(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const modelId = segments[1];

    if (request.method === "GET" && segments.length === 2) {
      const { config } = await loadOrCreateConfig();
      const model = config.models.find((candidate) => candidate.id === modelId);

      if (!model) {
        throw new HttpError(404, `Model "${modelId}" was not found.`);
      }

      sendJson(response, 200, { model });
      return;
    }

    if (request.method === "PATCH" && segments.length === 2) {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["id", "provider", "model", "label", "group", "enabled"]);
      sendJson(response, 200, await this.controller.updateModel(modelId, body as BenchLocalAgentPatchModelRequest));
      return;
    }

    if (request.method === "DELETE" && segments.length === 2) {
      sendJson(response, 200, await this.controller.deleteModel(modelId));
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "duplicate") {
      sendJson(response, 201, await this.controller.duplicateModel(modelId));
      return;
    }

    throw new HttpError(404, "Unknown endpoint.");
  }

  private async routeHistory(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const benchPackId = segments[1];

    if (request.method === "GET" && segments.length === 3) {
      sendJson(response, 200, { history: await this.controller.listRunHistory(benchPackId) });
      return;
    }

    if (request.method === "GET" && segments.length === 4) {
      sendJson(response, 200, { run: await this.controller.loadRunHistory(benchPackId, segments[3]) });
      return;
    }

    throw new HttpError(404, "Unknown endpoint.");
  }

  private async routeTabCommand(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const tabId = segments[1];

    if (request.method === "PATCH" && segments.length === 2) {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["title", "focusedScenarioId", "modelSelections", "samplingOverrides", "executionMode", "runsPerTest"]);
      sendJson(response, 200, await this.controller.patchTab(tabId, body as BenchLocalAgentPatchTabRequest));
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "select-benchpack") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["benchPackId", "title"]);
      const input = body as BenchLocalAgentSelectBenchPackRequest;
      sendJson(response, 200, await this.controller.selectTabBenchPack(tabId, input.benchPackId, input.title));
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "select-models") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["modelIds", "selections"]);
      sendJson(response, 200, await this.controller.selectTabModels(tabId, body as BenchLocalAgentSelectModelsRequest));
      return;
    }

    if (request.method === "POST" && segments.length === 5 && segments[2] === "models" && segments[3] === "availability" && segments[4] === "refresh") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["modelIds"]);
      sendJson(response, 200, { availability: await this.refreshTabModelAvailability(tabId, body as BenchLocalAgentAvailabilityRefreshRequest) });
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "sampling") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["samplingOverrides"]);
      const input = body as BenchLocalAgentSamplingRequest;
      sendJson(response, 200, await this.controller.patchTab(tabId, { samplingOverrides: input.samplingOverrides }));
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "execution-mode") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["executionMode", "runsPerTest"]);
      const input = body as BenchLocalAgentExecutionModeRequest;
      sendJson(response, 200, await this.controller.patchTab(tabId, {
        executionMode: input.executionMode,
        runsPerTest: input.runsPerTest
      }));
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "runs-per-test") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["runsPerTest"]);
      const input = body as BenchLocalAgentRunsPerTestRequest;
      sendJson(response, 200, await this.controller.patchTab(tabId, { runsPerTest: input.runsPerTest }));
      return;
    }

    if (request.method === "POST" && segments.length === 3 && segments[2] === "runs") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["benchPackId", "modelIds", "executionMode", "runsPerTest", "generation"]);
      await this.startRun(tabId, body as BenchLocalAgentRunRequest);
      sendJson(response, 202, { accepted: true, tabId });
      return;
    }

    if (request.method === "POST" && segments.length === 4 && segments[2] === "runs" && segments[3] === "stop") {
      sendJson(response, 200, await this.controller.stopRun(tabId));
      return;
    }

    if (request.method === "POST" && segments.length === 5 && segments[2] === "runs" && segments[4] === "resume") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["executionMode", "runsPerTest", "generation"]);
      await this.resumeRun(tabId, segments[3], body as BenchLocalAgentResumeRunRequest);
      sendJson(response, 202, { accepted: true, tabId, runId: segments[3] });
      return;
    }

    if (request.method === "POST" && segments.length === 5 && segments[2] === "runs" && segments[4] === "retry-scenario") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["scenarioId", "modelId", "runsPerTest", "generation"]);
      await this.retryScenario(tabId, segments[3], body as BenchLocalAgentRetryScenarioRequest);
      sendJson(response, 202, { accepted: true, tabId, runId: segments[3] });
      return;
    }

    if (request.method === "POST" && segments.length === 5 && segments[2] === "runs" && segments[4] === "retry-provider-errors") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["runsPerTest", "generation"]);
      const result = await this.retryBatch(tabId, segments[3], "provider_errors", body as BenchLocalAgentRetryBatchRequest);
      sendJson(response, result.accepted ? 202 : 200, result);
      return;
    }

    if (request.method === "POST" && segments.length === 5 && segments[2] === "runs" && segments[4] === "retry-failed-results") {
      const body = await readJsonRequest(request);
      assertOnlyKeys(body, ["runsPerTest", "generation"]);
      const result = await this.retryBatch(tabId, segments[3], "failed_results", body as BenchLocalAgentRetryBatchRequest);
      sendJson(response, result.accepted ? 202 : 200, result);
      return;
    }

    throw new HttpError(404, "Unknown endpoint.");
  }

  private async refreshTabModelAvailability(tabId: string, request: BenchLocalAgentAvailabilityRefreshRequest) {
    const { tab } = await this.loadRequiredTab(tabId);
    const modelIds = Array.isArray(request.modelIds) && request.modelIds.length > 0
      ? request.modelIds.filter((modelId): modelId is string => typeof modelId === "string")
      : tab.modelSelections.map((selection) => selection.modelId);
    const { config } = await loadOrCreateConfig();

    return this.controller.checkModelAvailability({
      config,
      modelIds
    });
  }

  private async startRun(tabId: string, request: BenchLocalAgentRunRequest): Promise<void> {
    const resolved = await this.resolveTabRun(tabId, request);

    void this.controller.runBenchPack(resolved).then(async (summary) => {
      await this.controller.setTabLoadedRun(tabId, summary.runId);
    }).catch((error) => {
      console.error("[benchlocal] agent-started run failed", error);
    });
  }

  private async resumeRun(tabId: string, runId: string, request: BenchLocalAgentResumeRunRequest): Promise<void> {
    const resolved = await this.resolveTabRun(tabId, request);

    void this.controller.resumeRun({
      ...resolved,
      runId
    }).then(async (summary) => {
      await this.controller.setTabLoadedRun(tabId, summary.runId);
    }).catch((error) => {
      console.error("[benchlocal] agent-started resume failed", error);
    });
  }

  private async retryScenario(tabId: string, runId: string, request: BenchLocalAgentRetryScenarioRequest): Promise<void> {
    const { tab } = await this.loadRequiredTab(tabId);
    const benchPackId = tab.benchPackId;

    if (!benchPackId) {
      throw new HttpError(400, `Tab "${tabId}" does not have a Bench Pack selected.`);
    }

    const scenarioId = normalizeString(request.scenarioId, "scenarioId");
    const modelId = normalizeString(request.modelId, "modelId");

    void this.controller.retryScenario({
      tabId,
      benchPackId,
      runId,
      scenarioId,
      modelId,
      runsPerTest: request.runsPerTest,
      generation: request.generation
    }).then(async (summary) => {
      await this.controller.setTabLoadedRun(tabId, summary.runId);
    }).catch((error) => {
      console.error("[benchlocal] agent-started retry failed", error);
    });
  }

  private async retryBatch(
    tabId: string,
    runId: string,
    kind: RetryBatchKind,
    request: BenchLocalAgentRetryBatchRequest
  ): Promise<{ accepted: boolean; tabId: string; runId: string; kind: RetryBatchKind; cellCount: number; groupCount: number }> {
    const { tab } = await this.loadRequiredTab(tabId);

    if (!tab.benchPackId) {
      throw new HttpError(400, `Tab "${tabId}" does not have a Bench Pack selected.`);
    }

    const plan = await this.controller.createRetryBatchPlan({
      tabId,
      benchPackId: tab.benchPackId,
      runId,
      kind,
      executionMode: tab.executionMode
    });

    if (plan.cells.length === 0) {
      return {
        accepted: false,
        tabId,
        runId,
        kind,
        cellCount: 0,
        groupCount: 0
      };
    }

    void this.controller.executeRetryBatch(plan, {
      runsPerTest: request.runsPerTest ?? tab.runsPerTest,
      generation: request.generation ?? tab.samplingOverrides
    }).then(async (result) => {
      await this.controller.setTabLoadedRun(tabId, result.run.runId);
    }).catch((error) => {
      console.error("[benchlocal] agent-started retry batch failed", error);
    });

    return {
      accepted: true,
      tabId,
      runId,
      kind,
      cellCount: plan.cells.length,
      groupCount: plan.groups.length
    };
  }

  private async resolveTabRun(tabId: string, request: BenchLocalAgentRunRequest | BenchLocalAgentResumeRunRequest) {
    const { tab } = await this.loadRequiredTab(tabId);
    const benchPackId = "benchPackId" in request && request.benchPackId ? request.benchPackId : tab.benchPackId;

    if (!benchPackId) {
      throw new HttpError(400, `Tab "${tabId}" does not have a Bench Pack selected.`);
    }

    return {
      tabId,
      benchPackId,
      modelIds: "modelIds" in request && request.modelIds ? request.modelIds : tab.modelSelections.map((selection) => selection.modelId),
      executionMode: request.executionMode ?? tab.executionMode,
      runsPerTest: request.runsPerTest ?? tab.runsPerTest,
      generation: request.generation ?? tab.samplingOverrides
    };
  }

  private async loadRequiredTab(tabId: string): Promise<{ tab: BenchLocalWorkspaceTab }> {
    const { state } = await this.controller.loadWorkspaceState();
    const tab = state.tabs[tabId];

    if (!tab) {
      throw new HttpError(404, `Tab "${tabId}" was not found.`);
    }

    return { tab };
  }
}

export const agentServer = new BenchLocalAgentServer(benchLocalController);
