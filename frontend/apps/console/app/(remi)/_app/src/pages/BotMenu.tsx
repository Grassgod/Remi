import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Menu, Plus, Trash2, ChevronDown, ChevronRight, Upload, Info } from "lucide-react";
import { cn } from "~remiadmin/lib/utils";
import { useBotMenuStore, type MenuItem, type MenuBehavior } from "../stores/bot-menu";

const ACTION_TYPES = [
  { value: "send_message", label: "Send Message" },
  { value: "target", label: "Open Link" },
  { value: "event_key", label: "Event Callback" },
] as const;

function emptyItem(): MenuItem {
  return { name: "", behaviors: [{ type: "send_message" }] };
}

export function BotMenu() {
  const { config, loading, syncing, dirty, error, fetch, sync, setConfig } = useBotMenuStore();

  useEffect(() => { fetch(); }, []);

  const defaultItems = config.default ?? [];

  const handleAddRoot = () => {
    setConfig({ ...config, default: [...defaultItems, emptyItem()] });
  };

  const handleUpdateRoot = (idx: number, item: MenuItem) => {
    const items = [...defaultItems];
    items[idx] = item;
    setConfig({ ...config, default: items });
  };

  const handleRemoveRoot = (idx: number) => {
    setConfig({ ...config, default: defaultItems.filter((_, i) => i !== idx) });
  };

  return (
    <Layout title="Bot Menu" subtitle="Menu Builder">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Menu className="h-4 w-4 text-muted-foreground" />
            Default Menu
            <Badge variant="secondary" className="text-[10px]">{defaultItems.length}/5</Badge>
            {dirty && <Badge variant="warning" className="text-[9px]">UNSAVED</Badge>}
            {syncing && <Badge variant="outline" className="text-[9px]">SYNCING</Badge>}
          </CardTitle>
          <Button variant="outline" size="sm" onClick={handleAddRoot} className="h-7 text-xs">
            <Plus className="mr-1 h-3 w-3" /> Add
          </Button>
        </CardHeader>
        <CardContent>
          {loading && !defaultItems.length ? (
            <div className="p-10 text-center text-xs text-muted-foreground">Loading...</div>
          ) : defaultItems.length === 0 ? (
            <div className="p-10 text-center text-xs text-muted-foreground">No menu items</div>
          ) : (
            <div className="space-y-1">
              {defaultItems.map((item, idx) => (
                <MenuItemRow
                  key={idx}
                  item={item}
                  onUpdate={(i) => handleUpdateRoot(idx, i)}
                  onRemove={() => handleRemoveRoot(idx)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={sync} disabled={syncing} className="text-xs">
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {syncing ? "Syncing..." : "Save & Sync to Feishu"}
        </Button>
        {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
      </div>

      {/* Limits */}
      <Card className="mt-3">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Info className="h-4 w-4 text-muted-foreground" />
            Limits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs text-muted-foreground">
          <div>Level 1: max <span className="text-foreground">5</span> items</div>
          <div>Level 2: max <span className="text-foreground">30</span> items, Level 3: max <span className="text-foreground">3</span></div>
          <div>Total items: max <span className="text-foreground">100</span>, size: max 300KB</div>
          <div><span className="text-foreground">behaviors</span> and <span className="text-foreground">children</span> are mutually exclusive</div>
        </CardContent>
      </Card>
    </Layout>
  );
}

function BehaviorEditor({ behavior, onChange }: { behavior: MenuBehavior; onChange: (b: MenuBehavior) => void }) {
  return (
    <div className="flex items-center gap-2">
      <select
        className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none"
        value={behavior.type}
        onChange={e => onChange({ ...behavior, type: e.target.value as MenuBehavior["type"] })}
      >
        {ACTION_TYPES.map(t => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
      {behavior.type === "target" && (
        <Input
          placeholder="URL"
          value={behavior.url ?? ""}
          onChange={e => onChange({ ...behavior, url: e.target.value })}
          className="h-7 flex-1 text-xs"
        />
      )}
      {behavior.type === "event_key" && (
        <Input
          placeholder="event_key"
          value={behavior.event_key ?? ""}
          onChange={e => onChange({ ...behavior, event_key: e.target.value })}
          className="h-7 flex-1 text-xs"
        />
      )}
      {behavior.type === "send_message" && (
        <span className="text-[10px] text-muted-foreground">Sends menu name on click</span>
      )}
    </div>
  );
}

function MenuItemRow({ item, onUpdate, onRemove, depth = 0 }: {
  item: MenuItem;
  onUpdate: (item: MenuItem) => void;
  onRemove: () => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = item.children && item.children.length > 0;

  const handleAddChild = () => {
    const children = [...(item.children ?? []), emptyItem()];
    onUpdate({ ...item, children, behaviors: undefined });
  };

  const handleRemoveChild = (idx: number) => {
    const children = (item.children ?? []).filter((_, i) => i !== idx);
    onUpdate({ ...item, children: children.length ? children : undefined });
  };

  const handleUpdateChild = (idx: number, child: MenuItem) => {
    const children = [...(item.children ?? [])];
    children[idx] = child;
    onUpdate({ ...item, children });
  };

  return (
    <div className={cn(depth > 0 && "ml-5 border-l border-border/50 pl-3")}>
      <div className="flex items-center gap-2 py-1.5">
        <button
          className="w-5 text-center text-xs text-muted-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {hasChildren ? (expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : "·"}
        </button>

        <Input
          placeholder="Menu name"
          value={item.name}
          onChange={e => onUpdate({ ...item, name: e.target.value })}
          className="h-7 w-[130px] text-xs"
        />

        <Input
          placeholder="icon token"
          value={item.icon?.token ?? ""}
          onChange={e => {
            const token = e.target.value || undefined;
            onUpdate({ ...item, icon: token ? { ...item.icon, token } : undefined });
          }}
          className="h-7 w-[100px] text-xs"
        />

        {!hasChildren && item.behaviors?.[0] ? (
          <div className="flex-1">
            <BehaviorEditor
              behavior={item.behaviors[0]}
              onChange={b => onUpdate({ ...item, behaviors: [b] })}
            />
          </div>
        ) : (
          <span className="flex-1 text-[10px] text-muted-foreground">
            {hasChildren ? `${item.children!.length} sub-items` : ""}
          </span>
        )}

        {depth < 2 && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleAddChild}>
            <Plus className="h-3 w-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {expanded && hasChildren && (
        <div>
          {item.children!.map((child, idx) => (
            <MenuItemRow
              key={idx}
              item={child}
              depth={depth + 1}
              onUpdate={c => handleUpdateChild(idx, c)}
              onRemove={() => handleRemoveChild(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
