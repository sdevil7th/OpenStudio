import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDAWStore } from "../store/useDAWStore";
import {
  getTrackNameEditKeyAction,
  resolveTrackRenameTargetIds,
  shouldCommitTrackNameEdit,
} from "../utils/trackRename";
import { Input } from "./ui";

interface TrackNameEditorProps {
  trackId: string;
  name: string;
  placeholder: string;
  className: string;
  inputClassName?: string;
}

export function TrackNameEditor({
  trackId,
  name,
  placeholder,
  className,
  inputClassName,
}: TrackNameEditorProps) {
  const { renameTracks } = useDAWStore(
    useShallow((state) => ({ renameTracks: state.renameTracks })),
  );
  const [draft, setDraft] = useState(name);
  const draftRef = useRef(name);
  const latestNameRef = useRef(name);
  const initialDraftRef = useRef(name);
  const targetTrackIdsRef = useRef<string[]>([trackId]);
  const isEditingRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    latestNameRef.current = name;
    if (!isEditingRef.current) {
      draftRef.current = name;
      setDraft(name);
    }
  }, [name]);

  const beginEdit = () => {
    if (isEditingRef.current) return;

    const state = useDAWStore.getState();
    targetTrackIdsRef.current = resolveTrackRenameTargetIds(
      state.tracks,
      state.selectedTrackIds,
      trackId,
    );
    initialDraftRef.current = draftRef.current;
    cancelledRef.current = false;
    isEditingRef.current = true;
  };

  const finishEdit = () => {
    if (!isEditingRef.current) return;

    isEditingRef.current = false;
    if (cancelledRef.current) {
      cancelledRef.current = false;
      draftRef.current = latestNameRef.current;
      setDraft(latestNameRef.current);
      return;
    }

    if (!shouldCommitTrackNameEdit(initialDraftRef.current, draftRef.current)) {
      draftRef.current = latestNameRef.current;
      setDraft(latestNameRef.current);
      return;
    }

    renameTracks(targetTrackIdsRef.current, draftRef.current);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = getTrackNameEditKeyAction(
      event.key,
      event.nativeEvent.isComposing,
      event.keyCode,
    );

    if (action === "commit") {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.blur();
      return;
    }

    if (action === "cancel") {
      event.preventDefault();
      event.stopPropagation();
      cancelledRef.current = true;
      draftRef.current = latestNameRef.current;
      setDraft(latestNameRef.current);
      event.currentTarget.blur();
    }
  };

  return (
    <Input
      type="text"
      variant="inline"
      size="sm"
      value={draft}
      onFocus={beginEdit}
      onChange={(event) => {
        draftRef.current = event.target.value;
        setDraft(event.target.value);
      }}
      onBlur={finishEdit}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={className}
      inputClassName={inputClassName}
      aria-label="Track name"
      data-track-name-input={trackId}
    />
  );
}
