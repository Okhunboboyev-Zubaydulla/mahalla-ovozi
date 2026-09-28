import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { telegramBotClient } from './telegram-bot-client.js';
import { districtQueryKeys } from './query-keys.js';
import { TelegramBotInfo, ConnectTelegramBotResponse, DisconnectTelegramBotResponse } from '@mahalla-ovozi/api-contracts';

export function useTelegramBot(districtId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery<TelegramBotInfo | null>({
    queryKey: districtQueryKeys.bot(districtId),
    queryFn: async () => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      const response = await telegramBotClient.getDistrictTelegramBot(districtId);
      return response.bot;
    },
    enabled: !!districtId,
  });

  const connectMutation = useMutation<ConnectTelegramBotResponse, Error, { token: string }>({
    mutationFn: async ({ token }) => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramBotClient.connectDistrictTelegramBot(districtId, { token });
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.bot(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
      }
    },
  });

  const disconnectMutation = useMutation<DisconnectTelegramBotResponse, Error, void>({
    mutationFn: async () => {
      if (!districtId) {
        throw new Error('Туман танланмаган.');
      }
      return telegramBotClient.disconnectDistrictTelegramBot(districtId);
    },
    onSuccess: () => {
      if (districtId) {
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.bot(districtId),
        });
        queryClient.invalidateQueries({
          queryKey: districtQueryKeys.readiness(districtId),
        });
      }
    },
  });

  return {
    ...query,
    bot: query.data ?? null,
    connectBot: connectMutation.mutate,
    connectBotAsync: connectMutation.mutateAsync,
    isConnecting: connectMutation.isPending,
    connectError: connectMutation.error,
    resetConnectError: connectMutation.reset,
    disconnectBot: disconnectMutation.mutate,
    disconnectBotAsync: disconnectMutation.mutateAsync,
    isDisconnecting: disconnectMutation.isPending,
    disconnectError: disconnectMutation.error,
    resetDisconnectError: disconnectMutation.reset,
  };
}
