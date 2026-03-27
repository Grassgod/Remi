import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Separator } from "../components/ui/separator";
import {
  BookOpen, ChevronRight, ChevronDown, FileText, FolderOpen,
  GitCommit, Clock, File,
} from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as api from "../api/client";
import type { WikiFileNode, WikiFileContent, WikiGitEntry } from "../api/types";

type FileNode = WikiFileNode;
type FileContent = WikiFileContent;
type GitLogEntry = WikiGitEntry;

export function Wiki() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [history, setHistory] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTree();
  }, []);

  useEffect(() => {
    if (selectedPath) {
      fetchFile(selectedPath);
      fetchHistory(selectedPath);
    }
  }, [selectedPath]);

  const fetchTree = async () => {
    setLoading(true);
    try {
      const data = await api.getWikiTree();
      if (data) {
        setTree(data);
        // Auto-select first file
        const first = findFirstFile(data);
        if (first) setSelectedPath(first);
      }
    } catch {}
    setLoading(false);
  };

  const fetchFile = async (path: string) => {
    try {
      const data = await api.getWikiFile(path);
      setFileContent(data);
    } catch {}
  };

  const fetchHistory = async (path: string) => {
    try {
      const data = await api.getWikiHistory(path, 10);
      setHistory(data);
    } catch {
      setHistory([]);
    }
  };

  return (
    <Layout title="Wiki" subtitle="Knowledge Base">
      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground">Loading...</div>
      ) : tree.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <BookOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">Wiki is being set up</div>
            <div className="mt-1 text-xs text-muted-foreground">
              The wiki API will browse documents from ~/.remi/wiki, soul.md, agents, and project config.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_1fr]">
          {/* File Tree */}
          <Card className="lg:sticky lg:top-0">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
                Files
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="max-h-[600px] px-2 pb-2">
                {tree.map(node => (
                  <TreeNode
                    key={node.path}
                    node={node}
                    selectedPath={selectedPath}
                    onSelect={setSelectedPath}
                    depth={0}
                  />
                ))}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Content */}
          <div className="flex flex-col gap-3">
            {fileContent ? (
              <>
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        {selectedPath?.split("/").pop()}
                      </CardTitle>
                      {fileContent.gitInfo && (
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <GitCommit className="h-3 w-3" />
                          <span>{fileContent.gitInfo.hash.slice(0, 7)}</span>
                          <Clock className="h-3 w-3" />
                          <span>{fileContent.gitInfo.date?.slice(0, 10)}</span>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {fileContent.content}
                      </ReactMarkdown>
                    </div>
                  </CardContent>
                </Card>

                {/* Git History */}
                {history.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <GitCommit className="h-4 w-4 text-muted-foreground" />
                        Version History
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      {history.map((entry, i) => (
                        <div key={entry.hash} className="flex items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-accent/30">
                          <span className="shrink-0 font-mono text-[10px] text-chart-1">{entry.hash.slice(0, 7)}</span>
                          <span className="min-w-0 flex-1 truncate text-foreground">{entry.message}</span>
                          <span className="hidden shrink-0 text-muted-foreground sm:inline">{entry.author}</span>
                          <span className="shrink-0 text-muted-foreground">{entry.date?.slice(0, 10)}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </>
            ) : (
              <Card>
                <CardContent className="p-10 text-center text-sm text-muted-foreground">
                  Select a file to view
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
}

function TreeNode({ node, selectedPath, onSelect, depth }: {
  node: FileNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isDir = node.type === "directory";
  const isSelected = selectedPath === node.path;

  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
          isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => {
          if (isDir) setExpanded(!expanded);
          else onSelect(node.path);
        }}
      >
        {isDir ? (
          expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <File className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {isDir && expanded && node.children?.map(child => (
        <TreeNode
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function findFirstFile(nodes: FileNode[]): string | null {
  for (const node of nodes) {
    if (node.type === "file") return node.path;
    if (node.children) {
      const found = findFirstFile(node.children);
      if (found) return found;
    }
  }
  return null;
}
