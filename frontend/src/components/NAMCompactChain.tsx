import { type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Lock,
  Power,
  RotateCcw,
  Unlock,
  X,
} from "lucide-react";
import type {
  NAMSignalChainPostModule,
  NAMSignalChainRouteModule,
} from "./NAMSignalChainTypes";
import "./NAMCompactChain.css";

export type NAMCompactChainProps = {
  fixedPre: NAMSignalChainRouteModule[];
  captureCore: NAMSignalChainRouteModule[];
  reorderablePost: NAMSignalChainPostModule[];
  tail: NAMSignalChainRouteModule[];
  postOrderLocked: boolean;
  onTogglePostOrderLock: () => void;
  onResetPostOrder: () => void;
  resetPostOrderDisabled?: boolean;
  onClose: () => void;
};

type ChainGroupProps = {
  eyebrow: string;
  title: string;
  accent: "pre" | "capture" | "post" | "tail";
  modules: NAMSignalChainRouteModule[];
  postModules?: NAMSignalChainPostModule[];
  postOrderLocked?: boolean;
  tools?: ReactNode;
};

function ChainNode({
  module,
  postModule,
  postOrderLocked = false,
}: {
  module: NAMSignalChainRouteModule;
  postModule?: NAMSignalChainPostModule;
  postOrderLocked?: boolean;
}) {
  const active = module.enabled !== false;
  const stateLabel = module.status ?? (active ? "ON" : "BYPASSED");
  const editLabel = module.editLabel ?? `Edit ${module.label}`;

  return (
    <article
      className="nam-compact-chain-node"
      data-active={active}
      data-disabled={Boolean(module.disabled)}
      data-qa={`nam-compact-chain-node-${module.id}`}
    >
      <button
        type="button"
        className="nam-compact-chain-node-main"
        onClick={module.onEdit}
        disabled={module.disabled || !module.onEdit}
        title={editLabel}
        aria-label={editLabel}
      >
        <span className="nam-compact-chain-node-icon" aria-hidden="true">
          {module.icon ?? <Power size={14} />}
        </span>
        <span className="nam-compact-chain-node-copy">
          <strong>{module.label}</strong>
          <small>{module.caption}</small>
        </span>
      </button>

      <footer>
        <span className="nam-compact-chain-node-state" data-active={active} title={stateLabel}>
          <i aria-hidden="true" />
          {stateLabel}
        </span>

        {postModule && (
          <span className="nam-compact-chain-order" aria-label={`${module.label} order`}>
            <button
              type="button"
              onClick={postModule.onMoveLeft}
              disabled={postOrderLocked || !postModule.canMoveLeft}
              title={`Move ${module.label} earlier`}
              aria-label={`Move ${module.label} earlier`}
            >
              <ArrowLeft size={12} />
            </button>
            <button
              type="button"
              onClick={postModule.onMoveRight}
              disabled={postOrderLocked || !postModule.canMoveRight}
              title={`Move ${module.label} later`}
              aria-label={`Move ${module.label} later`}
            >
              <ArrowRight size={12} />
            </button>
          </span>
        )}

        {module.onToggle && !postModule && (
          <button
            type="button"
            className="nam-compact-chain-power"
            onClick={module.onToggle}
            disabled={module.disabled}
            aria-pressed={active}
            title={active ? `Bypass ${module.label}` : `Enable ${module.label}`}
            aria-label={active ? `Bypass ${module.label}` : `Enable ${module.label}`}
          >
            <Power size={12} />
          </button>
        )}

        {postModule && (
          <button
            type="button"
            className="nam-compact-chain-power"
            onClick={postModule.onToggle}
            disabled={postModule.disabled}
            aria-pressed={active}
            title={active ? `Bypass ${module.label}` : `Enable ${module.label}`}
            aria-label={active ? `Bypass ${module.label}` : `Enable ${module.label}`}
          >
            <Power size={12} />
          </button>
        )}
      </footer>
    </article>
  );
}

function ChainGroup({
  eyebrow,
  title,
  accent,
  modules,
  postModules,
  postOrderLocked,
  tools,
}: ChainGroupProps) {
  return (
    <section className="nam-compact-chain-group" data-accent={accent} aria-label={`${title} signal-chain group`}>
      <header>
        <span><small>{eyebrow}</small>{title}</span>
        {tools}
      </header>
      <div className="nam-compact-chain-group-lane">
        {modules.map((module, index) => (
          <ChainNode
            key={module.id}
            module={module}
            postModule={postModules?.[index]}
            postOrderLocked={postOrderLocked}
          />
        ))}
      </div>
    </section>
  );
}

export function NAMCompactChain({
  fixedPre,
  captureCore,
  reorderablePost,
  tail,
  postOrderLocked,
  onTogglePostOrderLock,
  onResetPostOrder,
  resetPostOrderDisabled = false,
  onClose,
}: NAMCompactChainProps) {
  return (
    <aside className="nam-compact-chain" data-qa="nam-compact-chain" aria-label="NAM Rack signal chain">
      <div className="nam-compact-chain-titlebar">
        <div>
          <span>SUPPORTED ROUTE</span>
          <strong>Signal Chain</strong>
          <small>Stages wrap to fit. Select a stage to edit it. Only EQ, Mod, Delay, and Reverb can be reordered.</small>
        </div>
        <button type="button" onClick={onClose} title="Close signal chain" aria-label="Close signal chain">
          <X size={16} />
        </button>
      </div>

      <div
        className="nam-compact-chain-scroll"
        tabIndex={0}
        aria-label="Signal-chain overview; scroll vertically when needed"
      >
        <div className="nam-compact-chain-lane">
          <ChainGroup eyebrow="01" title="Pre & pedals" accent="pre" modules={fixedPre} />
          <ChainGroup eyebrow="02" title="Capture & cab" accent="capture" modules={captureCore} />
          <ChainGroup
            eyebrow="03"
            title="Post effects"
            accent="post"
            modules={reorderablePost}
            postModules={reorderablePost}
            postOrderLocked={postOrderLocked}
            tools={(
              <span className="nam-compact-chain-group-tools">
                <button
                  type="button"
                  onClick={onTogglePostOrderLock}
                  aria-pressed={postOrderLocked}
                  title={postOrderLocked ? "Unlock post-effect order" : "Lock post-effect order"}
                >
                  {postOrderLocked ? <Lock size={11} /> : <Unlock size={11} />}
                  {postOrderLocked ? "Locked" : "Unlocked"}
                </button>
                <button
                  type="button"
                  onClick={onResetPostOrder}
                  disabled={resetPostOrderDisabled}
                  title="Reset EQ, Mod, Delay, and Reverb order"
                >
                  <RotateCcw size={11} />
                  Reset
                </button>
              </span>
            )}
          />
          <ChainGroup eyebrow="04" title="Output" accent="tail" modules={tail} />
        </div>
      </div>
    </aside>
  );
}
