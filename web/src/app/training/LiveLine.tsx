"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

import type { TrainingBoardRow } from "~/lib/training/data";

import { TrainSvg } from "./TrainSvg";

const STAGES = [
  "generate",
  "validate",
  "train",
  "quantize",
  "evaluate",
  "review",
  "release",
] as const;
const STAGE_LABELS = [
  "Generate",
  "Validate",
  "Train",
  "Quantize",
  "Evaluate",
  "Review",
  "Release",
] as const;
const STAGE_POSITIONS = [7, 21, 35, 50, 64, 78, 91] as const;
const LIVE_WINDOW_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 1000;

type Stage = (typeof STAGES)[number];
type LineMode = "idle" | "live" | "stale";

interface ReportedRunState {
  run: string;
  stage: Stage;
  detail?: string;
  outcome?: "shipped" | "held" | "failed";
  updatedAt: string;
}

interface LiveLineProps {
  boardRows: TrainingBoardRow[];
  releasedRunId: string;
  releasedVersion: string;
}

export function LiveLine({
  boardRows,
  releasedRunId,
  releasedVersion,
}: LiveLineProps) {
  const [line, setLine] = useState<{
    mode: LineMode;
    report: ReportedRunState | null;
  }>({ mode: "idle", report: null });

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/training/run-state", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!active) return;
        if (response.status === 204 || response.status === 404) {
          setLine({ mode: "idle", report: null });
          return;
        }
        if (!response.ok) {
          setLine({ mode: "idle", report: null });
          return;
        }

        const report = parseReportedRunState(await response.json());
        if (!report) {
          setLine({ mode: "idle", report: null });
          return;
        }

        const age = Date.now() - new Date(report.updatedAt).getTime();
        setLine({
          mode: age < LIVE_WINDOW_MS ? "live" : "stale",
          report,
        });
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setLine({ mode: "idle", report: null });
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, []);

  const currentStage: Stage = line.report?.stage ?? "release";
  const stageIndex = STAGES.indexOf(currentStage);
  const trainPosition = STAGE_POSITIONS[stageIndex] ?? STAGE_POSITIONS.at(-1) ?? 91;
  const statusSentence = getStatusSentence(
    line.mode,
    line.report,
    releasedRunId,
    releasedVersion,
  );
  const visibleBoardRows = useMemo(
    () => getVisibleBoardRows(line.mode, line.report, boardRows),
    [boardRows, line.mode, line.report],
  );
  const trainStyle = {
    "--train-position": `${trainPosition}%`,
  } as CSSProperties;

  return (
    <div className="training-live-line">
      <p className="training-status-line">{statusSentence}</p>
      {line.mode === "stale" && line.report ? (
        <p className="training-stale-notice">
          last update{" "}
          <time dateTime={line.report.updatedAt}>
            {formatUpdatedAt(line.report.updatedAt)}
          </time>
        </p>
      ) : null}
      <p className="training-sr-only" aria-live="polite" aria-atomic="true">
        {statusSentence}
      </p>

      <div className="training-hall-desktop" aria-hidden="true">
        <div className={`training-scene training-scene--${line.mode}`}>
          <div className="training-bigboard">
            <div className="training-board-title">
              <span>OpenAdmin · training departures</span>
              <span>{line.mode === "idle" ? "−" : line.mode.toUpperCase()}</span>
            </div>
            <div className="training-board-head">
              <span>run</span>
              <span>status</span>
              <span>location</span>
              <span>detail</span>
            </div>
            {visibleBoardRows.map((row) => (
              <div
                className={`training-board-row training-board-row--${row.tone}`}
                key={`${row.run}-${row.status}-${row.location}-${row.detail}`}
              >
                <FlapCell text={row.run} width={10} />
                <FlapCell text={row.status} width={14} />
                <FlapCell text={row.location} width={14} />
                <FlapCell text={row.detail} width={28} />
              </div>
            ))}
          </div>

          <div className="training-rail" />
          <div className="training-siding" />
          <span className="training-siding-label">
            siding · held {boardRows.filter((row) => row.tone === "held").map((row) => row.run).join(", ")}
          </span>

          {STAGES.map((stage, index) => (
            <div
              className={`training-station${index === stageIndex ? " training-station--current" : ""}${index < stageIndex ? " training-station--passed" : ""}`}
              key={stage}
              style={{ left: `${STAGE_POSITIONS[index]}%` }}
            >
              <span className="training-station-node" />
              <span className="training-station-label">{STAGE_LABELS[index]}</span>
            </div>
          ))}

          <div
            className={`training-train training-train--${line.mode}`}
            style={trainStyle}
          >
            <span className="training-train-id">
              {line.report?.run ?? releasedRunId}
            </span>
            <TrainSvg className="training-train-svg" />
          </div>

          <div className="training-telemetry">
            <div className="training-telemetry-head">
              <strong>{line.report?.run ?? releasedRunId}</strong>
              <span>{line.mode === "idle" ? "idle" : line.mode}</span>
            </div>
            <p>
              {line.report
                ? `${STAGE_LABELS[stageIndex]}${line.report.outcome ? ` · ${line.report.outcome}` : ""}`
                : `${releasedVersion} parked at Release`}
            </p>
            {line.report?.detail ? (
              <span className="training-telemetry-detail">{line.report.detail}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className={`training-pipeline-mobile training-pipeline-mobile--${line.mode}`}>
        <div className="training-pipeline-mobile-head">
          <div>
            <span>pipeline status</span>
            <strong>{line.report?.run ?? releasedRunId}</strong>
          </div>
          <b>{line.mode === "idle" ? "−" : line.mode.toUpperCase()}</b>
        </div>
        <ol>
          {STAGES.map((stage, index) => (
            <li
              className={`${index === stageIndex ? "is-current" : ""}${index < stageIndex ? " is-passed" : ""}`}
              key={stage}
            >
              <span />
              <b>{STAGE_LABELS[index]}</b>
              {index === stageIndex && line.report?.detail ? (
                <small>{line.report.detail}</small>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function FlapCell({ text, width }: { text: string; width: number }) {
  const characters = text.toUpperCase().slice(0, width).padEnd(width, " ").split("");
  return (
    <span className="training-flap-cell">
      {characters.map((character, index) => (
        <span className="training-flap" key={`${index}-${character}`}>
          {character === " " ? "\u00a0" : character}
        </span>
      ))}
    </span>
  );
}

function getVisibleBoardRows(
  mode: LineMode,
  report: ReportedRunState | null,
  boardRows: TrainingBoardRow[],
): TrainingBoardRow[] {
  if (mode === "idle" || !report) return boardRows;

  const activeRow: TrainingBoardRow = {
    run: report.run,
    status: report.outcome ?? mode,
    location: STAGE_LABELS[STAGES.indexOf(report.stage)] ?? report.stage,
    detail: report.detail ?? "",
    tone: "released",
  };
  return [activeRow, ...boardRows.filter((row) => row.run !== report.run)];
}

function getStatusSentence(
  mode: LineMode,
  report: ReportedRunState | null,
  releasedRunId: string,
  releasedVersion: string,
): string {
  if (mode === "idle" || !report) {
    return `No current training run is being reported. ${releasedVersion} (${releasedRunId}) is parked at Release.`;
  }

  const stage = STAGE_LABELS[STAGES.indexOf(report.stage)] ?? report.stage;
  const detail = report.detail ? ` ${report.detail}` : "";
  if (mode === "stale") {
    return `The last reported state for ${report.run} was ${stage}.${detail}`;
  }
  return `${report.run} is live at ${stage}.${detail}`;
}

function parseReportedRunState(value: unknown): ReportedRunState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.run !== "string" ||
    typeof candidate.stage !== "string" ||
    !STAGES.includes(candidate.stage as Stage) ||
    typeof candidate.updatedAt !== "string" ||
    !Number.isFinite(new Date(candidate.updatedAt).getTime())
  ) {
    return null;
  }
  if (candidate.detail !== undefined && typeof candidate.detail !== "string") {
    return null;
  }
  if (
    candidate.outcome !== undefined &&
    !["shipped", "held", "failed"].includes(String(candidate.outcome))
  ) {
    return null;
  }

  return {
    run: candidate.run,
    stage: candidate.stage as Stage,
    detail: candidate.detail as string | undefined,
    outcome: candidate.outcome as ReportedRunState["outcome"],
    updatedAt: candidate.updatedAt,
  };
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
