import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type {
  BenchLocalAgentCreateModelRequest,
  BenchLocalAgentCreateProviderRequest,
  BenchLocalAgentEvent,
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
  BenchLocalExecutionMode,
  BenchLocalWorkspaceTab,
  GenerationRequest
} from "@core";
import { loadOrCreateConfig } from "@core";
import type { BenchLocalController } from "./controller";

type RetryBatchKind = "provider_errors" | "failed_results";

type BenchLocalMcpOptions = {
  getAgentGuide: () => string;
  getOpenApiDocument: () => unknown;
  getRecentEvents: () => BenchLocalAgentEvent[];
};

const executionModeSchema = z.enum([
  "serial",
  "serial_by_model",
  "parallel_by_model",
  "parallel_by_test_case",
  "full_parallel"
]);

const providerKindSchema = z.enum([
  "openrouter",
  "huggingface",
  "ollama",
  "llamacpp",
  "mlx",
  "lmstudio",
  "pico",
  "openai_compatible"
]);

const generationSchema = z.object({
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  min_p: z.number().optional(),
  repetition_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  request_timeout_seconds: z.number().optional()
});

const modelSelectionSchema = z.object({
  modelId: z.string(),
  alias: z.string().optional()
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function jsonToolResult(payload: unknown): CallToolResult {
  return {
    structuredContent: isRecord(payload) ? payload : { result: payload },
    content: [
      {
        type: "text",
        text: stringifyJson(payload)
      }
    ]
  };
}

function jsonResource(uri: string, payload: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: stringifyJson(payload)
      }
    ]
  };
}

function textResource(uri: string, mimeType: string, text: string) {
  return {
    contents: [
      {
        uri,
        mimeType,
        text
      }
    ]
  };
}

function normalizeString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }

  return value.trim();
}

async function loadRequiredTab(controller: BenchLocalController, tabId: string): Promise<{ tab: BenchLocalWorkspaceTab }> {
  const { state } = await controller.loadWorkspaceState();
  const tab = state.tabs[tabId];

  if (!tab) {
    throw new Error(`Tab "${tabId}" was not found.`);
  }

  return { tab };
}

