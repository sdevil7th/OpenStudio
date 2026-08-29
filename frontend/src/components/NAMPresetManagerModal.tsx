import { useEffect, useMemo, useRef, useState } from "react";
import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import {
  Check,
  Copy,
  Download,
  Edit3,
  EllipsisVertical,
  FolderOpen,
  Import,
  MessageSquare,
  RefreshCw,
  Save,
  Search,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { Modal } from "./ui";
import "./NAMPresetManagerModal.css";

export type NAMPresetManagerCollection = {
  id: string;
  label: string;
  count: number;
};

export type NAMPresetManagerFactoryPreset = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  disabled?: boolean;
  disabledReason?: string;
};

export type NAMPresetManagerUserPreset = {
  name: string;
  path?: string;
  folder: string;
  tags: string[];
  notes?: string;
  favorite: boolean;
  lastUsed?: number;
  active: boolean;
};

type SelectedPreset =
  | { kind: "factory"; id: string }
  | { kind: "user"; name: string }
  | null;

type NAMPresetManagerModalProps = {
  isOpen: boolean;
  currentPresetName: string;
  dirty: boolean;
  busy: boolean;
  status?: string;
  search: string;
  activeCollection: string;
  collections: NAMPresetManagerCollection[];
  factoryPresets: NAMPresetManagerFactoryPreset[];
  userPresets: NAMPresetManagerUserPreset[];
  emptyMessage?: string;
  showAllAvailable?: boolean;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onCollectionChange: (id: string) => void;
  onShowAll: () => void;
  onLoadFactory: (id: string) => Promise<boolean>;
  onLoadUser: (name: string) => Promise<boolean>;
  onSaveAs: () => void;
  onImport: () => void | Promise<void>;
  onExportCurrent: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onToggleFavorite: (name: string) => void;
  onEditFolder: (name: string) => void | Promise<void>;
  onEditTags: (name: string) => void | Promise<void>;
  onEditNotes: (name: string) => void | Promise<void>;
  onExportUser: (name: string) => void | Promise<void>;
  onDuplicateUser: (name: string) => void | Promise<void>;
  onRenameUser: (name: string) => void | Promise<void>;
  onDeleteUser: (name: string) => void | Promise<void>;
};

function sameSelectedPreset(left: SelectedPreset, right: SelectedPreset) {
  if (!left || !right || left.kind !== right.kind) return left === right;
  return left.kind === "factory"
    ? left.id === (right as Extract<SelectedPreset, { kind: "factory" }>).id
    : left.name.localeCompare(
        (right as Extract<SelectedPreset, { kind: "user" }>).name,
        undefined,
        { sensitivity: "base" },
      ) === 0;
}

function formatLastUsed(value?: number) {
  if (!value || !Number.isFinite(value)) return "Not used in this session";
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "Recently used";
  }
}

