import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clipboard,
  CopyCheck,
  Loader2,
  PenLine,
  Play,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Button, StatusBanner, Textarea } from "./ui";
import {
  type AssistantActionPlan,
  planRequiresConfirmation,
  validateAssistantActionPlan,
} from "../assistant/actionSchema";
import {
  executeAssistantActionPlan,
  summarizeAssistantExecutionResult,
  type AssistantExecutionStepResult,
  type AssistantExecutionResult,
} from "../assistant/executeAssistantActions";
import { buildAssistantProjectContext } from "../assistant/projectContext";

interface AssistantMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tone?: "default" | "warning" | "danger" | "success";
}

interface AssistantPanelProps {
  width: number;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

function messageId() {
  return `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function actionLabel(kind: string) {
  switch (kind) {
    case "ai.getRuntimeStatus":
      return "Check runtime";
    case "ai.openSetup":
      return "Open setup";
    case "ai.openContextGeneration":
      return "Open context generation";
    case "ai.createAITrack":
      return "Create AI track";
    case "ai.setWorkflow":
      return "Set workflow";
    case "ai.setGenerationParams":
      return "Set params";
    case "ai.generateMusic":
      return "Generate music";
    case "ai.cancelGeneration":
      return "Cancel generation";
    case "ai.pollGeneration":
      return "Poll generation";
    case "ai.insertGeneratedClip":
      return "Insert generated clip";
    case "app.executeRegisteredAction":
      return "Run OpenStudio action";
    case "plugin.scan":
      return "Scan plugins";
    case "plugin.listAvailable":
      return "List plugins";
    case "plugin.add":
      return "Add plugin";
    case "plugin.openEditor":
      return "Open plugin editor";
    case "plugin.bypass":
      return "Bypass plugin";
    case "plugin.remove":
      return "Remove plugin";
    case "plugin.reorder":
      return "Reorder plugin";
    case "plugin.listParameters":
      return "List plugin parameters";
    case "plugin.loadPreset":
      return "Load plugin preset";
    default:
      return kind;
  }
}

function statusTone(step: AssistantExecutionStepResult) {
  return step.ok ? "text-emerald-300" : "text-red-300";
}

function compactConversation(messages: AssistantMessage[], nextPrompt: string) {
  return [
    ...messages.slice(-10).map((message) => ({
      role: message.role,
      text: message.text.slice(0, 1200),
    })),
    { role: "user", text: nextPrompt.slice(0, 1200) },
  ];
}

function formatMessageForClipboard(message: AssistantMessage) {
  const label = message.role === "user" ? "You" : message.role === "system" ? "Status" : "Assistant";
  return `${label}: ${message.text}`;
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const element = document.createElement("textarea");
  element.value = text;
  element.setAttribute("readonly", "true");
  element.style.position = "fixed";
  element.style.left = "-9999px";
  document.body.appendChild(element);
  element.select();
  document.execCommand("copy");
  document.body.removeChild(element);
}

export default function AssistantPanel({ width, onResizeStart }: AssistantPanelProps) {
  const { closeAssistantPanel, openAiToolsSetup, refreshAiToolsStatus, aiToolsStatus } = useDAWStore(
    useShallow((state) => ({
      closeAssistantPanel: state.closeAssistantPanel,
      openAiToolsSetup: state.openAiToolsSetup,
      refreshAiToolsStatus: state.refreshAiToolsStatus,
      aiToolsStatus: state.aiToolsStatus,
    })),
  );
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [pendingPlan, setPendingPlan] = useState<AssistantActionPlan | null>(null);
  const [steps, setSteps] = useState<AssistantExecutionStepResult[]>([]);
  const [lastExecutionResult, setLastExecutionResult] = useState<AssistantExecutionResult | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isRefreshingSetupStatus, setIsRefreshingSetupStatus] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pendingPlan, steps, isSending, isExecuting]);

  useEffect(() => () => {
    if (copyTimeoutRef.current) {
      window.clearTimeout(copyTimeoutRef.current);
    }
  }, []);

  const runtimeReady = Boolean(aiToolsStatus.assistantRuntimeReady);
  const analyzerReady = Boolean(aiToolsStatus.audioUnderstandingRuntimeReady);
  const analyzerStatus = String(aiToolsStatus.audioUnderstandingStatus || "not_installed").replace(/_/g, " ");
  const setupPending = !runtimeReady || !analyzerReady;
  const runtimeSubtitle = `Qwen planner: ${runtimeReady ? "verified" : "pending"} / Analyzer: ${
    analyzerReady ? "verified" : analyzerStatus
  }`;
  const runLabel = useMemo(() => {
    if (!pendingPlan) return "Confirm and run";
    return planRequiresConfirmation(pendingPlan) ? "Confirm and run" : "Confirm and run";
  }, [pendingPlan]);

  const appendMessage = (message: Omit<AssistantMessage, "id">) => {
    setMessages((items) => [...items, { ...message, id: messageId() }]);
  };

  const markCopied = (target: string) => {
    setCopiedTarget(target);
    if (copyTimeoutRef.current) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = window.setTimeout(() => setCopiedTarget(""), 1400);
  };

  const handleCopyMessage = async (message: AssistantMessage) => {
    await copyTextToClipboard(message.text);
    markCopied(message.id);
  };

  const handleCopyConversation = async () => {
    if (messages.length === 0) return;
    await copyTextToClipboard(messages.map(formatMessageForClipboard).join("\n\n"));
    markCopied("conversation");
  };

  const handleLoadPrompt = (text: string) => {
    setInput(text);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(text.length, text.length);
    });
  };

  const handleClearChat = () => {
    if (isSending || isExecuting) return;
    setMessages([]);
    setPendingPlan(null);
    setSteps([]);
    setLastExecutionResult(null);
    setInput("");
  };

  const handleOpenSetup = async () => {
    if (isRefreshingSetupStatus) return;
    openAiToolsSetup();
    setIsRefreshingSetupStatus(true);
    try {
      const status = await refreshAiToolsStatus(true);
      const plannerNowReady = Boolean(status.assistantRuntimeReady);
      const analyzerNowReady = Boolean(status.audioUnderstandingRuntimeReady);
      const statusParts = [
        `Qwen planner: ${plannerNowReady ? "verified" : "pending"}`,
        `core music analyzer: ${
          analyzerNowReady
            ? "verified"
            : String(status.audioUnderstandingStatus || "not_installed").replace(/_/g, " ")
        }`,
      ];
      appendMessage({
        role: "system",
        tone: plannerNowReady && analyzerNowReady ? "success" : "warning",
        text: plannerNowReady && analyzerNowReady
          ? `AI Tools Setup opened. ${statusParts.join(". ")}.`
          : `AI Tools Setup opened. Setup is still pending. ${statusParts.join(". ")}.`,
      });
    } catch (error) {
      appendMessage({
        role: "system",
        tone: "warning",
        text: error instanceof Error
          ? `AI Tools Setup opened, but status refresh failed: ${error.message}`
          : "AI Tools Setup opened, but status refresh failed.",
      });
    } finally {
      setIsRefreshingSetupStatus(false);
    }
  };

  const sendPrompt = async (promptText: string) => {
    const prompt = promptText.trim();
    if (!prompt || isSending || isExecuting) return;

    setInput("");
    setPendingPlan(null);
    setSteps([]);
    appendMessage({ role: "user", text: prompt });
    setIsSending(true);

    try {
      const response = await nativeBridge.runAssistantPrompt(
        prompt,
        await buildAssistantProjectContext({
          recentConversation: compactConversation(messages, prompt),
          lastExecutionResult,
        }),
      );
      if (!response.ok) {
        appendMessage({
          role: "assistant",
          tone: "danger",
          text: response.error || "The assistant could not prepare a plan.",
        });
        return;
      }

      const mode = response.mode ?? (response.informational ? "answer" : response.plan ? "plan" : "answer");
      if (mode === "answer" || mode === "clarification" || mode === "execution_result" || response.informational) {
        appendMessage({
          role: "assistant",
          tone: mode === "clarification" ? "warning" : mode === "execution_result" ? "success" : "default",
          text: response.reply || (mode === "clarification" ? "I need a little more context before I can do that." : "Here is what I found."),
        });
        return;
      }

      const validation = validateAssistantActionPlan(response.plan);
      if (!validation.ok || !validation.plan) {
        appendMessage({
          role: "assistant",
          tone: "danger",
          text: `The assistant returned an invalid action plan: ${validation.errors.join(" ")}`,
        });
        return;
      }

      setPendingPlan(validation.plan);
      const planReply = response.reply || validation.plan.title;
      appendMessage({
        role: "assistant",
        tone: response.fallbackUsed ? "warning" : "default",
        text: planReply.toLowerCase().includes("plan ready")
          ? planReply
          : `Plan ready: ${planReply}`,
      });
      if (response.error) {
        appendMessage({
          role: "system",
          tone: "warning",
          text: `Model fallback used: ${response.error}`,
        });
      }
      if (response.audioUnderstandingError) {
        appendMessage({
          role: "system",
          tone: "warning",
          text: `Core music analyzer unavailable; OpenStudio did not use analyzer evidence. ${response.audioUnderstandingError}`,
        });
      }
    } catch (error) {
      appendMessage({
        role: "assistant",
        tone: "danger",
        text: error instanceof Error ? error.message : "The assistant request failed.",
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleSend = async () => {
    await sendPrompt(input);
  };

  const handleRunPlan = async () => {
    if (!pendingPlan || isExecuting) return;

    setIsExecuting(true);
    setSteps([]);
    try {
      const result = await executeAssistantActionPlan(pendingPlan, {
        confirmed: true,
        onStep: (step) => setSteps((items) => [...items, step]),
      });
      const summary = result.summary || summarizeAssistantExecutionResult(result);
      setLastExecutionResult(result);
      const setupPlan = pendingPlan.actions.some((action) => action.kind === "ai.openSetup");
      appendMessage({
        role: "assistant",
        tone: result.ok ? "success" : "danger",
        text: result.ok && setupPlan ? summary : result.ok ? `Executed.\n${summary}` : `Execution stopped.\n${summary}`,
      });
      if (result.ok) setPendingPlan(null);
    } catch (error) {
      appendMessage({
        role: "system",
        tone: "danger",
        text: error instanceof Error ? error.message : "Action execution failed.",
      });
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <aside
      className="relative z-30 flex h-full shrink-0 flex-col border-l border-daw-border bg-daw-panel shadow-2xl"
      style={{ width }}
      aria-label="Assistant panel"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize assistant panel"
        className="absolute inset-y-0 left-0 z-40 w-1.5 -translate-x-1/2 cursor-col-resize group"
        onMouseDown={onResizeStart}
        title="Drag to resize assistant"
      >
        <div className="mx-auto h-full w-px bg-daw-border group-hover:bg-daw-accent" />
      </div>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-daw-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={16} className="shrink-0 text-daw-accent" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-daw-text">Assistant</p>
            <p className="truncate text-[11px] text-daw-text-muted">
              {runtimeSubtitle}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            icon={copiedTarget === "conversation" ? <CopyCheck size={14} /> : <Clipboard size={14} />}
            iconPosition="only"
            title="Copy conversation"
            aria-label="Copy conversation"
            disabled={messages.length === 0}
            onClick={() => void handleCopyConversation()}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            icon={<Trash2 size={14} />}
            iconPosition="only"
            title="Clear chat"
            aria-label="Clear chat"
            disabled={messages.length === 0 && !pendingPlan && steps.length === 0}
            onClick={handleClearChat}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            icon={<X size={15} />}
            iconPosition="only"
            title="Close assistant"
            aria-label="Close assistant"
            onClick={closeAssistantPanel}
          />
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <StatusBanner
            tone={setupPending ? "warning" : "info"}
            title={setupPending ? "AI runtimes need setup" : "Ready"}
            actions={setupPending ? (
              <Button
                variant="primary"
                size="sm"
                icon={isRefreshingSetupStatus ? <Loader2 size={14} className="animate-spin" /> : <Settings size={14} />}
                disabled={isRefreshingSetupStatus}
                onClick={() => void handleOpenSetup()}
              >
                Open AI Tools Setup
              </Button>
            ) : undefined}
          >
            <div className="space-y-1">
              <p>Qwen planner: {runtimeReady ? "verified" : "pending"}.</p>
              <p>Core music analyzer: {analyzerReady ? "verified" : analyzerStatus}.</p>
            </div>
          </StatusBanner>
        ) : null}

        {messages.map((message) => {
          const isUser = message.role === "user";
          const Icon = isUser ? User : message.tone === "danger" ? AlertTriangle : Bot;
          const toneClass =
            message.tone === "danger"
              ? "border-red-800/50 bg-red-950/30 text-red-100"
              : message.tone === "warning"
                ? "border-yellow-800/40 bg-yellow-950/25 text-yellow-100"
                : message.tone === "success"
                  ? "border-emerald-800/40 bg-emerald-950/25 text-emerald-100"
                  : isUser
                    ? "border-blue-800/40 bg-blue-950/20 text-blue-50"
                    : "border-neutral-800 bg-neutral-950/40 text-daw-text";

          return (
            <div key={message.id} className={`group rounded-md border px-3 py-2 ${toneClass}`}>
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] opacity-80">
                  <Icon size={13} />
                  <span>{isUser ? "You" : message.role === "system" ? "Status" : "Assistant"}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    icon={copiedTarget === message.id ? <CopyCheck size={12} /> : <Clipboard size={12} />}
                    iconPosition="only"
                    title="Copy message"
                    aria-label="Copy message"
                    onClick={() => void handleCopyMessage(message)}
                  />
                  {isUser ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      icon={<PenLine size={12} />}
                      iconPosition="only"
                      title="Edit and resend"
                      aria-label="Edit and resend"
                      disabled={isSending || isExecuting}
                      onClick={() => handleLoadPrompt(message.text)}
                    />
                  ) : null}
                  {isUser ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      icon={<RotateCcw size={12} />}
                      iconPosition="only"
                      title="Resend message now"
                      aria-label="Resend message now"
                      disabled={isSending || isExecuting}
                      onClick={() => void sendPrompt(message.text)}
                    />
                  ) : null}
                </div>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-5">{message.text}</p>
            </div>
          );
        })}

        {isSending ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-daw-text">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] opacity-80">
              <Loader2 size={13} className="animate-spin" />
              <span>Assistant</span>
            </div>
            <p className="text-sm leading-5 text-daw-text-secondary">Thinking...</p>
          </div>
        ) : null}

        {pendingPlan ? (
          <div className="rounded-md border border-daw-border bg-neutral-950/50">
            <div className="border-b border-daw-border px-3 py-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-daw-accent">
                Plan ready
              </p>
              <p className="text-sm font-semibold text-daw-text">{pendingPlan.title}</p>
              <p className="mt-1 text-xs leading-5 text-daw-text-secondary">{pendingPlan.expectedImpact}</p>
            </div>
            <div className="space-y-2 px-3 py-3">
              {pendingPlan.actions.map((action) => (
                <div key={action.id} className="flex items-start gap-2 text-xs text-daw-text-secondary">
                  <Play size={13} className="mt-0.5 shrink-0 text-daw-accent" />
                  <div className="min-w-0">
                    <p className="font-medium text-daw-text">{action.summary || actionLabel(action.kind)}</p>
                    <p className="mt-0.5 uppercase tracking-[0.12em] text-daw-text-muted">
                      {actionLabel(action.kind)} / {action.risk}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {steps.length > 0 ? (
              <div className="border-t border-daw-border px-3 py-2">
                {steps.map((step) => (
                  <p key={step.actionId} className={`text-xs ${statusTone(step)}`}>
                    {step.ok ? "Done" : "Failed"}: {actionLabel(step.kind)}
                    {step.error ? ` - ${step.error}` : step.summary ? ` - ${step.summary}` : ""}
                  </p>
                ))}
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2 border-t border-daw-border px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={isExecuting}
                onClick={() => setPendingPlan(null)}
              >
                Dismiss
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={isExecuting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                disabled={isExecuting}
                onClick={() => void handleRunPlan()}
              >
                {runLabel}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-daw-border bg-daw-dark/60 p-3">
        <Textarea
          ref={inputRef}
          size="sm"
          fullWidth
          value={input}
          disabled={isSending || isExecuting}
          placeholder="Ask OpenStudio..."
          rows={3}
          textareaClassName="resize-none bg-neutral-950/80"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="truncate text-[11px] text-daw-text-muted">
            {copiedTarget
              ? "Copied."
              : isExecuting
              ? "Executing confirmed plan..."
              : isSending
                ? "Thinking..."
              : pendingPlan
                ? "Plan ready for confirmation."
                : setupPending
                  ? "Runtime setup pending."
                  : "Qwen planner and core music analyzer ready."}
          </p>
          <Button
            variant="primary"
            size="sm"
            icon={isSending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            disabled={isSending || isExecuting || input.trim().length === 0}
            onClick={() => void handleSend()}
          >
            Send
          </Button>
        </div>
      </div>
    </aside>
  );
}
