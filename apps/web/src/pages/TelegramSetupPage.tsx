import { useState, useCallback } from 'react';
import {
  Card,
  Typography,
  Space,
  Form,
  Input,
  Button,
  Alert,
  Tag,
  Descriptions,
  Spin,
  Empty,
  Divider,
} from 'antd';
import {
  RobotOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
  DisconnectOutlined,
  LockOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useDistrict } from '../district/district-context.js';
import { useTelegramBot } from '../district/useTelegramBot.js';
import { districtClient } from '../district/district-client.js';
import { districtQueryKeys } from '../district/query-keys.js';
import { useQuery } from '@tanstack/react-query';
import { TelegramGroupTable } from '../components/TelegramGroupTable.js';
import { ReplaceBotModal } from '../components/ReplaceBotModal.js';
import { DisconnectBotModal } from '../components/DisconnectBotModal.js';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';
import { themeColors } from '../theme/antd-theme.js';

const { Title, Text } = Typography;

const BOT_TOKEN_REGEX = /^\d{6,16}:[a-zA-Z0-9_-]{20,50}$/;

export interface TelegramSetupPageProps {
  districtId?: string;
}

export function TelegramSetupPage({ districtId }: TelegramSetupPageProps) {
  const { activeDistrictId: contextDistrictId } = useDistrict();
  const effectiveDistrictId = districtId ?? contextDistrictId;

  const { data: districtResponse } = useQuery({
    queryKey: districtQueryKeys.district(effectiveDistrictId),
    queryFn: () => (effectiveDistrictId ? districtClient.getDistrict(effectiveDistrictId) : null),
    enabled: !!effectiveDistrictId,
  });
  const activeDistrict = districtResponse?.district ?? null;

  const {
    bot,
    isLoading,
    error,
    connectBot,
    isConnecting,
    connectError,
    resetConnectError,
    disconnectBot,
    isDisconnecting,
    disconnectError,
    resetDisconnectError,
  } = useTelegramBot(effectiveDistrictId);

  const isOffline = useOnlineStatus();
  const [isReplaceModalOpen, setIsReplaceModalOpen] = useState(false);
  const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false);

  const [connectForm] = Form.useForm();

  const handleOpenReplaceModal = useCallback(() => {
    resetConnectError();
    setIsReplaceModalOpen(true);
  }, [resetConnectError]);

  const handleOpenDisconnectModal = useCallback(() => {
    resetDisconnectError();
    setIsDisconnectModalOpen(true);
  }, [resetDisconnectError]);

  const handleConnectSubmit = useCallback(
    (values: { token: string }) => {
      connectBot(
        { token: values.token.trim() },
        {
          onSuccess: () => {
            connectForm.resetFields();
          },
        },
      );
    },
    [connectBot, connectForm],
  );

  const handleReplaceSubmit = useCallback(
    (values: { token: string }) => {
      connectBot(
        { token: values.token.trim() },
        {
          onSuccess: () => {
            setIsReplaceModalOpen(false);
          },
        },
      );
    },
    [connectBot],
  );

  const handleDisconnectConfirm = useCallback(() => {
    disconnectBot(undefined, {
      onSuccess: () => {
        setIsDisconnectModalOpen(false);
      },
    });
  }, [disconnectBot]);

  if (!activeDistrict) {
    return (
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
        <Title level={2}>Telegram бот созламалари</Title>
        <Card>
          <Empty
            description={
              <Space direction="vertical" align="center">
                <Text strong>Туман танланмаган</Text>
                <Text type="secondary">
                  Telegram ботни созлаш учун аввал юқоридаги танлагичдан туманни танланг.
                </Text>
              </Space>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <Title level={2} style={{ marginBottom: '4px' }}>
            Telegram бот созламалари
          </Title>
          <Text type="secondary">
            {activeDistrict.name} тумани учун хабарларни йиғиш ва қайта ишлаш ботини бошқариш.
          </Text>
        </div>

        {isOffline && (
          <Alert
            message="Тармоқ алоқаси йўқ"
            description="Офлайн ҳолатда бот созламаларини ўзгартириб бўлмайди. Илтимос, интернет алоқасини текширинг."
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            style={{ minHeight: '44px' }}
          />
        )}

        {isLoading ? (
          <Card style={{ textAlign: 'center', padding: '48px 0' }}>
            <Spin size="large" tip="Бот маълумотлари юкланмоқда..." />
          </Card>
        ) : error ? (
          <Alert
            message="Бот маълумотларини юклашда хатолик"
            description={error.message || 'Сервер билан алоқада хатолик юз берди.'}
            type="error"
            showIcon
          />
        ) : bot && bot.status === 'VALID' ? (
          <>
          <Card
            title={
              <Space>
                <RobotOutlined style={{ fontSize: '20px', color: themeColors.colorPrimary }} />
                <span>Бириктирилган Telegram бот</span>
              </Space>
            }
            extra={<Tag color="success" icon={<CheckCircleOutlined />}>ФАОЛ / УЛАНГАН</Tag>}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Descriptions bordered column={1} size="middle">
                <Descriptions.Item label="Бот номи">
                  <Text strong>{bot.botFirstName}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="Telegram юзернейми">
                  <Text copyable strong>
                    {bot.botUsername ? `@${bot.botUsername}` : 'Юзернеймсиз'}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="Бот ID">
                  <Text code>{bot.botId}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="Токен кўриниши">
                  <Space>
                    <Text code>{bot.tokenMasked}</Text>
                    <Tag color="blue" icon={<LockOutlined />}>AES-256-GCM билан ҳимояланган</Tag>
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="Охирги текширилган вақт">
                  <Text type="secondary">
                    {new Date(bot.lastValidatedAt).toLocaleString('uz-UZ')}
                  </Text>
                </Descriptions.Item>
              </Descriptions>

              <Alert
                message="Пассив қабул режими"
                description="Мазкур бот фақат бириктирилган Telegram гуруҳларидаги хабарларни қабул қилиш режимида ишлайди. У аҳолига ўз номидан бевосита хабар ёзмайди ва тарқатмайди."
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              <Divider style={{ margin: '12px 0' }} />

              <Space wrap size="middle">
                <Button
                  type="default"
                  icon={<SwapOutlined />}
                  size="large"
                  onClick={handleOpenReplaceModal}
                  disabled={isOffline || isConnecting || isDisconnecting}
                  style={{ minHeight: '44px' }}
                >
                  Ботни алмаштириш
                </Button>
                <Button
                  danger
                  type="default"
                  icon={<DisconnectOutlined />}
                  size="large"
                  onClick={handleOpenDisconnectModal}
                  disabled={isOffline || isConnecting || isDisconnecting}
                  loading={isDisconnecting}
                  style={{ minHeight: '44px' }}
                >
                  Ботни узиш
                </Button>
              </Space>
            </Space>
          </Card>
          <TelegramGroupTable districtId={effectiveDistrictId || bot.districtId} isOffline={isOffline} />
          </>
        ) : (
          <>
          <Card
            title={
              <Space>
                <RobotOutlined style={{ fontSize: '20px', color: themeColors.colorPrimary }} />
                <span>Telegram ботни улаш</span>
              </Space>
            }
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Alert
                message="Бот токенини киритиш бўйича кўрсатма"
                description="BotFather орқали яратилган расмий Telegram бот токенини киритинг. Бот фақат бириктирилган туман гуруҳларидаги хабарларни қабул қилади ва ҳеч қачон автоматик хабар юбормайди."
                type="info"
                showIcon
                icon={<InfoCircleOutlined />}
              />

              {connectError && (
                <Alert
                  message="Ботни улашда хатолик"
                  description={connectError.message || 'Telegram бот токени нотўғри ёки ботга уланишда хатолик юз берди.'}
                  type="error"
                  showIcon
                  icon={<ExclamationCircleOutlined />}
                />
              )}

              <Form
                form={connectForm}
                layout="vertical"
                onFinish={handleConnectSubmit}
                requiredMark={false}
              >
                <Form.Item
                  name="token"
                  label={<Text strong>Telegram бот токени</Text>}
                  rules={[
                    { required: true, message: 'Илтимос, Telegram бот токенини киритинг.' },
                    {
                      pattern: BOT_TOKEN_REGEX,
                      transform: (value: string) => value?.trim(),
                      message: 'Илтимос, тўғри Telegram бот токенини киритинг (масалан: 123456789:ABCdefGHIjkl...).',
                    },
                  ]}
                  extra="Токен фақат серверда шифрланган ҳолда (AES-256-GCM) сақланади ва браузерга очиқ ҳолда қайтарилмайди."
                >
                  <Input.Password
                    placeholder="123456789:AAF..."
                    size="large"
                    prefix={<LockOutlined style={{ color: themeColors.colorIconPlaceholder }} />}
                    disabled={isOffline || isConnecting}
                    style={{ minHeight: '44px' }}
                    autoComplete="off"
                  />
                </Form.Item>

                <Form.Item style={{ marginBottom: 0 }}>
                  <Button
                    type="primary"
                    htmlType="submit"
                    icon={<SafetyCertificateOutlined />}
                    size="large"
                    loading={isConnecting}
                    disabled={isOffline}
                    style={{ minHeight: '44px', width: '100%' }}
                  >
                    Ботни текшириш ва улаш
                  </Button>
                </Form.Item>
              </Form>
            </Space>
          </Card>
          <Alert
            message="Маҳалла гуруҳларини бириктириш"
            description="Маҳаллалар учун Telegram гуруҳларини қўшиш ва синовдан ўтказиш учун аввал юқоридаги расмий ботни фаоллаштиринг."
            type="info"
            showIcon
            icon={<InfoCircleOutlined />}
          />
          </>
        )}
      </Space>

      <ReplaceBotModal
        isOpen={isReplaceModalOpen}
        isConnecting={isConnecting}
        connectError={connectError}
        onSubmit={handleReplaceSubmit}
        onClose={() => { setIsReplaceModalOpen(false); resetConnectError(); }}
      />

      <DisconnectBotModal
        isOpen={isDisconnectModalOpen}
        isDisconnecting={isDisconnecting}
        disconnectError={disconnectError}
        districtName={activeDistrict.name}
        onConfirm={handleDisconnectConfirm}
        onClose={() => { setIsDisconnectModalOpen(false); resetDisconnectError(); }}
      />
    </div>
  );
}
