// 跑分結果匯出（llm-pk score.json 格式)。獨立檔案，與 App.tsx 解耦，
// 上游 main 更新 App.tsx 時不會動到這裡。
import type {
  BenchLocalModelConfig,
  BenchLocalProviderConfig,
  BenchPackRunSummary,
  ScenarioMeta,
  ScenarioResult
} from "@core";

export type ExportModel = BenchLocalModelConfig & { displayLabel?: string };

// 推理後端類型 → 友善名稱。openai_compatible 留空，因為背後可能是 vLLM / TGI / SGLang 等，需手動填寫。
const EXPORT_BACKEND_NAME_BY_KIND: Record<string, string> = {
  openrouter: "OpenRouter",
  huggingface: "Hugging Face",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  mlx: "MLX",
  lmstudio: "LM Studio",
  pico: "Pico",
  openai_compatible: ""
};

// 雲端 API 供應商：匯出時標記 deployment="cloud"（無本地硬體 / 量化）；其餘視為本地自架。
const EXPORT_CLOUD_PROVIDER_KINDS = new Set(["openrouter", "huggingface"]);

function getModelDisplayIdentifier(model: Pick<BenchLocalModelConfig, "id" | "model">): string {
  return model.model.trim() || model.id.split(":").slice(1).join(":").trim() || model.id;
}

// 由 id / 名稱關鍵字猜測廠牌(org),讓匯出直接帶出 logo 用的 org。猜不到回 ""(由使用者補)。
const EXPORT_ORG_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ["claude", "Anthropic"],
  ["gpt", "OpenAI"],
  ["openai", "OpenAI"],
  ["gemini", "Google"],
  ["gemma", "Google"],
  ["qwen", "Qwen"],
  ["llama", "Meta"],
  ["mixtral", "Mistral AI"],
  ["mistral", "Mistral AI"],
  ["phi", "Microsoft"],
  ["deepseek", "DeepSeek"],
  ["mellum", "JetBrains"],
  ["grok", "xAI"],
  ["command", "Cohere"]
];

function guessExportOrg(id: string, name: string): string {
  if (id.includes("/")) {
    return id.split("/")[0]; // HuggingFace 形式 org/model
  }
  const haystack = `${id} ${name}`.toLowerCase();
  for (const [keyword, org] of EXPORT_ORG_KEYWORDS) {
    if (haystack.includes(keyword)) {
      return org;
    }
  }
  return "";
}

function normalizeRunsPerTest(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

// 每題狀態編碼：pass=1(正常)、fail=0(錯誤)、partial=null(半對)、未執行/錯誤=-1。
export function encodeExportScenarioStatus(result: ScenarioResult | undefined): number | null {
  if (!result || result.errorType) {
    return -1;
  }
  switch (result.status) {
    case "pass":
      return 1;
    case "partial":
      return null;
    case "fail":
    default:
      return 0;
  }
}

// 產生 llm-pk score.json 格式：欄位固定不增減，BenchLocal 取得不到的資訊一律留白供手動補全。
export function buildResultExportJson({
  runSummary,
  model,
  providers,
  score,
  scenarios,
  appVersion
}: {
  runSummary: BenchPackRunSummary;
  model: ExportModel | undefined;
  providers: Record<string, BenchLocalProviderConfig>;
  score: BenchPackRunSummary["scores"][string];
  scenarios: ScenarioMeta[];
  appVersion?: string;
}) {
  const modelId = model?.id ?? "model";
  const fullId = model ? getModelDisplayIdentifier(model) : modelId;
  const displayName = model?.displayLabel ?? model?.label ?? fullId;
  const modelResults = runSummary.resultsByModel[modelId] ?? [];
  const resultByScenarioId = new Map(modelResults.map((result) => [result.scenarioId, result]));
  const orderedScenarioIds =
    scenarios.length > 0 ? scenarios.map((scenario) => scenario.id) : modelResults.map((result) => result.scenarioId);
  const providerKind = model ? providers[model.provider]?.kind : undefined;
  const isCloud = providerKind ? EXPORT_CLOUD_PROVIDER_KINDS.has(providerKind) : false;

  const results: Record<string, { status: number | null; time: number }> = {};
  for (const scenarioId of orderedScenarioIds) {
    const result = resultByScenarioId.get(scenarioId);
    results[scenarioId] = {
      status: encodeExportScenarioStatus(result),
      time: result?.timings?.durationMs ?? 0
    };
  }

  // 雲端方案沒有本地硬體與量化資訊（device 留空的情況）；本地方案輸出空白骨架供手動補全。
  return {
    BenchLocal: appVersion ?? "",
    results_upload: "", // 上傳跑分者的 GitHub 帳號，匯出後請手動填入
    BenchPack: {
      name: runSummary.benchPackName || runSummary.benchPackId,
      ver: runSummary.packVersion ?? ""
    },
    deployment: isCloud ? "cloud" : "local",
    model: {
      id: fullId, // 完整識別碼(建議 HF 形式 org/model，可自動帶出廠牌 logo)
      name: displayName, // 重點展示的乾淨名稱(來自 BenchLocal 顯示標籤)
      org: guessExportOrg(fullId, displayName), // 由 id 前綴或名稱關鍵字猜廠牌(可手動修正)
      access: "open", // open=開源權重 / closed=閉源(與 deployment 無關)，無法自動判斷請依實際修正
      family: { name: "", ver: "" },
      type: "", // MoE / Dense（請補上）
      thinking: false, // 是否具備 thinking / reasoning 模式（請依實際修正）
      size: { params: "", active: "" },
      ...(isCloud ? {} : { quantization: { format: "", level: "", method: "" } }),
      link: "" // 選填，格式 hugging_face:{user}:{repo}
    },
    backend: {
      name: (providerKind ? EXPORT_BACKEND_NAME_BY_KIND[providerKind] : "") ?? "",
      ver: ""
    },
    ...(isCloud ? {} : { hardware: { company: "", device: "", chip: "", os: "", driver: "" } }),
    score: {
      total: score.totalScore,
      categories: score.categories.map((category) => ({
        id: category.id,
        label: category.label,
        score: category.score,
        ...(typeof category.weight === "number" ? { weight: category.weight } : {})
      }))
    },
    run: {
      date: runSummary.startedAt ?? "",
      mode: runSummary.executionMode ?? "",
      runsPerTest: normalizeRunsPerTest(runSummary.runsPerTest)
    },
    results
  };
}
