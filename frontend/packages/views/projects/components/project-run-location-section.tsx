"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, Plus } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multiremi/core/hooks";
import {
  projectDevicesOptions,
  useCreateProjectDevice,
  useDeleteProjectDevice,
} from "@multiremi/core/projects";
import { runtimeListOptions } from "@multiremi/core/runtimes/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@multiremi/ui/components/ui/combobox";
import { buildRuntimeMachines } from "../../runtimes/components/runtime-machines";
import { useT } from "../../i18n";

const EMPTY_DEVICE_RESPONSE = { devices: [], total: 0, warning: null } as const;

interface DeviceOption {
  daemonId: string;
  name: string;
  online: boolean;
  providers: string[];
}

function deviceMetadata(device: DeviceOption): string {
  return device.providers.length > 0 ? device.providers.join(" + ") : "--";
}

function DeviceStatus({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      className={`size-1.5 shrink-0 rounded-full ${online ? "bg-success" : "bg-muted-foreground/45"}`}
    />
  );
}

export function ProjectRunLocationSection({
  projectId,
  editable,
}: {
  projectId: string;
  editable: boolean;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const { data = EMPTY_DEVICE_RESPONSE, isLoading } = useQuery(
    projectDevicesOptions(wsId, projectId),
  );
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const createDevice = useCreateProjectDevice(wsId, projectId);
  const deleteDevice = useDeleteProjectDevice(wsId, projectId);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const options = useMemo<DeviceOption[]>(() => {
    const byDaemon = new Map<string, DeviceOption>();
    for (const machine of buildRuntimeMachines(runtimes, { now: Date.now() })) {
      if (!machine.daemonId) continue;
      byDaemon.set(machine.daemonId, {
        daemonId: machine.daemonId,
        name: machine.title,
        online: machine.onlineCount > 0,
        providers: machine.providerNames,
      });
    }
    for (const device of data.devices) {
      if (!byDaemon.has(device.daemon_id)) {
        byDaemon.set(device.daemon_id, {
          daemonId: device.daemon_id,
          name: device.display_name,
          online: device.online,
          providers: device.providers,
        });
      }
    }
    return [...byDaemon.values()].sort((left, right) => {
      if (left.online !== right.online) return left.online ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [data.devices, runtimes]);

  const selectedIds = useMemo(
    () => data.devices.map((device) => device.daemon_id),
    [data.devices],
  );
  const selectedOptions = useMemo(
    () => options.filter((option) => selectedIds.includes(option.daemonId)),
    [options, selectedIds],
  );
  const pendingOptions = useMemo(
    () => options.filter((option) => pendingIds.includes(option.daemonId)),
    [options, pendingIds],
  );

  useEffect(() => {
    if (data.devices.length > 0) setExpanded(true);
    if (!editing) setPendingIds(selectedIds);
  }, [data.devices.length, editing, selectedIds]);

  const beginEditing = () => {
    setPendingIds(selectedIds);
    setExpanded(true);
    setEditing(true);
  };

  const save = async () => {
    const previous = new Set(selectedIds);
    const next = new Set(pendingIds);
    try {
      await Promise.all([
        ...pendingIds.filter((id) => !previous.has(id)).map((id) => createDevice.mutateAsync(id)),
        ...selectedIds.filter((id) => !next.has(id)).map((id) => deleteDevice.mutateAsync(id)),
      ]);
      setEditing(false);
      if (pendingIds.length === 0) setExpanded(false);
      toast.success(t(($) => $.run_location.toast_saved));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.run_location.toast_failed),
      );
    }
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium">{t(($) => $.run_location.title)}</h3>
        {editable && expanded && !editing ? (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={beginEditing}>
            {t(($) => $.run_location.edit)}
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t(($) => $.run_location.loading)}
        </div>
      ) : !expanded ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2.5">
          <span className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" />
            {t(($) => $.run_location.any_device)}
          </span>
          {editable ? (
            <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={beginEditing}>
              <Plus className="size-3.5" />
              {t(($) => $.run_location.restrict)}
            </Button>
          ) : null}
        </div>
      ) : editing ? (
        <div className="space-y-2">
          <Combobox
            items={options}
            multiple
            value={pendingOptions}
            onValueChange={(next) => setPendingIds(next.map((device) => device.daemonId))}
            itemToStringLabel={(device) => device.name}
            itemToStringValue={(device) => device.daemonId}
            isItemEqualToValue={(item, value) => item.daemonId === value.daemonId}
          >
            <ComboboxChips>
              <ComboboxValue>
                {(value: DeviceOption[]) => (
                  <>
                    {value.map((device) => (
                      <ComboboxChip key={device.daemonId} aria-label={device.name}>
                        <DeviceStatus online={device.online} />
                        <span>{device.name}</span>
                        <span className="font-normal text-muted-foreground">{deviceMetadata(device)}</span>
                      </ComboboxChip>
                    ))}
                    <ComboboxChipsInput
                      aria-label={t(($) => $.run_location.search_placeholder)}
                      placeholder={value.length === 0 ? t(($) => $.run_location.search_placeholder) : ""}
                    />
                  </>
                )}
              </ComboboxValue>
            </ComboboxChips>
            <ComboboxContent>
              <ComboboxEmpty>{t(($) => $.run_location.no_devices)}</ComboboxEmpty>
              <ComboboxList>
                {(device: DeviceOption) => (
                  <ComboboxItem key={device.daemonId} value={device}>
                    <DeviceStatus online={device.online} />
                    <span className="min-w-0 flex-1 truncate">{device.name}</span>
                    <span className="text-xs text-muted-foreground">{deviceMetadata(device)}</span>
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <p className="text-xs text-muted-foreground">{t(($) => $.run_location.help)}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={createDevice.isPending || deleteDevice.isPending}
              onClick={() => {
                setPendingIds(selectedIds);
                setEditing(false);
                if (selectedIds.length === 0) setExpanded(false);
              }}
            >
              {t(($) => $.run_location.cancel)}
            </Button>
            <Button
              size="sm"
              disabled={createDevice.isPending || deleteDevice.isPending}
              onClick={() => void save()}
            >
              {t(($) => $.run_location.save)}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selectedOptions.map((device) => (
            <span
              key={device.daemonId}
              className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-muted px-2 text-xs font-medium"
            >
              <DeviceStatus online={device.online} />
              {device.name}
              <span className="font-normal text-muted-foreground">{deviceMetadata(device)}</span>
            </span>
          ))}
        </div>
      )}

      {data.warning ? (
        <p className="mt-2 text-xs text-warning">{t(($) => $.run_location.all_offline)}</p>
      ) : null}
    </section>
  );
}
