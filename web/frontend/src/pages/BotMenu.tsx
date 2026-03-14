import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { IconTrash } from "../components/icons";
import { useBotMenuStore, type MenuItem, type MenuBehavior } from "../stores/bot-menu";

const inputCls = "w-full rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground outline-none transition-colors focus:border-input";
const btnCls = "rounded-md border border-border bg-transparent px-3 py-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer";
const btnPrimary = "rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wide text-primary transition-colors hover:bg-primary/20 cursor-pointer";
const selectCls = "rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs text-foreground outline-none";

const ACTION_TYPES = [
  { value: "send_message", label: "发送消息" },
  { value: "target", label: "跳转链接" },
  { value: "event_key", label: "事件回调" },
] as const;

function emptyItem(): MenuItem {
  return { name: "", behaviors: [{ type: "send_message" }] };
}

function BehaviorEditor({ behavior, onChange }: {
  behavior: MenuBehavior;
  onChange: (b: MenuBehavior) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        className={selectCls}
        value={behavior.type}
        onChange={(e) => onChange({ ...behavior, type: e.target.value as MenuBehavior["type"] })}
      >
        {ACTION_TYPES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
      {behavior.type === "target" && (
        <input
          className={`${inputCls} flex-1`}
          placeholder="URL"
          value={behavior.url ?? ""}
          onChange={(e) => onChange({ ...behavior, url: e.target.value })}
        />
      )}
      {behavior.type === "event_key" && (
        <input
          className={`${inputCls} flex-1`}
          placeholder="event_key"
          value={behavior.event_key ?? ""}
          onChange={(e) => onChange({ ...behavior, event_key: e.target.value })}
        />
      )}
      {behavior.type === "send_message" && (
        <span className="font-mono text-[10px] text-muted-foreground">点击发送菜单名</span>
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
    <div className={`${depth > 0 ? "ml-6 border-l border-border/50 pl-3" : ""}`}>
      <div className="flex items-center gap-2 py-2">
        {/* Expand toggle for items with children */}
        <button
          className="w-5 text-center font-mono text-xs text-muted-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {hasChildren ? (expanded ? "▾" : "▸") : "·"}
        </button>

        {/* Name */}
        <input
          className={`${inputCls} !w-auto flex-[0_0_140px]`}
          placeholder="菜单名"
          value={item.name}
          onChange={(e) => onUpdate({ ...item, name: e.target.value })}
        />

        {/* Icon token */}
        <input
          className={`${inputCls} !w-auto flex-[0_0_120px]`}
          placeholder="icon token"
          value={item.icon?.token ?? ""}
          onChange={(e) => {
            const token = e.target.value || undefined;
            onUpdate({ ...item, icon: token ? { ...item.icon, token } : undefined });
          }}
        />

        {/* Behavior or "has children" indicator */}
        {!hasChildren && item.behaviors?.[0] ? (
          <div className="flex-1">
            <BehaviorEditor
              behavior={item.behaviors[0]}
              onChange={(b) => onUpdate({ ...item, behaviors: [b] })}
            />
          </div>
        ) : (
          <span className="flex-1 font-mono text-[10px] text-muted-foreground">
            {hasChildren ? `${item.children!.length} 个子菜单` : ""}
          </span>
        )}

        {/* Actions */}
        {depth < 2 && (
          <button className={`${btnCls} !px-2 !py-1`} onClick={handleAddChild} title="添加子菜单">
            +子
          </button>
        )}
        <button
          onClick={onRemove}
          className="flex items-center rounded-md border border-destructive/20 bg-transparent p-1.5 text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
        >
          <IconTrash />
        </button>
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {item.children!.map((child, idx) => (
            <MenuItemRow
              key={idx}
              item={child}
              depth={depth + 1}
              onUpdate={(c) => handleUpdateChild(idx, c)}
              onRemove={() => handleRemoveChild(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function BotMenu() {
  const {
    config, loading, syncing, dirty, error,
    fetch, sync,
    setConfig,
  } = useBotMenuStore();

  useEffect(() => { fetch(); }, []);

  const defaultItems = config.default ?? [];

  const handleAddRoot = () => {
    setConfig({
      ...config,
      default: [...defaultItems, emptyItem()],
    });
  };

  const handleUpdateRoot = (idx: number, item: MenuItem) => {
    const items = [...defaultItems];
    items[idx] = item;
    setConfig({ ...config, default: items });
  };

  const handleRemoveRoot = (idx: number) => {
    setConfig({
      ...config,
      default: defaultItems.filter((_, i) => i !== idx),
    });
  };

  return (
    <Layout
      title="Bot Menu"
      subtitle="千人千面菜单管理"
      badges={[
        ...(dirty ? [{ label: "UNSAVED", variant: "warning" as const }] : []),
        ...(syncing ? [{ label: "SYNCING", variant: "info" as const }] : []),
      ]}
    >
      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2 font-mono text-xs text-destructive">
          {error}
        </div>
      )}

      <HudPanel
        title="Default Menu"
        subtitle={`${defaultItems.length}/5 项 · 适用于所有 trigger_user_ids`}
        action={{ label: "+ 添加", onClick: handleAddRoot }}
        maxHeight={500}
      >
        {loading && !defaultItems.length ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">加载中...</div>
        ) : defaultItems.length === 0 ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">暂无菜单配置</div>
        ) : (
          <div className="px-4 py-2">
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-border pb-2 mb-1">
              <span className="w-5" />
              <span className="flex-[0_0_140px] font-mono text-[9px] uppercase tracking-widest text-muted-foreground">名称</span>
              <span className="flex-[0_0_120px] font-mono text-[9px] uppercase tracking-widest text-muted-foreground">图标</span>
              <span className="flex-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">动作</span>
              <span className="w-[80px]" />
            </div>

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
      </HudPanel>

      {/* Action bar */}
      <div className="mt-4 flex items-center gap-3">
        <button
          className={btnPrimary}
          onClick={sync}
          disabled={syncing}
        >
          {syncing ? "同步中..." : "保存并同步到飞书"}
        </button>
        {dirty && (
          <span className="font-mono text-[10px] text-warning">有未保存的更改</span>
        )}
      </div>

      {/* Limits info */}
      <div className="mt-4">
        <HudPanel title="限制说明" maxHeight={200}>
          <div className="p-4 font-mono text-xs leading-relaxed text-muted-foreground">
            <div>· 第一层菜单最多 <span className="text-foreground">5</span> 项</div>
            <div>· 第二层最多 <span className="text-foreground">30</span> 项，第三层最多 <span className="text-foreground">3</span> 项</div>
            <div>· 总菜单项不超过 <span className="text-foreground">100</span> 项，总大小不超过 300KB</div>
            <div>· <span className="text-foreground">behaviors</span> 和 <span className="text-foreground">children</span> 二选一</div>
            <div>· 千人千面菜单需先在开放平台后台配好全局默认菜单</div>
          </div>
        </HudPanel>
      </div>
    </Layout>
  );
}
