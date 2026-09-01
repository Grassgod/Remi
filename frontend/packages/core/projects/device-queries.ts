import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ListProjectDevicesResponse } from "../types";
import { projectKeys } from "./queries";

export const projectDeviceKeys = {
  list: (wsId: string, projectId: string) =>
    [...projectKeys.detail(wsId, projectId), "devices"] as const,
};

export function projectDevicesOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: projectDeviceKeys.list(wsId, projectId),
    queryFn: () => api.listProjectDevices(projectId),
  });
}

export function useCreateProjectDevice(wsId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (daemonId: string) => api.createProjectDevice(projectId, daemonId),
    onSuccess: ({ device, warning }) => {
      queryClient.setQueryData<ListProjectDevicesResponse>(
        projectDeviceKeys.list(wsId, projectId),
        (current) => current && !current.devices.some((item) => item.daemon_id === device.daemon_id)
          ? { devices: [...current.devices, device], total: current.total + 1, warning }
          : current,
      );
    },
    onSettled: () => queryClient.invalidateQueries({
      queryKey: projectDeviceKeys.list(wsId, projectId),
    }),
  });
}

export function useDeleteProjectDevice(wsId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (daemonId: string) => api.deleteProjectDevice(projectId, daemonId),
    onMutate: async (daemonId) => {
      const queryKey = projectDeviceKeys.list(wsId, projectId);
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ListProjectDevicesResponse>(queryKey);
      queryClient.setQueryData<ListProjectDevicesResponse>(queryKey, (current) => current ? {
        devices: current.devices.filter((device) => device.daemon_id !== daemonId),
        total: Math.max(0, current.total - 1),
        warning: null,
      } : current);
      return { previous };
    },
    onError: (_error, _daemonId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(projectDeviceKeys.list(wsId, projectId), context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({
      queryKey: projectDeviceKeys.list(wsId, projectId),
    }),
  });
}

export function useReplaceProjectDevices(wsId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (daemonIds: string[]) => api.replaceProjectDevices(projectId, daemonIds),
    onSuccess: (response) => {
      queryClient.setQueryData(projectDeviceKeys.list(wsId, projectId), response);
    },
    onSettled: () => queryClient.invalidateQueries({
      queryKey: projectDeviceKeys.list(wsId, projectId),
    }),
  });
}
