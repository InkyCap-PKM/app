import {
  Component,
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import * as ipc from "../lib/ipc";
import {
  getEntries,
  isLoading,
  loadMore,
  getState,
} from "../stores/journal-scroll";
import { openTab } from "../stores/tabs";
import type { JournalScrollEntry } from "../lib/types";

interface JournalScrollViewProps {
  tabId: string;
  anchorPath: string;
}

const JournalScrollView: Component<JournalScrollViewProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let sentinelRef: HTMLDivElement | undefined;

  // Set up intersection observer for infinite scroll
  createEffect(() => {
    if (!sentinelRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore(props.tabId);
        }
      },
      { root: containerRef, rootMargin: "200px" },
    );

    observer.observe(sentinelRef);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="journal-scroll" ref={containerRef}>
      <For each={getEntries(props.tabId)}>
        {(entry) => (
          <JournalScrollFile entry={entry} />
        )}
      </For>
      <Show when={isLoading(props.tabId)}>
        <div class="journal-scroll__loading">Loading...</div>
      </Show>
      <Show when={!isLoading(props.tabId) && getEntries(props.tabId).length === 0}>
        <div class="journal-scroll__empty">No files found for this scroll mode.</div>
      </Show>
      <div ref={sentinelRef} class="journal-scroll__sentinel" />
    </div>
  );
};

interface JournalScrollFileProps {
  entry: JournalScrollEntry;
}

const JournalScrollFile: Component<JournalScrollFileProps> = (props) => {
  const [content] = createResource(
    () => props.entry.path,
    async (path) => ipc.readFileContent(path),
  );

  const [rendered, setRendered] = createSignal("");

  createEffect(
    on(content, (doc) => {
      if (doc === undefined) return;
      setRendered(renderMarkdownToHtml(doc));
    }),
  );

  function handleTitleClick() {
    openTab(
      {
        type: "file",
        title: props.entry.title,
        path: props.entry.path,
      },
      { forceNewTab: true },
    );
  }

  return (
    <div class="journal-scroll__file">
      <div class="journal-scroll__file-header">
        <button
          class="journal-scroll__file-title"
          onClick={handleTitleClick}
          title="Open in new tab"
        >
          {props.entry.title}
        </button>
      </div>
      <Show
        when={content() !== undefined}
        fallback={
          <div class="journal-scroll__file-loading">Loading content...</div>
        }
      >
        <div
          class="journal-scroll__file-content"
          innerHTML={rendered()}
        />
      </Show>
    </div>
  );
};

function renderMarkdownToHtml(markdown: string): string {
  let body = markdown;
  if (body.startsWith("---")) {
    const endIdx = body.indexOf("---", 3);
    if (endIdx !== -1) {
      body = body.slice(endIdx + 3).trim();
    }
  }

  const lines = body.split("\n");
  const htmlLines: string[] = [];
  let inCodeBlock = false;
  let inList = false;
  let listTag = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Code blocks
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        htmlLines.push("</code></pre>");
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        htmlLines.push("<pre><code>");
      }
      continue;
    }
    if (inCodeBlock) {
      htmlLines.push(escapeHtml(line));
      continue;
    }

    // Close list if needed
    if (inList && !line.match(/^(\s*[-*+]|\s*\d+\.)\s/)) {
      htmlLines.push(`</${listTag}>`);
      inList = false;
    }

    // Empty lines
    if (line.trim() === "") {
      if (!inList) htmlLines.push("");
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlLines.push(
        `<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`,
      );
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+$|^\*\*\*+$|^___+$/)) {
      htmlLines.push("<hr />");
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      htmlLines.push(
        `<blockquote><p>${inlineFormat(line.slice(2))}</p></blockquote>`,
      );
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listTag !== "ul") {
        if (inList) htmlLines.push(`</${listTag}>`);
        htmlLines.push("<ul>");
        inList = true;
        listTag = "ul";
      }
      htmlLines.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList || listTag !== "ol") {
        if (inList) htmlLines.push(`</${listTag}>`);
        htmlLines.push("<ol>");
        inList = true;
        listTag = "ol";
      }
      htmlLines.push(`<li>${inlineFormat(olMatch[2])}</li>`);
      continue;
    }

    // Paragraph
    htmlLines.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inCodeBlock) htmlLines.push("</code></pre>");
  if (inList) htmlLines.push(`</${listTag}>`);

  return htmlLines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineFormat(text: string): string {
  let result = escapeHtml(text);
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");
  // Italic
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  result = result.replace(/_(.+?)_/g, "<em>$1</em>");
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, "<del>$1</del>");
  // Highlight
  result = result.replace(/==(.+?)==/g, "<mark>$1</mark>");
  // Inline code
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Wikilinks
  result = result.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, target, alias) =>
      `<span class="journal-scroll__wikilink">${alias || target}</span>`,
  );
  // Markdown links
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" class="journal-scroll__link">$1</a>',
  );
  // Tags
  result = result.replace(
    /(?:^|\s)(#[a-zA-Z][\w/-]*)/g,
    ' <span class="journal-scroll__tag">$1</span>',
  );
  return result;
}

export default JournalScrollView;
