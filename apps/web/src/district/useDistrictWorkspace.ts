import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  District,
  DistrictReadiness,
  TelegramBotInfo,
  TelegramGroupMapping,
  DistrictHokimAccount,
  HokimAccountStateEnum,
  ConfirmDisclosureResponse,
  ActivateDistrictResponse,
  ConnectTelegramBotResponse,
  DisconnectTelegramBotResponse,
  CreateTelegramGroupRequest,
  CreateTelegramGroupResponse,
  UpdateTelegramGroupRequest,
  UpdateTelegramGroupResponse,
  DeleteTelegramGroupResponse,
  StartGroupTestResponse,
  SimulateTestMessageRequest,
  SimulateTestMessageResponse,
  CreateHokimAccountResponse,
  ResetHokimPasswordResponse,
  DisableHokimAccountResponse,
  ReplaceHokimAccountResponse,
} from '@mahalla-ovozi/api-contracts';
import { districtClient } from './district-client.js';
import { telegramBotClient } from './telegram-bot-client.js';
import { telegramGroupClient } from './telegram-group-client.js';
import { hokimAccountClient } from './hokim-account-client.js';
import { useDistrict } from './district-context.js';
import { districtQueryKeys, type DistrictQueryKeys } from './query-keys.js';
import { ApiError } from '../lib/api-client.js';

export { districtQueryKeys, type DistrictQueryKeys };

/* ── Options & Facade Interface ── */

export interface UseDistrictWorkspaceOptions {
  districtId?: string | null;
  includeDetails?: boolean;
  includeReadiness?: boolean;
  includeBot?: boolean;
  includeGroups?: boolean;
  includeHokim?: boolean;
}

export interface DistrictWorkspace {
  districtId: string | null;

  // Domain Data
  district: District | null;
  readiness: DistrictReadiness | null;
  bot: TelegramBotInfo | null;
  groups: TelegramGroupMapping[];
  hokimState: HokimAccountStateEnum;
  hokimAccount: DistrictHokimAccount | null;

  // Aggregate States
  isLoading: boolean;
  isRefreshing: boolean;
  isError: boolean;
  isActivationReady: boolean;
  isAlreadyActive: boolean;
  passedCount: number;
  totalCount: number;

  // Mutation Pending States
  isActivating: boolean;
  activationError: Error | null;
  isConfirmingDisclosure: boolean;
  isConnectingBot: boolean;
  isDisconnectingBot: boolean;
  isCreatingGroup: boolean;
  isUpdatingGroup: boolean;
  isDeletingGroup: boolean;
  isStartingGroupTest: boolean;
  isSimulatingGroupMessage: boolean;
  isCreatingHokim: boolean;
  isResettingHokimPassword: boolean;
  isDisablingHokim: boolean;
  isReplacingHokim: boolean;

  // Action Handlers
  confirmDisclosure: () => Promise<ConfirmDisclosureResponse>;
  activateDistrict: () => Promise<ActivateDistrictResponse>;
  connectBot: (token: string) => Promise<ConnectTelegramBotResponse>;
  disconnectBot: () => Promise<DisconnectTelegramBotResponse>;
  createGroup: (payload: CreateTelegramGroupRequest) => Promise<CreateTelegramGroupResponse>;
  updateGroup: (groupId: string, payload: UpdateTelegramGroupRequest) => Promise<UpdateTelegramGroupResponse>;
  deleteGroup: (groupId: string) => Promise<DeleteTelegramGroupResponse>;
  startGroupTest: (groupId: string) => Promise<StartGroupTestResponse>;
  simulateGroupMessage: (groupId: string, payload: SimulateTestMessageRequest) => Promise<SimulateTestMessageResponse>;
  createHokimAccount: (username: string) => Promise<CreateHokimAccountResponse>;
  resetHokimPassword: () => Promise<ResetHokimPasswordResponse>;
  disableHokimAccount: () => Promise<DisableHokimAccountResponse>;
  replaceHokimAccount: (newUsername: string) => Promise<ReplaceHokimAccountResponse>;

