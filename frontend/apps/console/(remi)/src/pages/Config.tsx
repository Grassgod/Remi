import { useEffect, useRef, useState, useCallback } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Save, RefreshCw, AlertCircle, Check } from "lucide-react";
import * as api from "../api/client";

// CodeMirror
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { StreamLanguage } from "@codemirror/language";

// Minimal TOML tokenizer for syntax highlighting
const tomlLang = StreamLanguage.define({
  token(stream) {
    // Comments
    if (stream.match(/^#.*/)) return "comment";
    // Section headers [[...]] and [...]
    if (stream.match(/^\[\[[^\]]*\]\]/)) return "heading";
    if (stream.match(/^\[[^\]]*\]/)) return "heading";
    // Triple-quoted strings
    if (stream.match(/^"""/)) {
      while (!stream.match(/"""/, true)) {
        if (stream.next() == null) break;
      }
      return "string";
    }
    if (stream.match(/^'''/)) {
      while (!stream.match(/'''/, true)) {
        if (stream.next() == null) break;
      }
      return "string";
    }
    // Double/single quoted strings
    if (stream.match(/^"[^"]*"/)) return "string";
    if (stream.match(/^'[^']*'/)) return "string";
    // Booleans
    if (stream.match(/^(true|false)\b/)) return "atom";
    // Dates (before numbers to avoid partial match)
    if (stream.match(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/)) return "number";
    // Numbers
    if (stream.match(/^-?\d[\d_]*(\.\d[\d_]*)?(e[+-]?\d+)?/)) return "number";
    // Keys (word chars before =)
    if (stream.match(/^[a-zA-Z_][\w.-]*/)) {
      stream.eatWhile(/\s/);
      if (stream.peek() === "=") return "propertyName";
      return null;
    }
    stream.next();
    return null;
  },
});

const editorTheme = EditorView.theme({
  "&": { height: "calc(100vh - 220px)", fontSize: "13px" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-gutters": { minWidth: "40px" },
});

export function Config() {
  const [filePath, setFilePath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; line?: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const handleSave = useCallback(async () => {
    if (!viewRef.current) return;
    setSaving(true);
    setError(null);
    const text = viewRef.current.state.doc.toString();
    try {
      const result = await api.updateConfigRaw(text);
      if ("error" in result) {
        const r = result as { error: string; line?: number };
        setError({ message: r.error, line: r.line });
        if (r.line && viewRef.current) {
          const line = viewRef.current.state.doc.line(r.line);
          viewRef.current.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: "center" }),
          });
        }
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e: any) {
      setError({ message: e.message });
    }
    setSaving(false);
  }, []);

  const handleReload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { text, path } = await api.getConfigRaw();
      setFilePath(path);
      if (viewRef.current) {
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: text },
        });
      }
    } catch (e: any) {
      setError({ message: e.message });
    }
    setLoading(false);
  }, []);

  // Initialize editor
  useEffect(() => {
    let view: EditorView | null = null;

    (async () => {
      try {
        const { text, path } = await api.getConfigRaw();
        setFilePath(path);

        if (!editorRef.current) return;

        const state = EditorState.create({
          doc: text,
          extensions: [
            basicSetup,
            tomlLang,
            oneDark,
            editorTheme,
            keymap.of([{
              key: "Mod-s",
              run: () => { handleSave(); return true; },
            }]),
          ],
        });

        view = new EditorView({ state, parent: editorRef.current });
        viewRef.current = view;
      } catch (e: any) {
        setError({ message: e.message });
      }
      setLoading(false);
    })();

    return () => {
      view?.destroy();
      viewRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Layout title="Config" subtitle="REMI.TOML">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">Configuration</CardTitle>
            {filePath && (
              <Badge variant="outline" className="text-[10px] font-mono">{filePath}</Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saved && (
              <Badge variant="outline" className="border-green-500/30 text-green-500 text-[10px]">
                <Check className="mr-1 h-3 w-3" /> Saved
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={handleReload} className="h-7">
              <RefreshCw className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="sm" onClick={handleSave} disabled={saving} className="h-7 text-xs">
              <Save className="mr-1 h-3 w-3" /> {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="mx-4 mt-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error.message}{error.line ? ` (line ${error.line})` : ""}
            </div>
          )}
          {loading && (
            <div className="p-10 text-center font-mono text-xs text-muted-foreground">LOADING...</div>
          )}
          <div ref={editorRef} className={`border-t border-border ${loading ? "hidden" : ""}`} />
        </CardContent>
      </Card>
    </Layout>
  );
}