async function resolveTabRun(
  controller: BenchLocalController,
  tabId: string,
  request: BenchLocalAgentRunRequest | BenchLocalAgentResumeRunRequest
) {
  const { tab } = await loadRequiredTab(controller, tabId);
  const benchPackId = "benchPackId" in request && request.benchPackId ? request.benchPackId : tab.benchPackId;

  if (!benchPackId) {
    throw new Error(`Tab "${tabId}" does not have a Bench Pack selected.`);
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

async function refreshTabModelAvailability(
  controller: BenchLocalController,
  tabId: string,
  request: BenchLocalAgentAvailabilityRefreshRequest
) {
  const { tab } = await loadRequiredTab(controller, tabId);
  const modelIds = Array.isArray(request.modelIds) && request.modelIds.length > 0
    ? request.modelIds.filter((modelId): modelId is string => typeof modelId === "string")
    : tab.modelSelections.map((selection) => selection.modelId);
  const { config } = await loadOrCreateConfig();

  return controller.checkModelAvailability({
    config,
    modelIds
  });
}

async function startRun(controller: BenchLocalController, tabId: string, request: BenchLocalAgentRunRequest): Promise<void> {
  const resolved = await resolveTabRun(controller, tabId, request);

  void controller.runBenchPack(resolved).then(async (summary) => {
    await controller.setTabLoadedRun(tabId, summary.runId);
  }).catch((error) => {
    console.error("[benchlocal] mcp-started run failed", error);
  });
}

async function resumeRun(
  controller: BenchLocalController,
  tabId: string,
  runId: string,
  request: BenchLocalAgentResumeRunRequest
): Promise<void> {
  const resolved = await resolveTabRun(controller, tabId, request);

  void controller.resumeRun({
    ...resolved,
    runId
  }).then(async (summary) => {
    await controller.setTabLoadedRun(tabId, summary.runId);
  }).catch((error) => {
    console.error("[benchlocal] mcp-started resume failed", error);
  });
}

async function retryScenario(
  controller: BenchLocalController,
  tabId: string,
  runId: string,
  request: BenchLocalAgentRetryScenarioRequest
): Promise<void> {
  const { tab } = await loadRequiredTab(controller, tabId);
  const benchPackId = tab.benchPackId;

  if (!benchPackId) {
    throw new Error(`Tab "${tabId}" does not have a Bench Pack selected.`);
  }

  const scenarioId = normalizeString(request.scenarioId, "scenarioId");
  const modelId = normalizeString(request.modelId, "modelId");

  void controller.retryScenario({
    tabId,
    benchPackId,
    runId,
    scenarioId,
    modelId,
    runsPerTest: request.runsPerTest,
    generation: request.generation
  }).then(async (summary) => {
    await controller.setTabLoadedRun(tabId, summary.runId);
  }).catch((error) => {
    console.error("[benchlocal] mcp-started retry failed", error);
  });
}

async function retryBatch(
  controller: BenchLocalController,
  tabId: string,
  runId: string,
  kind: RetryBatchKind,
  request: BenchLocalAgentRetryBatchRequest
): Promise<{ accepted: boolean; tabId: string; runId: string; kind: RetryBatchKind; cellCount: number; groupCount: number }> {
  const { tab } = await loadRequiredTab(controller, tabId);

  if (!tab.benchPackId) {
    throw new Error(`Tab "${tabId}" does not have a Bench Pack selected.`);
  }

  const plan = await controller.createRetryBatchPlan({
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

  void controller.executeRetryBatch(plan, {
    runsPerTest: request.runsPerTest ?? tab.runsPerTest,
    generation: request.generation ?? tab.samplingOverrides
  }).then(async (result) => {
    await controller.setTabLoadedRun(tabId, result.run.runId);
  }).catch((error) => {
    console.error("[benchlocal] mcp-started retry batch failed", error);
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

function createBenchLocalMcpServer(controller: BenchLocalController, options: BenchLocalMcpOptions): McpServer {
  const server = new McpServer({
    name: "benchlocal",
    title: "BenchLocal",
    version: "1.0.0",
    websiteUrl: "https://github.com/stevibe/BenchLocal"
  });

  server.registerResource(
    "benchlocal-agent-guide",
    "benchlocal://agent/guide",
    {
      title: "BenchLocal Agent Guide",
      description: "Agent-readable BenchLocal control instructions.",
      mimeType: "text/markdown"
    },
    async (uri) => textResource(uri.href, "text/markdown", options.getAgentGuide())
  );

  server.registerResource(
    "benchlocal-openapi",
    "benchlocal://agent/openapi",
    {
      title: "BenchLocal OpenAPI Document",
      description: "OpenAPI description for the HTTP Agent API.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, options.getOpenApiDocument())
  );

  server.registerResource(
    "benchlocal-config",
    "benchlocal://state/config",
    {
      title: "BenchLocal Config",
      description: "Redacted BenchLocal configuration.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { config: await controller.getSafeConfig() })
  );

  server.registerResource(
    "benchlocal-workspaces",
    "benchlocal://state/workspaces",
    {
      title: "BenchLocal Workspaces",
      description: "Workspace and tab state.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, await controller.loadWorkspaceState())
  );

  server.registerResource(
    "benchlocal-benchpacks",
    "benchlocal://state/benchpacks",
    {
      title: "BenchLocal Bench Packs",
      description: "Installed Bench Packs and scenario metadata.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { benchPacks: await controller.listBenchPacks() })
  );

  server.registerResource(
    "benchlocal-providers",
    "benchlocal://state/providers",
    {
      title: "BenchLocal Providers",
      description: "Configured providers with secrets redacted.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { providers: await controller.listProviders() })
  );

  server.registerResource(
    "benchlocal-models",
    "benchlocal://state/models",
    {
      title: "BenchLocal Models",
      description: "Configured benchmark models.",
      mimeType: "application/json"
    },
    async (uri) => {
      const { config } = await loadOrCreateConfig();
      return jsonResource(uri.href, { models: config.models });
    }
  );

  server.registerResource(
    "benchlocal-active-runs",
    "benchlocal://state/runs/active",
    {
      title: "BenchLocal Active Runs",
      description: "Currently active benchmark runs.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { activeRuns: await controller.listActiveRuns() })
  );

  server.registerResource(
    "benchlocal-recent-events",
    "benchlocal://state/events/recent",
    {
      title: "BenchLocal Recent Events",
      description: "Recent Agent API events for progress polling.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri.href, { events: options.getRecentEvents() })
  );

  server.registerPrompt(
    "benchlocal-run-benchpack",
    {
      title: "Run a BenchLocal Bench Pack",
      description: "Recommended workflow for selecting a Bench Pack, selecting models, and starting a run.",
      argsSchema: {
        benchPackId: z.string().describe("Bench Pack id, for example toolcall-15."),
        modelIds: z.string().describe("Comma-separated model ids to select for the run."),
        workspaceId: z.string().optional().describe("Workspace id. If omitted, inspect benchlocal://state/workspaces first.")
      }
    },
    async ({ benchPackId, modelIds, workspaceId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Use BenchLocal MCP tools to run a benchmark.",
              workspaceId ? `Workspace: ${workspaceId}` : "First read benchlocal://state/workspaces and choose the active workspace.",
              `Bench Pack: ${benchPackId}`,
              `Models: ${modelIds}`,
              "Create or update a tab, select the Bench Pack, select the models, refresh availability, then call benchlocal_start_run.",
              "Poll benchlocal_get_recent_events or read benchlocal://state/events/recent while the UI shows progress in real time."
            ].join("\n")
          }
        }
      ]
    })
  );

  server.registerTool(
    "benchlocal_get_health",
    {
      title: "Get BenchLocal Health",
      description: "Return BenchLocal version metadata.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult({ ok: true, ...(await controller.getRuntimeCompatibility()) })
  );

  server.registerTool(
    "benchlocal_get_config",
    {
      title: "Get Redacted Config",
      description: "Return BenchLocal config with provider secrets redacted.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult({ config: await controller.getSafeConfig() })
  );

  server.registerTool(
    "benchlocal_list_workspaces",
    {
      title: "List Workspaces",
      description: "Return workspace and tab state.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult(await controller.loadWorkspaceState())
  );

  server.registerTool(
    "benchlocal_list_benchpacks",
    {
      title: "List Bench Packs",
      description: "Return installed Bench Packs and scenario metadata.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult({ benchPacks: await controller.listBenchPacks() })
  );

  server.registerTool(
    "benchlocal_list_benchpack_registry",
    {
      title: "List Bench Pack Registry",
      description: "Return registry entries for installable Bench Packs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult({ registry: await controller.loadBenchPackRegistry() })
  );

  server.registerTool(
    "benchlocal_list_providers",
    {
      title: "List Providers",
      description: "Return configured providers with secrets redacted.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult({ providers: await controller.listProviders() })
  );

  server.registerTool(
    "benchlocal_get_provider",
    {
      title: "Get Provider",
      description: "Return one configured provider with secrets redacted.",
      inputSchema: {
        providerId: z.string()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ providerId }) => {
      const providers = await controller.listProviders();
      const provider = providers[providerId];

      if (!provider) {
        throw new Error(`Provider "${providerId}" was not found.`);
      }

      return jsonToolResult({ providerId, provider });
    }
  );

  server.registerTool(
    "benchlocal_create_provider",
    {
      title: "Create Provider",
      description: "Create one provider record.",
      inputSchema: {
        id: z.string().optional(),
        kind: providerKindSchema,
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        base_url: z.string(),
        api_key: z.string().optional(),
        api_key_env: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) => jsonToolResult(await controller.createProvider(input as BenchLocalAgentCreateProviderRequest))
  );

  server.registerTool(
    "benchlocal_update_provider",
    {
      title: "Update Provider",
      description: "Patch one provider record.",
      inputSchema: {
        providerId: z.string(),
        kind: providerKindSchema.optional(),
        name: z.string().optional(),
        enabled: z.boolean().optional(),
        base_url: z.string().optional(),
        api_key: z.string().nullable().optional(),
        api_key_env: z.string().nullable().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ providerId, ...patch }) => jsonToolResult(
      await controller.updateProvider(providerId, patch as BenchLocalAgentPatchProviderRequest)
    )
  );

  server.registerTool(
    "benchlocal_delete_provider",
    {
      title: "Delete Provider",
      description: "Delete a provider and its linked models.",
      inputSchema: {
        providerId: z.string()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ providerId }) => jsonToolResult(await controller.deleteProvider(providerId))
  );

  server.registerTool(
    "benchlocal_duplicate_provider",
    {
      title: "Duplicate Provider",
      description: "Duplicate one provider record without duplicating linked models.",
      inputSchema: {
        providerId: z.string()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ providerId }) => jsonToolResult(await controller.duplicateProvider(providerId))
  );

  server.registerTool(
    "benchlocal_discover_provider_models",
    {
      title: "Discover Provider Models",
      description: "Discover provider models when the provider supports model browsing.",
      inputSchema: {
        providerId: z.string()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ providerId }) => jsonToolResult({ models: await controller.discoverProviderModelsById(providerId) })
  );

  server.registerTool(
    "benchlocal_list_models",
    {
      title: "List Models",
      description: "Return configured benchmark models.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const { config } = await loadOrCreateConfig();
      return jsonToolResult({ models: config.models });
    }
  );

  server.registerTool(
    "benchlocal_get_model",
    {
      title: "Get Model",
      description: "Return one configured benchmark model.",
      inputSchema: {
        modelId: z.string()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ modelId }) => {
      const { config } = await loadOrCreateConfig();
      const model = config.models.find((candidate) => candidate.id === modelId);

      if (!model) {
        throw new Error(`Model "${modelId}" was not found.`);
      }

      return jsonToolResult({ model });
    }
  );

  server.registerTool(
    "benchlocal_create_model",
    {
      title: "Create Model",
      description: "Create one model record.",
      inputSchema: {
        id: z.string().optional(),
        provider: z.string(),
        model: z.string(),
        label: z.string().optional(),
        group: z.string().optional(),
        enabled: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) => jsonToolResult(await controller.createModel(input as BenchLocalAgentCreateModelRequest))
  );

  server.registerTool(
    "benchlocal_update_model",
    {
      title: "Update Model",
      description: "Patch one model record.",
      inputSchema: {
        modelId: z.string(),
        id: z.string().optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        label: z.string().optional(),
        group: z.string().optional(),
        enabled: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ modelId, ...patch }) => jsonToolResult(
      await controller.updateModel(modelId, patch as BenchLocalAgentPatchModelRequest)
    )
  );

  server.registerTool(
    "benchlocal_delete_model",
    {
      title: "Delete Model",
      description: "Delete one model record and remove it from tab selections.",
      inputSchema: {
        modelId: z.string()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ modelId }) => jsonToolResult(await controller.deleteModel(modelId))
  );

  server.registerTool(
    "benchlocal_duplicate_model",
    {
      title: "Duplicate Model",
      description: "Duplicate one model record.",
      inputSchema: {
        modelId: z.string()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ modelId }) => jsonToolResult(await controller.duplicateModel(modelId))
  );

  server.registerTool(
    "benchlocal_check_model_availability",
    {
      title: "Check Model Availability",
      description: "Check availability for all models or selected model ids.",
      inputSchema: {
        modelIds: z.array(z.string()).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ modelIds }) => {
      const { config } = await loadOrCreateConfig();
      return jsonToolResult({
        availability: await controller.checkModelAvailability({ config, modelIds })
      });
    }
  );

  server.registerTool(
    "benchlocal_refresh_model_availability",
    {
      title: "Refresh Model Availability",
      description: "Refresh model availability globally or for a tab's selected models.",
      inputSchema: {
        tabId: z.string().optional(),
        modelIds: z.array(z.string()).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ tabId, modelIds }) => {
      if (tabId) {
        return jsonToolResult({
          availability: await refreshTabModelAvailability(controller, tabId, { modelIds })
        });
      }

      const { config } = await loadOrCreateConfig();
      return jsonToolResult({
        availability: await controller.checkModelAvailability({ config, modelIds })
      });
    }
  );

  server.registerTool(
    "benchlocal_create_tab",
    {
      title: "Create Tab",
      description: "Create a workspace tab and optionally select a Bench Pack and models.",
      inputSchema: {
        workspaceId: z.string(),
        benchPackId: z.string().nullable().optional(),
        title: z.string().optional(),
        modelSelections: z.array(modelSelectionSchema).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ workspaceId, ...input }) => jsonToolResult(await controller.createWorkspaceTab(workspaceId, input))
  );

  server.registerTool(
    "benchlocal_patch_tab",
    {
      title: "Patch Tab",
      description: "Patch tab title, focused scenario, selected models, sampling, execution mode, or runs per test.",
      inputSchema: {
        tabId: z.string(),
        title: z.string().optional(),
        focusedScenarioId: z.string().nullable().optional(),
        modelSelections: z.array(modelSelectionSchema).optional(),
        samplingOverrides: generationSchema.optional(),
        executionMode: executionModeSchema.optional(),
        runsPerTest: z.number().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ tabId, ...patch }) => jsonToolResult(await controller.patchTab(tabId, patch as BenchLocalAgentPatchTabRequest))
  );

  server.registerTool(
    "benchlocal_select_benchpack",
    {
      title: "Select Bench Pack",
      description: "Select a Bench Pack for a tab.",
      inputSchema: {
        tabId: z.string(),
        benchPackId: z.string().nullable(),
        title: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ tabId, ...input }) => {
      const request = input as BenchLocalAgentSelectBenchPackRequest;
      return jsonToolResult(await controller.selectTabBenchPack(tabId, request.benchPackId, request.title));
    }
  );

  server.registerTool(
    "benchlocal_select_models",
    {
      title: "Select Models",
      description: "Select models for a tab.",
      inputSchema: {
        tabId: z.string(),
        modelIds: z.array(z.string()).optional(),
        selections: z.array(modelSelectionSchema).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ tabId, ...input }) => jsonToolResult(await controller.selectTabModels(tabId, input as BenchLocalAgentSelectModelsRequest))
  );

  server.registerTool(
    "benchlocal_set_sampling",
    {
      title: "Set Sampling",
      description: "Set tab sampling overrides.",
      inputSchema: {
        tabId: z.string(),
        samplingOverrides: generationSchema
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ tabId, samplingOverrides }) => {
      const request: BenchLocalAgentSamplingRequest = {
        samplingOverrides: samplingOverrides as GenerationRequest
      };
      return jsonToolResult(await controller.patchTab(tabId, { samplingOverrides: request.samplingOverrides }));
    }
  );

  server.registerTool(
    "benchlocal_set_execution_mode",
    {
      title: "Set Execution Mode",
      description: "Set tab execution mode and optionally runs per test.",
      inputSchema: {
        tabId: z.string(),
        executionMode: executionModeSchema,
        runsPerTest: z.number().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ tabId, executionMode, runsPerTest }) => {
      const request: BenchLocalAgentExecutionModeRequest = {
        executionMode: executionMode as BenchLocalExecutionMode,
        runsPerTest
      };
      return jsonToolResult(await controller.patchTab(tabId, request));
    }
  );

  server.registerTool(
    "benchlocal_set_runs_per_test",
    {
      title: "Set Runs Per Test",
      description: "Set tab runs-per-test count.",
      inputSchema: {
        tabId: z.string(),
        runsPerTest: z.number()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ tabId, runsPerTest }) => {
      const request: BenchLocalAgentRunsPerTestRequest = { runsPerTest };
      return jsonToolResult(await controller.patchTab(tabId, request));
    }
  );

  server.registerTool(
    "benchlocal_start_run",
    {
      title: "Start Run",
      description: "Start a benchmark run for a tab. Returns immediately; poll recent events for progress.",
      inputSchema: {
        tabId: z.string(),
        benchPackId: z.string().optional(),
        modelIds: z.array(z.string()).optional(),
        executionMode: executionModeSchema.optional(),
        runsPerTest: z.number().optional(),
        generation: generationSchema.optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ tabId, ...request }) => {
      await startRun(controller, tabId, request as BenchLocalAgentRunRequest);
      return jsonToolResult({ accepted: true, tabId });
    }
  );

  server.registerTool(
    "benchlocal_resume_run",
    {
      title: "Resume Run",
      description: "Resume a historical benchmark run. Returns immediately; poll recent events for progress.",
      inputSchema: {
        tabId: z.string(),
        runId: z.string(),
        executionMode: executionModeSchema.optional(),
        runsPerTest: z.number().optional(),
        generation: generationSchema.optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ tabId, runId, ...request }) => {
      await resumeRun(controller, tabId, runId, request as BenchLocalAgentResumeRunRequest);
      return jsonToolResult({ accepted: true, tabId, runId });
    }
  );

  server.registerTool(
    "benchlocal_retry_scenario",
    {
      title: "Retry Scenario",
      description: "Retry one scenario/model cell from a saved run.",
      inputSchema: {
        tabId: z.string(),
        runId: z.string(),
        scenarioId: z.string(),
        modelId: z.string(),
        runsPerTest: z.number().optional(),
        generation: generationSchema.optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ tabId, runId, ...request }) => {
      await retryScenario(controller, tabId, runId, request as BenchLocalAgentRetryScenarioRequest);
      return jsonToolResult({ accepted: true, tabId, runId });
    }
  );

  server.registerTool(
    "benchlocal_retry_provider_errors",
    {
      title: "Retry Provider Errors",
      description: "Retry provider-error cells from a saved run.",
      inputSchema: {
        tabId: z.string(),
        runId: z.string(),
        runsPerTest: z.number().optional(),
        generation: generationSchema.optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ tabId, runId, ...request }) => jsonToolResult(
      await retryBatch(controller, tabId, runId, "provider_errors", request as BenchLocalAgentRetryBatchRequest)
    )
  );

  server.registerTool(
    "benchlocal_retry_failed_results",
    {
      title: "Retry Failed Results",
      description: "Retry non-provider failed cells from a saved run.",
      inputSchema: {
        tabId: z.string(),
        runId: z.string(),
        runsPerTest: z.number().optional(),
        generation: generationSchema.optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: true }
    },
    async ({ tabId, runId, ...request }) => jsonToolResult(
      await retryBatch(controller, tabId, runId, "failed_results", request as BenchLocalAgentRetryBatchRequest)
    )
  );

  server.registerTool(
    "benchlocal_stop_run",
    {
      title: "Stop Run",
      description: "Stop the active run for a tab.",
      inputSchema: {
        tabId: z.string()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ tabId }) => jsonToolResult(await controller.stopRun(tabId))
  );

  server.registerTool(
    "benchlocal_list_active_runs",
    {
      title: "List Active Runs",
      description: "Return active benchmark runs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult({ activeRuns: await controller.listActiveRuns() })
  );

  server.registerTool(
    "benchlocal_list_run_history",
    {
      title: "List Run History",
      description: "Return run history for a Bench Pack.",
      inputSchema: {
        benchPackId: z.string()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ benchPackId }) => jsonToolResult({ history: await controller.listRunHistory(benchPackId) })
  );

  server.registerTool(
    "benchlocal_get_run_summary",
    {
      title: "Get Run Summary",
      description: "Return a saved run summary.",
      inputSchema: {
        benchPackId: z.string(),
        runId: z.string()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ benchPackId, runId }) => jsonToolResult({ run: await controller.loadRunHistory(benchPackId, runId) })
  );

  server.registerTool(
    "benchlocal_list_verifiers",
    {
      title: "List Verifiers",
      description: "Return verifier runtime status.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => jsonToolResult({ verifiers: await controller.listVerifiers() })
  );

  server.registerTool(
    "benchlocal_get_recent_events",
    {
      title: "Get Recent Events",
      description: "Return recent Agent API events for polling run progress.",
      inputSchema: {
        limit: z.number().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ limit }) => {
      const events = options.getRecentEvents();
      const count = Number.isFinite(limit) && limit && limit > 0 ? Math.floor(limit) : events.length;
      return jsonToolResult({ events: events.slice(-count) });
    }
  );

  return server;
}

function sendMcpMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
}

export async function handleBenchLocalMcpRequest(
  controller: BenchLocalController,
  options: BenchLocalMcpOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method === "GET" || request.method === "DELETE") {
    sendMcpMethodNotAllowed(response);
    return;
  }

  if (request.method !== "POST") {
    sendMcpMethodNotAllowed(response);
    return;
  }

  const server = createBenchLocalMcpServer(controller, options);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  let closed = false;

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    void transport.close();
    void server.close();
  };

  response.on("close", close);

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } finally {
    close();
  }
}
