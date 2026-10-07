import { useEffect, useState } from "react";
import type { TONE3000User } from "../services/NativeBridge";
import { Modal, Button } from "./ui";
import logo from "../assets/tone3000/tone3000-logo.svg";
import mark from "../assets/tone3000/t3k-mark.svg";

const logoSizes = {
  default: "h-6 w-[158px]",
  small: "h-[18px] w-28",
  source: "h-5 w-[126px]",
  introduction: "h-8 w-[210px]",
} as const;

export function TONE3000Logo({ compact = false, size = "default" }: { compact?: boolean; size?: keyof typeof logoSizes }) {
  return <img className={`block max-w-full flex-none object-contain ${compact ? "t3k-mark h-4 w-[47px]" : `tone3000-logo ${logoSizes[size]}`}`} src={compact ? mark : logo} alt="TONE3000" />;
}

export function TONE3000Avatar({ username, url }: { username: string; url?: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <span className="tone3000-avatar inline-flex size-6 flex-none items-center justify-center overflow-hidden rounded-full bg-[#343c48] text-[10px] text-white" aria-hidden="true">
    {url && !failed ? <img className="size-full object-cover" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : username.replace(/^@/, "").slice(0, 2).toUpperCase() || "?"}
  </span>;
}

export function TONE3000Creator({ username, avatarUrl }: { username: string; avatarUrl?: string | null }) {
  return <span className="tone3000-creator inline-flex min-w-0 items-center gap-1.5 text-[11px] text-[#c9d0db]"><TONE3000Avatar username={username} url={avatarUrl} /><span className="min-w-0 truncate" title={username}>@{username.replace(/^@/, "")}</span></span>;
}

export function TONE3000LibraryHeader({ user, connected, busy, onBrowse, embedded = false }: {
  user?: TONE3000User | null; connected: boolean; busy: boolean; onBrowse: () => void; embedded?: boolean;
}) {
  return <section className={`tone3000-library-header @container/tone3000 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md text-[#f1f1f1] ${embedded ? "flex-1 py-1.5" : "border border-[#303741] bg-[#11151b] p-3"}`} aria-label="TONE3000 community library">
    <div className="tone3000-library-identity flex min-w-0 max-w-full flex-wrap items-center gap-2.5">
      <TONE3000Logo size={embedded ? "source" : "default"} />
      {connected && user ? <TONE3000Creator username={user.username} avatarUrl={user.avatar_url} /> : <span className="text-xs text-neutral-400">{connected ? "Connected account" : "Community captures & IRs"}</span>}
    </div>
    <button type="button" className="tone3000-browse-button flex min-h-11 flex-none items-center justify-center gap-2.5 rounded border border-[#525d69] bg-[#222a34] px-3 py-2 text-xs text-white enabled:cursor-pointer enabled:hover:bg-[#303a47] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#80bdff] @max-[280px]/tone3000:w-full" onClick={onBrowse} disabled={busy} aria-busy={busy || undefined}>
      <TONE3000Logo compact /><span>{busy ? "Opening library…" : "Browse TONE3000"}</span>
    </button>
  </section>;
}

export function TONE3000Introduction({ open, onClose, onContinue }: { open: boolean; onClose: () => void; onContinue: () => void }) {
  return <Modal isOpen={open} onClose={onClose} title="Explore the TONE3000 community" size="md">
    <div className="tone3000-introduction flex flex-col gap-5 p-5">
      <div className="flex flex-wrap items-center justify-center gap-6">
        <img className="size-14 object-contain" src="/icon.png" alt="OpenStudio" />
        <TONE3000Logo size="introduction" />
      </div>
      <p className="text-sm leading-relaxed text-neutral-300">OpenStudio connects you to TONE3000’s library of Neural Amp Modeler (NAM) captures and cabinet impulse responses of real analog gear, shared by a global community of musicians.</p>
      <p className="text-xs leading-relaxed text-neutral-400">Continue to TONE3000 to sign in and choose a tone. You’ll return here to select a capture and audition it in your rack.</p>
      <div className="flex justify-end gap-3"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={onContinue}>Continue</Button></div>
    </div>
  </Modal>;
}

export type TONE3000ToneOrigin = { title: string; toneId?: number; imageUrl?: string; creator?: string; gear?: string; format: string };

export function TONE3000LoadedTone({ tone, onDetails }: { tone: TONE3000ToneOrigin; onDetails?: () => void }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [tone.imageUrl]);
  return <button type="button" className="tone3000-loaded-tone flex w-full min-w-0 items-center gap-2.5 rounded border border-[#343e4b] bg-[#131921] px-2.5 py-2 text-left text-[#eee] enabled:cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#80bdff]" onClick={onDetails} disabled={!onDetails} aria-label={`Open ${tone.title} tone details`}>
    {tone.imageUrl && !imageFailed ? <img className="tone3000-loaded-art size-10 flex-none rounded-[3px] object-cover" src={tone.imageUrl} alt="" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} /> : <span className="tone3000-loaded-art flex size-10 flex-none items-center justify-center rounded-[3px] bg-[#303a48]" aria-hidden="true">♪</span>}
    <span className="tone3000-loaded-copy flex min-w-0 flex-1 flex-col gap-1"><strong className="truncate text-xs" title={tone.title}>{tone.title}</strong><small className="break-words text-[10px] text-[#a4b0bf]">{[tone.gear, tone.format, tone.creator ? `@${tone.creator.replace(/^@/, "")}` : ""].filter(Boolean).join(" · ")}</small></span>
    <TONE3000Logo compact />
  </button>;
}
