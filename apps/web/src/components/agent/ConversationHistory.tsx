import { Check, Pencil, Search, Trash2, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AppCopy } from "../../i18n";
import { useAppCopy } from "../../lib/contexts";
import { type ChatThreadSummary } from "../../lib/persistence";

export type ConversationActions = {
  conversations: ChatThreadSummary[];
  activeConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
  onSearchConversations: (query: string) => Promise<string[]>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function conversationTitle(conversation: Pick<ChatThreadSummary, "title" | "preview">, copy: AppCopy) {
  return conversation.title || conversation.preview || copy.agent.untitledConversation;
}

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Today / Yesterday / Earlier this week / Older, the way a chat history is usually grouped. */
function groupConversations(conversations: ChatThreadSummary[], copy: AppCopy, now: number) {
  const today = startOfDay(now);
  const groups: { label: string; items: ChatThreadSummary[] }[] = [
    { label: copy.agent.historyToday, items: [] },
    { label: copy.agent.historyYesterday, items: [] },
    { label: copy.agent.historyThisWeek, items: [] },
    { label: copy.agent.historyOlder, items: [] },
  ];
  for (const conversation of conversations) {
    const day = startOfDay(conversation.updatedAt);
    const index = day >= today ? 0 : day >= today - DAY_MS ? 1 : day >= today - 6 * DAY_MS ? 2 : 3;
    groups[index].items.push(conversation);
  }
  return groups.filter((group) => group.items.length);
}

export function conversationMeta(conversation: ChatThreadSummary, copy: AppCopy, now: number) {
  const pages = conversation.pages.slice(0, 3).map((page) => `p.${page}`).join(" ");
  const more = conversation.pages.length > 3 ? ` +${conversation.pages.length - 3}` : "";
  return [
    pages ? `${pages}${more}` : "",
    copy.agent.historyMessageCount(conversation.messageCount),
    copy.agent.historyRelativeTime(Math.max(0, now - conversation.updatedAt)),
  ].filter(Boolean).join(" · ");
}

// ── ConversationHistory ──────────────────────────────────────

/** The conversations of the open document: search, reopen, rename, delete. */
export function ConversationHistory(props: ConversationActions & { onClose: () => void }) {
  const copy = useAppCopy();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Set<string> | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const now = useMemo(() => Date.now(), [props.conversations]);
  const { onClose, onSearchConversations } = props;

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (rootRef.current?.contains(target) || target?.closest("[data-conversation-history-toggle]")) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Titles match as you type; what was said inside a conversation is looked up in storage.
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setMatches(null);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onSearchConversations(needle)
        .then((ids) => {
          if (!cancelled) setMatches(new Set(ids));
        })
        .catch(() => undefined);
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onSearchConversations, query]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return props.conversations;
    return props.conversations.filter((conversation) =>
      conversationTitle(conversation, copy).toLowerCase().includes(needle)
      || conversation.preview.toLowerCase().includes(needle)
      || matches?.has(conversation.id));
  }, [copy, matches, props.conversations, query]);
  const groups = useMemo(() => groupConversations(visible, copy, now), [copy, now, visible]);

  return (
    <div className="conversation-history" ref={rootRef} role="dialog" aria-label={copy.agent.history}>
      <label className="conversation-search">
        <Search aria-hidden="true" />
        <input
          id="conversation-history-search"
          ref={searchRef}
          type="search"
          value={query}
          placeholder={copy.agent.historySearchPlaceholder}
          aria-label={copy.agent.historySearchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="conversation-list">
        {!groups.length && (
          <p className="conversation-empty">
            {query.trim() ? copy.agent.historyNoMatches : copy.agent.historyEmpty}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3>{group.label}</h3>
            {group.items.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                now={now}
                active={conversation.id === props.activeConversationId}
                renaming={renamingId === conversation.id}
                deleting={deletingId === conversation.id}
                onOpen={() => {
                  props.onOpenConversation(conversation.id);
                  onClose();
                }}
                onStartRename={() => {
                  setDeletingId(null);
                  setRenamingId(conversation.id);
                }}
                onRename={(title) => {
                  setRenamingId(null);
                  if (title !== null) props.onRenameConversation(conversation.id, title);
                }}
                onAskDelete={() => {
                  setRenamingId(null);
                  setDeletingId(conversation.id);
                }}
                onDelete={(confirmed) => {
                  setDeletingId(null);
                  if (confirmed) props.onDeleteConversation(conversation.id);
                }}
              />
            ))}
          </section>
        ))}
      </div>
      <p className="conversation-scope">{copy.agent.historyScope}</p>
    </div>
  );
}