  // Lifecycle & Cache Operations
  invalidateReadiness: () => Promise<void>;
  invalidateWorkspace: () => Promise<void>;
  refetchAll: () => Promise<void>;
}

/* ── Deep Facade Hook Implementation ── */

export function useDistrictWorkspace(
  optionsOrDistrictId?: string | null | UseDistrictWorkspaceOptions
): DistrictWorkspace {
  const queryClient = useQueryClient();
  const districtContext = useDistrict();

  const options: UseDistrictWorkspaceOptions =
    typeof optionsOrDistrictId === 'string' || optionsOrDistrictId === null
      ? { districtId: optionsOrDistrictId }
      : optionsOrDistrictId ?? {};

  const districtId =
    options.districtId !== undefined ? options.districtId : districtContext.activeDistrictId;

  const includeDetails = options.includeDetails ?? true;
  const includeReadiness = options.includeReadiness ?? true;
  const includeBot = options.includeBot ?? true;
  const includeGroups = options.includeGroups ?? true;
  const includeHokim = options.includeHokim ?? true;

  const isEnabled = Boolean(districtId);

  /* ── 1. Sub-Resource Queries ── */

  const detailsQuery = useQuery({
    queryKey: districtQueryKeys.district(districtId),
    queryFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return districtClient.getDistrict(districtId);
    },
    select: (res) => res.district,
    enabled: isEnabled && includeDetails,
  });

  const readinessQuery = useQuery({
    queryKey: districtQueryKeys.readiness(districtId),
    queryFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      const res = await districtClient.getDistrictReadiness(districtId);
      return res.readiness;
    },
    enabled: isEnabled && includeReadiness,
  });

  const botQuery = useQuery({
    queryKey: districtQueryKeys.bot(districtId),
    queryFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      const res = await telegramBotClient.getDistrictTelegramBot(districtId);
      return res.bot;
    },
    enabled: isEnabled && includeBot,
  });

  const groupsQuery = useQuery({
    queryKey: districtQueryKeys.groups(districtId),
    queryFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      const res = await telegramGroupClient.listGroups(districtId);
      return res.groups;
    },
    enabled: isEnabled && includeGroups,
  });

  const hokimQuery = useQuery({
    queryKey: districtQueryKeys.hokim(districtId),
    queryFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return hokimAccountClient.getDistrictHokimAccount(districtId);
    },
    enabled: isEnabled && includeHokim,
  });

  /* ── 2. Cache Invalidation Helpers ── */

  const invalidateReadiness = useCallback(async () => {
    if (!districtId) return;
    await queryClient.invalidateQueries({
      queryKey: districtQueryKeys.readiness(districtId),
    });
  }, [queryClient, districtId]);

  const invalidateWorkspace = useCallback(async () => {
    if (!districtId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: districtQueryKeys.district(districtId) }),
      queryClient.invalidateQueries({ queryKey: districtQueryKeys.readiness(districtId) }),
      queryClient.invalidateQueries({ queryKey: districtQueryKeys.bot(districtId) }),
      queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) }),
      queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) }),
    ]);
  }, [queryClient, districtId]);

  /* ── 3. Action Mutations with Automatic Invalidation ── */

  const confirmDisclosureMutation = useMutation({
    mutationFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return districtClient.confirmDisclosure(districtId);
    },
    onSuccess: async () => {
      await invalidateReadiness();
    },
    onError: (err) => {
      console.error('Confirm disclosure failed:', err);
    },
  });

  const activateDistrictMutation = useMutation({
    mutationFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return districtClient.activateDistrict(districtId);
    },
    onSuccess: async (data) => {
      if (districtId) {
        queryClient.setQueryData(districtQueryKeys.district(districtId), { district: data.district });
        await Promise.all([
          invalidateReadiness(),
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.list() }),
        ]);
      }
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'DISTRICT_ALREADY_ACTIVE' && districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.district(districtId) }),
          invalidateReadiness(),
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.list() }),
        ]);
      }
    },
  });

  const connectBotMutation = useMutation({
    mutationFn: async (token: string) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return telegramBotClient.connectDistrictTelegramBot(districtId, { token });
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.bot(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Connect bot failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.bot(districtId) });
    },
  });

  const disconnectBotMutation = useMutation({
    mutationFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return telegramBotClient.disconnectDistrictTelegramBot(districtId);
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.bot(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Disconnect bot failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.bot(districtId) });
    },
  });

  const createGroupMutation = useMutation({
    mutationFn: async (payload: CreateTelegramGroupRequest) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return telegramGroupClient.createGroup(districtId, payload);
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Group mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) });
    },
  });

  const updateGroupMutation = useMutation({
    mutationFn: async ({ groupId, payload }: { groupId: string; payload: UpdateTelegramGroupRequest }) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return telegramGroupClient.updateGroup(districtId, groupId, payload);
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Group mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) });
    },
  });

  const deleteGroupMutation = useMutation({
    mutationFn: async (groupId: string) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return telegramGroupClient.deleteGroup(districtId, groupId);
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Group mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) });
    },
  });

  const startGroupTestMutation = useMutation({
    mutationFn: async (groupId: string) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return telegramGroupClient.startTest(districtId, groupId);
    },
    onSuccess: async () => {
      if (districtId) {
        await queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) });
      }
    },
    onError: (err) => {
      console.error('Group mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) });
    },
  });

  const simulateGroupMessageMutation = useMutation({
    mutationFn: async ({ groupId, payload }: { groupId: string; payload: SimulateTestMessageRequest }) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return telegramGroupClient.simulateTestMessage(districtId, groupId, payload);
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Group mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.groups(districtId) });
    },
  });

  const createHokimMutation = useMutation({
    mutationFn: async (username: string) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return hokimAccountClient.createDistrictHokimAccount(districtId, { username });
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Hokim mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) });
    },
  });

  const resetHokimPasswordMutation = useMutation({
    mutationFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return hokimAccountClient.resetDistrictHokimPassword(districtId);
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Hokim mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) });
    },
  });

  const disableHokimMutation = useMutation({
    mutationFn: async () => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return hokimAccountClient.disableDistrictHokimAccount(districtId);
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Hokim mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) });
    },
  });

  const replaceHokimMutation = useMutation({
    mutationFn: async (newUsername: string) => {
      if (!districtId) throw new Error('Туман танланмаган.');
      return hokimAccountClient.replaceDistrictHokimAccount(districtId, { newUsername });
    },
    onSuccess: async () => {
      if (districtId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) }),
          invalidateReadiness(),
        ]);
      }
    },
    onError: (err) => {
      console.error('Hokim mutation failed:', err);
      if (districtId) queryClient.invalidateQueries({ queryKey: districtQueryKeys.hokim(districtId) });
    },
  });

  /* ── 4. Derived & Aggregate States ── */

  const readiness = readinessQuery.data ?? null;
  const district = detailsQuery.data ?? null;
  const bot = botQuery.data ?? null;
  const groups = groupsQuery.data ?? [];
  const hokimData = hokimQuery.data;

  const isLoading =
    (includeDetails && detailsQuery.isLoading) ||
    (includeReadiness && readinessQuery.isLoading) ||
    (includeBot && botQuery.isLoading) ||
    (includeGroups && groupsQuery.isLoading) ||
    (includeHokim && hokimQuery.isLoading);

  const isRefreshing =
    (includeDetails && detailsQuery.isFetching && !detailsQuery.isLoading) ||
    (includeReadiness && readinessQuery.isFetching && !readinessQuery.isLoading) ||
    (includeBot && botQuery.isFetching && !botQuery.isLoading) ||
    (includeGroups && groupsQuery.isFetching && !groupsQuery.isLoading) ||
    (includeHokim && hokimQuery.isFetching && !hokimQuery.isLoading);

  const isError =
    (includeDetails && detailsQuery.isError) ||
    (includeReadiness && readinessQuery.isError) ||
    (includeBot && botQuery.isError) ||
    (includeGroups && groupsQuery.isError) ||
    (includeHokim && hokimQuery.isError);

  const isAlreadyActive =
    readiness?.status === 'ACTIVE' || district?.status === 'ACTIVE';

  const isActivationReady = readiness?.isActivationReady ?? false;
  const passedCount = readiness?.passedCount ?? 0;
  const totalCount = readiness?.totalCount ?? 8;

  const refetchAll = useCallback(async () => {
    const promises: Promise<unknown>[] = [];
    if (includeDetails) promises.push(detailsQuery.refetch());
    if (includeReadiness) promises.push(readinessQuery.refetch());
    if (includeBot) promises.push(botQuery.refetch());
    if (includeGroups) promises.push(groupsQuery.refetch());
    if (includeHokim) promises.push(hokimQuery.refetch());
    await Promise.all(promises);
  }, [includeDetails, includeReadiness, includeBot, includeGroups, includeHokim, detailsQuery, readinessQuery, botQuery, groupsQuery, hokimQuery]);

  return {
    districtId,

    district,
    readiness,
    bot,
    groups,
    hokimState: hokimData?.state ?? 'NO_ACCOUNT',
    hokimAccount: hokimData?.account ?? null,

    isLoading,
    isRefreshing,
    isError,
    isActivationReady,
    isAlreadyActive,
    passedCount,
    totalCount,

    isActivating: activateDistrictMutation.isPending,
    activationError: activateDistrictMutation.error,
    isConfirmingDisclosure: confirmDisclosureMutation.isPending,
    isConnectingBot: connectBotMutation.isPending,
    isDisconnectingBot: disconnectBotMutation.isPending,
    isCreatingGroup: createGroupMutation.isPending,
    isUpdatingGroup: updateGroupMutation.isPending,
    isDeletingGroup: deleteGroupMutation.isPending,
    isStartingGroupTest: startGroupTestMutation.isPending,
    isSimulatingGroupMessage: simulateGroupMessageMutation.isPending,
    isCreatingHokim: createHokimMutation.isPending,
    isResettingHokimPassword: resetHokimPasswordMutation.isPending,
    isDisablingHokim: disableHokimMutation.isPending,
    isReplacingHokim: replaceHokimMutation.isPending,

    confirmDisclosure: confirmDisclosureMutation.mutateAsync,
    activateDistrict: activateDistrictMutation.mutateAsync,
    connectBot: (token: string) => connectBotMutation.mutateAsync(token),
    disconnectBot: () => disconnectBotMutation.mutateAsync(),
    createGroup: (payload: CreateTelegramGroupRequest) => createGroupMutation.mutateAsync(payload),
    updateGroup: (groupId: string, payload: UpdateTelegramGroupRequest) =>
      updateGroupMutation.mutateAsync({ groupId, payload }),
    deleteGroup: (groupId: string) => deleteGroupMutation.mutateAsync(groupId),
    startGroupTest: (groupId: string) => startGroupTestMutation.mutateAsync(groupId),
    simulateGroupMessage: (groupId: string, payload: SimulateTestMessageRequest) =>
      simulateGroupMessageMutation.mutateAsync({ groupId, payload }),
    createHokimAccount: (username: string) => createHokimMutation.mutateAsync(username),
    resetHokimPassword: () => resetHokimPasswordMutation.mutateAsync(),
    disableHokimAccount: () => disableHokimMutation.mutateAsync(),
    replaceHokimAccount: (newUsername: string) => replaceHokimMutation.mutateAsync(newUsername),

    invalidateReadiness,
    invalidateWorkspace,
    refetchAll,
  };
}
