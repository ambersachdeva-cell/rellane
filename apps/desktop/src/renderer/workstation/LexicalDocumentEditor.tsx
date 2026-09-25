/** Rich editing is optional; exact Markdown remains authoritative until a conversion is approved. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEditor,
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  CAN_UNDO_COMMAND,
  CAN_REDO_COMMAND,
  FORMAT_TEXT_COMMAND,
  UNDO_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type EditorState,
  type LexicalEditor,
  type SerializedEditorState,
  type LexicalNode,
} from "lexical";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HeadingNode, QuoteNode, $createHeadingNode, $isHeadingNode, type HeadingTagType } from "@lexical/rich-text";
import { ListNode, ListItemNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND, $isListNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { CodeNode } from "@lexical/code";
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from "@lexical/markdown";
import { VersionDiffView } from "./VersionDiff.js";

export const MAX_EDITOR_CHAR_BUDGET = 50_000;

export const lexicalWorkstationTheme = {
  paragraph: "ws-prose-p",
  heading: { h1: "ws-prose-h1", h2: "ws-prose-h2", h3: "ws-prose-h3", h4: "ws-prose-h4", h5: "ws-prose-h5", h6: "ws-prose-h6" },
  quote: "ws-prose-blockquote",
  list: { nested: { listitem: "ws-prose-nested-listitem" }, ol: "ws-prose-ol", ul: "ws-prose-ul", listitem: "ws-prose-li" },
  link: "ws-prose-link",
  text: { bold: "ws-prose-bold", italic: "ws-prose-italic", underline: "ws-prose-underline", strikethrough: "ws-prose-strikethrough", code: "ws-prose-code" },
  code: "ws-prose-code-block",
};

export function validateEditorUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed, "https://internal-domain.local");
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function checkKnownLimitations(markdown: string): string | null {
  if (markdown.length > MAX_EDITOR_CHAR_BUDGET) return `Document exceeds ${MAX_EDITOR_CHAR_BUDGET.toLocaleString()} character budget for rich text editing.`;
  const codeFree = markdown.replace(/```[\s\S]*?```|`[^`\n]+`/g, "");
  if (/(?:^|\n)\|[^\n]+\|\r?\n\|[-:\s|]+\|/.test(codeFree)) return "Markdown tables are not supported in the rich text editor.";
  if (/<[a-zA-Z][\s\S]*?>/.test(codeFree)) return "Raw HTML tags are not supported in the rich text editor.";
  if (/!\[.*?\]\(.*?\)/.test(codeFree)) return "Markdown images are not supported in the rich text editor.";
  return null;
}

export interface MarkdownCompatibilityResult {
  readonly isSupported: boolean;
  readonly features: readonly { readonly kind: string; readonly label: string; readonly sample: string; readonly line: number }[];
  readonly warnings: readonly string[];
}

export function inspectMarkdownCompatibility(markdown: string): MarkdownCompatibilityResult {
  const limitation = checkKnownLimitations(markdown);
  if (!limitation) return { isSupported: true, features: [], warnings: [] };
  return { isSupported: false, features: [{ kind: "limitation", label: limitation, sample: "", line: 1 }], warnings: [limitation] };
}

const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, CodeNode];

export function testMarkdownRoundTrip(markdown: string) {
  try {
    const editor = createEditor({ nodes: EDITOR_NODES });
    editor.update(() => { $convertFromMarkdownString(markdown, TRANSFORMERS); }, { discrete: true });
    const editorState = editor.getEditorState();
    let converted = "";
    editorState.read(() => { converted = $convertToMarkdownString(TRANSFORMERS); });
    return { converted, isLossless: converted === markdown, editorState };
  } catch (err) {
    return { converted: markdown, isLossless: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export interface LexicalDocumentEditorChange {
  readonly markdown: string;
  readonly editorState: EditorState | null;
  readonly serializedState?: SerializedEditorState;
}

export interface LexicalDocumentEditorProps {
  readonly documentKey: string;
  readonly resetRevision?: number | string;
  readonly initialMarkdown: string;
  readonly readOnly?: boolean;
  readonly onChange?: (change: LexicalDocumentEditorChange) => void;
  readonly onError?: (error: Error, fallbackMarkdown: string) => void;
  readonly onRequestSource?: () => void;
  readonly onFallbackToSource?: () => void;
  readonly onCompatibilityNotice?: (result: MarkdownCompatibilityResult) => void;
  readonly className?: string;
  readonly placeholder?: string;
  readonly editorRef?: React.MutableRefObject<LexicalEditor | null>;
}

function ReadOnlyPlugin({ readOnly }: { readOnly: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => { editor.setEditable(!readOnly); }, [editor, readOnly]);
  return null;
}

function EditorRefPlugin({ editorRef }: { editorRef?: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (editorRef) { editorRef.current = editor; return () => { editorRef.current = null; }; }
  }, [editor, editorRef]);
  return null;
}

function MarkdownChangePlugin({ onChange }: { onChange: (state: EditorState) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
    if (dirtyElements.size > 0 || dirtyLeaves.size > 0) onChange(editorState);
  }), [editor, onChange]);
  return null;
}

function LexicalToolbar({ readOnly }: { readOnly?: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [blockType, setBlockType] = useState<"paragraph" | "h1" | "h2" | "h3" | "ul" | "ol">("paragraph");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateToolbar = useCallback(() => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) {
      setIsBold(sel.hasFormat("bold"));
      setIsItalic(sel.hasFormat("italic"));
      let el: LexicalNode | null = sel.anchor.getNode();
      while (el && !$isListNode(el) && !$isHeadingNode(el)) {
        const parent: LexicalNode | null = el.getParent();
        if (!parent || parent === $getRoot()) break;
        el = parent;
      }
      if ($isHeadingNode(el)) {
        const t = el.getTag();
        setBlockType(t === "h1" || t === "h2" || t === "h3" ? t : "paragraph");
      } else if ($isListNode(el)) {
        setBlockType(el.getListType() === "number" ? "ol" : "ul");
      } else {
        setBlockType("paragraph");
      }
    }
  }, []);

  useEffect(() => {
    const uSel = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => { updateToolbar(); return false; }, COMMAND_PRIORITY_LOW);
    const uUp = editor.registerUpdateListener(({ editorState }) => { editorState.read(updateToolbar); });
    const uUndo = editor.registerCommand(CAN_UNDO_COMMAND, (p: boolean) => { setCanUndo(p); return false; }, COMMAND_PRIORITY_CRITICAL);
    const uRedo = editor.registerCommand(CAN_REDO_COMMAND, (p: boolean) => { setCanRedo(p); return false; }, COMMAND_PRIORITY_CRITICAL);
    return () => { uSel(); uUp(); uUndo(); uRedo(); };
  }, [editor, updateToolbar]);

  const formatHeading = useCallback((tag: HeadingTagType) => {
    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) {
        const top = sel.anchor.getNode().getTopLevelElementOrThrow();
        if ($isHeadingNode(top) && top.getTag() === tag) {
          const p = $createParagraphNode();
          for (const c of top.getChildren()) p.append(c);
          top.replace(p);
        } else {
          const h = $createHeadingNode(tag);
          for (const c of top.getChildren()) h.append(c);
          top.replace(h);
        }
      }
    });
  }, [editor]);

  return (
    <div className="ws-editor-toolbar ws-lexical-toolbar" role="toolbar" aria-label="Formatting options">
      <div className="ws-segmented" role="group" aria-label="Text styling">
        <button type="button" className="ws-button ws-button--small" aria-label="Format bold" aria-pressed={isBold} disabled={readOnly} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}><strong>B</strong></button>
        <button type="button" className="ws-button ws-button--small" aria-label="Format italic" aria-pressed={isItalic} disabled={readOnly} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}><em>I</em></button>
      </div>
      <div className="ws-segmented" role="group" aria-label="Headings">
        {( ["h1", "h2", "h3"] as const).map((t) => (
          <button key={t} type="button" className="ws-button ws-button--small" aria-label={`Heading ${t.slice(1)}`} aria-pressed={blockType === t} disabled={readOnly} onClick={() => formatHeading(t)}>{t.toUpperCase()}</button>
        ))}
      </div>
      <div className="ws-segmented" role="group" aria-label="Lists">
        <button type="button" className="ws-button ws-button--small" aria-label="Bullet list" aria-pressed={blockType === "ul"} disabled={readOnly} onClick={() => editor.dispatchCommand(blockType === "ul" ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined)}>• List</button>
        <button type="button" className="ws-button ws-button--small" aria-label="Numbered list" aria-pressed={blockType === "ol"} disabled={readOnly} onClick={() => editor.dispatchCommand(blockType === "ol" ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined)}>1. List</button>
      </div>
      <div className="ws-segmented" role="group" aria-label="History">
        <button type="button" className="ws-button ws-button--small" aria-label="Undo" disabled={readOnly || !canUndo} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>Undo</button>
        <button type="button" className="ws-button ws-button--small" aria-label="Redo" disabled={readOnly || !canRedo} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>Redo</button>
      </div>
    </div>
  );
}

function LexicalDocumentEditorInner({
  initialMarkdown: incomingMarkdown,
  readOnly = false,
  onChange,
  onError,
  onRequestSource,
  onFallbackToSource,
  onCompatibilityNotice,
  className = "",
  placeholder = "Start writing...",
  editorRef,
}: LexicalDocumentEditorProps) {
  const initialMarkdown = useRef(incomingMarkdown).current;
  const [editorError, setEditorError] = useState<Error | null>(null);
  const [acceptedConversion, setAcceptedConversion] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(initialMarkdown);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const limitation = useMemo(() => checkKnownLimitations(initialMarkdown), [initialMarkdown]);
  useEffect(() => {
    if (limitation) onCompatibilityNotice?.({ isSupported: false, features: [{ kind: "limitation", label: limitation, sample: "", line: 1 }], warnings: [limitation] });
  }, [limitation, onCompatibilityNotice]);

  const conversion = useMemo(() => testMarkdownRoundTrip(initialMarkdown), [initialMarkdown]);
  const lastEmittedMarkdownRef = useRef(conversion.converted);
  const handleEditorCatch = useCallback((err: Error) => { setEditorError(err); onErrorRef.current?.(err, initialMarkdown); }, [initialMarkdown]);
  useEffect(() => { if (conversion.error) handleEditorCatch(conversion.error); }, [conversion.error, handleEditorCatch]);

  const handleLexicalChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const markdown = $convertToMarkdownString(TRANSFORMERS);
      if (markdown === lastEmittedMarkdownRef.current) return;
      lastEmittedMarkdownRef.current = markdown;
      onChangeRef.current?.({ markdown, editorState, serializedState: editorState.toJSON() });
    });
  }, []);

  const handleAcceptConversion = useCallback(() => {
    setAcceptedConversion(true);
    if (conversion.editorState) {
      onChangeRef.current?.({ markdown: conversion.converted, editorState: conversion.editorState, serializedState: conversion.editorState.toJSON() });
    }
  }, [conversion]);

  const handleKeepSource = useCallback(() => {
    setSourceMode(true);
    (onRequestSource ?? onFallbackToSource)?.();
  }, [onRequestSource, onFallbackToSource]);

  const handleSourceChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setSourceDraft(val);
    onChangeRef.current?.({ markdown: val, editorState: null });
  }, []);

  const handleEditorClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("a")) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  const initialConfig = useMemo<InitialConfigType>(() => {
    const content = acceptedConversion ? conversion.converted : initialMarkdown;
    return {
      namespace: "RellaneLexicalDocumentEditor",
      theme: lexicalWorkstationTheme,
      nodes: EDITOR_NODES,
      onError: handleEditorCatch,
      editable: !readOnly,
      editorState: () => {
        try { if (content) $convertFromMarkdownString(content, TRANSFORMERS); }
        catch (err) { handleEditorCatch(err instanceof Error ? err : new Error(String(err))); }
      },
    };
  }, [acceptedConversion, conversion.converted, initialMarkdown, handleEditorCatch, readOnly]);

  const renderFallback = (message: string, alertRole = false) => (
    <div className={`ws-lexical-document-editor ws-lexical-source-fallback ${className}`}>
      <div className="ws-version-history" role="region" aria-label="Source fallback notice">
        <p className="ws-inline-problem" {...(alertRole ? { role: "alert" } : {})}><strong>Source editing:</strong> {message}</p>
        <button type="button" className="ws-button ws-button--small ws-button--primary" onClick={handleKeepSource}>Keep source editing</button>
      </div>
      <div className="ws-editor-paper">
        <textarea className="ws-document-input ws-source-textarea" aria-label="Plain source editor" readOnly={readOnly} value={sourceDraft} onChange={handleSourceChange} />
      </div>
    </div>
  );

  if (editorError) return renderFallback(`Rich text error: ${editorError.message}`, true);
  if (limitation) return renderFallback(limitation, true);
  if (!conversion.isLossless && !acceptedConversion && !sourceMode) {
    return (
      <div className={`ws-lexical-document-editor ws-lexical-conversion-guard ${className}`} role="region" aria-label="Conversion preview">
        <div className="ws-version-history">
          <p className="ws-inline-problem"><strong>Conversion difference detected:</strong> Opening in rich text will adjust formatting.</p>
          <div className="ws-button-group">
            <button type="button" className="ws-button ws-button--small ws-button--primary" onClick={handleAcceptConversion}>Use rich editor</button>
            <button type="button" className="ws-button ws-button--small" onClick={handleKeepSource}>Keep source editing</button>
          </div>
        </div>
        <VersionDiffView before={initialMarkdown} after={conversion.converted} beforeLabel="Original Markdown" afterLabel="Rich Editor Conversion" />
      </div>
    );
  }
  if (sourceMode) return renderFallback("Source editing mode active.");

  return (
    <div className={`ws-lexical-document-editor ${className}`} onClickCapture={handleEditorClick}>
      <LexicalComposer initialConfig={initialConfig}>
        <ReadOnlyPlugin readOnly={readOnly} />
        <EditorRefPlugin {...(editorRef ? { editorRef } : {})} />
        <LexicalToolbar readOnly={readOnly} />
        <div className="ws-editor-paper">
          <div className="ws-prose ws-document ws-lexical-container">
            <RichTextPlugin
              contentEditable={<ContentEditable className="ws-document-input ws-lexical-input" aria-label="Rich text document content" aria-readonly={readOnly} />}
              placeholder={<div className="ws-lexical-placeholder" aria-hidden="true">{placeholder}</div>}
              ErrorBoundary={LexicalErrorBoundary}
            />
          </div>
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin validateUrl={validateEditorUrl} />
        <MarkdownChangePlugin onChange={handleLexicalChange} />
      </LexicalComposer>
    </div>
  );
}

export function LexicalDocumentEditor(props: LexicalDocumentEditorProps) {
  const identityKey = `${props.documentKey}:${props.resetRevision ?? "initial"}`;
  return <LexicalDocumentEditorInner key={identityKey} {...props} />;
}
