// 跑分結果「Export」按鈕。自包含元件:自行載入 App 版本、管理「已複製」狀態,
// 在 App.tsx 只需一行 import + 放置一個 <ExportResultButton/>，降低與上游的衝突面。
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type {
  BenchLocalProviderConfig,
  BenchPackRunSummary,
  ScenarioMeta
} from "@core";

import { buildResultExportJson, type ExportModel } from "./exportResult";

// 只取一次 App 版本(透過與「關於」對話框相同的 IPC),跨多個按鈕共用。
let cachedVersion: string | undefined;
async function getAppVersion(): Promise<string> {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  try {
    const metadata = await window.benchlocal.app.metadata();
    cachedVersion = metadata?.version ?? "";
  } catch {
    cachedVersion = "";
  }
  return cachedVersion;
}

export function ExportResultButton({
  runSummary,
  model,
  providers,
  score,
  scenarios,
  disabled
}: {
  runSummary: BenchPackRunSummary;
  model: ExportModel | undefined;
  providers: Record<string, BenchLocalProviderConfig>;
  score: BenchPackRunSummary["scores"][string];
  scenarios: ScenarioMeta[];
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleExport = async () => {
    const appVersion = await getAppVersion();
    const exportData = buildResultExportJson({ runSummary, model, providers, score, scenarios, appVersion });
    try {
      await navigator.clipboard?.writeText(JSON.stringify(exportData, null, 2));
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      className="ghost-button ghost-button-compact score-share-button"
      disabled={disabled}
      title={disabled ? "No results to export yet" : "Copy results JSON to clipboard"}
      onClick={handleExport}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : "Export"}
    </button>
  );
}