function ConversationRow(props: {
  conversation: ChatThreadSummary;
  now: number;
  active: boolean;
  renaming: boolean;
  deleting: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onRename: (title: string | null) => void;
  onAskDelete: () => void;
  onDelete: (confirmed: boolean) => void;
}) {
  const copy = useAppCopy();
  const { conversation } = props;
  const title = conversationTitle(conversation, copy);
  const [draft, setDraft] = useState(title);

  useEffect(() => {
    if (props.renaming) setDraft(title);
  }, [props.renaming, title]);

  const onRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      props.onRename(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onRename(null);
    }
  };

  if (props.renaming) {
    return (
      <div className="conversation-row editing">
        <input
          id={`conversation-title-${conversation.id}`}
          autoFocus
          value={draft}
          aria-label={copy.agent.historyRename}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onRenameKeyDown}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" onClick={() => props.onRename(draft)} aria-label={copy.agent.historySaveTitle} title={copy.agent.historySaveTitle}>
          <Check />
        </button>
        <button type="button" onClick={() => props.onRename(null)} aria-label={copy.agent.cancel} title={copy.agent.cancel}>
          <X />
        </button>
      </div>
    );
  }

  if (props.deleting) {
    return (
      <div className="conversation-row confirming" role="alertdialog" aria-label={copy.agent.historyDeleteConfirm}>
        <span>{copy.agent.historyDeleteConfirm}</span>
        <button className="danger" type="button" onClick={() => props.onDelete(true)}>{copy.agent.historyDelete}</button>
        <button type="button" onClick={() => props.onDelete(false)}>{copy.agent.cancel}</button>
      </div>
    );
  }

  return (
    <div className={`conversation-row ${props.active ? "active" : ""}`}>
      <button className="conversation-open" type="button" onClick={props.onOpen} aria-current={props.active ? "true" : undefined}>
        <span className="conversation-title">{title}</span>
        <span className="conversation-meta">{conversationMeta(conversation, copy, props.now)}</span>
      </button>
      <div className="conversation-row-actions">
        <button type="button" onClick={props.onStartRename} aria-label={copy.agent.historyRename} title={copy.agent.historyRename}>
          <Pencil />
        </button>
        <button type="button" onClick={props.onAskDelete} aria-label={copy.agent.historyDelete} title={copy.agent.historyDelete}>
          <Trash2 />
        </button>
      </div>
    </div>
  );
}

// ── RecentConversations ──────────────────────────────────────

/** Shown under an empty conversation, so starting a new one never hides the earlier ones. */
export function RecentConversations(props: {
  conversations: ChatThreadSummary[];
  activeConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onShowAll: () => void;
}) {
  const copy = useAppCopy();
  const now = useMemo(() => Date.now(), [props.conversations]);
  const recent = props.conversations.filter((conversation) => conversation.id !== props.activeConversationId);
  if (!recent.length) return null;
  return (
    <section className="recent-conversations" aria-label={copy.agent.recentConversations}>
      <header>
        <h3>{copy.agent.recentConversations}</h3>
        {recent.length > 3 && (
          <button type="button" onClick={props.onShowAll}>{copy.agent.historyShowAll(recent.length)}</button>
        )}
      </header>
      {recent.slice(0, 3).map((conversation) => (
        <button
          className="recent-conversation"
          key={conversation.id}
          type="button"
          onClick={() => props.onOpenConversation(conversation.id)}
        >
          <span className="conversation-title">{conversationTitle(conversation, copy)}</span>
          <span className="conversation-meta">{conversationMeta(conversation, copy, now)}</span>
        </button>
      ))}
    </section>
  );
}
