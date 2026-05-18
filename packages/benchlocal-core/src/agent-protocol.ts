import type {
  BenchLocalConfig,
  BenchLocalAgentAccess,
  BenchLocalModelConfig,
  BenchLocalProviderKind
} from "./config.js";
import type {
  GenerationRequest,
  ModelAvailability,
  ProgressEvent
} from "./protocol.js";
import type {
  BenchLocalWorkspaceState,
  BenchLocalWorkspaceTab,
  BenchLocalWorkspaceTabModelSelection
} from "./workspaces.js";

export type BenchLocalAgentEventType =
  | "agent.state.updated"
  | "config.updated"
  | "workspace.updated"
  | "models.availability.updated"
  | "benchpack.run.started"
  | "benchpack.run.event"
  | "benchpack.run.finished"
  | "benchpack.run.error"
  | "verifier.event";

export type BenchLocalAgentEvent<TPayload = unknown> = {
  eventId: string;
  createdAt: string;
  type: BenchLocalAgentEventType;
  payload: TPayload;
};

export type BenchLocalAgentAccessState = {
  enabled: boolean;
  running: boolean;
  access: BenchLocalAgentAccess;
  host: "127.0.0.1" | "0.0.0.0";
  configuredPort?: number;
  port?: number;
  baseUrl?: string;
  token?: string;
  connectedClients: number;
  message?: string;
  startedAt?: string;
};

export type BenchLocalAgentSafeConfig = Omit<BenchLocalConfig, "providers"> & {
  providers: Record<
    string,
    Omit<BenchLocalConfig["providers"][string], "api_key"> & {
      has_api_key: boolean;
      has_api_key_env: boolean;
    }
  >;
};

export type BenchLocalAgentCreateTabRequest = {
  benchPackId?: string | null;
  title?: string;
  modelSelections?: BenchLocalWorkspaceTabModelSelection[];
};

export type BenchLocalAgentPatchTabRequest = Partial<
  Pick<BenchLocalWorkspaceTab, "title" | "focusedScenarioId" | "modelSelections" | "samplingOverrides" | "executionMode" | "runsPerTest">
>;

export type BenchLocalAgentSelectBenchPackRequest = {
  benchPackId: string | null;
  title?: string;
};

export type BenchLocalAgentSelectModelsRequest = {
  modelIds?: string[];
  selections?: BenchLocalWorkspaceTabModelSelection[];
};

export type BenchLocalAgentCreateProviderRequest = {
  id?: string;
  kind: BenchLocalProviderKind;
  name?: string;
  enabled?: boolean;
  base_url: string;
  api_key?: string;
  api_key_env?: string;
};

export type BenchLocalAgentPatchProviderRequest = {
  kind?: BenchLocalProviderKind;
  name?: string;
  enabled?: boolean;
  base_url?: string;
  api_key?: string | null;
  api_key_env?: string | null;
};

export type BenchLocalAgentCreateModelRequest = {
  id?: string;
  provider: string;
  model: string;
  label?: string;
  group?: string;
  enabled?: boolean;
};

export type BenchLocalAgentPatchModelRequest = {
  id?: string;
  provider?: string;
  model?: string;
  label?: string;
  group?: string;
  enabled?: boolean;
};

export type BenchLocalAgentSamplingRequest = {
  samplingOverrides: GenerationRequest;
};

export type BenchLocalAgentExecutionModeRequest = {
  executionMode: BenchLocalWorkspaceTab["executionMode"];
  runsPerTest?: number;
};

export type BenchLocalAgentRunsPerTestRequest = {
  runsPerTest: number;
};

export type BenchLocalAgentRunRequest = {
  benchPackId?: string;
  modelIds?: string[];
  executionMode?: BenchLocalWorkspaceTab["executionMode"];
  runsPerTest?: number;
  generation?: GenerationRequest;
};

export type BenchLocalAgentResumeRunRequest = {
  executionMode?: BenchLocalWorkspaceTab["executionMode"];
  runsPerTest?: number;
  generation?: GenerationRequest;
};

export type BenchLocalAgentRetryScenarioRequest = {
  scenarioId: string;
  modelId: string;
  runsPerTest?: number;
  generation?: GenerationRequest;
};

export type BenchLocalAgentRetryBatchRequest = {
  runsPerTest?: number;
  generation?: GenerationRequest;
};

export type BenchLocalAgentAvailabilityRefreshRequest = {
  modelIds?: string[];
};

export type BenchLocalAgentWorkspaceUpdatedPayload = {
  state: BenchLocalWorkspaceState;
};

export type BenchLocalAgentConfigUpdatedPayload = {
  config: BenchLocalAgentSafeConfig;
};

export type BenchLocalAgentModelAvailabilityPayload = {
  availability: ModelAvailability[];
};

export type BenchLocalAgentRunEventPayload = {
  tabId: string;
  benchPackId: string;
  event: ProgressEvent;
};

export type BenchLocalAgentModelListResponse = {
  models: BenchLocalModelConfig[];
};