export function NAMPresetManagerModal({
  isOpen,
  currentPresetName,
  dirty,
  busy,
  status,
  search,
  activeCollection,
  collections,
  factoryPresets,
  userPresets,
  emptyMessage,
  showAllAvailable,
  onClose,
  onSearchChange,
  onCollectionChange,
  onShowAll,
  onLoadFactory,
  onLoadUser,
  onSaveAs,
  onImport,
  onExportCurrent,
  onRefresh,
  onToggleFavorite,
  onEditFolder,
  onEditTags,
  onEditNotes,
  onExportUser,
  onDuplicateUser,
  onRenameUser,
  onDeleteUser,
}: NAMPresetManagerModalProps) {
  const activePreset = useMemo<SelectedPreset>(() => {
    const activeUser = userPresets.find((entry) => entry.active);
    if (activeUser) return { kind: "user", name: activeUser.name };
    const activeFactory = factoryPresets.find((entry) => entry.active);
    return activeFactory ? { kind: "factory", id: activeFactory.id } : null;
  }, [factoryPresets, userPresets]);
  const [selectedPreset, setSelectedPreset] = useState<SelectedPreset>(null);
  const [actionPending, setActionPending] = useState(false);
  const actionPendingRef = useRef(false);
  const locked = busy || actionPending;

  const selectedFactory = selectedPreset?.kind === "factory"
    ? factoryPresets.find((entry) => entry.id === selectedPreset.id)
    : undefined;
  const selectedUser = selectedPreset?.kind === "user"
    ? userPresets.find((entry) => entry.name.localeCompare(selectedPreset.name, undefined, { sensitivity: "base" }) === 0)
    : undefined;
  const selectedVisible = Boolean(selectedFactory || selectedUser);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedPreset((current) => {
      const currentStillVisible = current?.kind === "factory"
        ? factoryPresets.some((entry) => entry.id === current.id)
        : current?.kind === "user"
          ? userPresets.some((entry) => entry.name.localeCompare(current.name, undefined, { sensitivity: "base" }) === 0)
          : false;
      if (currentStillVisible) return current;
      if (activePreset) return activePreset;
      if (userPresets[0]) return { kind: "user", name: userPresets[0].name };
      if (factoryPresets[0]) return { kind: "factory", id: factoryPresets[0].id };
      return null;
    });
  }, [activePreset, factoryPresets, isOpen, userPresets]);

  const selectedName = selectedFactory?.name ?? selectedUser?.name ?? "No preset selected";
  const selectedDisabled = Boolean(selectedFactory?.disabled);

  const runPresetAction = async <T,>(action: () => T | Promise<T>): Promise<T | undefined> => {
    if (locked || actionPendingRef.current) return;
    actionPendingRef.current = true;
    setActionPending(true);
    try {
      return await action();
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  };

  const loadSelected = async () => {
    if (!selectedPreset || locked || selectedDisabled) return;
    if (selectedPreset.kind === "factory") {
      await runPresetAction(() => onLoadFactory(selectedPreset.id));
    } else {
      await runPresetAction(() => onLoadUser(selectedPreset.name));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={locked ? () => undefined : onClose}
      closeOnEscape={!locked}
      closeOnOverlayClick={!locked}
      showCloseButton={!locked}
      size="xl"
      fullHeight
      title="Preset Library"
      className="nam-preset-library-modal"
      footer={(
        <div className="nam-preset-library-footer">
          <span aria-live="polite">
            {selectedDisabled
              ? selectedFactory?.disabledReason ?? `${selectedName} is unavailable`
              : selectedVisible
                ? `Ready to load ${selectedName}`
                : "Choose a preset to continue"}
          </span>
          <div>
            <button type="button" className="nam-preset-secondary" onClick={onClose} disabled={locked}>Cancel</button>
            <button
              type="button"
              className="nam-preset-primary"
              onClick={() => void loadSelected()}
              disabled={!selectedVisible || selectedDisabled || locked}
              data-qa="nam-preset-load-selected"
              title={selectedFactory?.disabledReason}
            >
              {locked ? "Working..." : "Load Preset"}
            </button>
          </div>
        </div>
      )}
    >
      <div
        id="nam-preset-manager-dialog"
        className="nam-preset-library-shell"
        aria-busy={locked || undefined}
      >
      <div className="nam-preset-library-summary">
        <div>
          <span>Current preset</span>
          <strong>{currentPresetName}</strong>
          {dirty && <em>Edited</em>}
        </div>
        <div className="nam-preset-library-toolbar">
          <button type="button" onClick={() => void runPresetAction(onSaveAs)} disabled={locked}>
            <Save size={14} aria-hidden="true" />
            Save As
          </button>
          <button type="button" onClick={() => void runPresetAction(onImport)} disabled={locked}>
            <Import size={14} aria-hidden="true" />
            Import
          </button>
          <button type="button" onClick={() => void runPresetAction(onExportCurrent)} disabled={locked}>
            <Download size={14} aria-hidden="true" />
            Export Current
          </button>
          <button
            type="button"
            onClick={() => void runPresetAction(onRefresh)}
            disabled={locked}
            data-qa="nam-preset-refresh"
          >
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {status && (
        <p className="nam-preset-library-status" role="status" aria-live="polite">
          {status}
        </p>
      )}

      <div className="nam-preset-library-layout">
        <aside className="nam-preset-library-collections" aria-label="Preset collections">
          <strong>Collections</strong>
          <nav>
            {collections.map((collection) => (
              <button
                type="button"
                key={collection.id}
                data-active={activeCollection === collection.id}
                aria-current={activeCollection === collection.id ? "true" : undefined}
                onClick={() => onCollectionChange(collection.id)}
                disabled={locked}
              >
                <span>{collection.label}</span>
                <small>{collection.count}</small>
              </button>
            ))}
          </nav>
        </aside>

        <section className="nam-preset-library-browser" aria-label="Available presets">
          <label className="nam-preset-library-search">
            <Search size={15} aria-hidden="true" />
            <input
              data-nam-dialog-initial-focus="true"
              autoFocus
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              placeholder="Search names, tags, notes, or collections"
              aria-label="Search presets"
              disabled={locked}
            />
          </label>

          <div className="nam-preset-library-list" aria-label="Preset results" aria-busy={locked || undefined}>
            {factoryPresets.length > 0 && (
              <div className="nam-preset-library-group" role="group" aria-label="Templates for current capture">
                <header>
                  <strong>Templates</strong>
                  <small>Effect settings for the current capture</small>
                </header>
                {factoryPresets.map((entry) => {
                  const target: SelectedPreset = { kind: "factory", id: entry.id };
                  const selected = sameSelectedPreset(selectedPreset, target);
                  return (
                    <button
                      type="button"
                      className="nam-preset-library-row"
                      key={entry.id}
                      aria-pressed={selected}
                      aria-current={entry.active ? "true" : undefined}
                      aria-disabled={entry.disabled || undefined}
                      data-selected={selected}
                      data-active={entry.active}
                      data-disabled={Boolean(entry.disabled)}
                      data-qa={`nam-factory-preset-${entry.id}`}
                      disabled={locked}
                      onClick={() => setSelectedPreset(target)}
                      onDoubleClick={() => {
                        setSelectedPreset(target);
                        if (!entry.disabled) void runPresetAction(() => onLoadFactory(entry.id));
                      }}
                    >
                      <span className="nam-preset-library-row-icon">{entry.active ? <Check size={14} /> : "T"}</span>
                      <span>
                        <strong>{entry.name}</strong>
                        <small>{entry.disabled ? entry.disabledReason : entry.description}</small>
                      </span>
                      <em>Template</em>
                    </button>
                  );
                })}
              </div>
            )}

            {userPresets.length > 0 && (
              <div className="nam-preset-library-group" role="group" aria-label="User presets">
                <header>
                  <strong>User presets</strong>
                  <small>Complete saved racks</small>
                </header>
                {userPresets.map((entry) => {
                  const target: SelectedPreset = { kind: "user", name: entry.name };
                  const selected = sameSelectedPreset(selectedPreset, target);
                  return (
                    <div
                      className="nam-preset-library-user-row"
                      key={entry.name}
                      data-selected={selected}
                      data-active={entry.active}
                    >
                      <button
                        type="button"
                        className="nam-preset-library-row"
                        aria-pressed={selected}
                        aria-current={entry.active ? "true" : undefined}
                        data-selected={selected}
                        data-active={entry.active}
                        data-qa={`nam-user-preset-${entry.name}`}
                        title={entry.path}
                        disabled={locked}
                        onClick={() => setSelectedPreset(target)}
                        onDoubleClick={() => {
                          setSelectedPreset(target);
                          void runPresetAction(() => onLoadUser(entry.name));
                        }}
                      >
                        <span className="nam-preset-library-row-icon">
                          {entry.active ? <Check size={14} /> : entry.favorite ? <Star size={13} /> : "U"}
                        </span>
                        <span>
                          <strong>{entry.name}</strong>
                          <small>{entry.folder}{entry.tags.length > 0 ? ` · ${entry.tags.slice(0, 3).join(" · ")}` : ""}</small>
                        </span>
                        <em>User</em>
                      </button>
                      <Menu as="div" className="nam-preset-library-overflow">
                        <MenuButton
                          type="button"
                          aria-label={`Actions for ${entry.name}`}
                          title={`Actions for ${entry.name}`}
                          disabled={locked}
                        >
                          <EllipsisVertical size={15} aria-hidden="true" />
                        </MenuButton>
                        <MenuItems
                          anchor={{ to: "bottom end", gap: 4, padding: 8 }}
                          portal
                          className="nam-preset-library-action-menu"
                        >
                          <MenuItem>
                            <button type="button" onClick={() => void runPresetAction(() => onToggleFavorite(entry.name))}>
                              <Star size={13} aria-hidden="true" /> {entry.favorite ? "Remove favorite" : "Favorite"}
                            </button>
                          </MenuItem>
                          <MenuItem>
                            <button type="button" onClick={() => void runPresetAction(() => onEditFolder(entry.name))}><FolderOpen size={13} aria-hidden="true" /> Collection</button>
                          </MenuItem>
                          <MenuItem>
                            <button type="button" onClick={() => void runPresetAction(() => onEditTags(entry.name))}><Tag size={13} aria-hidden="true" /> Tags</button>
                          </MenuItem>
                          <MenuItem>
                            <button type="button" onClick={() => void runPresetAction(() => onEditNotes(entry.name))}><MessageSquare size={13} aria-hidden="true" /> Notes</button>
                          </MenuItem>
                          <MenuItem>
                            <button type="button" onClick={() => void runPresetAction(() => onExportUser(entry.name))}><Download size={13} aria-hidden="true" /> Export</button>
                          </MenuItem>
                          <MenuItem>
                            <button type="button" onClick={() => void runPresetAction(() => onDuplicateUser(entry.name))}><Copy size={13} aria-hidden="true" /> Duplicate</button>
                          </MenuItem>
                          <MenuItem>
                            <button type="button" onClick={() => void runPresetAction(() => onRenameUser(entry.name))}><Edit3 size={13} aria-hidden="true" /> Rename</button>
                          </MenuItem>
                          <MenuItem>
                            <button type="button" className="danger" onClick={() => void runPresetAction(() => onDeleteUser(entry.name))}><Trash2 size={13} aria-hidden="true" /> Delete</button>
                          </MenuItem>
                        </MenuItems>
                      </Menu>
                    </div>
                  );
                })}
              </div>
            )}

            {factoryPresets.length === 0 && userPresets.length === 0 && (
              <div className="nam-preset-library-empty">
                <strong>No presets found</strong>
                <span>{emptyMessage ?? "Try a different search or collection."}</span>
                {showAllAvailable && <button type="button" onClick={onShowAll} disabled={locked}>Show all presets</button>}
              </div>
            )}
          </div>
        </section>

        <aside className="nam-preset-library-details" aria-label="Selected preset details">
          <span>{selectedFactory ? "Template" : selectedUser ? "User preset" : "Preset details"}</span>
          <strong>{selectedName}</strong>
          {selectedFactory && (
            <>
              <p>{selectedFactory.description}</p>
              <dl>
                <div><dt>Contains</dt><dd>Effect settings</dd></div>
                <div><dt>Capture</dt><dd>Uses the current amp</dd></div>
              </dl>
              {selectedFactory.disabledReason && <em>{selectedFactory.disabledReason}</em>}
            </>
          )}
          {selectedUser && (
            <>
              <p>{selectedUser.notes || "A complete saved NAM Rack preset."}</p>
              <dl>
                <div><dt>Collection</dt><dd>{selectedUser.folder}</dd></div>
                <div><dt>Last used</dt><dd>{formatLastUsed(selectedUser.lastUsed)}</dd></div>
                <div><dt>Favorite</dt><dd>{selectedUser.favorite ? "Yes" : "No"}</dd></div>
              </dl>
              {selectedUser.tags.length > 0 && (
                <div className="nam-preset-library-tags">
                  {selectedUser.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              )}
              {selectedUser.path && <small title={selectedUser.path}>{selectedUser.path}</small>}
            </>
          )}
          {!selectedFactory && !selectedUser && <p>Select a preset to review it before loading.</p>}
        </aside>
      </div>
      </div>
    </Modal>
  );
}
